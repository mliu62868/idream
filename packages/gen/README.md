# @idream/gen

Generation Service — image + video. Slow async workers: payload self-contained,
write blob only, no DB authority. Image/video attempts persist one durable
terminal record and enqueue it to Main's BullMQ relay. Character Preview is an
ordinary `ai.image.generate` Attempt with a Main-owned source projection.

## Playwright-managed workers

Main's Playwright configuration runs Gen's real image and video pipelines from
source (`packages/main/src/e2e/start-playwright-gen-worker.ts image|video`) plus
one Main-side `gen-finalizer` process, in addition to its four URL services.
The image worker consumes `ai.image.generate` jobs, including Character
Preview, from the run-scoped Redis/BullMQ namespace. Main keeps its production
profile pins (runner `comfyui`), so the workers run with the `backend` adapter
while provider I/O uses `createMockGenProviders()`. Because the workers have no
HTTP ports, Playwright waits for their stdout readiness records and stops them
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
PyTorch attention, RedGraft/LTX with model-scoped MPSGraph attention and split fallback, and H3 with
exact PyTorch SDPA. Set `GEN_IMAGE_PROVIDER=backend` to route `providers.image`
through it. `GEN_WORKFLOW_DIR` defaults to
`packages/gen/workflows` (repo-root relative); the smoke script below resolves
it explicitly so it works regardless of cwd.

The active image graphs treat text encoding as a prompt-scoped phase. Krea2
loads a fresh standalone CLIP for conditioning; Qwen separates checkpoint
MODEL/VAE ownership from a fresh checkpoint CLIP. Once every positive,
negative, and reference branch has materialized conditioning,
`IDreamUnloadOffDeviceModels` destroys that CLIP owner while leaving the
diffusion model and VAE available to the sampler and decoder. Fresh loaders are
deliberately non-cacheable so a later prompt never observes the destroyed
owner.

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

`preflight` hard-checks the node directory (via `COMFYUI_ROOT`, or the legacy
`COMFYUI_VENV_PYTHON` layout when no root is set), model
visibility, the REDQW21 V2 editor's BF16 diffusion / ConvRot INT8 encoder / VAE /
Viggle LoRA SHA-256, and every production video recipe's pinned model SHA-256
against the bytes under `COMFYUI_MODEL_ROOT`. For Qwen edits it also proves
that the local image listener resolves each model uniquely from that root;
run the probe on the ComfyUI host. `smoke:backend` requires an explicit
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
`redcraft-krea2-redmix3-txt2img@2`. Identity Edit uses
`redcraft-krea2-identity-edit@5`: the full v1.2 LoRA at strength 1,
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

Image editing uses REDQW21 UNLOCKED V2 TI2I (Civitai `452459@3370753`,
file `3258921`), converted from scaled FP8 to BF16 for MPS. The source SHA256
is `0efb5aeb2b372025042e320c2e35c66ec6681ef54ad5de88a652ab19cc63ad92`.
The three existing `qwen-image-edit-*` workflow keys preserve their caller
contracts; their current versions use only REDQW21 V2. Rapid-AIO v19 is retired
and must not be installed or used as a fallback. Publish existing database
profiles with `db/sql/2026-09-30-redqw21-v2-image-edit-retire-rapid-aio.sql`
after installing the verified source and BF16 conversion, with queues drained.
All four Qwen-Image-2.1 routes (`redqw21` and the three editor workflows) use
[Comfy-Org Qwen3-VL 8B INT8 ConvRot](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/blob/cb504a4090723e43f17ad01cec0359490e2de613/text_encoders/qwen3vl_8b_int8_convrot.safetensors).
Install `qwen3vl_8b_int8_convrot.safetensors` in shared `text_encoders`;
its exact size is 9,350,798,360 bytes and SHA256 is
`8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f`.
The single-source editor (`qwen-image-edit-img2img@5`) runs this encoder on
MPS and computes only positive conditioning at CFG 1. The other three routes
retain CPU conditioning. ConvRot INT8 describes the community checkpoint;
M4 execution dequantizes for floating-point operations and is not native INT8
matrix multiplication.

