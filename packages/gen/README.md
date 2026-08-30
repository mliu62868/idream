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
  drives ComfyUI's native `/prompt` → `/history` → `/view` HTTP API) and
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

Set `COMFYUI_IMAGE_API_URL` (default `http://127.0.0.1:8189`) and
`COMFYUI_VIDEO_API_URL` (default `http://127.0.0.1:8188`) to the isolated native
image and RedGraft/LTX APIs. `COMFYUI_H3_API_URL` defaults to
`http://127.0.0.1:8190` for MiniMax H3. `bun run comfyui:start` starts image with
PyTorch attention, RedGraft/LTX with validated split attention, and H3 with
exact PyTorch SDPA. Set `GEN_IMAGE_PROVIDER=backend` to route `providers.image`
through it. `GEN_WORKFLOW_DIR` defaults to
`packages/gen/workflows` (repo-root relative); the smoke script below resolves
it explicitly so it works regardless of cwd.

#### FP8 on Apple Silicon (MPS)

PyTorch MPS has no native Float8 dtype. The runner needs the
[ComfyUI-AppleSilicon-FP8](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8)
custom node in `custom_nodes/` — it re-applies its runtime patches on every
ComfyUI startup, so a ComfyUI upgrade needs **no re-patching**. Do NOT install
the older `fp4-fp8-for-torch-mps` pip package alongside it; both patch the
same MPS ops and stack unpredictably.

RedCraft RedMix3 uses the author/release scaled-FP8 checkpoint directly. On
M1–M4, the 8-bit weights remain the resident/storage representation and the
compatibility layer decodes one operation at a time to BF16 for MPS GEMM. This
is intentional: it preserves the roughly 12 GiB resident checkpoint instead of
materializing a roughly 24 GiB whole-model BF16 serving copy. Do not add
`--supports-fp8-compute`; on this host it would quantize BF16 activations only to
decode them again before the same BF16 GEMM.

After every ComfyUI upgrade (then `bun run comfyui:restart`):

```bash
cd packages/gen && bun run preflight
```

`preflight` hard-checks the node directory (via `COMFYUI_VENV_PYTHON`), model
visibility, and every production video recipe's pinned model SHA-256 against
the bytes under `COMFYUI_MODEL_ROOT`; `smoke:backend` requires an explicit
model. If a supported route fails after an upgrade, update the node
itself and restart:

```bash
git -C "<comfyui>/custom_nodes/ComfyUI-AppleSilicon-FP8" pull
```

Per-patch status is logged at startup — inspect with
`pm2 logs comfyui-video comfyui-image --nostream | grep AppleSilicon-FP8`. A venv rebuild
(major ComfyUI Desktop upgrade) keeps the node but may drop its pip deps;
reinstall with the venv python: `pip install -r <node dir>/requirements.txt`.

### RedCraft Krea2 routes

The active text-to-image descriptor is
`redcraft-krea2-redmix3-txt2img@1`. Identity Edit uses
`redcraft-krea2-identity-edit@4`: the full v1.2 LoRA at strength 1,
`ref_boost=4`, `grounding_px=768`, 832×1216, 8 steps, CFG 1, Euler/Simple. Its
pixel path receives `vae + source_image + target_latent` and pre-encodes the
fitted source before sampling; the required `source_latent` socket uses the
same empty target latent as a type-correct placeholder, avoiding a redundant
source VAE encode.

Only the active FP8 profiles may point at these descriptors. The legacy
`/Users/kk/Downloads/models/redcraftKREA2RedMix_krea2Edition.safetensors`
profiles remain archived because that file is absent. The materialized BF16
comparison profile also remains archived: its file is absent and its matched
warm A/B did not justify doubling resident model bytes.

### Pointing at Draw Things

Install the official `draw-things-cli`, set `DRAWTHINGS_CLI` when it is not on
`PATH`, and select `pornmaster-zimage-drawthings-txt2img` on a model profile.
On macOS the CLI automatically reuses the Draw Things app model directory;
`DRAWTHINGS_MODELS_DIR` overrides it. Worker generations are offline by default
(`DRAWTHINGS_OFFLINE=true`) so missing models fail instead of downloading at
request time.

