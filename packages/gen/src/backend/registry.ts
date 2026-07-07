// SPEC: BackendRegistry — indexes workflow descriptors by modelId and resolves each
// modelId to the (already-constructed) GenBackend instance for its declared
// backendKind. One long-lived backend instance per kind (comfyui/sdcpp), shared
// across every model that routes through it.
// INTENT: Keep backend selection data-driven — adding a new model is "drop a
// workflow descriptor JSON in the workflow dir", not "write new wiring code".
// INVARIANTS: resolveForModel throws a clear error for a modelId with no matching
// descriptor (caller maps this to a non-retryable "unknown_model" failure).
import { ComfyUIBackend } from "./comfyui";
import { SdcppBackend } from "./sdcpp";
import { loadWorkflowDescriptors, type WorkflowDescriptor } from "./workflow";
import type { GenBackend } from "./types";

export interface BackendRegistry {
  resolveForModel(modelId: string): { backend: GenBackend; descriptor: WorkflowDescriptor };
}

export async function buildBackendRegistry(opts: {
  comfyApiUrl: string;
  sdcppCli: string;
  workflowDir: string;
}): Promise<BackendRegistry> {
  const descriptors = await loadWorkflowDescriptors(opts.workflowDir);
  const byModelId = new Map<string, WorkflowDescriptor>();
  for (const descriptor of descriptors) {
    byModelId.set(descriptor.modelId, descriptor);
  }

  const backends: Record<WorkflowDescriptor["backendKind"], GenBackend> = {
    comfyui: new ComfyUIBackend({ apiUrl: opts.comfyApiUrl }),
    sdcpp: new SdcppBackend({ cli: opts.sdcppCli }),
  };

  return {
    resolveForModel(modelId: string) {
      const descriptor = byModelId.get(modelId);
      if (!descriptor) {
        throw new Error(`buildBackendRegistry: unknown modelId "${modelId}" (no workflow descriptor found)`);
      }
      return { backend: backends[descriptor.backendKind], descriptor };
    },
  };
}
