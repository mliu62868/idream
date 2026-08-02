# @idream/gen

Generation Service — image + video. Slow async workers: payload self-contained,
write blob only, no DB authority. Image/video attempts persist one durable
terminal record and enqueue it to Main's BullMQ relay. Character Preview is an
ordinary `ai.image.generate` Attempt with a Main-owned source projection.

## Playwright-managed image worker

Main's Playwright configuration owns one `start:image` process and one
Main-side `gen-finalizer` process in addition to its four URL services. The Gen
process consumes `ai.image.generate` jobs, including Character Preview, from the
run-scoped Redis/BullMQ namespace. Because the workers have no HTTP ports,
Playwright 1.61 waits for their stable stdout readiness records and stops them
with graceful `SIGTERM`. The harness explicitly pins the higher-priority
`GEN_*` variables so Gen cannot inherit `packages/gen/.env` Redis or provider
authority. Image/video jobs resume a persisted terminal record before invoking
their provider, so interrupted relay admission cannot repeat expensive
generation. Main outages retry only the independent relay row; the finalizer
projects all image/video outcomes from the same terminal record authority.

## Backend abstraction (`GEN_IMAGE_PROVIDER=backend`)

`providers.image` (see `src/providers.ts`) supports a `backend` provider that
talks directly to a local generation backend instead of an external
OpenAI-compatible pipeline gateway:

- **`GenBackend`** (`src/backend/types.ts`) — a small `submit`/`poll`/`health`
  contract implemented per backend kind: `ComfyUIBackend` (`src/backend/comfyui.ts`,
  drives ComfyUI's native `/prompt` → `/history` → `/view` HTTP API),
  `SdcppBackend` (`src/backend/sdcpp.ts`, shells out to the `sd-cli` binary), and
  `DrawThingsBackend` (`src/backend/drawthings.ts`, shells out to the official
  `draw-things-cli`).
- **Workflow descriptors** (`src/backend/workflow.ts`, JSON files under
  `packages/gen/workflows/`) are discriminated by backend kind. ComfyUI
  workflows declare an `apiPrompt` graph; CLI workflows declare backend config.
  All workflows expose named input slots (`prompt`, `width`, `height`, `seed`,
  `steps`, ...), bound to either a `{nodeId, field}` or a CLI `argFlag`. Adding
  a new model is "drop a descriptor JSON," not "write new wiring code."
- **`BackendRegistry`** (`src/backend/registry.ts`) loads every descriptor from
  `GEN_WORKFLOW_DIR`, indexes them by `modelId`, and resolves each to its
  backend instance.
- **`BackendImageModel`** (`src/backend/backend-image-model.ts`) is the
  `ImageModel` adapter: it resolves `input.model` through the registry, maps
  `orientation`/`controls` to slot values, and loops submit→poll once per
  requested image.

### Pointing at a local ComfyUI

Set `COMFYUI_API_URL` (default `http://127.0.0.1:8188`) to your running ComfyUI
instance's native API, and `GEN_IMAGE_PROVIDER=backend` to route
`providers.image` through it. `GEN_WORKFLOW_DIR` defaults to
`packages/gen/workflows` (repo-root relative); the smoke script below resolves
it explicitly so it works regardless of cwd.

### RedCraft Krea2 RedMix3 comparison candidate

`redcraft-krea2-redmix3-txt2img` is an opt-in RedMix3 text-to-image workflow
for Civitai model `958009`, version `3139241`, file `3019490`. It remains
separate from the serving `redcraft-krea2-redmix3-txt2img` workflow so the current
RedCraft BF16 model stays available as the default and rollback path.

The exact source file is the 12.24 GiB scaled-FP8 variant:

- upstream filename: `redcraft23INT8INT4FP8_30Krea2.safetensors`
- normalized local filename:
  `Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors`
- SHA-256:
  `F6088960C0FEBD27CBD372FC758BB07D012F2D8AE3CD10C45C903D48B94409EA`
- Civitai download:
  `https://civitai.red/api/download/models/3139241?fileId=3019490`

Header inspection must show 256 FP8 weights, 256 matching `weight_scale`
sidecars, and 256 `comfy_quant` tags. **No conversion step is needed.** With
`fp4-fp8-for-torch-mps` in the runner venv, ComfyUI dequantizes scaled-fp8 per
layer on MPS, so the descriptor loads the Civitai release file as-is. The
former bf16 conversion product is not equivalent to it anyway — same-seed
output differs (RMSE 25.5); see
`docs/research/QWEN_FP8_ON_APPLE_MPS_LANDED_2026-07-29.md`.

The candidate also requires:

- `models/text_encoders/qwen3vl_4b_bf16.safetensors`
- `models/vae/qwen_image_vae.safetensors`

Its controlled graph uses 12 steps, Euler, Simple, and CFG 1. Author showcase
LoRA, SeedVR2, sharpening, and upscalers are intentionally excluded. The
current route uses 10-step ER-SDE, so a same-prompt/seed/dimensions comparison
still compares two version-native recipes; it is not a model-weight-only
experiment. Run a local artifact smoke with:

```bash
cd packages/gen
GEN_IMAGE_PROVIDER=backend \
  COMFYUI_API_URL=http://127.0.0.1:8188 \
  bun run smoke:backend -- \
  --model redcraft-krea2-redmix3-fp8 \
  --prompt "editorial portrait, dramatic foreground perspective, natural skin texture" \
  --seed 486071801727172 \
  --steps 12 \
  --out /private/tmp/idream-redmix3-mps-smoke.png
```

The seeded profile `redcraft-krea2-redmix3-comparison` stays `draft`, disabled,
and at zero rollout. A successful artifact smoke proves runtime compatibility;
it does not switch the serving default or establish character-consistency
qualification.

### Dark Beast FLUX.2 Klein comparison candidate

`darkbeast-flux2-klein-9b-multi-reference` is an opt-in, two-reference
ComfyUI workflow for Civitai version `2740209` (`DBKleinV2 BFS`). Despite the
collection slug, this exact version is based on FLUX.2 Klein 9B, not Krea 2.
It is registered separately from Qwen Image Edit and is not a default route.

Install these files on the target ComfyUI runner before executing it:

- `models/diffusion_models/darkBeastINT8Convrot2_dbkleinv2BFS.safetensors`
- `models/text_encoders/qwen_3_8b_fp8mixed.safetensors`
- `models/vae/flux2-vae.safetensors`

Set `COMFYUI_MODEL_ROOT` to that runner's absolute `models` directory before
running `packages/main`'s database seed. It defaults to the local
`/Users/kk/ComfyUI-Shared/models` layout. The release-readiness probe streams
the checkpoint once under `--require-ready` and requires SHA-256
`B20B6F2744E152FD3EFA2638E88A5FEAB478C778EE25C81B183FD80E03A099C3`,
so a different file with the same name cannot pass the exact-version gate.

The descriptor uses native `VAEEncode → ReferenceLatent` chains for one
identity image and one source image. Optional LoRA and SeedVR2 nodes from the
author's showcase workflow are intentionally excluded so later A/B output
differences remain attributable to Dark Beast versus Qwen Image Edit. Its
width and height controls update both `EmptyFlux2LatentImage` and
`Flux2Scheduler`, keeping explicit orientation requests aligned with Qwen.

Use the same identity image, source image, prompt, and fixed smoke seed for the
first comparison:

```bash
cd packages/gen
GEN_IMAGE_PROVIDER=backend \
  COMFYUI_API_URL=http://127.0.0.1:8188 \
  bun run smoke:backend -- \
  --model darkbeast-flux2-klein-9b-bfs \
  --ref /path/to/identity.png --ref-role identity_reference \
  --ref /path/to/source.png --ref-role source_image \
  --out /tmp/darkbeast-klein-comparison.png

GEN_IMAGE_PROVIDER=backend \
  COMFYUI_API_URL=http://127.0.0.1:8188 \
  bun run smoke:backend -- \
  --model qwen-image-edit-multi-reference \
  --ref /path/to/identity.png --ref-role identity_reference \
  --ref /path/to/source.png --ref-role source_image \
  --out /tmp/qwen-image-edit-comparison.png
```

The seeded model profile remains `draft`, disabled, and at zero rollout until
the exact assets are installed on a compatible runner and a real artifact
smoke plus identity/intent review passes.

### Pointing at Draw Things

Install the official `draw-things-cli`, set `DRAWTHINGS_CLI` when it is not on
`PATH`, and select `pornmaster-zimage-drawthings-txt2img` on a model profile.
On macOS the CLI automatically reuses the Draw Things app model directory;
`DRAWTHINGS_MODELS_DIR` overrides it. Worker generations are offline by default
(`DRAWTHINGS_OFFLINE=true`) so missing models fail instead of downloading at
request time.

The adapter serializes Draw Things commands inside each worker. When the host
must load only one model process at a time, start PM2 with
`GEN_IMAGE_INSTANCES=1`; leaving the variable unset preserves the two-worker
default used by the other backends.

```bash
cd packages/gen
GEN_IMAGE_PROVIDER=backend \
  DRAWTHINGS_CLI=/opt/homebrew/bin/draw-things-cli \
  bun run smoke:backend -- \
  --model pornmaster-zimage-drawthings \
  --out /tmp/drawthings-smoke.png
```

### Running the backend smoke

`src/backend/smoke.ts` drives `providers.image.generate()` for the
the selected workflow against its live backend, asserts the returned
PNG passes `assertGeneratedImageSanity`, and writes it to a temp path (or
`--out <path>`). It is manual-only — not part of `vitest run` — since it
requires the corresponding real backend:

```bash
cd packages/gen
GEN_IMAGE_PROVIDER=backend COMFYUI_API_URL=http://127.0.0.1:8188 bun run smoke:backend -- --out /tmp/backend-smoke.png
```

The first generation on a cold ComfyUI process loads a ~24GB bf16 checkpoint
into memory and can take a few minutes; subsequent runs are much faster once
the model is resident.

## Production video backend (`GEN_VIDEO_PROVIDER=backend`)

The production video worker uses the same backend registry, but resolves the
video-only `ltx23-gtanimation-i2v` descriptor through `BackendVideoModel`.
This route requires exactly one `source_image` reference. Before blob persistence,
`ffprobe` reads the actual stream envelope and `ffmpeg` fully decodes the file;
the worker rejects corrupt media or anything other than 768x1152, about four
seconds, 25 fps, and an audio stream. Missing verification binaries fail closed.

The checked-in descriptor pins the exact Civitai LTX 2.3 GTAnimation INT4
ConvRot workflow tested on ComfyUI/MPS:

```dotenv
GEN_VIDEO_PROVIDER=backend
GEN_VIDEO_TIMEOUT_MS=1800000
COMFYUI_API_URL=http://127.0.0.1:8188
# Optional when the binaries are not on PATH:
# GEN_FFPROBE_BIN=/opt/homebrew/bin/ffprobe
# GEN_FFMPEG_BIN=/opt/homebrew/bin/ffmpeg
```

```text
model: ltx23-gtanimation-int4-convrot
workflow: ltx23-gtanimation-i2v
input: one published source image
output: 768x1152, 25 fps, MP4 with audio
```

Regenerate the descriptor from the validated ComfyUI API prompt with:

```bash
bun packages/gen/scripts/build-ltx23-gtanimation-workflow.mjs
bun run sync:comfyui-workflows
```

The 30-minute provider timeout is intentional: the full 768x1152 route takes
roughly 10–15 minutes on the current M4 Max/MPS host.

The PM2 `gen-video` process intentionally runs with `watch: false` in both
development and production. A source-file restart can otherwise interrupt an
in-flight clip after coins were reserved. Main's video stale timeout is 35
minutes, deliberately longer than this provider timeout.

**fp8 → bf16 note:** on Apple Silicon (MPS), fp8-quantized checkpoints are not
supported — they must be dequantized to bf16 before ComfyUI can load them on
MPS. See `docs/superpowers/specs/2026-07-07-image-generation-redesign-design.md`
§4.2b for the conversion approach (per-tensor `weight * weight_scale` dequant);
the workflow descriptors in `packages/gen/workflows/` already point at the
converted bf16 filenames.
