// SPEC: Today 首屏的服务健康 —— 聊天、图片、视频三条产品链路各给一个 ok / degraded / down。
// INTENT: 探活只回答「进程在不在」；进程在但请求一直失败（模型坏、工作流坏）只能从真实请求
//         的成败看出来，所以两者都要。口径是全部数据类：这是服务信号，不是客户口径的业务数。
// INVARIANT: 只读；探活沿用各自诊断面的实现与超时，不另起一套判定。
import { prisma } from "@/server/lib/db";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { chatOpsProviderHealth } from "@/server/modules/admin-v2/chat/operations";
import { generationBackendHealth } from "@/server/modules/admin-v2/generation/diagnostics";

const HOUR_MS = 60 * 60 * 1000;
// 一小时里至少这么多次请求才谈得上失败率；少于它时一两次偶发失败不应把首屏染红。
const MIN_ATTEMPTS_FOR_RATE = 3;
const DEGRADED_FAILURE_RATE = 0.2;

type ServiceKey = "chat" | "image" | "video";

export function serviceState(input: { probeOk: boolean; attempts: number; failures: number }) {
  if (!input.probeOk) return "down" as const;
  if (input.attempts >= MIN_ATTEMPTS_FOR_RATE && input.failures / input.attempts >= DEGRADED_FAILURE_RATE) {
    return "degraded" as const;
  }
  return "ok" as const;
}

export async function getOpsHealth(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const since = new Date(Date.now() - HOUR_MS);
  const [chat, image, video, chatAttempts, chatFailures, jobs] = await Promise.all([
    chatOpsProviderHealth(request),
    generationBackendHealth("comfyui", "image"),
    generationBackendHealth("comfyui", "video"),
    prisma.chatTurn.count({ where: { terminalAt: { gte: since }, assistantStatus: { in: ["sent", "failed"] } } }),
    prisma.chatTurn.count({ where: { terminalAt: { gte: since }, assistantStatus: "failed" } }),
    prisma.generationJob.groupBy({
      by: ["mode", "status"],
      where: { finishedAt: { gte: since }, status: { in: ["completed", "failed"] } },
      _count: { _all: true },
    }),
  ]);
  const chatItem = chat.items.find((item) => item.provider === "chat_model");
  const counts = (mode: string) => {
    const rows = jobs.filter((row) => row.mode === mode);
    return {
      attempts: rows.reduce((sum, row) => sum + row._count._all, 0),
      failures: rows.filter((row) => row.status === "failed").reduce((sum, row) => sum + row._count._all, 0),
    };
  };
  const service = (key: ServiceKey, probeOk: boolean, detail: string | null, attempts: number, failures: number) => ({
    key,
    state: serviceState({ probeOk, attempts, failures }),
    probeOk,
    detail,
    attemptsLastHour: attempts,
    failuresLastHour: failures,
  });
  const imageCounts = counts("image");
  const videoCounts = counts("video");
  return {
    checkedAt: new Date().toISOString(),
    services: [
      service("chat", chatItem?.ok === true, chatItem ? chatItem.error : chat.configured ? "chat_runtime_unreachable" : "chat_service_not_configured", chatAttempts, chatFailures),
      service("image", image.ok, image.detail ?? null, imageCounts.attempts, imageCounts.failures),
      service("video", video.ok, video.detail ?? null, videoCounts.attempts, videoCounts.failures),
    ],
  };
}
