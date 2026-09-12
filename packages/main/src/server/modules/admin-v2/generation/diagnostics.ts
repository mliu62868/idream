// SPEC: read-only engineering diagnostics — the generation backends (ComfyUI / Draw Things)
//       with a live reachability probe, and the workflow descriptor catalogue.
// INTENT: migrated from v1 `generation/backends-and-workflows.ts`. This is only the HTTP face:
//         how a descriptor is found, parsed, and cached stays in
//         `modules/generation/generation-catalog.ts`, the same authority the generation path
//         reads, so the dependency runs one way only.
// INVARIANT: the workflow list never carries `apiPrompt` — it is large and internal, and only
//            the detail route expands it for engineering triage.
import { resolveExecutable } from "@idream/shared";
import { comfyUiEndpoint, type ComfyUiModality } from "@idream/shared/env";
import type { WorkflowDescriptor } from "@idream/shared/gen-workflow";
import { Errors } from "@/server/lib/errors";
import { listWorkflowDescriptors } from "@/server/modules/generation/generation-catalog";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

// A readiness probe for a diagnostics panel, not a generation request: it gets a fixed short
// timeout rather than borrowing the pipeline's minute-scale one.
const HEALTH_TIMEOUT_MS = 3_000;

export type BackendHealth = { ok: boolean; detail?: string; latencyMs?: number };

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

// SPEC: 当前请求真正依赖的生成后端就绪度；写入口用它在创建任何权威记录前失败关闭。
//
// INTENT: `modality` 是必填的。此前这里固定读 `COMFYUI_API_URL ?? 8188` —— 那是
// video 的监听端口，而唯一的写入口调用方是角色身份图（image，8189）。真实部署把
// image 和 video 跑成两个进程并配置 `COMFYUI_IMAGE_API_URL` /
// `COMFYUI_VIDEO_API_URL`，此时 `COMFYUI_API_URL` 往往没设，于是这次「失败关闭」
// 检查的是另一台机器的健康。端点解析改走 `comfyUiEndpoint` 之后，模态就不能再
// 靠默认值猜。
export function generationBackendHealth(
  backendKind: string,
  modality: ComfyUiModality,
): Promise<BackendHealth> {
  if (backendKind === "comfyui") {
    return comfyuiHealth(comfyUiEndpoint(process.env, modality));
  }
  if (backendKind === "drawthings") {
    return executableHealth(
      process.env.DRAWTHINGS_CLI ?? "draw-things-cli",
    );
  }
  return Promise.resolve({
    ok: false,
    detail: `Unknown generation backend: ${backendKind}`,
  });
}

// INVARIANT: env is read inside the handler, never as a module constant, so a test can set
// COMFYUI_API_URL / DRAWTHINGS_CLI after importing this module.
export async function listGenerationBackends(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  // 后台这张表是图片生成诊断面；视频有自己的 readiness 检查。
  const comfyuiEndpoint = comfyUiEndpoint(process.env, "image");
  const drawThingsCli = process.env.DRAWTHINGS_CLI ?? "draw-things-cli";
  const drawThingsModelsDir = process.env.DRAWTHINGS_MODELS_DIR;
  const [comfyui, drawthings] = await Promise.all([
    generationBackendHealth("comfyui", "image"),
    generationBackendHealth("drawthings", "image"),
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
