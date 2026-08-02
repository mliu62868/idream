/**
 * SPEC: verify a ComfyUI runner can actually serve every workflow descriptor
 * before traffic reaches it. Exits 0 when clean, 1 when anything is broken.
 *
 * INTENT: two classes of failure have already bitten us and both are silent
 * until generation time:
 *   1. A model file resolves in ComfyUI's dropdown but cannot be opened —
 *      dangling symlinks stay listed after their target disappears.
 *   2. Descriptors asking for `fp8_e4m3fn` weights need the
 *      `fp4-fp8-for-torch-mps` shim in the runner's venv. PyTorch MPS has no
 *      native Float8 dtype, so without it the sampler raises at step 0. The
 *      shim autoloads via a `[torch.backends]` entry point, which means an
 *      already-running process never picks up a fresh install — and a ComfyUI
 *      upgrade that rebuilds the venv drops it entirely.
 *
 * INVARIANT: read-only. This probe never submits a generation.
 */
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const base = process.env.COMFYUI_API_URL ??
    process.env.COMFYUI_URL ??
    "http://127.0.0.1:8188";
  // Resolve relative to this file so the probe works from the repo root or from
  // packages/gen, matching how the other gen scripts get invoked.
  const dir = process.env.GEN_WORKFLOW_DIR
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../workflows");

  const stats = await fetch(`${base}/system_stats`).catch(() => null);
  if (!stats?.ok) {
    process.stderr.write(`preflight: cannot reach ComfyUI at ${base}\n`);
    process.exit(1);
  }

  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const problems: Problem[] = [];
  for (const [name, executable] of [
    ["ffprobe", process.env.GEN_FFPROBE_BIN ?? "ffprobe"],
    ["ffmpeg", process.env.GEN_FFMPEG_BIN ?? "ffmpeg"],
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
    // Point COMFYUI_VENV_PYTHON at the runner interpreter for a hard check;
    // without it we can only warn, since ComfyUI exposes no package listing.
    const venvPython = process.env.COMFYUI_VENV_PYTHON;
    if (venvPython) {
      const probe = spawnSync(venvPython, ["-c", "import fp4_fp8_for_torch_mps"], { stdio: "ignore" });
      if (probe.status !== 0) {
        problems.push({
          workflow: "(runner)",
          detail: `fp8 descriptors present but ${venvPython} cannot import fp4_fp8_for_torch_mps`,
        });
      }
    } else {
      process.stdout.write(
        "preflight: set COMFYUI_VENV_PYTHON to hard-check the fp4-fp8-for-torch-mps shim\n",
      );
    }
  }

  for (const p of problems) process.stdout.write(`FAIL  ${p.workflow}: ${p.detail}\n`);
  process.stdout.write(
    `preflight: ${files.length} descriptors, ${checked} model refs checked, ${problems.length} problem(s)\n`,
  );
  if (needsFp8Shim) {
    process.stdout.write(
      "preflight: fp8 descriptors present — runner venv needs fp4-fp8-for-torch-mps, and must be restarted after installing it\n",
    );
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

void main();
