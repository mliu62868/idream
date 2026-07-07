# @idream/gen

Generation Service — image + video. Slow async workers: payload self-contained,
write blob only, no DB authority. Finalize happens main-side via
`app.ai.finalize` → gen-finalizer.

## Backend abstraction (`IMAGE_PROVIDER=backend`)

`providers.image` (see `src/providers.ts`) supports a `backend` provider that
talks directly to a local generation backend instead of an external
OpenAI-compatible pipeline gateway:

- **`GenBackend`** (`src/backend/types.ts`) — a small `submit`/`poll`/`health`
  contract implemented per backend kind: `ComfyUIBackend` (`src/backend/comfyui.ts`,
  drives ComfyUI's native `/prompt` → `/history` → `/view` HTTP API) and
  `SdcppBackend` (`src/backend/sdcpp.ts`, shells out to the `sd-cli` binary).
- **Workflow descriptors** (`src/backend/workflow.ts`, JSON files under
  `packages/gen/workflows/`) declare a ComfyUI `apiPrompt` graph plus a list of
  named input slots (`prompt`, `width`, `height`, `seed`, `steps`, ...), each
  bound to either a `{nodeId, field}` in the graph or a CLI `argFlag`. Adding a
  new model is "drop a descriptor JSON," not "write new wiring code."
- **`BackendRegistry`** (`src/backend/registry.ts`) loads every descriptor from
  `GEN_WORKFLOW_DIR`, indexes them by `modelId`, and resolves each to its
  backend instance.
- **`BackendImageModel`** (`src/backend/backend-image-model.ts`) is the
  `ImageModel` adapter: it resolves `input.model` through the registry, maps
  `orientation`/`controls` to slot values, and loops submit→poll once per
  requested image.

### Pointing at a local ComfyUI

Set `COMFYUI_API_URL` (default `http://127.0.0.1:8188`) to your running ComfyUI
instance's native API, and `IMAGE_PROVIDER=backend` (or `GEN_IMAGE_PROVIDER=backend`,
which takes priority — see `.env`'s `GEN_IMAGE_PROVIDER`) to route
`providers.image` through it. `GEN_WORKFLOW_DIR` defaults to
`packages/gen/workflows` (repo-root relative); the smoke script below resolves
it explicitly so it works regardless of cwd.

### Running the backend smoke

`src/backend/smoke.ts` drives `providers.image.generate()` for the
`redcraft-krea2-comfyui` workflow against a live ComfyUI, asserts the returned
PNG passes `assertGeneratedImageSanity`, and writes it to a temp path (or
`--out <path>`). It is manual-only — not part of `vitest run` — since it
requires a real ComfyUI server:

```bash
cd packages/gen
IMAGE_PROVIDER=backend COMFYUI_API_URL=http://127.0.0.1:8188 bun run smoke:backend -- --out /tmp/backend-smoke.png
```

The first generation on a cold ComfyUI process loads a ~24GB bf16 checkpoint
into memory and can take a few minutes; subsequent runs are much faster once
the model is resident.

**fp8 → bf16 note:** on Apple Silicon (MPS), fp8-quantized checkpoints are not
supported — they must be dequantized to bf16 before ComfyUI can load them on
MPS. See `docs/superpowers/specs/2026-07-07-image-generation-redesign-design.md`
§4.2b for the conversion approach (per-tensor `weight * weight_scale` dequant);
the workflow descriptors in `packages/gen/workflows/` already point at the
converted bf16 filenames.
