// SPEC: workflow 描述符目录的读取权威 —— 从磁盘加载 packages/gen 的 workflow 描述符 JSON，
// 供生成链路（attempt-dispatch / generation-attempt-authority / ourdream 报价）与 admin
// 只读页面共用同一份解析结果。
// INTENT: main 不依赖 packages/gen（两者只通过 Redis 队列耦合），这里独立读取同一份描述符
// JSON（shared 的 loadWorkflowDescriptors）与同样的 env 默认值（GEN_WORKFLOW_DIR，口径对齐
// packages/gen/src/env.ts），保持配置语义一致但零运行时耦合。60s 进程内缓存：描述符文件是
// 工程 seed，低频变更，不值得每次请求都扫目录。
// INVARIANT: 本模块只做「读磁盘 + 解析 + 缓存」，不含任何 HTTP 层原语（ok()/actorWithPermission）。
// 只读 admin API（generation/backends、generation/workflows）住在
// modules/admin/generation/backends-and-workflows.ts —— 依赖方向单向为
// modules/admin → modules/generation。
import { existsSync } from "node:fs";
import path from "node:path";
import { loadWorkflowDescriptors, type WorkflowDescriptor } from "@idream/shared/gen-workflow";

const DESCRIPTOR_CACHE_TTL_MS = 60_000;

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

// SPEC: 全量描述符列表（admin 只读目录页用）。所有导出共用这一份 60s 缓存，不重复扫目录。
export async function listWorkflowDescriptors(): Promise<WorkflowDescriptor[]> {
  const now = Date.now();
  if (descriptorCache && now - descriptorCache.at < DESCRIPTOR_CACHE_TTL_MS) {
    return descriptorCache.items;
  }
  const items = await loadWorkflowDescriptors(resolveWorkflowDir());
  descriptorCache = { at: now, items };
  return items;
}

// SPEC: P2 Task 7 —— admin profile create/patch 校验 GenerationModelProfile.workflowKey
// 是否为已知 workflow 描述符。只暴露布尔判断，不把内部数组结构泄漏给调用方。
export async function workflowKeyExists(workflowKey: string): Promise<boolean> {
  const items = await listWorkflowDescriptors();
  return items.some((item) => item.workflowKey === workflowKey);
}

export async function generationWorkflowDescriptor(
  workflowKey: string,
): Promise<WorkflowDescriptor | null> {
  const items = await listWorkflowDescriptors();
  return items.find((item) => item.workflowKey === workflowKey) ?? null;
}
