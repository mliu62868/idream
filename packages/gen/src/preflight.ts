/**
 * SPEC: verify a ComfyUI runner can actually serve every workflow descriptor
 * before traffic reaches it. Exits 0 when clean, 1 when anything is broken.
 *
 * INTENT: two classes of failure have already bitten us and both are silent
 * until generation time:
 *   1. A model file resolves in ComfyUI's dropdown but cannot be opened —
 *      dangling symlinks stay listed after their target disappears.
 *   2. Descriptors asking for `fp8_e4m3fn` weights need the
 *      ComfyUI-AppleSilicon-FP8 custom node in the runner's custom_nodes/.
 *      PyTorch MPS has no native Float8 dtype, so without it the sampler
 *      raises at step 0. custom_nodes/ survives ComfyUI upgrades, but a fresh
 *      install loses it — and an already-running process never picks up a
 *      fresh install.
 *
 * INVARIANT: read-only. This probe never submits a generation.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { characterVideoProductionRecipes } from "@idream/shared";
import { env } from "./env";
import { attestLocalComfyUiModelRoot, attestPinnedModelAssets } from "./model-asset-attestation";
import {
  modelLoaderNodeForReference,
  requiredComfyNodeTypes,
  comboOptions,
} from "./preflight-model-reference";
import { comfyUiRunnerForDescriptor } from "./backend/registry";

type Descriptor = {
  workflowKey?: string;
  backendKind?: string;
  capabilities?: string[];
  apiPrompt?: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
};

type Problem = { workflow: string; detail: string };

// ComfyUI exposes each loader's selectable files through /object_info, keyed by
// the input name. That listing is authority on what the runner can actually see.
const FP8_DTYPES = new Set(["fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"]);

// INVARIANT: filenames in dropdowns do not prove that the REDQW21 V2 recipe
// loads the qualified BF16 diffusion, community ConvRot INT8 encoder and VAE.
const QWEN21_EDIT_MODEL_ASSETS = [
  {
    path: "diffusion_models/redqw21_unlocked_v2_bf16.safetensors",
    sha256: "c2ff9ea7e983b61589363fe11d0437419f7ade088bb470ef2e501bd81513c45f",
  },
  {
    path: "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
    sha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
  },
  {
    path: "vae/qwen_image_2.1_vae_bf16.safetensors",
    sha256: "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9",
  },
];
const QWEN21_TURBO_MODEL_ASSET = {
  path: "loras/Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors",
  sha256: "0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3",
};

async function objectInfo(base: string, node: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${base}/object_info/${node}`);
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, unknown>;
  return (body[node] as Record<string, unknown>) ?? null;
}

async function availableFiles(base: string, node: string, slot: string): Promise<Set<string> | null> {
  const info = await objectInfo(base, node);
  if (!info) return null;
  const required = (info.input as { required?: Record<string, unknown> } | undefined)?.required ?? {};
  const spec = required[slot];
  const options = comboOptions(spec);
  return options ? new Set(options) : null;
}

async function main() {
  // INTENT: probe the same modality-specific authorities the workers use. A
  // green video runner cannot stand in for an unreachable image runner.
  const runnerBases = new Set([
    env.COMFYUI_IMAGE_API_URL,
    env.COMFYUI_VIDEO_API_URL,
    env.COMFYUI_H3_API_URL,
  ]);
  const dir = env.GEN_WORKFLOW_DIR;

  for (const base of runnerBases) {
    const stats = await fetch(`${base}/system_stats`).catch(() => null);
    if (!stats?.ok) {
      process.stderr.write(`preflight: cannot reach ComfyUI at ${base}\n`);
      process.exit(1);
    }
  }

  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const problems: Problem[] = [];
  for (const [name, executable] of [
    ["ffprobe", env.FFPROBE_BIN],
    ["ffmpeg", env.FFMPEG_BIN],
  ] as const) {
    const probe = spawnSync(executable, ["-version"], { stdio: "ignore" });
    if (probe.error || probe.status !== 0) {
      problems.push({
        workflow: "(video verification)",
        detail: `${name} executable is unavailable: ${executable}`,
      });
    }
  }
  const cache = new Map<string, Set<string> | null>();
  const nodeTypeAvailability = new Map<string, boolean>();
  const fp8RunnerBases = new Set<string>();
  let checked = 0;
  let checkedNodeTypes = 0;
  let checkedModelAssets = 0;
  let qwen21EditPresent = false;
  let qwen21TurboPresent = false;

  for (const file of files) {
    let descriptor: Descriptor;
    try {
      descriptor = JSON.parse(await readFile(path.join(dir, file), "utf8")) as Descriptor;
    } catch (error) {
      problems.push({ workflow: file, detail: `unparsable: ${String(error)}` });
      continue;
    }
    if (descriptor.backendKind !== "comfyui" || !descriptor.apiPrompt) continue;
    const runner = comfyUiRunnerForDescriptor({
      workflowKey: descriptor.workflowKey ?? "",
      capabilities: descriptor.capabilities ?? [],
    });
    const base = runner === "image"
      ? env.COMFYUI_IMAGE_API_URL
      : runner === "video-h3"
        ? env.COMFYUI_H3_API_URL
        : env.COMFYUI_VIDEO_API_URL;
    if (runner === "image" && descriptor.workflowKey?.startsWith("qwen-image-edit-")) {
      qwen21EditPresent = true;
      qwen21TurboPresent ||= Object.values(descriptor.apiPrompt).some(
        (node) => node.class_type === "IDreamQwen21TurboLora",
      );
    }

    for (const nodeType of requiredComfyNodeTypes(descriptor.apiPrompt)) {
      const nodeTypeKey = `${base}:${nodeType}`;
      if (!nodeTypeAvailability.has(nodeTypeKey)) {
        nodeTypeAvailability.set(
          nodeTypeKey,
          await objectInfo(base, nodeType) !== null,
        );
        checkedNodeTypes++;
      }
      if (!nodeTypeAvailability.get(nodeTypeKey)) {
        problems.push({
          workflow: file,
          detail: `required node type ${nodeType} is not registered by ${base}`,
        });
      }
    }

    for (const [nodeId, node] of Object.entries(descriptor.apiPrompt)) {
      for (const [slot, value] of Object.entries(node.inputs ?? {})) {
        const nodeType = modelLoaderNodeForReference(node.class_type, slot);
        if (!nodeType) continue;
        if (typeof value !== "string" || value === "") continue;
        checked++;
        const cacheKey = `${base}:${nodeType}:${slot}`;
        if (!cache.has(cacheKey)) {
          cache.set(cacheKey, await availableFiles(base, nodeType, slot));
        }
        const available = cache.get(cacheKey);
        if (!available) {
          problems.push({ workflow: file, detail: `cannot read ${nodeType}.${slot} from ${base}` });
          continue;
        }
        if (!available.has(value)) {
          problems.push({
            workflow: file,
            detail: `node ${nodeId} ${slot}="${value}" not visible to the runner`,
          });
        }
      }
      const dtype = node.inputs?.weight_dtype;
      if (typeof dtype === "string" && FP8_DTYPES.has(dtype)) {
        fp8RunnerBases.add(base);
      }
    }
  }

  if (env.IMAGE_PROVIDER === "backend" && qwen21EditPresent) {
    const assets = qwen21TurboPresent
      ? [...QWEN21_EDIT_MODEL_ASSETS, QWEN21_TURBO_MODEL_ASSET]
      : QWEN21_EDIT_MODEL_ASSETS;
    const attestation = await attestPinnedModelAssets({
      modelRoot: env.COMFYUI_MODEL_ROOT,
      assets,
    });
    checkedModelAssets += attestation.checked;
    for (const detail of attestation.problems) {
      problems.push({ workflow: "(Qwen image model bytes)", detail });
    }
    try {
      await attestLocalComfyUiModelRoot({
        apiUrl: env.COMFYUI_IMAGE_API_URL,
        modelRoot: env.COMFYUI_MODEL_ROOT,
        assetPaths: assets.map((asset) => asset.path),
      });
    } catch (error) {
      problems.push({ workflow: "(Qwen image model resolution)", detail: String(error) });
    }
  }

  if (env.VIDEO_PROVIDER === "backend") {
    const pinnedModelAssets: Array<{ path: string; sha256: string }> = [];
    for (const recipe of characterVideoProductionRecipes) {
      pinnedModelAssets.push(...recipe.modelAssets);
    }
    const attestation = await attestPinnedModelAssets({
      modelRoot: env.COMFYUI_MODEL_ROOT,
      assets: pinnedModelAssets,
    });
    checkedModelAssets += attestation.checked;
    for (const detail of attestation.problems) {
      problems.push({ workflow: "(video model bytes)", detail });
    }
  }

  // The shim has no HTTP surface, so probe the capability it enables: a runner
  // without it lists fp8 dtypes but dies when the sampler casts to MPS.
  for (const base of fp8RunnerBases) {
    const kj = await objectInfo(base, "CheckpointLoaderKJ");
    if (!kj) {
      problems.push({
        workflow: "(runner)",
        detail: `descriptors request fp8 weights but CheckpointLoaderKJ is missing from ${base} — install comfyui-kjnodes`,
      });
    }
  }
  if (fp8RunnerBases.size > 0) {
    // The node registers no ComfyUI nodes (pure runtime patches), so there is
    // no /object_info surface to probe. Source and Python may live in separate
    // directories. An explicit source root is authoritative; only the existing
    // <comfyui>/.venv layout can be inferred when that root is absent.
    const venvPython = process.env.COMFYUI_VENV_PYTHON;
    const comfyRoot = process.env.COMFYUI_ROOT
      || (venvPython ? path.resolve(venvPython, "../../..") : undefined);
    if (comfyRoot) {
      const nodeInit = path.resolve(
        comfyRoot,
        "custom_nodes/ComfyUI-AppleSilicon-FP8/__init__.py",
      );
      if (!existsSync(nodeInit)) {
        problems.push({
          workflow: "(runner)",
          detail: `fp8 descriptors present but ${nodeInit} is missing — install ComfyUI-AppleSilicon-FP8`,
        });
      }
    } else {
      process.stdout.write(
        "preflight: set COMFYUI_ROOT (or COMFYUI_VENV_PYTHON for the legacy .venv layout) to hard-check the ComfyUI-AppleSilicon-FP8 node\n",
      );
    }
  }

  for (const p of problems) process.stdout.write(`FAIL  ${p.workflow}: ${p.detail}\n`);
  process.stdout.write(
    `preflight: ${files.length} descriptors, ${checkedNodeTypes} node types, ${checked} model refs and ${checkedModelAssets} pinned model bytes checked, ${problems.length} problem(s)\n`,
  );
  if (fp8RunnerBases.size > 0) {
    process.stdout.write(
      "preflight: fp8 descriptors present — runner needs the ComfyUI-AppleSilicon-FP8 custom node, and must be restarted after installing it\n",
    );
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

void main();
