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

The `backend` adapter in `providers.image` (see `src/providers.ts`) executes
released workflows directly on a local generation backend:

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

The active Qwen image graphs load a fresh standalone CLIP for each prompt.
Once every positive, negative, and reference branch has materialized
conditioning, `IDreamUnloadOffDeviceModels` destroys that CLIP owner while
leaving the diffusion model and VAE available to the sampler and decoder.
Fresh loaders are deliberately non-cacheable so a later prompt never observes
the destroyed owner.

#### FP8 on Apple Silicon (MPS)

PyTorch MPS has no native Float8 dtype. The runner needs the
[ComfyUI-AppleSilicon-FP8](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8)
custom node in `custom_nodes/` — it re-applies its runtime patches on every
ComfyUI startup, so a ComfyUI upgrade needs **no re-patching**. Do NOT install
the older `fp4-fp8-for-torch-mps` pip package alongside it; both patch the
same MPS ops and stack unpredictably.

After every ComfyUI upgrade (then `bun run comfyui:restart`):

```bash
cd packages/gen && bun run preflight
```

`preflight` hard-checks the node directory (via `COMFYUI_ROOT`, or the legacy
`COMFYUI_VENV_PYTHON` layout when no root is set), model
visibility, every RedCraft image route's diffusion / ConvRot INT8 encoder /
TextureFix VAE SHA-256, and every production video recipe's pinned model SHA-256
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

### Qwen image routes

All active image-generation profiles use one RedCraft / FineView checkpoint.
The input contracts remain separate: `redcraft-qw21t@3` handles text and an
optional reference, `qwen-image-edit-img2img@6` handles one source,
`qwen-image-edit-multi-identity@7` handles identity plus identity/look, and
`qwen-image-edit-multi-reference@8` handles identity plus source. Their model
route IDs are `redcraft-qw21t`, `redcraft-image-edit`, `redcraft-multi-identity`
and `redcraft-multi-reference`; these identify workflows, not different weights.
Profiles must pin the matching descriptor key and version.

The dispatch contract preserves published reference weights through 10.
Current Qwen graphs bind references by their semantic role and frozen order;
their image slots do not apply this numeric weight to selection or
conditioning. A preserved weight is not evidence of weighted identity
fidelity; qualify any future workflow that actually applies it separately.

Krea text-to-image and Identity Edit routes are retired. Their descriptors,
Draw Things patches, smoke controls, and benchmark entry point have been
removed. The database retirement script is
[`2026-10-04-retire-krea-image-profiles.sql`](../../db/sql/2026-10-04-retire-krea-image-profiles.sql);
it rebinds published presets to Qwen and archives old profiles while preserving
historical attempt and billing records. Old Krea diffusion weights and Identity Edit LoRA have been deleted,
including their retirement archive. Draw Things Krea registrations are removed.

### Pointing at Draw Things

Install the official `draw-things-cli`, set `DRAWTHINGS_CLI` when it is not on
`PATH`, and select `pornmaster-zimage-drawthings-txt2img` on a model profile.
On macOS the CLI automatically reuses the Draw Things app model directory;
`DRAWTHINGS_MODELS_DIR` overrides it. Worker generations are offline by default
(`DRAWTHINGS_OFFLINE=true`) so missing models fail instead of downloading at
request time.

The host defaults to one image worker. Image and video backend calls also share
`GEN_ACCELERATOR_LOCK_PATH`, so separate ComfyUI processes cannot execute large
MPS jobs concurrently on the same unified-memory GPU. Bun holds an OS `flock`
on one permanent inode for the full submit/poll window; closing the descriptor
or a worker crash releases the lock. File contents are diagnostic metadata,
not ownership authority. Never unlink or replace this file while any worker
or benchmark using it is alive.

The previous existence/PID/mtime lease and this native lease cannot run together:
the old stale-owner reclaimer can unlink the new worker's held inode.
For this protocol upgrade, use `bun run pm2:stop` to drain and stop both
`gen-image` and `gen-video`, then the matching `pm2:start` or
`pm2:start:production` wrapper to start the new source. Do not roll or reload
one worker at a time. An old unlocked file can stay in place. Native loading
fails closed; there is no existence-lock fallback. Darwin uses libSystem;
Linux currently requires the glibc `libc.so.6` / `__errno_location` ABI. The
native multiprocess/crash regression has passed on macOS; run that regression
on the actual Linux target before qualifying its deployment.

```bash
cd packages/gen
GEN_IMAGE_PROVIDER=backend \
  DRAWTHINGS_CLI=/opt/homebrew/bin/draw-things-cli \
  bun run smoke:backend -- \
  --model pornmaster-zimage-drawthings \
  --out /tmp/drawthings-smoke.png
```

### Running the backend smoke

All four image graphs use the same FineView INT8 diffusion checkpoint,
ConvRot INT8 Qwen3-VL encoder on MPS and TextureFix BF16 VAE. Their fixed recipe
is six steps, `er_sde/simple`, CFG 1 and AuraFlow shift 1.31, without a LoRA.
`IDreamQwen21VAELoader` retains the model-scoped `torch.cat` temporal-padding
correction for MPS reference latents. Source-image and identity-reference slots
retain their distinct roles and ordering; references are never silently dropped.

