// SPEC: 只读 admin API —— GET generation/backends（comfyui/drawthings + 健康探测）与
// GET generation/workflows[/:workflowKey]（workflow 描述符目录只读展示，供工程排查）。
// INTENT: 这里只是 HTTP 面：鉴权 + 探活 + 响应投影。描述符怎么找、怎么解析、怎么缓存归
// modules/generation/generation-catalog.ts（生成链路同一份权威），依赖方向单向为
// modules/admin → modules/generation。backends 的 env 默认值口径对齐
// packages/gen/src/env.ts（COMFYUI_API_URL/DRAWTHINGS_CLI），保持配置语义一致但零运行时耦合。
// INVARIANTS: 全部只读、全部要求 generation.config.read；workflows 列表摘要绝不包含
// apiPrompt（体积大且是内部实现细节，只在 detail 端点展开供工程排查）。
import { resolveExecutable } from "@idream/shared";
import type { WorkflowDescriptor } from "@idream/shared/gen-workflow";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/shared/legacy-primitives";
import { listWorkflowDescriptors } from "@/server/modules/generation/generation-catalog";

const CONFIG_READ = "generation.config.read" as const;
// health() 是就绪探测（诊断面板轮询），不是生成请求 —— 用固定短超时，不借用生成任务的
// PIPELINE_TIMEOUT_MS（那个是分钟级，会让一次探针请求悬挂太久）。
const HEALTH_TIMEOUT_MS = 3_000;

type BackendHealth = { ok: boolean; detail?: string; latencyMs?: number };

// ---------------------------------------------------------------------------
// GET generation/backends
// ---------------------------------------------------------------------------

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

// INVARIANT: env 读取放在 handler 内部（不是 module 顶层常量），测试才能按用例覆盖
// COMFYUI_API_URL/DRAWTHINGS_CLI 后照常 import 生效。
export async function listGenerationBackends(request: Request): Promise<Response> {
  await actorWithPermission(request, CONFIG_READ);
  const comfyuiEndpoint = process.env.COMFYUI_API_URL ?? "http://127.0.0.1:8188";
  const drawThingsCli = process.env.DRAWTHINGS_CLI ?? "draw-things-cli";
  const drawThingsModelsDir = process.env.DRAWTHINGS_MODELS_DIR;
  const [comfyui, drawthings] = await Promise.all([
    comfyuiHealth(comfyuiEndpoint),
    executableHealth(drawThingsCli),
  ]);
  return ok({
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
  });
}

// ---------------------------------------------------------------------------
// GET generation/workflows[/:workflowKey]
// ---------------------------------------------------------------------------

type WorkflowSummary = Pick<
  WorkflowDescriptor,
  "workflowKey" | "modelId" | "backendKind" | "version" | "capabilities" | "inputs"
>;

function toSummary(descriptor: WorkflowDescriptor): WorkflowSummary {
  const { workflowKey, modelId, backendKind, version, capabilities, inputs } = descriptor;
  return { workflowKey, modelId, backendKind, version, capabilities, inputs };
}

export async function listGenerationWorkflows(request: Request): Promise<Response> {
  await actorWithPermission(request, CONFIG_READ);
  const items = (await listWorkflowDescriptors()).map(toSummary);
  return ok({ items });
}

export async function getGenerationWorkflow(request: Request, workflowKey: string): Promise<Response> {
  await actorWithPermission(request, CONFIG_READ);
  const descriptor = (await listWorkflowDescriptors()).find(
    (item) => item.workflowKey === workflowKey,
  );
  if (!descriptor) throw Errors.notFound("Unknown workflowKey");
  return ok({ workflow: descriptor });
}
