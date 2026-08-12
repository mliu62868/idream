// SPEC: Inbox (main → chat). HTTP ingest persists this receipt before ACK;
// the receiver-local queue and reconciler only wake application of the receipt.
// These are cache-invalidation / blocking / compensation; the AUTHORITY is still
// the read-only views (re-checked every turn). Consumers are idempotent on eventId.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma, chatProjectorPrisma } from "./db.js";
import { Prisma } from "../generated/client/client.js";
import { z } from "zod";
import { deleteAccount } from "./privacy.js";
import { deliverRequestBoundAccountErasureCompletion } from "./outbox.js";
import { advisoryLock } from "./turn-lock.js";
import {
  durableEventEnvelopeSchema,
  durableEnvelopeHash,
  type DurableAck,
  type DurableEventEnvelope,
  MAIN_TO_CHAT_EVENTS,
  accountDeletionRequestedV2PayloadSchema,
  chatImageAcceptedPayloadSchema,
  chatImageCompletedPayloadSchema,
  chatImageFailedPayloadSchema,
  chatSessionReleaseMigrationRequestedPayloadSchema,
  characterModerationRemovalEventId,
  characterModerationRemovedPayloadSchema,
  characterModerationRestorationEventId,
  characterModerationRestorationPayloadSchema,
} from "@idream/shared/contracts";

const REMOVAL_HEADER_LAYER = "main_moderation_removal";
const REMOVAL_SESSION_STATUS = "archived_by_removal";
const REMOVAL_OWNER_LAYER = "main_moderation_removal_owner";
const RESTORATION_HEADER_LAYER = "main_moderation_restoration";
const USER_SESSION_LIFECYCLE_LAYER = "user_session_lifecycle";
const USER_ARCHIVED_STATUS = "user_archived";

const removalHeaderDetailsSchema = z
  .object({
    version: z.literal(1),
    sourceEventId: z.string().min(1),
    characterId: z.string().min(1),
    moderationDecisionId: z.string().min(1).nullable(),
    previousRemovalEventId: z.string().min(1).nullable(),
  })
  .strict();

const removalSessionDetailsSchema = removalHeaderDetailsSchema.extend({
  sessionId: z.string().min(1),
});

const userArchiveDetailsSchema = z
  .object({
    version: z.literal(1),
    overriddenRemovalEventIds: z.array(z.string().min(1)),
  })
  .strict();

const removalOwnerDetailsSchema = z
  .object({
    version: z.literal(1),
    characterId: z.string().min(1),
    removalEventId: z.string().min(1).nullable(),
  })
  .strict();

function removalHeaderId(sourceEventId: string): string {
  return `moderation_removal:${sourceEventId}`;
}

function restorationHeaderId(sourceEventId: string): string {
  return `moderation_restoration:${sourceEventId}`;
}

function removalOwnerId(characterId: string): string {
  return `moderation_removal_owner:${characterId}`;
}

async function currentRemovalEventId(
  tx: Prisma.TransactionClient,
  characterId: string,
) {
  const owner = await tx.chatModerationEvent.findUnique({
    where: { id: removalOwnerId(characterId) },
  });
  if (!owner) return null;
  if (
    owner.targetType !== "character" ||
    owner.targetId !== characterId ||
    owner.layer !== REMOVAL_OWNER_LAYER
  ) {
    throw new Error("character removal owner authority is inconsistent");
  }
  const details = removalOwnerDetailsSchema.parse(owner.details);
  if (details.characterId !== characterId) {
    throw new Error("character removal owner authority is inconsistent");
  }
  if (owner.status === "cleared") return null;
  if (owner.status !== "active" || !details.removalEventId) {
    throw new Error("character removal owner authority is invalid");
  }
  return details.removalEventId;
}

async function setRemovalEventOwner(
  tx: Prisma.TransactionClient,
  characterId: string,
  removalEventId: string | null,
) {
  const details = removalOwnerDetailsSchema.parse({
    version: 1,
    characterId,
    removalEventId,
  });
  await tx.chatModerationEvent.upsert({
    where: { id: removalOwnerId(characterId) },
    create: {
      id: removalOwnerId(characterId),
      targetType: "character",
      targetId: characterId,
      layer: REMOVAL_OWNER_LAYER,
      status: removalEventId ? "active" : "cleared",
      details,
    },
    update: {
      status: removalEventId ? "active" : "cleared",
      details,
    },
  });
}

