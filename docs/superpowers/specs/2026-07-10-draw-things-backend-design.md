# Draw Things generation backend

## Decision

Support Draw Things as an optional `GenBackend` adapter behind
`GEN_IMAGE_PROVIDER=backend`. Do not add a fourth global image-provider path and
do not make the Draw Things GUI HTTP server a production dependency.

The first transport is the official `draw-things-cli`. The adapter may later run
the same CLI with its remote gRPC flags without changing callers.

## Module and seam

The existing `GenBackend` interface is the seam:

```ts
interface GenBackend {
  readonly id: string;
  readonly kind: "comfyui" | "sdcpp" | "drawthings";
  capabilities(): Capabilities;
  submit(job: ResolvedGenJob): Promise<BackendHandle>;
  poll(handle: BackendHandle): Promise<BackendResult>;
  health(): Promise<BackendHealth>;
}
```

`DrawThingsBackend` is a deep module behind that interface. It owns command
construction, model-directory selection, source-image materialization, process
timeouts, bounded logs, output validation, temporary-file cleanup, and health
checks. `BackendImageModel`, the queue pipeline, blob persistence, finalization,
pricing, and callers remain unchanged.

## Workflow descriptor

Workflow descriptors become a discriminated union by `backendKind`:

- `comfyui` requires `apiPrompt`.
- `sdcpp` uses argument-bound inputs.
- `drawthings` requires `drawThings.model` and uses argument-bound inputs.

This removes the current requirement for non-Comfy backends to carry a dummy
`apiPrompt: {}` while preserving the existing descriptor files.

The initial Draw Things workflow is opt-in and uses a unique model id. Existing
profiles therefore do not change backend until their `workflowKey` or
`pipelineModel` explicitly selects it.

## Draw Things CLI contract

For each requested image the adapter runs one command:

```text
draw-things-cli generate
  --model <workflow model>
  --prompt <prompt>
  --negative-prompt <negative>
  --width <width>
  --height <height>
  --seed <seed>
  --steps <steps>
  [--image <materialized source image> --strength <strength>]
  [--models-dir <directory>]
  --no-download-missing --offline
  --output <temporary png>
```

The adapter runs offline by default. Operators can explicitly allow network
access through configuration. One backend invocation produces one PNG;
`BackendImageModel` keeps ownership of count/batch semantics.

## Reference-image contract

Version 1 accepts at most one `source_image`. Identity anchors and identity
references are rejected by the workflow identity contract. The source image may
arrive as base64 or a fetchable URL and is deleted after the command exits.

## Configuration

- `DRAWTHINGS_CLI` — executable path or command name; defaults to
  `draw-things-cli`.
- `DRAWTHINGS_MODELS_DIR` — optional model directory. On macOS, omission lets
  the CLI use the Draw Things app model directory.
- `DRAWTHINGS_OFFLINE` — defaults to `true`.
- `GEN_IMAGE_INSTANCES` — PM2 image-worker process count. Set it to `1` for a
  Draw Things deployment that must load only one model process at a time.

## Operational behavior

- The adapter serializes CLI generation within each image-worker process because
  every child may load a large model. Set `GEN_IMAGE_INSTANCES=1` for strict
  host-wide serialization; multiple PM2 workers intentionally provide parallelism.
- A timeout aborts the child process and is retryable through the existing
  `BackendImageModel` error mapping.
- stdout/stderr are bounded before inclusion in errors.
- Health resolves the executable through an explicit path or `PATH` and checks
  that it is executable; it does not generate an image.

## Test seams

Tests exercise only confirmed public interfaces:

1. `workflowDescriptorSchema` accepts Draw Things descriptors and keeps
   ComfyUI-specific requirements.
2. `DrawThingsBackend.submit/poll/health` verifies argv, output, source-image
   handling, errors, cleanup, and executable discovery.
3. `buildBackendRegistry` resolves Draw Things by model id and workflow key.
4. Admin generation-catalog handlers expose Draw Things health alongside the
   existing backends.

## Acceptance

- Existing ComfyUI and sd.cpp tests remain green.
- A Draw Things descriptor can be selected without changing queue/finalizer
  contracts.
- Text-to-image and one-source img2img return sane PNG bytes and dimensions.
- Missing CLI, non-zero exit, timeout, and unsupported references produce clear
  failures.
- Gen/shared/main typechecks and the repository check pass.
