// SPEC: BackendRegistry — indexes workflow descriptors by EITHER descriptor.modelId
// OR descriptor.workflowKey (dual index into one map) and resolves either key to the
// (already-constructed) GenBackend instance for its declared backendKind. One
// long-lived backend instance per kind (comfyui/drawthings), shared across every
// model that routes through it.
// INTENT: Keep backend selection data-driven — adding a new model is "drop a
// workflow descriptor JSON in the workflow dir", not "write new wiring code". The
// dual index is the precondition for main routing jobs via
// GenerationModelProfile.workflowKey: payload.model may carry either a modelId or a
// workflowKey and gen must resolve both the same way.
// INVARIANTS: resolveForModel throws a clear error for a key with no matching
// descriptor (caller maps this to a non-retryable "unknown_model" failure). Build
// time rejects with a "duplicate registry key" error if a modelId or workflowKey
// collides with a *different* descriptor's key — a descriptor whose own
// workflowKey equals its own modelId is not a collision.
import { ComfyUIBackend } from "./comfyui";
import { DrawThingsBackend } from "./drawthings";
import { loadWorkflowDescriptors, type WorkflowDescriptor } from "./workflow";
import type { GenBackend } from "./types";
import { logger } from "../logger";

export interface BackendRegistry {
  resolveForModel(key: string): { backend: GenBackend; descriptor: WorkflowDescriptor };
}

export async function buildBackendRegistry(opts: {
  comfyApiUrl: string;
  drawThingsCli?: string;
  drawThingsModelsDir?: string;
  drawThingsOffline?: boolean;
  workflowDir: string;
}): Promise<BackendRegistry> {
  const descriptors = await loadWorkflowDescriptors(opts.workflowDir, {
    onSkip: (file, err) => logger.warn({ file, err }, "skipping invalid workflow descriptor"),
  });

  // Single map for both namespaces: insert all modelIds first, then all
  // workflowKeys. A key that already points at a *different* descriptor is a
  // build-time configuration error, not a runtime one — fail fast.
  const byKey = new Map<string, WorkflowDescriptor>();
  const index = (key: string, descriptor: WorkflowDescriptor) => {
    const existing = byKey.get(key);
    if (existing && existing !== descriptor) {
      throw new Error(`duplicate registry key: ${key}`);
    }
    byKey.set(key, descriptor);
  };
  for (const descriptor of descriptors) {
    index(descriptor.modelId, descriptor);
  }
  for (const descriptor of descriptors) {
    index(descriptor.workflowKey, descriptor);
  }

  const backends: Record<WorkflowDescriptor["backendKind"], GenBackend> = {
    comfyui: new ComfyUIBackend({ apiUrl: opts.comfyApiUrl }),
    drawthings: new DrawThingsBackend({
      cli: opts.drawThingsCli ?? "draw-things-cli",
      modelsDir: opts.drawThingsModelsDir,
      offline: opts.drawThingsOffline,
    }),
  };

  return {
    resolveForModel(key: string) {
      const descriptor = byKey.get(key);
      if (!descriptor) {
        throw new Error(`buildBackendRegistry: unknown modelId "${key}" (no workflow descriptor found)`);
      }
      return { backend: backends[descriptor.backendKind], descriptor };
    },
  };
}

// SPEC: the ONE authority that decides which backend executes an attempt is
// `resolveForModel(payload.model).descriptor` — its backendKind picks the
// GenBackend and its graph/argv define the run. This function is the matching
// admission check: Main pins `workflowKey@workflowVersion` into controls when it
// reserves the Attempt, and the worker refuses to execute anything else.
// INTENT: shared verbatim by BackendImageModel and BackendVideoModel. The two
// modalities previously carried byte-identical copies that differed only in an
// image-side escape hatch for "no pin supplied at all"; that hatch let an image
// attempt run against whatever descriptor the model id happened to resolve to,
// with no version agreement between Main and the worker. Both modalities now
// fail closed, so a descriptor edit that Main has not seen cannot be executed
// under a stale pin.
// INVARIANT: an unpinned attempt is a mismatch, not a pass.
export function validateWorkflowPin(
  descriptor: WorkflowDescriptor,
  controls: Record<string, unknown> | undefined,
) {
  const workflowKey = controls?.workflowKey;
  const workflowVersion = controls?.workflowVersion;
  if (
    workflowKey !== descriptor.workflowKey ||
    workflowVersion !== descriptor.version
  ) {
    return `Pinned workflow ${String(workflowKey)}@${String(workflowVersion)} does not match worker descriptor ${descriptor.workflowKey}@${descriptor.version}`;
  }
  return null;
}
