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
import { dreamcoinBalance, postDreamcoinEntry } from "@/server/modules/billing/ledger";
import {
  dispatchGenerationAttemptOutbox,
  reserveInitialGenerationAttempt as reserveInitialGenerationAttemptAuthority,
} from "@/server/modules/generation/generation-attempt-authority";
import { jsonRecord, numberFromRecord } from "./json-values";
import type { GenerationSource } from "./generation-request-schema";
import { lockUserLedger } from "./subscription-lifecycle";

// SPEC: 用户侧付费生成的接纳 authority。入口只准备各自的历史 PIN；幂等重放、
// 余额与在飞上限、Job/附件/扣费/事件/Attempt/outbox 的原子提交在这里收敛。
// 建角色预览仍复用下方原语，其独立预览配额与草稿事务不属于付费接纳协议。

type GenerationJobIdentity = {
  idempotencyKey?: string | null;
  requestFingerprint?: string;
  source?: GenerationSource;
};

type GenerationAdmissionData = Omit<
  Prisma.GenerationJobUncheckedCreateInput,
  "userId" | "status" | "idempotencyKey" | "derivedFromJobId" | "costDreamcoins"
> & { costDreamcoins: number };

type GenerationAdmission = {
  userId: string;
  identity: GenerationJobIdentity;
  retryOf?: Pick<GenerationJobRow, "id" | "version">;
  chatAttachment?: { sessionId: string; turnId: string; attempt: number };
  // This is the only varying step: lock and revalidate the entry's Character,
  // references or source image, then return its exact immutable request pins.
  prepare(tx: Prisma.TransactionClient): Promise<{
    data: GenerationAdmissionData;
    entitlements: Record<string, Prisma.JsonValue>;
  }>;
};