All four graphs load `IDreamQwen21VAELoader` from
`comfyui_nodes/idream_qwen21`. Its model-scoped temporal padding uses
`torch.cat` instead of the large 5-D MPS `F.pad` that corrupts Qwen 2.1
reference latents ([ComfyUI #16433](https://github.com/Comfy-Org/ComfyUI/issues/16433)).
The correction preserves CPU semantics and leaves video VAE instances alone.
Large square/portrait FP32/BF16 padding tests match CPU exactly; full BF16
VAE round trips match the CPU reference within measured numerical tolerance.

Single-source edits use unmerged
[Viggle v0.3 six-step rank-128 LoRA](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/tree/009a44a895ef85f7e643c80fdca9543795248867)
at strength 1, `BasicGuider` and Euler with the author's shifted six-point
sigma grid. Install `Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors`
under shared `loras`, keeping its Qwen Research license. SHA256:
`0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3`.
`IDreamQwen21TurboLora` adds residuals without rounding them into the BF16
base weights and handles Comfy's fused SwiGLU projections. The schedule
requires exactly six steps; an ordinary simple scheduler is not equivalent.
Two-reference workflows retain 16 steps / CFG 2 pending their own qualification.

The selected default is the native ComfyUI single-source editor above: BF16
REDQW21 V2 diffusion, community ConvRot INT8 Qwen3-VL 8B on MPS, corrected
native VAE, and unmerged Viggle six-step Euler. MFLUX/MLX samplers remain
research prototypes and are absent from the production graph.

The image PM2 definition pins Python from its Qwen21 installation;
`bun run comfyui:restart` reloads that definition. The latest controlled local
acceptance on M4 Max 128 GiB / PyTorch 2.14 delivered two real 832×1024 edits in
58.117 and 48.337 seconds from Job creation to completion. Both verified HTTP
image readback, terminal relay, persistence, and exactly one 8-Dreamcoin spend;
idempotent admission replay returned the same Job. These are two single-source
samples, not a latency distribution or multi-reference quality qualification.
The user's 16-second M5 Pro result is a separate-machine measurement.
Execution evidence is bound to source revision
`idream-worktree-2068f6373b7e0cf026dcac2533da8d8225b9ab590ea1a37af0ba4c7b37561309`;
this later documentation update does not change the generation recipe.

Conservative EasyCache skipped no steps and is inactive. The attempted Metal-preference experiment
lacks proof that its flag reached Python, so its timing cannot establish a
backend comparison. The active Python process has no Metal-preference override.

Publish existing profiles with `db/sql/2026-10-01-qwen21-mac-acceleration.sql`
after the prior REDQW21 and community INT8 cutovers, installation verification,
and queue/admission quiescence. It publishes N+1 and preserves historical
Job/Attempt pins, pricing, rollout and multi-reference controls. The local
CPU-encoder dual-reference run exceeded ten minutes; this Mac retains
`GEN_IMAGE_TIMEOUT_MS=1200000` for those routes.
See [the implementation and product-delivery record](../../docs/research/QWEN21_MAC_ACCELERATION_IMPLEMENTATION_2026-10-01.md),
[the original acceleration investigation](../../docs/research/QWEN21_MAC_IMAGE_EDIT_ACCELERATION_2026-10-01.md)
and [the Mac runtime research](../../docs/research/QWEN21_MAC_RUNTIME_OPTIONS_2026-10-01.md).
Excluded content is expressed as positive instructions.
Source edits use the requested output dimensions; identity and look references
are bounded to approximately 1 MP while preserving their aspect ratios.
The controlled local probe preserved source framing and applied the requested
edit, but source-plus-identity editing retained much of the source face even
at 16 steps / CFG 2. This route is not yet qualified for reliable face replacement.

`src/backend/smoke.ts` drives `providers.image.generate()` for the
selected workflow against its live backend, asserts the returned
PNG passes `assertGeneratedImageSanity`, and writes it to a temp path (or
`--out <path>`). It is manual-only — not part of `vitest run` — since it
requires the corresponding real backend:

```bash
cd packages/gen
GEN_IMAGE_PROVIDER=backend \
  COMFYUI_IMAGE_API_URL=http://127.0.0.1:8189 \
  bun run smoke:backend -- \
  --model redqw21-image-edit \
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
which the worker binds to H3's native 124-frame grid. Workflow v4 routes H3 to
8190 but keeps exact SDPA: the matched 512×512/124-frame SolAttn A/B saved only
about eight seconds of an eleven-minute prompt while changing generated pixels,
which was not enough evidence to accept approximation.

RedGraft workflow v4 uses `IDreamMPSGraphAttention` in explicit BF16 mode on
both sampling stages. It preserves the 8+3 Euler schedule, CFG 1, current
weights, MLX Q8 Gemma and accelerated Conv VAE. Long compatible attention
shapes use MPSGraph; short or unsupported calls retain the original split
implementation. BF16 accumulation changes pixels and motion details, so this
is a separately qualified recipe, not a bit-exact replacement.

The 8188 PM2 definition pins a separate Torch 2.11 / mps-sdpa 0.2.0 environment
and persistent native extension cache. Comfy source stays on the validated
0.34.2 checkout. Set `COMFYUI_ROOT` and `COMFYUI_VENV_PYTHON` independently in
Gen's environment. Install the exact dependencies from
`comfyui_nodes/idream_mps_attention/requirements.txt` into that video environment.
After draining through the root README's PM2 wrapper, `bun run comfyui:restart:video`
restarts only 8188. Image and H3 retain their separate dependencies.

`db/sql/2026-10-02-redgraft-mpsgraph.sql` publishes immutable profile v6/v7
after admission/worker quiescence. An already active options-v5 becomes active
v7 with the same 3/5-second, portrait/square, preview/standard choices; a
disabled draft remains disabled. Old jobs and profiles retain their pins.
See [the controlled A/B/A, numerical and recovery evidence](../../docs/research/LTX25_MPSGRAPH_IMPLEMENTATION_2026-10-02.md).

Every checked-in ComfyUI image/video workflow places
`IDreamUnloadOffDeviceModels` after every text/reference conditioning branch
and before the first sampler. The node detaches only models whose load device
differs from the MPS render device, then evicts the active RAM-cache entries
that otherwise keep CPU text-loader outputs alive. Pending diffusion/VAE
consumers retain their own executor references, so sampling and decode continue
without reloading the text encoder mid-render. The launch profiles pin ComfyUI's
RAM-pressure cache (`--cache-ram 10 128`); do not switch them to a different
cache mode without re-running the physical RSS and full-path probes.

Both recipes pin every executable checkpoint, text encoder, VAE, and LTX
upscaler by relative model path plus SHA-256. Set `COMFYUI_MODEL_ROOT` to the
exact model directory used by the target runner. Startup preflight and each
release probe hash the actual bytes from that root; matching filenames are not
sufficient for the launch gate. Every new immutable TerminalRecord also pins
the Gen execution source revision, so a new checker cannot relabel an old run
as current launch evidence.

The shared custom-node configuration loads `comfyui_nodes/idream_ltx25_mps_vae`. Its constructor
hook recognizes the convolutional LTX 2.5 VAE and replaces eligible decoder
Conv3D arithmetic with bounded Conv2D depth sums on MPS. It preserves Comfy's
dynamic weight-loading context and the existing tile/blending rules. CPU/CUDA,
the encoder, and other VAE configurations retain their original operations.
In the prior Torch 2.10 environment, the same captured 121-frame latent
measured 199.88 seconds for stock decode and 32.16 seconds for this plugin,
with a maximum per-frame RGB RMSE of 0.00192. The native Comfy decode node
measured 32.17 seconds; full I2V latency was not remeasured.
See [the VAE replay evidence](../../docs/research/LTX25_VAE_ACCELERATION_2026-10-02.md).

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
667.438 seconds total (565 seconds for 8-step sampling). An earlier isolated
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
