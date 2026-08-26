// SPEC: 「这个事故上，某个缓解动作到底有没有可作用的对象」的唯一判据。
// INTENT: 这两个函数原来私有在 incidents/service.ts 里，只有预览路径用得到；
//         而 incidents/query.ts 给运营展示的 `recommendedActions` 是建事故时写死的常量
//         （service.ts 里那行 `recommendedActions: ["retry_eligible", "pause_route"]`），
//         从不看事故自己的事实。实测事故 cmt6zba3h… 的两条 occurrence 对应的 Attempt 都是
//         `unknown / not_retryable / ambiguous_non_replayable`——正因为结果不确定，重放可能
//         二次扣费或二次交付，所以被明确判定为不可重试。控制台却照样写着「推荐：retry eligible」，
//         点下去只得到一句干巴巴的 400 "Incident action has no eligible occurrences"。
//         把判据抽出来共用，是为了让展示与执行只有一个权威，不会再各说各话。

import type { Prisma } from "@prisma/client";
// import type：仅类型引用，编译后擦除，不会和 service.ts 形成运行时循环依赖。
import type { FailedAttemptSource } from "./service";

type Db = Prisma.TransactionClient;

export const OPEN_INCIDENT_STATUSES = ["detected", "triaged", "mitigating", "monitoring"] as const;

export function incidentCanCreateActionPlan(status: string) {
  return (OPEN_INCIDENT_STATUSES as readonly string[]).includes(status);
}

const INCIDENT_ACTIONS = new Set(["retry_eligible", "refund", "pause_route", "rollback"]);

export function isIncidentAction(action: string): action is "retry_eligible" | "refund" | "pause_route" | "rollback" {
  return INCIDENT_ACTIONS.has(action);
}

function record(value: Prisma.JsonValue | null | undefined) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// INVARIANT: route actions are executable only against authority that exists now;
// the immutable Incident recommendation snapshot alone is never sufficient.
export async function incidentRouteActionAvailable(
  db: Pick<Db, "generationProviderRoute" | "generationModelProfile">,
  input: {
    readonly action: "pause_route" | "rollback";
    readonly mitigation: Prisma.JsonValue;
    readonly targetVersion?: string | null;
  },
) {
  const components = record(record(input.mitigation).signatureComponents as Prisma.JsonValue | undefined);
  const profileKey = typeof components.profileKey === "string" ? components.profileKey : null;
  const provider = typeof components.provider === "string" ? components.provider : null;
  if (!profileKey) return false;
  if (input.action === "pause_route") {
    return Boolean(await db.generationProviderRoute.findFirst({
      where: { profileKey, ...(provider ? { provider } : {}), enabled: true },
      select: { id: true },
    }));
  }
  const targetVersion = Number(input.targetVersion);
  if (!Number.isInteger(targetVersion) || targetVersion <= 0) return false;
  return Boolean(await db.generationModelProfile.findFirst({
    where: { profileKey, version: targetVersion, enabled: true },
    select: { id: true },
  }));
}

export function eligibleOccurrenceIds(
  action: string,
  occurrences: ReadonlyArray<{
    id: string;
    attempt: FailedAttemptSource | null;
    capturedSpend: number;
    refunded: number;
  }>,
) {
  if (action === "refund") {
    return occurrences
      .filter((row) => row.capturedSpend > row.refunded)
      .map((row) => row.id)
      .sort();
  }
  if (action !== "retry_eligible") return occurrences.map((row) => row.id).sort();
  return occurrences
    .filter(
      (row) =>
        row.attempt &&
        ["failed", "unknown"].includes(row.attempt.status) &&
        ["retryable", "auto_retry", "operator_retry"].includes(row.attempt.retryability ?? ""),
    )
    .map((row) => row.id)
    .sort();
}

export async function occurrenceSnapshot(db: Db, incidentId: string) {
  const occurrences = await db.opsIncidentOccurrence.findMany({
    where: { incidentId },
    orderBy: [{ observedAt: "asc" }, { id: "asc" }],
  });
  const attemptIds = occurrences.flatMap((row) => (row.attemptId ? [row.attemptId] : []));
  const requestIds = occurrences.flatMap((row) => (row.requestId ? [row.requestId] : []));
  const attempts = attemptIds.length
    ? await db.generationAttempt.findMany({ where: { id: { in: attemptIds } } })
    : [];
  const ledger = requestIds.length
    ? await db.dreamcoinLedger.findMany({
        where: { sourceId: { in: requestIds }, reason: { in: ["generation_spend", "refund"] } },
        select: { sourceId: true, reason: true, delta: true },
      })
    : [];
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  return occurrences.map((row) => ({
    id: row.id,
    attempt: row.attemptId ? attemptsById.get(row.attemptId) ?? null : null,
    capturedSpend: -ledger.filter((entry) => entry.sourceId === row.requestId && entry.reason === "generation_spend" && entry.delta < 0).reduce((sum, entry) => sum + entry.delta, 0),
    refunded: ledger.filter((entry) => entry.sourceId === row.requestId && entry.reason === "refund" && entry.delta > 0).reduce((sum, entry) => sum + entry.delta, 0),
  }));
}
