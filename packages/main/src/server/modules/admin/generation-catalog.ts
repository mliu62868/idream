// SPEC: 只读 admin API —— GET generation/backends（comfyui/sdcpp 端点 + 健康探测）与
// GET generation/workflows[/:workflowKey]（workflow 描述符目录只读展示，供工程排查）。
// INTENT: main 不依赖 packages/gen（两者只通过 Redis 队列耦合），这里独立读取同一份
// workflow 描述符 JSON（shared 的 loadWorkflowDescriptors）与同样的 env 默认值
// （COMFYUI_API_URL/SDCPP_CLI/GEN_WORKFLOW_DIR，口径对齐 packages/gen/src/env.ts），
// 保持配置语义一致但零运行时耦合。60s 进程内缓存：描述符文件是工程 seed，低频变更，
// 不值得每次请求都扫目录。
// INVARIANTS: 全部只读、全部要求 generation.config.read；workflows 列表摘要绝不包含
// apiPrompt（体积大且是内部实现细节，只在 detail 端点展开供工程排查）。
import { constants as fsConstants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadWorkflowDescriptors, type WorkflowDescriptor } from "@idream/shared/gen-workflow";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/service";

const CONFIG_READ = "generation.config.read" as const;
// health() 是就绪探测（诊断面板轮询），不是生成请求 —— 用固定短超时，不借用生成任务的
// PIPELINE_TIMEOUT_MS（那个是分钟级，会让一次探针请求悬挂太久）。
const HEALTH_TIMEOUT_MS = 3_000;
const DESCRIPTOR_CACHE_TTL_MS = 60_000;

type BackendHealth = { ok: boolean; detail?: string; latencyMs?: number };

// SPEC: 目录解析顺序 —— 显式 env 优先；否则按「仓库根 cwd」「packages/main cwd」依次探测
// 第一个真实存在的候选目录。两个候选分别对应「从仓库根跑（turbo/pm2）」与「cd
// packages/main 跑（vitest/独立 next dev）」这两种本仓库实际会用到的 cwd。
function resolveWorkflowDir(): string {
  const fromEnv = process.env.GEN_WORKFLOW_DIR;
  if (fromEnv) return fromEnv;
  const candidates = [
    path.resolve(process.cwd(), "packages/gen/workflows"),
    path.resolve(process.cwd(), "..", "gen", "workflows"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `generation-catalog: could not resolve workflow descriptor dir (set GEN_WORKFLOW_DIR, or run with cwd at repo root or packages/main) — tried: ${candidates.join(", ")}`,
    );
  }
  return found;
}

let descriptorCache: { at: number; items: WorkflowDescriptor[] } | null = null;

async function cachedDescriptors(): Promise<WorkflowDescriptor[]> {
  const now = Date.now();
  if (descriptorCache && now - descriptorCache.at < DESCRIPTOR_CACHE_TTL_MS) {
    return descriptorCache.items;
  }
  const items = await loadWorkflowDescriptors(resolveWorkflowDir());
  descriptorCache = { at: now, items };
  return items;
}

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

async function sdcppHealth(cliPath: string): Promise<BackendHealth> {
  try {
    await access(cliPath, fsConstants.X_OK);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// INVARIANT: env 读取放在 handler 内部（不是 module 顶层常量），测试才能按用例覆盖
// COMFYUI_API_URL/SDCPP_CLI 后照常 import 生效。
export async function listGenerationBackends(request: Request): Promise<Response> {
  await actorWithPermission(request, CONFIG_READ);
  const comfyuiEndpoint = process.env.COMFYUI_API_URL ?? "http://127.0.0.1:8188";
  const sdcppCli = process.env.SDCPP_CLI ?? path.join(os.homedir(), "bin", "sd-cli");
  const [comfyui, sdcpp] = await Promise.all([
    comfyuiHealth(comfyuiEndpoint),
    sdcppHealth(sdcppCli),
  ]);
  return ok({
    items: [
      { id: "comfyui", kind: "comfyui", endpoint: comfyuiEndpoint, health: comfyui },
      { id: "sdcpp", kind: "sdcpp", cliPath: sdcppCli, health: sdcpp },
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
  const items = (await cachedDescriptors()).map(toSummary);
  return ok({ items });
}

export async function getGenerationWorkflow(request: Request, workflowKey: string): Promise<Response> {
  await actorWithPermission(request, CONFIG_READ);
  const descriptor = (await cachedDescriptors()).find((item) => item.workflowKey === workflowKey);
  if (!descriptor) throw Errors.notFound("Unknown workflowKey");
  return ok({ workflow: descriptor });
}