export function generationWriteRequestFingerprint(
  commandType:
    | "generation.create"
    | "media.variation.create"
    | "media.enhance.create"
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

function assertGenerationJobRequestFingerprint(
  job: Pick<GenerationJobRow, "id" | "momentSpec" | "controls">,
  requestFingerprint?: string,
) {
  if (!requestFingerprint) return;
  // Privacy edits erase MomentSpec text; the content-free request identity must
  // survive so an old receipt cannot be replayed with a different body afterward.
  const storedFingerprint = jsonRecord(job.controls).generationRequestFingerprint ?? jsonRecord(job.momentSpec).requestFingerprint;
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
  options: GenerationJobIdentity,
  db: Prisma.TransactionClient = prisma,
) {
  if (options.idempotencyKey) {
    const existing = await db.generationJob.findFirst({
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
    const existing = await db.generationJob.findFirst({
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

async function findAdmissionReplay(
  tx: Prisma.TransactionClient,
  input: GenerationAdmission,
) {
  const existing = await findExistingGenerationJob(input.userId, input.identity, tx);
  if (existing && input.retryOf && existing.derivedFromJobId !== input.retryOf.id) {
    throw Errors.conflict(
      "Idempotency-Key was already used for a different generation request",
    );
  }
  return existing;
}

export async function acceptGenerationJobForUser(input: GenerationAdmission) {
  let reservation: { job: GenerationJobRow; outboxId: string | null };
  try {
    reservation = await prisma.$transaction(async (tx) => {
      // Source Turns can be edited/deleted under this same user lock. Own it
      // before source/Character/media locks so admission cannot invert their order.
      await lockUserLedger(tx, input.userId);
      let retrySource: GenerationJobRow | null = null;
      if (input.retryOf) {
        // Keep retry intent and source serialization before Character/media
        // locks. Retrying never mutates the original failed request.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`generation-retry-idempotency:${input.userId}:${input.identity.idempotencyKey}`}))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`generation-retry-authority:${input.retryOf.id}`}))`;
        retrySource = await tx.generationJob.findFirst({
          where: { id: input.retryOf.id, userId: input.userId },
        });
        if (!retrySource || retrySource.status !== "failed" || retrySource.version !== input.retryOf.version) {
          throw Errors.conflict(
            "Generation job changed before retry authority could be reserved",
            { generationJobId: input.retryOf.id },
          );
        }
      }
      const replay = await findAdmissionReplay(tx, input);
      if (replay) return { job: replay, outboxId: null };
      if (retrySource) {
        const retries = await tx.generationJob.count({ where: { derivedFromJobId: retrySource.id } });
        if (retries >= 3) {
          throw Errors.rateLimited("Retry limit reached for this generation job", { retries, max: 3 });
        }
      }

      const { data, entitlements } = await input.prepare(tx);
      // Exact replay precedes both charging and attachment checks.
      const accepted = await findAdmissionReplay(tx, input);
      if (accepted) return { job: accepted, outboxId: null };
      const chatAttachment = await lockGenerationChatAttachment(tx, input, data, retrySource);
      const balance = await dreamcoinBalance(input.userId, tx);
      if (balance < data.costDreamcoins) {
        if (!retrySource && data.sourceType === "media_enhance") {
          throw Errors.paymentRequired("Insufficient DreamCoins", { required: data.costDreamcoins, available: balance });
        }
        throw Errors.paymentRequired("Insufficient dreamcoins", { balance, cost: data.costDreamcoins, required: data.costDreamcoins });
      }
      const active = await tx.generationJob.count({
        where: { userId: input.userId, status: { in: activeGenerationStatuses() } },
      });
      const max = maxInflightJobs(entitlements);
      if (active >= max) throw Errors.rateLimited("Too many active generation jobs", { active, max });

      const job = await tx.generationJob.create({ data: {
        ...data,
        userId: input.userId,
        idempotencyKey: input.identity.idempotencyKey,
        derivedFromJobId: input.retryOf?.id,
        status: "queued",
      } });
      if (chatAttachment) {
        // The exact delivery pointer commits with debit and outbox, so even an
        // immediate provider terminal observes the accepted attachment.
        await tx.chatTurnAttachment.update({ where: { id: chatAttachment.id }, data: {
          generationJobId: job.id, status: "accepted", errorCode: null,
          ...(retrySource ? { mediaAssetId: null, width: null, height: null } : {}),
          // Keep effect identity/attempt so regenerate ACKs this replacement.
          metadata: toInputJson({ ...jsonRecord(chatAttachment.metadata), costDreamcoins: job.costDreamcoins }),
        } });
      }
      const enhancement = !retrySource && job.sourceType === "media_enhance";
      await appendGenerationEvent(tx, job.id, "created",
        retrySource ? "Retry generation job accepted" : enhancement ? "Image enhancement accepted" : "Generation job accepted",
        retrySource ? { derivedFromJobId: retrySource.id } : enhancement ? {
          sourceMediaId: jsonRecord(job.controls).sourceImageAssetId, scale: 2,
        } : {
          mode: job.mode, profileId: job.profileId, recipeId: job.recipeId,
          visualProfileId: job.visualProfileId, visualProfileVersion: job.visualProfileVersion,
          referenceSetRevisionId: job.referenceSetRevisionId, consistencyMode: job.consistencyMode,
          idempotencyKey: input.identity.idempotencyKey ?? null, sourceType: job.sourceType, sourceId: job.sourceId,
        });
      await postDreamcoinEntry(tx, {
        kind: "generation_spend", userId: input.userId, amount: job.costDreamcoins,
        sourceId: job.id, idempotencyKey: `generation:${job.id}:reserve`,
      });
      await appendGenerationEvent(tx, job.id, "reserved", "Dreamcoins reserved", { amount: job.costDreamcoins });
      await appendGenerationEvent(tx, job.id, "queued",
        retrySource ? "Retry generation job queued" : enhancement ? "Image enhancement queued" : "Generation job queued", {});
      const dispatch = await reserveInitialGenerationAttempt(tx, job);
      return { job, outboxId: dispatch.outbox.id };
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const existing = await findAdmissionReplay(prisma, input);
    if (!existing) throw error;
    reservation = { job: existing, outboxId: null };
  }

  // Never reserve or dispatch a replay while holding the user lock: terminal
  // settlement locks Job before user. Wake only after the transaction commits.
  if (reservation.outboxId) {
    await dispatchGenerationAttemptOutbox(prisma, { outboxIds: [reservation.outboxId] });
  } else {
    await wakeQueuedGenerationDispatch(reservation.job);
  }
  return reservation.job;
}

async function lockGenerationChatAttachment(
  tx: Prisma.TransactionClient,
  input: GenerationAdmission,
  data: GenerationAdmissionData,
  retrySource: GenerationJobRow | null,
) {
  if (retrySource && ["chat_image", "chat_video"].includes(retrySource.sourceType)) {
    const candidate = await tx.chatTurnAttachment.findFirst({
      where: { generationJobId: retrySource.id, ...(retrySource.sourceId ? { id: retrySource.sourceId } : {}), turn: { session: { userId: input.userId } } },
      include: { turn: true },
    });
    if (!candidate) throw Errors.conflict("The original Chat image is no longer available to retry");
    // Match Chat mutation order: user → session → Turn → attachment.
    await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${candidate.turn.sessionId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "chat_turns" WHERE id = ${candidate.turnId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "chat_turn_attachments" WHERE id = ${candidate.id} FOR UPDATE`;
    const current = await tx.chatTurnAttachment.findUnique({
      where: { id: candidate.id }, include: { turn: { include: { session: true } } },
    });
    const metadata = jsonRecord(current?.metadata);
    const effect = jsonRecord(metadata.effect);
    const attempt = numberFromRecord(metadata, "attempt") ?? numberFromRecord(effect, "attempt") ?? 1;
    if (!current || current.turn.session.userId !== input.userId ||
      current.turn.session.characterId !== data.characterId || current.turn.session.status === "deleted" ||
      current.kind !== (retrySource.sourceType === "chat_video" ? "generated_video" : "generated_image") || !["failed", "refunded"].includes(current.status) ||
      current.generationJobId !== retrySource.id || attempt !== current.turn.attempt) {
      throw Errors.conflict("The Chat image changed before its retry could be reserved");
    }
    return current;
  }
  if (!input.chatAttachment) return null;
  const binding = input.chatAttachment;
  const attachmentId = input.identity.source?.sourceId;
  if (input.identity.source?.sourceType === "chat_video" && attachmentId) {
    await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${binding.sessionId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "chat_turns" WHERE id = ${binding.turnId} FOR UPDATE`;
    const turn = await tx.chatTurn.findUnique({ where: { id: binding.turnId }, include: { session: true } });
    if (!turn || turn.sessionId !== binding.sessionId || turn.session.userId !== input.userId ||
      turn.session.characterId !== data.characterId || turn.session.status === "deleted" ||
      turn.attempt !== binding.attempt || turn.assistantStatus !== "sent") {
      throw Errors.conflict("The original Chat reply changed before its video could be reserved");
    }
    // The video is a separate, explicitly priced action on an accepted reply.
    // Creating it inside admission preserves the original Turn text and terminal.
    return tx.chatTurnAttachment.create({ data: {
      id: attachmentId, turnId: turn.id, kind: "generated_video", status: "requesting",
      promptHint: typeof jsonRecord(data.momentSpec).rawInput === "string" ? String(jsonRecord(data.momentSpec).rawInput) : null,
      metadata: toInputJson({ attempt: binding.attempt, sourceMediaId: jsonRecord(data.sourceMeta).sourceMediaId }),
    } });
  }
  if (input.identity.source?.sourceType !== "chat_image" || !attachmentId) {
    throw Errors.badRequest("Chat attachment binding requires its image action source");
  }
  await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${binding.sessionId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "chat_turns" WHERE id = ${binding.turnId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "chat_turn_attachments" WHERE id = ${attachmentId} FOR UPDATE`;
  const current = await tx.chatTurnAttachment.findUnique({ where: { id: attachmentId }, include: { turn: { include: { session: true } } } });
  if (!current || current.kind !== "generated_image" || current.status !== "requesting" ||
    current.generationJobId !== null || current.turnId !== binding.turnId ||
    current.turn.sessionId !== binding.sessionId || current.turn.session.userId !== input.userId ||
    current.turn.session.characterId !== data.characterId || current.turn.session.status === "deleted" ||
    current.turn.attempt !== binding.attempt || jsonRecord(current.metadata).attempt !== binding.attempt ||
    !["pending", "generating"].includes(current.turn.assistantStatus)) {
    throw Errors.conflict("The Chat image changed before its request could be reserved");
  }
  return current;
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
    /** Granted only by a locked, freshly resolved Comic context. Never a request field. */
    readonly authorizedComicSourceMediaId?: string;
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
        ...(input.authorizedComicSourceMediaId === input.sourceImageAssetId ? [{ id: input.sourceImageAssetId }] : []),
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

function maxInflightJobs(entitlements: Record<string, Prisma.JsonValue>) {
  const configured = Number.parseInt(process.env.MAX_INFLIGHT_JOBS_PER_USER ?? "3", 10);
  const base = Number.isFinite(configured) && configured > 0 ? configured : 3;
  const plan = entitlements.plan;
  if (isRecord(plan) && plan.slug === "deluxe") return Math.max(base, 6);
  return base;
}