/** The persisted receipt as the effect appliers see it — never a wire shape. */
interface InboundEvent {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export async function persistInboundEvent(
  rawEvent: unknown,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<DurableAck> {
  const event = durableEventEnvelopeSchema.parse(rawEvent);
  const payloadHash = durableEnvelopeHash(event);
  const existing = await prisma.chatInboxEvent.findUnique({
    where: {
      sourceService_sourceEventId: {
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId,
      },
    },
  });
  if (existing) {
    // INVARIANT: a hash conflict is sticky until explicit reconciliation.
    // A later replay of the originally accepted payload must not let either
    // sender interpret a quarantined identity as durably accepted again.
    if (existing.status === "quarantined") {
      return { acknowledged: false, status: "quarantined", receiptId: existing.id };
    }
    // INVARIANT: an operator-confirmed missing target is terminal transport
    // evidence, not a successful delivery. A later blind replay must not turn
    // this receipt into a positive ACK and imply that Chat applied a user effect.
    if (existing.status === "discarded_target_missing") {
      return {
        acknowledged: false,
        status: "discarded_target_missing",
        receiptId: existing.id,
      };
    }
    if (existing.payloadHash === payloadHash) {
      return { acknowledged: true, status: "duplicate", receiptId: existing.id };
    }
    await prisma.chatInboxEvent.update({
      where: { id: existing.id },
      data: { status: "quarantined", processedAt: new Date(), attempts: { increment: 1 } },
    });
    return { acknowledged: false, status: "quarantined", receiptId: existing.id };
  }
  try {
    await prisma.chatInboxEvent.create({
      data: {
        id: receiptId(event.sourceService, event.sourceEventId),
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId,
        payloadHash,
        eventType: event.eventType,
        payload: event.payload as never,
      },
    });
  } catch (error) {
    // Concurrent at-least-once deliveries can both observe no receipt. Let the
    // unique source key choose the winner, then classify the loser as an exact
    // replay or a payload conflict through the same public path.
    if (isUniqueConstraintError(error)) return persistInboundEvent(rawEvent, prisma);
    throw error;
  }
  return { acknowledged: true, status: "persisted", receiptId: receiptId(event.sourceService, event.sourceEventId) };
}

export async function persistAccountDeletionRequestV2(
  rawEvent: unknown,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<DurableAck> {
  const event = durableEventEnvelopeSchema.parse(rawEvent);
  const payload = accountDeletionRequestedV2PayloadSchema.parse(event.payload);
  if (
    event.sourceService !== "main" ||
    event.eventType !== MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2 ||
    event.schemaVersion !== 2 ||
    event.aggregateType !== "user" ||
    event.aggregateId !== payload.userId
  ) {
    throw new Error("invalid account deletion v2 durable envelope");
  }
  return persistInboundEvent(event, prisma);
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export function receiptId(sourceService: string, sourceEventId: string): string {
  return `${sourceService}:${sourceEventId}`;
}

export const ACCOUNT_DELETION_V2_CONSUMED_STATUS = "consumed_v2" as const;

type AccountDeletionV2Delivery = (
  deletionRequestEventId: string,
  prisma: ChatPrismaClient,
) => Promise<{ eventId: string; delivered: true }>;

/**
 * Synchronously close one v2 deletion request across Chat and Main.
 *
 * INVARIANT: `consumed_v2` means the exact Chat file effect exists and Main's
 * dedicated completion endpoint durably projected it. A legacy `consumed`
 * receipt is deliberately reclaimable because an older binary may have marked
 * an unknown v2 event successful without applying any effect.
 */
export async function consumeAccountDeletionRequestV2(
  id: string,
  prisma: ChatPrismaClient = chatPrisma,
  projectorPrisma: ChatPrismaClient = chatProjectorPrisma,
  deliver: AccountDeletionV2Delivery =
    deliverRequestBoundAccountErasureCompletion,
): Promise<{ applied: boolean }> {
  const receipt = await prisma.chatInboxEvent.findUniqueOrThrow({
    where: { id },
  });
  const payload = accountDeletionRequestedV2PayloadSchema.parse(receipt.payload);
  if (
    receipt.sourceService !== "main" ||
    receipt.eventType !== MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2
  ) {
    throw new Error(`inbox receipt ${id} is not account deletion v2 authority`);
  }

  if (receipt.status === ACCOUNT_DELETION_V2_CONSUMED_STATUS) {
    // Redeliver on every request replay. The Main endpoint is idempotent and its
    // dedicated receipt namespace repairs any prior generic no-op receipt.
    await deliver(receipt.sourceEventId, prisma);
    return { applied: false };
  }

  const claimStartedAt = new Date();
  const staleBefore = new Date(claimStartedAt.getTime() - 5 * 60_000);
  const claim = await prisma.chatInboxEvent.updateMany({
    where: {
      id,
      OR: [
        { status: { in: ["pending", "failed", "consumed"] } },
        { status: "processing", processedAt: { lt: staleBefore } },
      ],
    },
    data: { status: "processing", processedAt: claimStartedAt },
  });
  if (claim.count !== 1) {
    throw new Error(`account deletion v2 receipt ${id} is already processing`);
  }

  try {
    await deleteAccount({
      userId: payload.userId,
      deletionRequestEventId: receipt.sourceEventId,
      requestBound: true,
    }, prisma, projectorPrisma);
    await deliver(receipt.sourceEventId, prisma);
    const consumed = await prisma.chatInboxEvent.updateMany({
      where: { id, status: "processing", processedAt: claimStartedAt },
      data: {
        status: ACCOUNT_DELETION_V2_CONSUMED_STATUS,
        processedAt: new Date(),
        consumedAt: new Date(),
      },
    });
    if (consumed.count !== 1) {
      throw new Error(`account deletion v2 receipt ${id} completion lost its claim`);
    }
    return { applied: true };
  } catch (error) {
    await prisma.chatInboxEvent.updateMany({
      where: { id, status: "processing", processedAt: claimStartedAt },
      data: { status: "failed", attempts: { increment: 1 } },
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * Apply one persisted receipt. Idempotent: the status claim is the dedupe gate,
 * so a redelivered event that was already consumed is a no-op.
 */
export async function consumeDurableInbox(
  id: string,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<{ applied: boolean }> {

  const claimStartedAt = new Date();
  const staleBefore = new Date(claimStartedAt.getTime() - 5 * 60_000);
  const claim = await prisma.chatInboxEvent.updateMany({
    where: {
      id,
      OR: [
        { status: { in: ["pending", "failed"] } },
        { status: "processing", processedAt: { lt: staleBefore } },
      ],
    },
    data: { status: "processing", processedAt: claimStartedAt },
  });
  if (claim.count === 0) return { applied: false };

  const claimed = await prisma.chatInboxEvent.findUniqueOrThrow({ where: { id } });
  const eventToApply: InboundEvent = {
    eventId: claimed.sourceEventId,
    eventType: claimed.eventType,
    payload: (claimed.payload ?? {}) as Record<string, unknown>,
  };

  try {
    await applyEffect(eventToApply, prisma);
    await prisma.chatInboxEvent.updateMany({
      where: { id, status: "processing", processedAt: claimStartedAt },
      data: { status: "consumed", processedAt: new Date(), consumedAt: new Date() },
    });
    return { applied: true };
  } catch (error) {
    await prisma.chatInboxEvent.updateMany({
      where: { id, status: "processing", processedAt: claimStartedAt },
      data: { status: "failed", attempts: { increment: 1 } },
    });
    throw error;
  }
}

async function applyCharacterRemoval(
  event: InboundEvent,
  prisma: ChatPrismaClient,
): Promise<void> {
  const causalPayload = characterModerationRemovedPayloadSchema.safeParse(
    event.payload,
  );
  if (
    !causalPayload.success &&
    (event.payload.version !== undefined || event.payload.binding !== undefined)
  ) {
    throw causalPayload.error;
  }
  const characterId = causalPayload.success
    ? causalPayload.data.characterId
    : String(event.payload.characterId ?? "");
  if (!characterId) return;
  const moderationDecisionId = causalPayload.success
    ? causalPayload.data.moderationDecisionId
    : null;
  if (
    moderationDecisionId &&
    event.eventId !== characterModerationRemovalEventId(moderationDecisionId)
  ) {
    throw new Error("character removal event identity does not match its decision");
  }

  await prisma.$transaction(async (tx) => {
    await advisoryLock(tx, `moderation-removal:${characterId}`);
    const headerId = removalHeaderId(event.eventId);
    const existing = await tx.chatModerationEvent.findUnique({
      where: { id: headerId },
    });
    if (existing) {
      const details = removalHeaderDetailsSchema.parse(existing.details);
      if (
        details.sourceEventId !== event.eventId ||
        details.characterId !== characterId ||
        details.moderationDecisionId !== moderationDecisionId
      ) {
        throw new Error("character removal effect identity was reused");
      }
      return;
    }

    const currentRemoval = await currentRemovalEventId(
      tx,
      characterId,
    );
    const previousRemovalEventId = causalPayload.success
      ? causalPayload.data.previousRemovalEventId
      : currentRemoval;
    if (causalPayload.success && currentRemoval !== previousRemovalEventId) {
      throw new Error(
        "character removal predecessor has not become the current effect",
      );
    }

    // INVARIANT: the row locks define the immutable causal set. A user archive
    // ordered before this query is excluded; one ordered after it records an
    // explicit override against the per-session removal evidence.
    const sessions = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT id
        FROM chat.chat_sessions
        WHERE character_id = ${characterId}
          AND status = 'active'
          AND deleted_at IS NULL
        ORDER BY id
        FOR UPDATE
      `,
    );
    const details = {
      version: 1 as const,
      sourceEventId: event.eventId,
      characterId,
      moderationDecisionId,
      previousRemovalEventId,
    };
    await tx.chatModerationEvent.create({
      data: {
        id: headerId,
        targetType: "character",
        targetId: characterId,
        layer: REMOVAL_HEADER_LAYER,
        status: "applied",
        details,
      },
    });
    await setRemovalEventOwner(tx, characterId, event.eventId);
    if (sessions.length === 0) return;

    await tx.chatModerationEvent.createMany({
      data: sessions.map((session) => ({
        id: `${headerId}:session:${session.id}`,
        targetType: "session",
        targetId: session.id,
        layer: REMOVAL_HEADER_LAYER,
        status: REMOVAL_SESSION_STATUS,
        details: { ...details, sessionId: session.id },
      })),
    });
    const archived = await tx.chatSession.updateMany({
      where: {
        id: { in: sessions.map((session) => session.id) },
        characterId,
        status: "active",
        deletedAt: null,
      },
      data: { status: "archived" },
    });
    if (archived.count !== sessions.length) {
      throw new Error("character removal causal set changed while applying");
    }
  });
}

async function applyCharacterRestoration(
  event: InboundEvent,
  prisma: ChatPrismaClient,
): Promise<void> {
  const payload = characterModerationRestorationPayloadSchema.parse(event.payload);
  if (
    event.eventId !== characterModerationRestorationEventId(payload.appealId) ||
    payload.removalEventId !==
      characterModerationRemovalEventId(payload.moderationDecisionId)
  ) {
    throw new Error("character restoration event is not bound to its causal identities");
  }

  await prisma.$transaction(async (tx) => {
    await advisoryLock(tx, `moderation-removal:${payload.characterId}`);
    const effectId = restorationHeaderId(event.eventId);
    const existing = await tx.chatModerationEvent.findUnique({
      where: { id: effectId },
    });
    if (existing) {
      const details = characterModerationRestorationPayloadSchema.parse(
        existing.details,
      );
      if (
        details.appealId !== payload.appealId ||
        details.characterId !== payload.characterId ||
        details.moderationDecisionId !== payload.moderationDecisionId ||
        details.removalEventId !== payload.removalEventId
      ) {
        throw new Error("character restoration effect identity was reused");
      }
      return;
    }

    const currentRemoval = await currentRemovalEventId(
      tx,
      payload.characterId,
    );
    if (currentRemoval !== payload.removalEventId) {
      throw new Error(
        "character restoration does not own the current removal effect",
      );
    }

    const removalHeader = await tx.chatModerationEvent.findUnique({
      where: { id: removalHeaderId(payload.removalEventId) },
    });
    if (!removalHeader) {
      throw new Error("character restoration has no applied removal authority");
    }
    const removalDetails = removalHeaderDetailsSchema.parse(
      removalHeader.details,
    );
    if (
      removalDetails.sourceEventId !== payload.removalEventId ||
      removalDetails.characterId !== payload.characterId ||
      removalDetails.moderationDecisionId !== payload.moderationDecisionId
    ) {
      throw new Error("character restoration does not match removal authority");
    }

    const snapshots = await tx.chatModerationEvent.findMany({
      where: {
        id: { startsWith: `${removalHeaderId(payload.removalEventId)}:session:` },
        targetType: "session",
        layer: REMOVAL_HEADER_LAYER,
        status: REMOVAL_SESSION_STATUS,
      },
      orderBy: { id: "asc" },
    });
    const sessionIds = snapshots.map((snapshot) => {
      const details = removalSessionDetailsSchema.parse(snapshot.details);
      if (
        details.sourceEventId !== payload.removalEventId ||
        details.characterId !== payload.characterId ||
        details.moderationDecisionId !== payload.moderationDecisionId ||
        details.sessionId !== snapshot.targetId
      ) {
        throw new Error("character removal session evidence is inconsistent");
      }
      return snapshot.targetId;
    });

    const causalSessions = sessionIds.length
      ? await tx.chatSession.findMany({
          where: { id: { in: sessionIds } },
          select: { id: true, userId: true },
        })
      : [];
    // INVARIANT: createSession uses this same authority key. If a user created
    // a replacement after Main approved the appeal but before this event was
    // consumed, keep the old causal session archived instead of producing two
    // active conversations for the same user/Character.
    const sessionAuthorityKeys = [
      ...new Set(
        causalSessions.map(
          (session) => `session:${session.userId}:${payload.characterId}`,
        ),
      ),
    ].sort();
    for (const authorityKey of sessionAuthorityKeys) {
      await advisoryLock(tx, authorityKey);
    }
    if (sessionIds.length > 0) {
      await tx.$queryRaw(
        Prisma.sql`
          SELECT id
          FROM chat.chat_sessions
          WHERE id IN (${Prisma.join(sessionIds)})
          ORDER BY id
          FOR UPDATE
        `,
      );
    }
    const userArchives = sessionIds.length
      ? await tx.chatModerationEvent.findMany({
          where: {
            targetType: "session",
            targetId: { in: sessionIds },
            layer: USER_SESSION_LIFECYCLE_LAYER,
            status: USER_ARCHIVED_STATUS,
          },
        })
      : [];
    const userOverriddenSessionIds = new Set(
      userArchives
        .filter((archive) =>
          userArchiveDetailsSchema
            .parse(archive.details)
            .overriddenRemovalEventIds.includes(payload.removalEventId),
        )
        .map((archive) => archive.targetId),
    );
    const causalSessionById = new Map(
      causalSessions.map((session) => [session.id, session]),
    );
    const activeReplacementUsers = new Set(
      sessionIds.length
        ? (
            await tx.chatSession.findMany({
              where: {
                id: { notIn: sessionIds },
                userId: { in: causalSessions.map((session) => session.userId) },
                characterId: payload.characterId,
                status: "active",
                deletedAt: null,
              },
              select: { userId: true },
            })
          ).map((session) => session.userId)
        : [],
    );
    const selectedUsers = new Set<string>();
    const restorableSessionIds = sessionIds.filter((sessionId) => {
      const session = causalSessionById.get(sessionId);
      if (
        !session ||
        userOverriddenSessionIds.has(sessionId) ||
        activeReplacementUsers.has(session.userId) ||
        selectedUsers.has(session.userId)
      ) {
        return false;
      }
      selectedUsers.add(session.userId);
      return true;
    });
    if (restorableSessionIds.length) {
      await tx.chatSession.updateMany({
        where: {
          id: { in: restorableSessionIds },
          characterId: payload.characterId,
          status: "archived",
          deletedAt: null,
        },
        data: { status: "active" },
      });
    }

    await setRemovalEventOwner(
      tx,
      payload.characterId,
      removalDetails.previousRemovalEventId,
    );

    await tx.chatModerationEvent.create({
      data: {
        id: effectId,
        targetType: "character",
        targetId: payload.characterId,
        layer: RESTORATION_HEADER_LAYER,
        status: "applied",
        details: payload,
      },
    });
  });
}

async function applyEffect(event: InboundEvent, prisma: ChatPrismaClient): Promise<void> {
  switch (event.eventType) {
    case MAIN_TO_CHAT_EVENTS.userSuspended: {
      // Reversible: stop active sessions. New messages were already blocked by the
      // eligibility view; this just reflects suspension in chat state.
      const userId = String(event.payload.userId ?? "");
      if (userId) {
        await prisma.chatSession.updateMany({
          where: { userId, status: "active" },
          data: { status: "archived" },
        });
      }
      return;
    }
    case MAIN_TO_CHAT_EVENTS.userDeleted: {
      // Legacy account deletion remains consumable for already-persisted rows.
      const userId = String(event.payload.userId ?? "");
      if (userId) {
        await deleteAccount({
          userId,
          deletionRequestEventId: event.eventId,
        }, prisma);
      }
      return;
    }
    case MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2: {
      throw new Error(
        "account deletion v2 requires synchronous request-bound consumption",
      );
    }
    case MAIN_TO_CHAT_EVENTS.characterRemoved: {
      await applyCharacterRemoval(event, prisma);
      return;
    }
    case MAIN_TO_CHAT_EVENTS.characterModerationRestorationRequested: {
      await applyCharacterRestoration(event, prisma);
      return;
    }
    case MAIN_TO_CHAT_EVENTS.chatImageAccepted: {
      const payload = chatImageAcceptedPayloadSchema.parse(event.payload);
      await prisma.messageAttachment.updateMany({
        where: {
          id: payload.attachmentId,
          status: { in: ["requesting", "proposed", "failed", "refunded"] },
        },
        data: {
          status: "queued",
          generationJobId: payload.generationJobId,
          costDreamcoins: payload.costDreamcoins,
          errorCode: null,
        },
      });
      return;
    }
    case MAIN_TO_CHAT_EVENTS.chatImageCompleted: {
      const payload = chatImageCompletedPayloadSchema.parse(event.payload);
      const attachment = await prisma.messageAttachment.findUnique({
        where: { id: payload.attachmentId },
        select: { metadata: true },
      });
      const metadata = (attachment?.metadata ?? {}) as Record<string, unknown>;
      await prisma.messageAttachment.updateMany({
        where: { id: payload.attachmentId, status: { notIn: ["completed", "canceled"] } },
        data: {
          status: "completed",
          generationJobId: payload.generationJobId,
          mediaAssetId: payload.mediaAssetId,
          width: payload.width ?? null,
          height: payload.height ?? null,
          errorCode: null,
          // P4 Task 5: agent's recollection of "what photo it sent" (generate.ts
          // buildModelMessages reads this back for the photo-awareness context line).
          ...(payload.summary ? { metadata: { ...metadata, summary: payload.summary } } : {}),
        },
      });
      return;
    }
    case MAIN_TO_CHAT_EVENTS.chatImageFailed: {
      const payload = chatImageFailedPayloadSchema.parse(event.payload);
      await prisma.messageAttachment.updateMany({
        where: { id: payload.attachmentId, status: { notIn: ["completed", "canceled"] } },
        data: {
          status: payload.status,
          generationJobId: payload.generationJobId ?? undefined,
          errorCode: payload.errorCode ?? null,
        },
      });
      return;
    }
    case MAIN_TO_CHAT_EVENTS.sessionReleaseMigrationRequested: {
      const payload = chatSessionReleaseMigrationRequestedPayloadSchema.parse(event.payload);
      const existingMigration = await prisma.chatSessionReleaseMigration.findUnique({
        where: { commandId: payload.commandId },
      });
      if (existingMigration) {
        if (
          existingMigration.sessionId !== payload.sessionId ||
          existingMigration.toCharacterContentVersionId !== payload.toCharacterContentVersionId ||
          existingMigration.toCharacterReleaseId !== payload.toCharacterReleaseId
        ) {
          throw new Error("session release migration command payload changed on redelivery");
        }
        return;
      }
      const session = await prisma.chatSession.findUnique({ where: { id: payload.sessionId } });
      if (!session || session.characterId !== payload.characterId) {
        throw new Error("session release migration target does not exist");
      }
      if (
        session.characterContentVersionId !== payload.fromCharacterContentVersionId ||
        session.characterReleaseId !== payload.fromCharacterReleaseId
      ) {
        throw new Error("session release migration source pin is stale");
      }
      const content = await prisma.chatCharacterContentVersionView.findUnique({
        where: { contentVersionId: payload.toCharacterContentVersionId },
      });
      if (!content || content.characterId !== payload.characterId) {
        throw new Error("session release migration content version is invalid");
      }
      if (payload.toCharacterReleaseId) {
        const release = await prisma.chatCharacterReleaseView.findUnique({
          where: { releaseId: payload.toCharacterReleaseId },
        });
        if (
          !release ||
          release.characterId !== payload.characterId ||
          release.characterContentVersionId !== payload.toCharacterContentVersionId
        ) {
          throw new Error("session release migration Release does not match immutable content");
        }
      }
      await prisma.chatSessionReleaseMigration.create({
        data: {
          id: event.eventId,
          commandId: payload.commandId,
          sessionId: payload.sessionId,
          characterId: payload.characterId,
          fromCharacterContentVersionId: payload.fromCharacterContentVersionId,
          fromCharacterReleaseId: payload.fromCharacterReleaseId,
          toCharacterContentVersionId: payload.toCharacterContentVersionId,
          toCharacterReleaseId: payload.toCharacterReleaseId,
          reason: payload.reason,
          compatibilityQa: payload.compatibilityQa as never,
          requestedById: payload.requestedById,
        },
      });
      return;
    }
    // entitlement/policy/visibility/age updates: views are authority, nothing to
    // persist on the chat side — recording the event (above) is the audit trail.
    default:
      return;
  }
}

/** Re-process inbox rows stuck in pending/failed (reconciler). */
export async function reprocessPendingInbox(
  prisma: ChatPrismaClient = chatPrisma,
  batch = 100,
): Promise<number> {
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const pending = await prisma.chatInboxEvent.findMany({
    where: {
      eventType: { not: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2 },
      OR: [
        { status: { in: ["pending", "failed"] } },
        { status: "processing", processedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: batch,
  });
  let applied = 0;
  for (const row of pending) {
    try {
      const result = await consumeDurableInbox(row.id, prisma);
      if (result.applied) applied += 1;
    } catch {
      // consumeDurableInbox records the failed attempt while retaining the event.
    }
  }
  return applied;
}

/** Repair current failures and legacy successful no-ops without a sender replay. */
export async function reprocessAccountDeletionRequestsV2(
  prisma: ChatPrismaClient = chatPrisma,
  projectorPrisma: ChatPrismaClient = chatProjectorPrisma,
  batch = 100,
  deliver: AccountDeletionV2Delivery =
    deliverRequestBoundAccountErasureCompletion,
): Promise<number> {
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const rows = await prisma.chatInboxEvent.findMany({
    where: {
      sourceService: "main",
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      OR: [
        { status: { in: ["pending", "failed", "consumed"] } },
        { status: "processing", processedAt: { lt: staleBefore } },
      ],
    },
    // A poisoned authority must not permanently occupy the first batch. Each
    // failed attempt increments attempts, rotating it behind untouched work.
    orderBy: [{ attempts: "asc" }, { createdAt: "asc" }],
    take: batch,
  });
  let applied = 0;
  for (const row of rows) {
    try {
      const result = await consumeAccountDeletionRequestV2(
        row.id,
        prisma,
        projectorPrisma,
        deliver,
      );
      if (result.applied) applied += 1;
    } catch {
      // The guarded consumer retains failed authority for the next sweep.
    }
  }
  return applied;
}
