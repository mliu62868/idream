import { Prisma, type GenerationJob as GenerationJobRow } from "@prisma/client";
import {
  GENERATION_JOB_STATUSES,
  TERMINAL_GENERATION_JOB_STATUSES,
} from "@idream/shared/catalog";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { isRecord, toInputJson } from "@/server/lib/request-json";
import { canonicalJsonHash } from "@/server/modules/admin-v2/shared/idempotency";
import {
  dispatchGenerationAttemptOutbox,
  reserveInitialGenerationAttempt as reserveInitialGenerationAttemptAuthority,
} from "@/server/modules/generation/generation-attempt-authority";
import { jsonRecord } from "./json-values";
import type { GenerationSource } from "./generation-request-schema";

// SPEC: 每一次用户侧生成写入（下单 / 重试 / 建角色预览 / 图片变体）共用的耐久性原语：
// 幂等去重、首次 Attempt 预留与唤醒、事件追加、在飞数量上限、源图权威校验。
//
// INTENT: 这些原语此前只存在于 service.ts 内部，于是「谁能发起一次生成」等价于
// 「谁在 dispatchV1 的路由表里」。抽出来之后它们成了显式契约：新的生成入口必须走
// 同一套幂等与预留协议，而不是各写一遍。

export function generationWriteRequestFingerprint(
  commandType:
    | "generation.create"
    | "media.variation.create"
    | "character.preview.create",
  body: unknown,
  targetId?: string,
) {
  const semanticBody = isRecord(body)
    ? Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== "quoteAuthority"),
      )
    : body;
  return canonicalJsonHash({
    schemaVersion: "generation-write-request-v1",
    commandType,
    targetId: targetId ?? null,
    body: semanticBody,
  });
}

export function assertGenerationJobRequestFingerprint(
  job: Pick<GenerationJobRow, "id" | "momentSpec">,
  requestFingerprint?: string,
) {
  if (!requestFingerprint) return;
  const storedFingerprint = jsonRecord(job.momentSpec).requestFingerprint;
  // Jobs created before fingerprint binding remain replayable by their durable
  // user/idempotency tuple. Every new public generation write pins the hash.
  if (
    typeof storedFingerprint === "string" &&
    storedFingerprint !== requestFingerprint
  ) {
    throw Errors.conflict(
      "Idempotency-Key was already used for a different generation request",
      { generationJobId: job.id },
    );
  }
}

// Dedup lookup for generation jobs: idempotencyKey first, then (sourceType, sourceId).
// Shared by the cheap pre-check fast-path and the P2002 conflict fallback so both resolve
// a duplicate request to the SAME existing job.
export async function findExistingGenerationJob(
  userId: string,
  options: {
    idempotencyKey?: string | null;
    requestFingerprint?: string;
    source?: GenerationSource;
  },
) {
  if (options.idempotencyKey) {
    const existing = await prisma.generationJob.findFirst({
      where: { userId, idempotencyKey: options.idempotencyKey },
    });
    if (existing) {
      assertGenerationJobRequestFingerprint(
        existing,
        options.requestFingerprint,
      );
      return existing;
    }
  }
  if (options.source) {
    const existing = await prisma.generationJob.findFirst({
      where: { sourceType: options.source.sourceType, sourceId: options.source.sourceId },
    });
    if (existing) {
      assertGenerationJobRequestFingerprint(
        existing,
        options.requestFingerprint,
      );
      return existing;
    }
  }
  return null;
}

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function assertGenerationSourceImageAuthorityInTx(
  tx: Prisma.TransactionClient,
  input: {
    readonly sourceImageAssetId: string;
    readonly userId: string;
    readonly characterId: string | null;
  },
) {
  const source = await tx.mediaAsset.findFirst({
    where: {
      id: input.sourceImageAssetId,
      type: "image",
      deletedAt: null,
      safetyStatus: "passed",
      OR: [
        { ownerId: input.userId },
        ...(input.characterId ? [{ characterId: input.characterId }] : []),
      ],
    },
    select: {
      id: true,
      storageKey: true,
      url: true,
      metadata: true,
    },
  });
  if (
    !source ||
    !isMediaAssetOperationalForAuthority(source.metadata) ||
    !hasHydratableMediaBlobAuthority(source)
  ) {
    throw Errors.conflict(
      "Source image changed or became unavailable before generation was pinned",
      { sourceImageAssetId: input.sourceImageAssetId },
    );
  }
}

export async function reserveInitialGenerationAttempt(
  tx: Prisma.TransactionClient,
  job: {
    readonly id: string;
    readonly provider: string | null;
    readonly profileId: string | null;
    readonly profileVersion: number | null;
    readonly model: string | null;
    readonly controls: Prisma.JsonValue;
  },
) {
  return reserveInitialGenerationAttemptAuthority(tx, {
    requestId: job.id,
    dispatch: {
      outboxId: `generation_initial_${job.id}`,
      eventType: "generation.retry.dispatch.v2",
    },
  });
}

export async function wakeQueuedGenerationDispatch(job: {
  readonly id: string;
  readonly status: string;
  readonly provider: string | null;
  readonly profileId: string | null;
  readonly profileVersion: number | null;
  readonly model: string | null;
  readonly controls: Prisma.JsonValue;
}) {
  if (job.status !== "queued") return;
  const reservation = await prisma.$transaction((tx) =>
    reserveInitialGenerationAttempt(tx, job),
  );
  await dispatchGenerationAttemptOutbox(prisma, {
    outboxIds: [reservation.outbox.id],
  });
}

export async function appendGenerationEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  return tx.generationJobEvent.create({
    data: {
      jobId,
      type,
      message,
      metadata: toInputJson(metadata),
    },
  });
}

// INTENT: 「活跃」= 非终态。以终态集合取反，新增一个状态时不会漏进这里。
export function activeGenerationStatuses() {
  return GENERATION_JOB_STATUSES.filter(
    (status) => !(TERMINAL_GENERATION_JOB_STATUSES as readonly string[]).includes(status),
  );
}

export function maxInflightJobs(entitlements: Record<string, Prisma.JsonValue>) {
  const configured = Number.parseInt(process.env.MAX_INFLIGHT_JOBS_PER_USER ?? "3", 10);
  const base = Number.isFinite(configured) && configured > 0 ? configured : 3;
  const plan = entitlements.plan;
  if (isRecord(plan) && plan.slug === "deluxe") return Math.max(base, 6);
  return base;
}