The host defaults to one image worker. Image and video backend calls also share
`GEN_ACCELERATOR_LOCK_PATH`, so separate ComfyUI processes cannot execute large
MPS jobs concurrently on the same unified-memory GPU.

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
GEN_IMAGE_PROVIDER=backend \
  COMFYUI_IMAGE_API_URL=http://127.0.0.1:8189 \
  bun run smoke:backend -- \
  --model qwen-image-edit \
  --ref /absolute/path/to/reference.png \
  --out /tmp/backend-smoke.png
```

Cold-start cost depends on the explicitly selected model. The smoke command has
no implicit model fallback, so an unspecified or archived model cannot be
exercised accidentally.

## Production video backend (`GEN_VIDEO_PROVIDER=backend`)

The production video worker uses the same backend registry and resolves one of
the pinned video descriptors through `BackendVideoModel`. Both routes require
exactly one `source_image` reference. Before blob persistence,
`ffprobe` reads the actual stream envelope and `ffmpeg` fully decodes the file;
the worker rejects corrupt media or output that drifts from its recipe-specific
dimensions, duration, fps, or required audio stream. Missing verification
binaries fail closed.

The checked-in descriptors pin the exact RedGraft LTX 2.5 and MiniMax H3
workflows tested on ComfyUI/MPS:

```dotenv
GEN_VIDEO_PROVIDER=backend
GEN_VIDEO_TIMEOUT_MS=1800000
COMFYUI_VIDEO_API_URL=http://127.0.0.1:8188
COMFYUI_H3_API_URL=http://127.0.0.1:8190
# Optional when the binaries are not on PATH:
# GEN_FFPROBE_BIN=/opt/homebrew/bin/ffprobe
# GEN_FFMPEG_BIN=/opt/homebrew/bin/ffmpeg
```

```text
default model: redgraft-ltx25-fast2k-int8-convrot
default workflow: redgraft-ltx25-i2v
default output: 768x1152, 121 frames / 5.042 seconds, 24 fps, MP4 with audio

explicit model: minimax-h3-redcraft-a2a-int8-convrot
explicit workflow: minimax-h3-redcraft-i2v
explicit output: 512x512, 124 frames / 5.167 seconds, 24 fps, MP4 with audio
input: one published source image
```

MiniMax H3 is registered as `profile_video_h3_v1` with
`publicSelection.explicitOnly=true`; it never replaces the RedGraft default when a
caller omits the model. Its request contract is the integer value `seconds=5`,
which the worker binds to H3's native 124-frame grid. Workflow v3 routes H3 to
8190 but keeps exact SDPA: the matched 512×512/124-frame SolAttn A/B saved only
about eight seconds of an eleven-minute prompt while changing generated pixels,
which was not enough evidence to accept approximation. RedGraft/LTX continues
to use its unchanged 8188 split-attention process.

Both recipes pin every executable checkpoint, text encoder, VAE, and LTX
upscaler by relative model path plus SHA-256. Set `COMFYUI_MODEL_ROOT` to the
exact model directory used by the target runner. Startup preflight and each
release probe hash the actual bytes from that root; matching filenames are not
sufficient for the launch gate. Every new immutable TerminalRecord also pins
the Gen execution source revision, so a new checker cannot relabel an old run
as current launch evidence.

Unless startup receives an explicit `IDREAM_SOURCE_REVISION`, the PM2 wrapper
computes `IDREAM_SOURCE_REVISION` with
`idream_worktree_sha256_v1`. That computed form includes every Git-tracked file
and every non-ignored untracked file, including documentation, so a docs-only
edit invalidates its freshness exactly like a code edit. Explicit immutable
release revisions remain opaque exact-match authority. See
`docs/architecture/10-operations.md` for the drain and reprobe procedure.

Sync the checked-in descriptors into the ComfyUI API workflow directory with:

```bash
bun run sync:comfyui-workflows
```

The 30-minute provider timeout is intentional. On the current M4 Max host, the
executor-bound `0fdf96b06508` evidence snapshot measured MiniMax H3 direct at
667.438 seconds total (565 seconds for 8-step sampling). The latest isolated
RedGraft product probe took 893.807 seconds end to end for 121 frames. Historical
LTX 2.3 timings remain evidence for old outputs, not an executable route. The
active routes use different resolution/frame contracts and warm/cold states, so
these values are operating baselines rather than a controlled model benchmark.

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
