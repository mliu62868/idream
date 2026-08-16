// SPEC: read-only engineering diagnostics — the generation backends (ComfyUI / Draw Things)
//       with a live reachability probe, and the workflow descriptor catalogue.
// INTENT: migrated from v1 `generation/backends-and-workflows.ts`. This is only the HTTP face:
//         how a descriptor is found, parsed, and cached stays in
//         `modules/generation/generation-catalog.ts`, the same authority the generation path
//         reads, so the dependency runs one way only.
// INVARIANT: the workflow list never carries `apiPrompt` — it is large and internal, and only
//            the detail route expands it for engineering triage.
import { resolveExecutable } from "@idream/shared";
import type { WorkflowDescriptor } from "@idream/shared/gen-workflow";
import { Errors } from "@/server/lib/errors";
import { listWorkflowDescriptors } from "@/server/modules/generation/generation-catalog";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

// A readiness probe for a diagnostics panel, not a generation request: it gets a fixed short
// timeout rather than borrowing the pipeline's minute-scale one.
const HEALTH_TIMEOUT_MS = 3_000;

type BackendHealth = { ok: boolean; detail?: string; latencyMs?: number };

async function comfyuiHealth(endpoint: string): Promise<BackendHealth> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${endpoint}/system_stats`, { signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false, detail: `ComfyUI /system_stats HTTP ${response.status}`, latencyMs };
    }
    return { ok: true, latencyMs };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      detail: aborted
        ? `ComfyUI /system_stats timed out after ${HEALTH_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function executableHealth(command: string): Promise<BackendHealth> {
  try {
    await resolveExecutable(command);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// INVARIANT: env is read inside the handler, never as a module constant, so a test can set
// COMFYUI_API_URL / DRAWTHINGS_CLI after importing this module.
export async function listGenerationBackends(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const comfyuiEndpoint = process.env.COMFYUI_API_URL ?? "http://127.0.0.1:8188";
  const drawThingsCli = process.env.DRAWTHINGS_CLI ?? "draw-things-cli";
  const drawThingsModelsDir = process.env.DRAWTHINGS_MODELS_DIR;
  const [comfyui, drawthings] = await Promise.all([
    comfyuiHealth(comfyuiEndpoint),
    executableHealth(drawThingsCli),
  ]);
  return {
    items: [
      { id: "comfyui", kind: "comfyui", endpoint: comfyuiEndpoint, health: comfyui },
      {
        id: "drawthings",
        kind: "drawthings",
        cliPath: drawThingsCli,
        ...(drawThingsModelsDir ? { modelsDir: drawThingsModelsDir } : {}),
        health: drawthings,
      },
    ],
  };
}

function workflowSummary(descriptor: WorkflowDescriptor) {
  const { workflowKey, modelId, backendKind, version, capabilities, inputs } = descriptor;
  return { workflowKey, modelId, backendKind, version, capabilities, inputs };
}

export async function listGenerationWorkflows(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  return { items: (await listWorkflowDescriptors()).map(workflowSummary) };
}

export async function getGenerationWorkflow(request: Request, workflowKey: string) {
  await actorWithPermission(request, "generation.config.read");
  const descriptor = (await listWorkflowDescriptors()).find(
    (item) => item.workflowKey === workflowKey,
  );
  if (!descriptor) throw Errors.notFound("Unknown workflowKey");
  return { workflow: descriptor };
}
