import { Prisma, type PrismaClient } from "@prisma/client";
import {
  type MainToChatReceiverAuthority,
  MAIN_TO_CHAT_EVENTS,
  type MainToChatTargetIdentity,
} from "@idream/shared/contracts";
import {
  type MainToChatOutboxEventQuery,
  type MainToChatOutboxReplayRequest,
  type MainToChatOutboxTargetMissingDispositionRequest,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  actorWithPermission,
  queryParams,
  type AdminActor,
} from "@/server/modules/admin-v2/shared/authority";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  parseIsoCursorKey,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { validateMainToChatOutboxEnvelope } from "./main-outbox-reconciliation";
import {
  discardChatReceiverTargetMissing,
  inspectChatReceiverAuthority,
} from "./chat-receiver-authority-client";

type Db = PrismaClient | Prisma.TransactionClient;

const CHAT_OUTBOX_CURSOR_SCOPE = "main-to-chat-failed-outbox";
const CHAT_EVENT_TYPES = Object.values(MAIN_TO_CHAT_EVENTS);

export async function listFailedMainToChatOutboxEvents(
  request: Request,
  db: Db = prisma,
) {
  await actorWithPermission(request, "chat.ops.read");
  const query = queryParams(
    request,
    "GET /api/v2/admin/chat/main-outbox-events",
  ) as MainToChatOutboxEventQuery;
  const queryIdentity = {
    status: query.status,
    eventType: query.eventType ?? null,
  };
  const cursor = query.cursor
    ? decodeAdminListCursor(
        query.cursor,
        CHAT_OUTBOX_CURSOR_SCOPE,
        queryIdentity,
      )
    : undefined;
  if (cursor && cursor.length !== 2) {
    throw Errors.badRequest(`${CHAT_OUTBOX_CURSOR_SCOPE} cursor key count is invalid`);
  }
  const cursorUpdatedAt = cursor
    ? parseIsoCursorKey(cursor[0], CHAT_OUTBOX_CURSOR_SCOPE)
    : undefined;
  const cursorId = cursor
    ? cursorString(cursor[1], CHAT_OUTBOX_CURSOR_SCOPE)
    : undefined;
  const rows = await db.mainOutboxEvent.findMany({
    where: {
      status: "failed",
      eventType: query.eventType
        ? query.eventType
        : { in: CHAT_EVENT_TYPES },
      ...(cursorUpdatedAt && cursorId
        ? {
            OR: [
              { updatedAt: { lt: cursorUpdatedAt } },
              { updatedAt: cursorUpdatedAt, id: { lt: cursorId } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
  });
  const hasNextPage = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const receiver = await receiverAuthorityForRows(page);
  return {
    items: page.map((row) => {
      const envelope = storedEnvelope(row);
      return {
        id: row.id,
        eventType: row.eventType,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        status: "failed" as const,
        attempts: row.attempts,
        nextRunAt: row.nextRunAt.toISOString(),
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        lastErrorMessage: errorMessage(row.lastError),
        envelopeHash: envelope?.envelopeHash ?? null,
        storedEnvelopeHash: canonicalSha256(row.payload),
        receiverAuthority: receiverAuthorityView(
          row.id,
          envelope,
          receiver,
        ),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor(
            CHAT_OUTBOX_CURSOR_SCOPE,
            queryIdentity,
            [last.updatedAt.toISOString(), last.id],
          )
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: receiver.available ? "fresh" as const : "degraded" as const,
  };
}

export async function prepareMainToChatReplayAuthority(
  body: MainToChatOutboxReplayRequest,
  db: Db = prisma,
) {
  const rows = await db.mainOutboxEvent.findMany({
    where: {
      id: { in: body.events.map(({ id }) => id) },
      eventType: { in: CHAT_EVENT_TYPES },
    },
  });
  const requested = new Map(body.events.map((event) => [event.id, event]));
  const candidates = rows.flatMap((row) => {
    const expected = requested.get(row.id);
    const validation = storedEnvelope(row);
    return expected &&
      validation &&
      row.status === "failed" &&
      row.attempts === expected.expectedAttempts &&
      row.updatedAt.getTime() === new Date(expected.expectedUpdatedAt).getTime()
      ? [validation.envelope]
      : [];
  });
  if (candidates.length === 0) return new Map<string, MainToChatReceiverAuthority>();
  const authority = await inspectChatReceiverAuthority(candidates);
  return new Map(authority.map((item) => [item.sourceEventId, item]));
}

export async function replayFailedMainToChatOutboxEvents(
  input: {
    readonly body: MainToChatOutboxReplayRequest;
    readonly actor: AdminActor;
    readonly requestId: string;
    readonly receiverAuthority?: ReadonlyMap<string, MainToChatReceiverAuthority>;
  },
  tx: Prisma.TransactionClient,
) {
  const results: Array<{
    id: string;
    outcome:
      | "requeued"
      | "already_delivered"
      | "already_requeued"
      | "stale"
      | "invalid_envelope"
      | "receiver_target_missing"
      | "receiver_conflict"
      | "not_found";
    priorAttempts: number | null;
    envelopeHash: string | null;
    storedEnvelopeHash: string | null;
  }> = [];

  for (const requested of input.body.events) {
    const row = await tx.mainOutboxEvent.findFirst({
      where: {
        id: requested.id,
        eventType: { in: CHAT_EVENT_TYPES },
      },
    });
    if (!row) {
      results.push(result(requested.id, "not_found", null, null, null));
      continue;
    }
    const rawEnvelopeHash = canonicalSha256(row.payload);
    const envelope = storedEnvelope(row);
    const envelopeHash = envelope?.envelopeHash ?? null;
    const stableOutcome = outcomeForCurrentStatus(row.status);
    if (stableOutcome) {
      results.push(result(
        row.id,
        stableOutcome,
        row.attempts,
        envelopeHash,
        rawEnvelopeHash,
      ));
      continue;
    }
    if (
      row.status !== "failed" ||
      row.attempts !== requested.expectedAttempts ||
      row.updatedAt.getTime() !== new Date(requested.expectedUpdatedAt).getTime()
    ) {
      results.push(result(
        row.id,
        "stale",
        row.attempts,
        envelopeHash,
        rawEnvelopeHash,
      ));
      continue;
    }
    if (!envelope) {
      results.push(result(
        row.id,
        "invalid_envelope",
        row.attempts,
        null,
        rawEnvelopeHash,
      ));
      continue;
    }
    if (input.receiverAuthority) {
      const authority = input.receiverAuthority.get(row.id);
      if (
        !authority ||
        authority.envelopeHash !== envelope.envelopeHash ||
        authority.disposition === "receiver_hash_conflict" ||
        authority.disposition === "receiver_quarantined" ||
        authority.disposition === "discarded_target_missing" ||
        authority.disposition === "invalid_event_payload"
      ) {
        results.push(result(
          row.id,
          "receiver_conflict",
          row.attempts,
          envelopeHash,
          rawEnvelopeHash,
        ));
        continue;
      }
      if (authority.disposition === "expected_target_missing") {
        results.push(result(
          row.id,
          "receiver_target_missing",
          row.attempts,
          envelopeHash,
          rawEnvelopeHash,
        ));
        continue;
      }
    }

    const nextRunAt = new Date();
    const transitioned = await tx.mainOutboxEvent.updateMany({
      where: {
        id: row.id,
        status: "failed",
        attempts: requested.expectedAttempts,
        updatedAt: new Date(requested.expectedUpdatedAt),
      },
      data: {
        status: "pending",
        attempts: 0,
        nextRunAt,
        deliveredAt: null,
        lastError: Prisma.DbNull,
      },
    });
    if (transitioned.count === 0) {
      const current = await tx.mainOutboxEvent.findFirst({
        where: {
          id: row.id,
          eventType: { in: CHAT_EVENT_TYPES },
        },
        select: { status: true, attempts: true },
      });
      results.push(
        result(
          row.id,
          current ? outcomeForCurrentStatus(current.status) ?? "stale" : "not_found",
          current?.attempts ?? null,
          envelopeHash,
          rawEnvelopeHash,
        ),
      );
      continue;
    }

    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "chat.main_outbox.replayed",
        targetType: "main_to_chat_outbox_event",
        targetId: row.id,
        reason: reasonText(input.body.reason),
        before: toInputJson({
          status: row.status,
          attempts: row.attempts,
          updatedAt: row.updatedAt.toISOString(),
          lastErrorCode: errorCode(row.lastError),
          lastErrorHash: row.lastError === null
            ? null
            : canonicalSha256(row.lastError),
          envelopeHash,
          storedEnvelopeHash: rawEnvelopeHash,
        }),
        after: toInputJson({
          status: "pending",
          attempts: 0,
          nextRunAt: nextRunAt.toISOString(),
          envelopeHash,
          storedEnvelopeHash: rawEnvelopeHash,
        }),
        requestId: input.requestId,
      },
    });
    results.push(result(
      row.id,
      "requeued",
      row.attempts,
      envelopeHash,
      rawEnvelopeHash,
    ));
  }

  return {
    results,
    requeuedCount: results.filter(({ outcome }) => outcome === "requeued").length,
  };
}

export async function discardTargetMissingMainToChatOutboxEvents(
  input: {
    readonly body: MainToChatOutboxTargetMissingDispositionRequest;
    readonly actor: AdminActor;
    readonly requestId: string;
  },
  tx: Prisma.TransactionClient,
  disposeReceiver: typeof discardChatReceiverTargetMissing =
    discardChatReceiverTargetMissing,
) {
  type FinalResult = ReturnType<typeof targetMissingResult>;
  type Candidate = {
    readonly row: Awaited<ReturnType<typeof tx.mainOutboxEvent.findFirst>> & {};
    readonly requested: MainToChatOutboxTargetMissingDispositionRequest["events"][number];
    readonly envelope: NonNullable<ReturnType<typeof storedEnvelope>>;
    readonly storedEnvelopeHash: string;
  };
  const slots: Array<FinalResult | Candidate> = [];

  for (const requested of input.body.events) {
    const row = await tx.mainOutboxEvent.findFirst({
      where: { id: requested.id, eventType: { in: CHAT_EVENT_TYPES } },
    });
    if (!row) {
      slots.push(targetMissingResult(requested.id, "not_found"));
      continue;
    }
    const storedEnvelopeHash = canonicalSha256(row.payload);
    const envelope = storedEnvelope(row);
    const envelopeHash = envelope?.envelopeHash ?? null;
    if (!envelope) {
      slots.push(targetMissingResult(
        row.id,
        "invalid_envelope",
        row.attempts,
        null,
        storedEnvelopeHash,
      ));
      continue;
    }
    if (envelope.envelopeHash !== requested.expectedEnvelopeHash) {
      slots.push(targetMissingResult(
        row.id,
        "envelope_hash_mismatch",
        row.attempts,
        envelope.envelopeHash,
        storedEnvelopeHash,
        envelope.target,
      ));
      continue;
    }
    if (!envelope.target || !sameTarget(envelope.target, requested.expectedTarget)) {
      slots.push(targetMissingResult(
        row.id,
        "expected_target_mismatch",
        row.attempts,
        envelope.envelopeHash,
        storedEnvelopeHash,
        envelope.target,
      ));
      continue;
    }
    if (row.status === "discarded_target_missing") {
      slots.push(targetMissingResult(
        row.id,
        "already_discarded_target_missing",
        row.attempts,
        envelopeHash,
        storedEnvelopeHash,
        envelope.target,
      ));
      continue;
    }
    if (row.status === "delivered") {
      slots.push(targetMissingResult(
        row.id,
        "already_delivered",
        row.attempts,
        envelopeHash,
        storedEnvelopeHash,
        envelope.target,
      ));
      continue;
    }
    if (row.status === "pending") {
      slots.push(targetMissingResult(
        row.id,
        "already_requeued",
        row.attempts,
        envelopeHash,
        storedEnvelopeHash,
        envelope.target,
      ));
      continue;
    }
    if (
      row.status !== "failed" ||
      row.attempts !== requested.expectedAttempts ||
      row.updatedAt.getTime() !== new Date(requested.expectedUpdatedAt).getTime()
    ) {
      slots.push(targetMissingResult(
        row.id,
        "stale",
        row.attempts,
        envelopeHash,
        storedEnvelopeHash,
        envelope.target,
      ));
      continue;
    }

    // INVARIANT: lock the exact Main revision before Chat writes its terminal
    // receipt. The receiver endpoint is idempotent, so a Main commit failure can
    // be retried without either a false delivery or an orphaned stale decision.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "main_outbox_events"
      WHERE "id" = ${row.id}
        AND "status" = 'failed'
        AND "attempts" = ${requested.expectedAttempts}
        AND "updatedAt" = ${new Date(requested.expectedUpdatedAt)}
      FOR UPDATE
    `;
    if (locked.length !== 1) {
      slots.push(targetMissingResult(
        row.id,
        "stale",
        row.attempts,
        envelope.envelopeHash,
        storedEnvelopeHash,
        envelope.target,
      ));
      continue;
    }
    slots.push({ row, requested, envelope, storedEnvelopeHash });
  }

  const candidates = slots.filter((slot): slot is Candidate => "row" in slot);
  const receiverResults = candidates.length === 0
    ? []
    : await disposeReceiver(candidates.map((candidate) => ({
        envelope: candidate.envelope.envelope,
        expectedEnvelopeHash: candidate.envelope.envelopeHash,
        expectedTarget: candidate.requested.expectedTarget,
      })));
  const receiverById = new Map(
    receiverResults.map((result) => [result.sourceEventId, result]),
  );

  const results: FinalResult[] = [];
  for (const slot of slots) {
    if (!("row" in slot)) {
      results.push(slot);
      continue;
    }
    const receiver = receiverById.get(slot.row.id);
    if (!receiver) {
      throw Errors.unavailable("Chat receiver omitted terminal disposition evidence", {
        sourceEventId: slot.row.id,
      });
    }
    if (
      receiver.envelopeHash !== slot.envelope.envelopeHash ||
      !receiver.target ||
      !sameTarget(receiver.target, slot.requested.expectedTarget)
    ) {
      results.push(targetMissingResult(
        slot.row.id,
        "receiver_conflict",
        slot.row.attempts,
        slot.envelope.envelopeHash,
        slot.storedEnvelopeHash,
        slot.envelope.target,
        receiver.receiptId,
      ));
      continue;
    }
    if (receiver.outcome === "expected_target_present") {
      results.push(targetMissingResult(
        slot.row.id,
        "expected_target_present",
        slot.row.attempts,
        slot.envelope.envelopeHash,
        slot.storedEnvelopeHash,
        slot.envelope.target,
        receiver.receiptId,
      ));
      continue;
    }
    if (
      receiver.outcome !== "discarded_target_missing" &&
      receiver.outcome !== "already_discarded_target_missing"
    ) {
      results.push(targetMissingResult(
        slot.row.id,
        receiver.outcome === "invalid_envelope_hash"
          ? "envelope_hash_mismatch"
          : receiver.outcome === "expected_target_mismatch"
            ? "expected_target_mismatch"
            : receiver.outcome === "invalid_event_payload"
              ? "invalid_envelope"
              : "receiver_conflict",
        slot.row.attempts,
        slot.envelope.envelopeHash,
        slot.storedEnvelopeHash,
        slot.envelope.target,
        receiver.receiptId,
      ));
      continue;
    }
    if (!receiver.receiptId) {
      throw Errors.unavailable("Chat receiver terminal evidence has no receipt id", {
        sourceEventId: slot.row.id,
      });
    }

    const transitioned = await tx.mainOutboxEvent.updateMany({
      where: {
        id: slot.row.id,
        status: "failed",
        attempts: slot.requested.expectedAttempts,
        updatedAt: new Date(slot.requested.expectedUpdatedAt),
      },
      data: {
        status: "discarded_target_missing",
        deliveredAt: null,
      },
    });
    if (transitioned.count !== 1) {
      throw Errors.conflict("Main outbox revision changed while terminalizing", {
        sourceEventId: slot.row.id,
      });
    }
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "chat.main_outbox.discarded_target_missing",
        targetType: "main_to_chat_outbox_event",
        targetId: slot.row.id,
        reason: reasonText(input.body.reason),
        before: toInputJson({
          status: slot.row.status,
          attempts: slot.row.attempts,
          updatedAt: slot.row.updatedAt.toISOString(),
          lastErrorCode: errorCode(slot.row.lastError),
          lastErrorHash: slot.row.lastError === null
            ? null
            : canonicalSha256(slot.row.lastError),
          envelopeHash: slot.envelope.envelopeHash,
          storedEnvelopeHash: slot.storedEnvelopeHash,
          target: slot.envelope.target,
        }),
        after: toInputJson({
          status: "discarded_target_missing",
          attempts: slot.row.attempts,
          deliveredAt: null,
          envelopeHash: slot.envelope.envelopeHash,
          storedEnvelopeHash: slot.storedEnvelopeHash,
          receiverReceiptId: receiver.receiptId,
          target: slot.envelope.target,
          receiverTargetState: "missing",
          userEffectApplied: false,
        }),
        requestId: input.requestId,
      },
    });
    results.push(targetMissingResult(
      slot.row.id,
      "discarded_target_missing",
      slot.row.attempts,
      slot.envelope.envelopeHash,
      slot.storedEnvelopeHash,
      slot.envelope.target,
      receiver.receiptId,
    ));
  }

  return {
    results,
    discardedCount: results.filter(({ outcome }) =>
      outcome === "discarded_target_missing").length,
  };
}

function result(
  id: string,
  outcome:
    | "requeued"
    | "already_delivered"
    | "already_requeued"
    | "stale"
    | "invalid_envelope"
    | "receiver_target_missing"
    | "receiver_conflict"
    | "not_found",
  priorAttempts: number | null,
  envelopeHash: string | null,
  storedEnvelopeHash: string | null,
) {
  return { id, outcome, priorAttempts, envelopeHash, storedEnvelopeHash };
}

function targetMissingResult(
  id: string,
  outcome:
    | "discarded_target_missing"
    | "already_discarded_target_missing"
    | "already_delivered"
    | "already_requeued"
    | "stale"
    | "invalid_envelope"
    | "envelope_hash_mismatch"
    | "expected_target_mismatch"
    | "expected_target_present"
    | "receiver_conflict"
    | "not_found",
  priorAttempts: number | null = null,
  envelopeHash: string | null = null,
  storedEnvelopeHash: string | null = null,
  target: MainToChatTargetIdentity | null = null,
  receiverReceiptId: string | null = null,
) {
  return {
    id,
    outcome,
    priorAttempts,
    envelopeHash,
    storedEnvelopeHash,
    target,
    receiverReceiptId,
  };
}

function outcomeForCurrentStatus(status: string) {
  if (status === "delivered") return "already_delivered" as const;
  if (status === "pending") return "already_requeued" as const;
  return null;
}

function storedEnvelope(row: {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Prisma.JsonValue;
}) {
  const validation = validateMainToChatOutboxEnvelope(row);
  return validation.valid ? validation : null;
}

function errorMessage(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function errorCode(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const code = value.code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

function cursorString(value: unknown, scope: string) {
  if (typeof value !== "string" || !value) {
    throw Errors.badRequest(`${scope} cursor id is invalid`);
  }
  return value;
}

function reasonText(reason: MainToChatOutboxReplayRequest["reason"]) {
  return [reason.code, reason.summary, reason.details].filter(Boolean).join(": ");
}

function sameTarget(left: MainToChatTargetIdentity, right: MainToChatTargetIdentity) {
  return left.kind === right.kind && left.id === right.id;
}

async function receiverAuthorityForRows(rows: readonly {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Prisma.JsonValue;
}[]) {
  const envelopes = rows.flatMap((row) => {
    const validation = storedEnvelope(row);
    return validation ? [validation.envelope] : [];
  });
  try {
    const authority = envelopes.length === 0
      ? []
      : await inspectChatReceiverAuthority(envelopes);
    return {
      available: true,
      checkedAt: new Date().toISOString(),
      byId: new Map(authority.map((item) => [item.sourceEventId, item])),
    };
  } catch {
    return {
      available: false,
      checkedAt: new Date().toISOString(),
      byId: new Map<string, MainToChatReceiverAuthority>(),
    };
  }
}

function receiverAuthorityView(
  id: string,
  envelope: ReturnType<typeof storedEnvelope>,
  receiver: Awaited<ReturnType<typeof receiverAuthorityForRows>>,
) {
  if (!envelope) {
    return {
      disposition: "invalid_envelope" as const,
      target: null,
      targetStatus: null,
      receiptId: null,
      receiptStatus: null,
      checkedAt: receiver.checkedAt,
    };
  }
  const authority = receiver.byId.get(id);
  if (!receiver.available || !authority) {
    return {
      disposition: "unavailable" as const,
      target: envelope.target,
      targetStatus: null,
      receiptId: null,
      receiptStatus: null,
      checkedAt: receiver.checkedAt,
    };
  }
  return {
    disposition: authority.disposition,
    target: authority.target,
    targetStatus: authority.targetStatus,
    receiptId: authority.receipt?.receiptId ?? null,
    receiptStatus: authority.receipt?.status ?? null,
    checkedAt: receiver.checkedAt,
  };
}
