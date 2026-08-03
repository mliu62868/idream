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
import { env } from "./env";

type Descriptor = {
  workflowKey?: string;
  backendKind?: string;
  apiPrompt?: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
};

type Problem = { workflow: string; detail: string };

// ComfyUI exposes each loader's selectable files through /object_info, keyed by
// the input name. That listing is authority on what the runner can actually see.
const SLOT_TO_NODE: Record<string, string> = {
  ckpt_name: "CheckpointLoaderSimple",
  unet_name: "UNETLoader",
  clip_name: "CLIPLoader",
  vae_name: "VAELoader",
};

const FP8_DTYPES = new Set(["fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"]);

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
  if (!Array.isArray(spec) || !Array.isArray(spec[0])) return null;
  return new Set(spec[0] as string[]);
}

async function main() {
  // INTENT: read the worker's own config, never a second copy of it. This used to
  // resolve `COMFYUI_API_URL ?? COMFYUI_URL ?? "http://127.0.0.1:8188"` while the
  // worker (env.ts) resolves `COMFYUI_API_URL ?? "http://127.0.0.1:8188"`.
  // COMFYUI_URL appears nowhere else in the repo, so setting only that pointed
  // preflight at one runner and left the worker on localhost — every descriptor
  // verified green against a ComfyUI that serves no generation. Same reason the
  // workflow dir and the ffprobe/ffmpeg paths come from env.
  const base = env.COMFYUI_API_URL;
  const dir = env.GEN_WORKFLOW_DIR;

  const stats = await fetch(`${base}/system_stats`).catch(() => null);
  if (!stats?.ok) {
    process.stderr.write(`preflight: cannot reach ComfyUI at ${base}\n`);
    process.exit(1);
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
  let needsFp8Shim = false;
  let checked = 0;

  for (const file of files) {
    let descriptor: Descriptor;
    try {
      descriptor = JSON.parse(await readFile(path.join(dir, file), "utf8")) as Descriptor;
    } catch (error) {
      problems.push({ workflow: file, detail: `unparsable: ${String(error)}` });
      continue;
    }
    if (descriptor.backendKind !== "comfyui" || !descriptor.apiPrompt) continue;

    for (const [nodeId, node] of Object.entries(descriptor.apiPrompt)) {
      for (const [slot, nodeType] of Object.entries(SLOT_TO_NODE)) {
        const value = node.inputs?.[slot];
        if (typeof value !== "string" || value === "") continue;
        checked++;
        if (!cache.has(slot)) cache.set(slot, await availableFiles(base, nodeType, slot));
        const available = cache.get(slot);
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
      if (typeof dtype === "string" && FP8_DTYPES.has(dtype)) needsFp8Shim = true;
    }
  }

  // The shim has no HTTP surface, so probe the capability it enables: a runner
  // without it lists fp8 dtypes but dies when the sampler casts to MPS.
  if (needsFp8Shim) {
    const kj = await objectInfo(base, "CheckpointLoaderKJ");
    if (!kj) {
      problems.push({
        workflow: "(runner)",
        detail: "descriptors request fp8 weights but CheckpointLoaderKJ is missing — install comfyui-kjnodes",
      });
    }
    // The node registers no ComfyUI nodes (pure runtime patches), so there is
    // no /object_info surface to probe. Point COMFYUI_VENV_PYTHON at the
    // runner interpreter (<comfyui>/.venv/bin/python3); custom_nodes/ is
    // derived from it for a hard presence check. Without it we can only warn.
    const venvPython = process.env.COMFYUI_VENV_PYTHON;
    if (venvPython) {
      const nodeInit = path.resolve(
        venvPython,
        "../../..",
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
        "preflight: set COMFYUI_VENV_PYTHON to hard-check the ComfyUI-AppleSilicon-FP8 node\n",
      );
    }
  }

  for (const p of problems) process.stdout.write(`FAIL  ${p.workflow}: ${p.detail}\n`);
  process.stdout.write(
    `preflight: ${files.length} descriptors, ${checked} model refs checked, ${problems.length} problem(s)\n`,
  );
  if (needsFp8Shim) {
    process.stdout.write(
      "preflight: fp8 descriptors present — runner needs the ComfyUI-AppleSilicon-FP8 custom node, and must be restarted after installing it\n",
    );
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

void main();