### Default RedCraft / FineView QW21 Fixed

`profile_image_default_v1` provides text-to-image, single-reference Character
generation and source-only edits. Its batch limit is four, preserving capacity
from the retired Premium image option. The Premium and duplicate
`image-redcraft-qw21t` choices are archived. Multi-reference and explicit edit
profiles use the same physical model with their existing pricing and access
policy. The default canvas remains 832×1024.

Fresh databases use seed; existing databases publish immutable new versions with
[`2026-10-23-unify-redcraft-image-model.sql`](../../db/sql/2026-10-23-unify-redcraft-image-model.sql)
after quiescing admission and workers through the repository PM2 wrapper. The
cutover refuses pending affected jobs and conflicting configuration, and leaves
historical Jobs, Attempts, delivered assets and ledger entries unchanged.

This binds RedCraft model958009/version3407259/file3299030, the exact INT8
asset already installed as `fineview_qw21_turbo_fixed_int8.safetensors`:
SHA256 `712b44d2a79b30ed1aa11f19fc4e2cd0f1f46a43dc3bde5d6fe2a07e36b68f0f`.
FineView and this RedCraft version publish the same bytes. It uses the
TextureFix BF16 VAE, the existing ConvRot INT8 encoder on MPS, and
`IDreamQwen21ResidentWeights` to materialize exact BF16 diffusion weights once.
Keep enough unified memory for the roughly 13.3 GiB resident diffusion model
and its cached INT8 source, encoder, activations and VAE; this is not native
INT8 Metal execution.

Resident Qwen graphs also keep one complete, lossless prefix KV entry across
requests. Repeating the exact prompt/reference/geometry can reuse it with a
different seed; changed inputs, model options or weights invalidate it. A real
model unload frees the entry. The measured 1 MP references add roughly 2.1 GiB
of retained unified memory. First requests and new prompts do not receive this
cache-hit benefit. See the [M4 optimization comparison](../../docs/research/REDCRAFT_M4_OPTIMIZATION_2026-10-16.md)
for timings, pixel-exact controls and MPS memory-release evidence.

The descriptor uses six-step `er_sde/simple`, AuraFlow shift 1.31, CFG1 and
denoise 1, without an extra Viggle LoRA or second sampler. This is the measured
six-step variant of the author's eight-step first pass. Workflow v3 and the
new profile versions archive the earlier parameters without rewriting Jobs or
Attempts; publication refuses pending affected Jobs.
Preflight pins diffusion/encoder/VAE bytes and required runtime nodes. Smoke
uses the descriptor's six-step default unless `--steps` is supplied:

```bash
bun run --filter @idream/gen smoke:backend --model redcraft-qw21t --out /tmp/redcraft-text.png
bun run --filter @idream/gen smoke:backend --model redcraft-qw21t --ref /absolute/path/adult-reference.png --ref-role identity_anchor --out /tmp/redcraft-edit.png
```

[Initial integration evidence](../../docs/research/REDCRAFT_QW21T_INTEGRATION_2026-10-16.md)
records the historical eight-step recipe and comparison with REDQW21.
The [six-versus-eight benchmark](../../docs/research/REDCRAFT_SIX_VS_EIGHT_2026-10-21.md)
found a median 29.25% paired latency reduction with no clear visual regression
in eight controlled pairs. The user selected RedCraft/FineView as default on
2026-10-21. This does not establish superiority over REDQW21 for every use case;
NSFW remains untested in that comparison.

The image PM2 definition pins Python from its Qwen21 installation;
`bun run comfyui:restart` reloads that definition. Earlier REDQW21/Viggle
implementation and timing records remain historical evidence, not current
runtime configuration. See [the previous implementation record](../../docs/research/QWEN21_MAC_ACCELERATION_IMPLEMENTATION_2026-10-01.md).

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
  --model redcraft-image-edit \
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
default output: 448x768 (7:12 portrait, 480p tier), 121 frames / 5.042 seconds, 24 fps, MP4 with audio
default video options: orientation=7:12, quality=preview

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

RedGraft workflow v5 uses `IDreamMPSGraphAttention` in explicit BF16 mode on
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

`db/sql/2026-10-05-redgraft-480p.sql` publishes the current default as immutable
profile v8/v9 and workflow v5 after admission/worker quiescence. The new 7:12
preview option is 448×768; its standard option is 896×1536. Explicit 2:3 and
1:1 choices retain their previous sizes. Old profiles and job pins remain
unchanged. The single native 448×768 sample took 210.574 seconds of ComfyUI
execution on M4 Max; resource waiting is recorded separately. See
[the 480p validation](../../docs/research/REDGRAFT_LTX25_480P_VALIDATION_2026-10-05.md).

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

**Checkpoint format:** use the exact format and bytes pinned by the selected
workflow descriptor and checked by `preflight`. Current image routes pin the
FineView INT8 checkpoint and materialize exact BF16 resident weights on MPS. For a route requiring FP8 runtime
handling, follow the MPS patch setup above. Do not convert or rename weights
outside that artifact contract. For offline conversion, distinguish
scaled FP8 (`weight * weight_scale`) from plain FP8; see the dated
[format conversion record](../../docs/superpowers/specs/2026-07-07-image-generation-redesign-design.md#格式转换).
