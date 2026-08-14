import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  IncidentCorrelationOutboxAttemptMissingDiscardRequest,
  IncidentCorrelationOutboxEventQuery,
  IncidentCorrelationOutboxReplayRequest,
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
import { isGenerationIncidentCorrelationReplayEligible } from "./service";

type Db = PrismaClient | Prisma.TransactionClient;
type JsonRecord = Record<string, unknown>;

const INCIDENT_CORRELATION_EVENT_TYPE = "generation.incident.correlate.v2";
const INCIDENT_CORRELATION_CURSOR_SCOPE = "incident-correlation-failed-outbox";

function record(value: Prisma.JsonValue | null): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function payloadAttemptId(payload: Prisma.JsonValue) {
  const value = record(payload).attemptId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorText(value: Prisma.JsonValue | null, key: "code" | "message") {
  const candidate = record(value)[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : null;
}

function cursorId(value: unknown) {
  if (typeof value !== "string" || !value) {
    throw Errors.badRequest(`${INCIDENT_CORRELATION_CURSOR_SCOPE} cursor id is invalid`);
  }
  return value;
}

export async function listFailedIncidentCorrelationOutboxEvents(
  request: Request,
  db: Db = prisma,
) {
  await actorWithPermission(request, "ops.incident.read");
  const query = queryParams(
    request,
    "GET /api/v2/admin/incidents/correlation-outbox",
  ) as IncidentCorrelationOutboxEventQuery;
  const queryIdentity = { status: query.status };
  const cursor = query.cursor
    ? decodeAdminListCursor(
        query.cursor,
        INCIDENT_CORRELATION_CURSOR_SCOPE,
        queryIdentity,
      )
    : undefined;
  if (cursor && cursor.length !== 2) {
    throw Errors.badRequest(`${INCIDENT_CORRELATION_CURSOR_SCOPE} cursor key count is invalid`);
  }
  const cursorUpdatedAt = cursor
    ? parseIsoCursorKey(cursor[0], INCIDENT_CORRELATION_CURSOR_SCOPE)
    : undefined;
  const cursorEventId = cursor ? cursorId(cursor[1]) : undefined;
  const rows = await db.mainOutboxEvent.findMany({
    where: {
      eventType: INCIDENT_CORRELATION_EVENT_TYPE,
      status: "failed",
      ...(cursorUpdatedAt && cursorEventId
        ? {
            OR: [
              { updatedAt: { lt: cursorUpdatedAt } },
              { updatedAt: cursorUpdatedAt, id: { lt: cursorEventId } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
  });
  const hasNextPage = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const attemptIds = [...new Set(page.flatMap((row) => {
    const attemptId = payloadAttemptId(row.payload);
    return attemptId ? [attemptId] : [];
  }))];
  const attempts = attemptIds.length
    ? await db.generationAttempt.findMany({ where: { id: { in: attemptIds } } })
    : [];
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const last = page.at(-1);

  return {
    items: page.map((row) => {
      const attemptId = payloadAttemptId(row.payload);
      const attempt = attemptId ? attemptsById.get(attemptId) ?? null : null;
      const replayEligibility = !attemptId
        ? "invalid_payload" as const
        : !attempt
          ? "attempt_missing" as const
          : !isGenerationIncidentCorrelationReplayEligible(attempt)
            ? "attempt_not_correlatable" as const
            : "eligible" as const;
      return {
        id: row.id,
        eventType: INCIDENT_CORRELATION_EVENT_TYPE,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        status: "failed" as const,
        attempts: row.attempts,
        attemptId,
        attemptStatus: attempt?.status ?? null,
        replayEligibility,
        lastErrorCode: errorText(row.lastError, "code"),
        lastErrorMessage: errorText(row.lastError, "message"),
        payloadHash: canonicalSha256(row.payload),
        nextRunAt: row.nextRunAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor(
            INCIDENT_CORRELATION_CURSOR_SCOPE,
            queryIdentity,
            [last.updatedAt.toISOString(), last.id],
          )
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh" as const,
  };
}

export async function replayFailedIncidentCorrelationOutboxEvents(
  input: {
    readonly body: IncidentCorrelationOutboxReplayRequest;
    readonly actor: AdminActor;
    readonly requestId: string;
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
      | "payload_hash_mismatch"
      | "invalid_payload"
      | "attempt_missing"
      | "attempt_not_correlatable"
      | "not_found";
    priorAttempts: number | null;
    payloadHash: string | null;
  }> = [];

  for (const requested of input.body.events) {
    const row = await tx.mainOutboxEvent.findFirst({
      where: { id: requested.id, eventType: INCIDENT_CORRELATION_EVENT_TYPE },
    });
    if (!row) {
      results.push(replayResult(requested.id, "not_found"));
      continue;
    }
    const payloadHash = canonicalSha256(row.payload);
    if (row.status === "delivered") {
      results.push(replayResult(row.id, "already_delivered", row.attempts, payloadHash));
      continue;
    }
    if (row.status === "pending" || row.status === "dispatched") {
      results.push(replayResult(row.id, "already_requeued", row.attempts, payloadHash));
      continue;
    }
    if (payloadHash !== requested.expectedPayloadHash) {
      results.push(replayResult(row.id, "payload_hash_mismatch", row.attempts, payloadHash));
      continue;
    }
    if (
      row.status !== "failed" ||
      row.attempts !== requested.expectedAttempts ||
      row.updatedAt.getTime() !== new Date(requested.expectedUpdatedAt).getTime()
    ) {
      results.push(replayResult(row.id, "stale", row.attempts, payloadHash));
      continue;
    }
    const attemptId = payloadAttemptId(row.payload);
    if (!attemptId) {
      results.push(replayResult(row.id, "invalid_payload", row.attempts, payloadHash));
      continue;
    }
    const attempt = await tx.generationAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt) {
      results.push(replayResult(row.id, "attempt_missing", row.attempts, payloadHash));
      continue;
    }
    if (!isGenerationIncidentCorrelationReplayEligible(attempt)) {
      results.push(replayResult(row.id, "attempt_not_correlatable", row.attempts, payloadHash));
      continue;
    }

    const nextRunAt = new Date();
    const transitioned = await tx.mainOutboxEvent.updateMany({
      where: {
        id: row.id,
        eventType: INCIDENT_CORRELATION_EVENT_TYPE,
        status: "failed",
        attempts: requested.expectedAttempts,
        updatedAt: new Date(requested.expectedUpdatedAt),
      },
      data: {
        // INVARIANT: replay returns the original carrier to the worker. The
        // HTTP request never correlates an Incident and never rewrites payload.
        status: "pending",
        attempts: 0,
        nextRunAt,
        deliveredAt: null,
        lastError: Prisma.DbNull,
      },
    });
    if (transitioned.count === 0) {
      const current = await tx.mainOutboxEvent.findFirst({
        where: { id: row.id, eventType: INCIDENT_CORRELATION_EVENT_TYPE },
        select: { status: true, attempts: true },
      });
      const outcome = current?.status === "delivered"
        ? "already_delivered" as const
        : current && ["pending", "dispatched"].includes(current.status)
          ? "already_requeued" as const
          : "stale" as const;
      results.push(replayResult(
        row.id,
        outcome,
        current?.attempts ?? null,
        payloadHash,
      ));
      continue;
    }

    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "incident.correlation_outbox.replayed",
        targetType: "incident_correlation_outbox_event",
        targetId: row.id,
        reason: reasonText(input.body.reason),
        before: toInputJson({
          eventType: row.eventType,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          status: row.status,
          attempts: row.attempts,
          updatedAt: row.updatedAt.toISOString(),
          payloadHash,
          lastErrorCode: errorText(row.lastError, "code"),
          lastErrorHash: row.lastError === null
            ? null
            : canonicalSha256(row.lastError),
        }),
        after: toInputJson({
          eventType: row.eventType,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          status: "pending",
          attempts: 0,
          nextRunAt: nextRunAt.toISOString(),
          payloadHash,
          payloadPreserved: true,
          businessEffectApplied: false,
          consumer: "admin-command-worker",
        }),
        requestId: input.requestId,
      },
    });
    results.push(replayResult(row.id, "requeued", row.attempts, payloadHash));
  }

  return {
    results,
    requeuedCount: results.filter(({ outcome }) => outcome === "requeued").length,
  };
}

export async function discardAttemptMissingIncidentCorrelationOutboxEvent(
  input: {
    readonly body: IncidentCorrelationOutboxAttemptMissingDiscardRequest;
    readonly actor: AdminActor;
    readonly requestId: string;
  },
  tx: Prisma.TransactionClient,
) {
  const requested = input.body;
  // INVARIANT: the operator decision is valid only for one locked carrier
  // revision; every status, payload and source-authority check below observes
  // that same row until the terminal transition commits.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "main_outbox_events"
    WHERE "id" = ${requested.id}
    FOR UPDATE
  `;
  if (locked.length !== 1) {
    return attemptMissingDiscardResult(requested.id, "not_found");
  }

  const row = await tx.mainOutboxEvent.findUnique({
    where: { id: requested.id },
  });
  if (!row || row.eventType !== INCIDENT_CORRELATION_EVENT_TYPE) {
    return attemptMissingDiscardResult(requested.id, "not_found");
  }
  const payloadHash = canonicalSha256(row.payload);
  if (payloadHash !== requested.expectedPayloadHash) {
    return attemptMissingDiscardResult(
      row.id,
      "payload_hash_mismatch",
      row.attempts,
      payloadHash,
    );
  }
  const attemptId = payloadAttemptId(row.payload);
  if (!attemptId) {
    return attemptMissingDiscardResult(
      row.id,
      "invalid_payload",
      row.attempts,
      payloadHash,
    );
  }
  if (
    attemptId !== requested.expectedAttemptId ||
    row.aggregateType !== "generation_attempt" ||
    row.aggregateId !== requested.expectedAttemptId
  ) {
    return attemptMissingDiscardResult(
      row.id,
      "attempt_id_mismatch",
      row.attempts,
      payloadHash,
    );
  }
  if (row.status === "discarded_target_missing") {
    return attemptMissingDiscardResult(
      row.id,
      "already_discarded_target_missing",
      row.attempts,
      payloadHash,
    );
  }
  if (row.status === "delivered") {
    return attemptMissingDiscardResult(
      row.id,
      "already_delivered",
      row.attempts,
      payloadHash,
    );
  }
  if (row.status === "pending" || row.status === "dispatched") {
    return attemptMissingDiscardResult(
      row.id,
      "already_requeued",
      row.attempts,
      payloadHash,
    );
  }
  if (
    row.status !== "failed" ||
    row.attempts !== requested.expectedAttempts ||
    row.updatedAt.getTime() !== new Date(requested.expectedUpdatedAt).getTime()
  ) {
    return attemptMissingDiscardResult(
      row.id,
      "stale",
      row.attempts,
      payloadHash,
    );
  }

  const attempt = await tx.generationAttempt.findUnique({
    where: { id: requested.expectedAttemptId },
    select: { id: true },
  });
  if (attempt) {
    return attemptMissingDiscardResult(
      row.id,
      "attempt_present",
      row.attempts,
      payloadHash,
    );
  }

  const transitioned = await tx.mainOutboxEvent.updateMany({
    where: {
      id: row.id,
      eventType: INCIDENT_CORRELATION_EVENT_TYPE,
      status: "failed",
      attempts: requested.expectedAttempts,
      updatedAt: new Date(requested.expectedUpdatedAt),
    },
    data: {
      // INTENT: Main outbox already recognizes this terminal status. Audit
      // evidence below narrows the reason to a missing GenerationAttempt source
      // authority, so no parallel status vocabulary or DB migration is needed.
      status: "discarded_target_missing",
    },
  });
  if (transitioned.count !== 1) {
    throw Errors.conflict(
      "Incident correlation outbox revision changed while terminalizing",
      { eventId: row.id },
    );
  }

  const lastErrorHash = row.lastError === null
    ? null
    : canonicalSha256(row.lastError);
  await tx.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "incident.correlation_outbox.discarded_attempt_missing",
      targetType: "incident_correlation_outbox_event",
      targetId: row.id,
      reason: reasonText(requested.reason),
      before: toInputJson({
        eventType: row.eventType,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        status: row.status,
        attempts: row.attempts,
        updatedAt: row.updatedAt.toISOString(),
        payloadHash,
        expectedAttemptId: requested.expectedAttemptId,
        lastErrorHash,
      }),
      after: toInputJson({
        eventType: row.eventType,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        status: "discarded_target_missing",
        attempts: row.attempts,
        payloadHash,
        expectedAttemptId: requested.expectedAttemptId,
        lastErrorHash,
        payloadPreserved: true,
        lastErrorPreserved: true,
        userEffectApplied: false,
        sourceAuthorityMissing: true,
      }),
      requestId: input.requestId,
    },
  });

  return attemptMissingDiscardResult(
    row.id,
    "discarded_target_missing",
    row.attempts,
    payloadHash,
  );
}

function replayResult(
  id: string,
  outcome:
    | "requeued"
    | "already_delivered"
    | "already_requeued"
    | "stale"
    | "payload_hash_mismatch"
    | "invalid_payload"
    | "attempt_missing"
    | "attempt_not_correlatable"
    | "not_found",
  priorAttempts: number | null = null,
  payloadHash: string | null = null,
) {
  return { id, outcome, priorAttempts, payloadHash };
}

function attemptMissingDiscardResult(
  id: string,
  outcome:
    | "discarded_target_missing"
    | "already_discarded_target_missing"
    | "already_delivered"
    | "already_requeued"
    | "stale"
    | "payload_hash_mismatch"
    | "invalid_payload"
    | "attempt_id_mismatch"
    | "attempt_present"
    | "not_found",
  priorAttempts: number | null = null,
  payloadHash: string | null = null,
) {
  return { id, outcome, priorAttempts, payloadHash };
}

function reasonText(
  reason:
    | IncidentCorrelationOutboxReplayRequest["reason"]
    | IncidentCorrelationOutboxAttemptMissingDiscardRequest["reason"],
) {
  return [reason.code, reason.summary, reason.details].filter(Boolean).join(": ");
}
