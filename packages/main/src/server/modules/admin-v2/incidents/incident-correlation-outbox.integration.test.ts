import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  incidentCorrelationOutboxEventListResponseSchema,
  incidentCorrelationOutboxReplayRequestSchema,
  incidentCorrelationOutboxReplayResultSchema,
} from "@idream/shared/admin";
import { GET as listIncidentCorrelationOutboxRoute } from "@/app/api/v2/admin/incidents/correlation-outbox/route";
import { POST as replayIncidentCorrelationOutboxRoute } from "@/app/api/v2/admin/incidents/correlation-outbox/commands/replay/route";
import { prisma } from "@/server/lib/db";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { dispatchGenerationIncidentCorrelation } from "./service";

const suffix = randomUUID();
const prefix = `incident-correlation-replay-${suffix}`;
const generationUserId = `${prefix}-customer`;
const routeActors = {
  authorized: `${prefix}-admin`,
  missingIncidentRead: `${prefix}-no-incident-read`,
  missingQueueRead: `${prefix}-no-queue-read`,
  missingIncidentManage: `${prefix}-no-incident-manage`,
  missingDeadletterWrite: `${prefix}-no-deadletter-write`,
} as const;
const routeActorIds = Object.values(routeActors);
const validAttemptId = `${prefix}-attempt-valid`;
const invalidAttemptId = `${prefix}-attempt-uncorrelatable`;
const attemptIds = [validAttemptId, invalidAttemptId];
const jobIds = [`${prefix}-job-valid`, `${prefix}-job-uncorrelatable`];

function correlationPayload(attemptId: string) {
  return {
    attemptId,
    terminalEventId: `${attemptId}:failed`,
    outcome: "failed",
  };
}

async function failedRow(
  id: string,
  attemptId: string | null = validAttemptId,
  payload: unknown = attemptId ? correlationPayload(attemptId) : {},
) {
  return prisma.mainOutboxEvent.create({
    data: {
      id,
      eventType: "generation.incident.correlate.v2",
      aggregateType: "generation_attempt",
      aggregateId: attemptId ?? id,
      payload: toInputJson(payload),
      status: "failed",
      attempts: 8,
      lastError: toInputJson({
        code: "incident_correlation_failed",
        message: "temporary database outage",
      }),
    },
  });
}

function replayBody(events: Array<{
  id: string;
  expectedAttempts: number;
  expectedUpdatedAt: string;
  expectedPayloadHash: string;
}>) {
  return incidentCorrelationOutboxReplayRequestSchema.parse({
    events,
    reason: {
      code: "dependency_recovered",
      summary: "Replay exact correlation carriers",
    },
    confirmation: "REPLAY_INCIDENT_CORRELATION_FAILED",
  });
}

function replayRequest(input: {
  readonly actorId?: string;
  readonly body: ReturnType<typeof replayBody>;
  readonly idempotencyKey?: string;
}) {
  return new Request(
    "http://localhost/api/v2/admin/incidents/correlation-outbox/commands/replay",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": input.actorId ?? routeActors.authorized,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
        ...(input.idempotencyKey
          ? { "idempotency-key": input.idempotencyKey }
          : {}),
      },
      body: JSON.stringify(input.body),
    },
  );
}

async function replayData(response: Response) {
  const envelope = await response.json() as { readonly data?: unknown };
  return incidentCorrelationOutboxReplayResultSchema.parse(envelope.data);
}

describe("Incident correlation failed outbox operator recovery", () => {
  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: generationUserId,
          email: `${generationUserId}@example.test`,
          role: "user",
          status: "active",
        },
        ...routeActorIds.map((id) => ({
          id,
          email: `${id}@example.test`,
          role: "admin",
          status: "active",
        })),
      ],
    });
    await prisma.adminUserPermission.createMany({
      data: [
        [routeActors.missingIncidentRead, "ops.incident.read"],
        [routeActors.missingQueueRead, "ops.queue.read"],
        [routeActors.missingIncidentManage, "ops.incident.manage"],
        [routeActors.missingDeadletterWrite, "ops.deadletter.write"],
      ].map(([userId, permissionKey]) => ({
        userId: userId!,
        permissionKey: permissionKey!,
        effect: "revoke",
        reason: "Incident correlation route permission regression",
        createdById: routeActors.authorized,
      })),
    });
    await prisma.generationJob.createMany({
      data: jobIds.map((id) => ({
        id,
        userId: generationUserId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
      })),
    });
    await prisma.generationAttempt.createMany({
      data: [
        {
          id: validAttemptId,
          requestId: jobIds[0],
          attemptNo: 1,
          provider: "comfyui",
          profileKey: "portrait-v3",
          workflowKey: "image-v2",
          status: "failed",
          errorClass: "gateway_timeout",
          errorSignature: "normalized_gateway_timeout",
          retryability: "operator_retry",
          finishedAt: new Date("2026-08-11T12:00:00.000Z"),
        },
        {
          id: invalidAttemptId,
          requestId: jobIds[1],
          attemptNo: 1,
          provider: "comfyui",
          status: "failed",
          errorClass: "gateway_timeout",
          errorSignature: "normalized_gateway_timeout",
          retryability: "operator_retry",
          finishedAt: new Date("2026-08-11T12:00:00.000Z"),
        },
      ],
    });
  });

  afterAll(async () => {
    const occurrences = await prisma.opsIncidentOccurrence.findMany({
      where: { attemptId: { in: attemptIds } },
      select: { incidentId: true },
    });
    const incidentIds = [...new Set(occurrences.map(({ incidentId }) => incidentId))];
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId: { in: routeActorIds } },
    });
    await prisma.adminAuditLog.deleteMany({
      where: {
        OR: [
          { targetId: { startsWith: prefix } },
          { targetId: { in: incidentIds } },
        ],
      },
    });
    await prisma.mainOutboxEvent.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.opsIncidentOccurrence.deleteMany({ where: { attemptId: { in: attemptIds } } });
    await prisma.opsIncident.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { in: attemptIds } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.adminUserPermission.deleteMany({ where: { userId: { in: routeActorIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [...routeActorIds, generationUserId] } } });
    await prisma.$disconnect();
  });

  it.each([
    [routeActors.missingIncidentRead, "ops.incident.read"],
    [routeActors.missingQueueRead, "ops.queue.read"],
  ] as const)("fails list closed when %s lacks %s", async (actorId, permission) => {
    const response = await listIncidentCorrelationOutboxRoute(new Request(
      "http://localhost/api/v2/admin/incidents/correlation-outbox?status=failed&limit=50",
      { headers: { "x-idream-user-id": actorId, "x-idream-role": "admin" } },
    ));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "forbidden", details: { permission } },
    });
  });

  it("lists only exact failed correlation carriers with replay eligibility", async () => {
    const eligible = await failedRow(`${prefix}-list-eligible`);
    const missing = await failedRow(
      `${prefix}-list-missing-attempt`,
      `${prefix}-attempt-missing`,
    );
    const invalid = await failedRow(`${prefix}-list-invalid`, null);
    const notCorrelatable = await failedRow(
      `${prefix}-list-not-correlatable`,
      invalidAttemptId,
    );
    await prisma.mainOutboxEvent.create({
      data: {
        id: `${prefix}-unrelated-chat-event`,
        eventType: "chat.message.persisted.v1",
        aggregateType: "chat_message",
        aggregateId: `${prefix}-message`,
        payload: {},
        status: "failed",
        attempts: 8,
      },
    });

    const response = await listIncidentCorrelationOutboxRoute(new Request(
      "http://localhost/api/v2/admin/incidents/correlation-outbox?status=failed&limit=100",
      {
        headers: {
          "x-idream-user-id": routeActors.authorized,
          "x-idream-role": "admin",
        },
      },
    ));
    expect(response.status).toBe(200);
    const envelope = await response.json() as { readonly data?: unknown };
    const list = incidentCorrelationOutboxEventListResponseSchema.parse(envelope.data);
    const byId = new Map(list.items.map((item) => [item.id, item]));
    expect(byId.get(eligible.id)).toMatchObject({
      replayEligibility: "eligible",
      attemptId: validAttemptId,
      attemptStatus: "failed",
      payloadHash: canonicalSha256(eligible.payload),
    });
    expect(byId.get(missing.id)?.replayEligibility).toBe("attempt_missing");
    expect(byId.get(invalid.id)?.replayEligibility).toBe("invalid_payload");
    expect(byId.get(notCorrelatable.id)?.replayEligibility).toBe("attempt_not_correlatable");
    expect(byId.has(`${prefix}-unrelated-chat-event`)).toBe(false);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: eligible.id } }))
      .resolves.toMatchObject({ status: "failed", attempts: 8 });
  });

  it.each([
    [routeActors.missingIncidentManage, "ops.incident.manage"],
    [routeActors.missingDeadletterWrite, "ops.deadletter.write"],
  ] as const)("fails replay closed when %s lacks %s", async (actorId, permission) => {
    const response = await replayIncidentCorrelationOutboxRoute(replayRequest({
      actorId,
      body: replayBody([{
        id: `${prefix}-permission-probe`,
        expectedAttempts: 8,
        expectedUpdatedAt: "2026-08-11T12:00:00.000Z",
        expectedPayloadHash: "a".repeat(64),
      }]),
      idempotencyKey: `${prefix}-${actorId}-permission`,
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "forbidden", details: { permission } },
    });
    await expect(prisma.controlPlaneCommand.count({ where: { actorId } })).resolves.toBe(0);
  });

  it("requires an idempotency key before touching the failed carrier", async () => {
    const row = await failedRow(`${prefix}-missing-idempotency`);
    const response = await replayIncidentCorrelationOutboxRoute(replayRequest({
      body: replayBody([{
        id: row.id,
        expectedAttempts: row.attempts,
        expectedUpdatedAt: row.updatedAt.toISOString(),
        expectedPayloadHash: canonicalSha256(row.payload),
      }]),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_request", message: "Idempotency-Key header is required" },
    });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ status: "failed", attempts: 8 });
  });

  it("idempotently requeues the unchanged carrier and leaves correlation to the worker", async () => {
    const row = await failedRow(`${prefix}-route-replay`);
    const payloadHash = canonicalSha256(row.payload);
    const body = replayBody([{
      id: row.id,
      expectedAttempts: row.attempts,
      expectedUpdatedAt: row.updatedAt.toISOString(),
      expectedPayloadHash: payloadHash,
    }]);
    const idempotencyKey = `${prefix}-same-command`;
    await expect(prisma.opsIncidentOccurrence.count({ where: { attemptId: validAttemptId } }))
      .resolves.toBe(0);

    const firstResponse = await replayIncidentCorrelationOutboxRoute(replayRequest({
      body,
      idempotencyKey,
    }));
    expect(firstResponse.status).toBe(200);
    const first = await replayData(firstResponse);
    expect(first).toMatchObject({
      replayed: false,
      requeuedCount: 1,
      results: [{ id: row.id, outcome: "requeued", priorAttempts: 8, payloadHash }],
    });
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
      .toMatchObject({
        status: "pending",
        attempts: 0,
        payload: row.payload,
        deliveredAt: null,
        lastError: null,
      });
    await expect(prisma.opsIncidentOccurrence.count({ where: { attemptId: validAttemptId } }))
      .resolves.toBe(0);

    const replayResponse = await replayIncidentCorrelationOutboxRoute(replayRequest({
      body,
      idempotencyKey,
    }));
    expect(replayResponse.status).toBe(200);
    expect(await replayData(replayResponse)).toEqual({ ...first, replayed: true });
    await expect(prisma.adminAuditLog.count({
      where: { targetId: row.id, action: "incident.correlation_outbox.replayed" },
    })).resolves.toBe(1);
    await expect(prisma.controlPlaneCommand.findFirstOrThrow({
      where: { actorId: routeActors.authorized, idempotencyKey },
    })).resolves.toMatchObject({
      commandType: "incident.correlation_outbox.replay",
      targetType: "incident_correlation_outbox_batch",
      status: "succeeded",
    });

    await prisma.mainOutboxEvent.update({
      where: { id: row.id },
      data: { nextRunAt: new Date(0) },
    });
    await expect(dispatchGenerationIncidentCorrelation(prisma, { outboxIds: [row.id] }))
      .resolves.toMatchObject({ examined: 1, correlated: 1, failed: 0 });
    await expect(prisma.opsIncidentOccurrence.count({ where: { attemptId: validAttemptId } }))
      .resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ status: "delivered", payload: row.payload });
  });

  it("leaves stale, changed, invalid, and uncorrelatable carriers untouched", async () => {
    const changed = await failedRow(`${prefix}-changed-payload`);
    const stale = await failedRow(`${prefix}-stale-revision`);
    const invalid = await failedRow(`${prefix}-invalid-payload`, null);
    const missing = await failedRow(
      `${prefix}-missing-attempt`,
      `${prefix}-never-created-attempt`,
    );
    const notCorrelatable = await failedRow(
      `${prefix}-not-correlatable`,
      invalidAttemptId,
    );
    const result = await prisma.$transaction(async (tx) => {
      const { replayFailedIncidentCorrelationOutboxEvents } = await import("./correlation-outbox");
      return replayFailedIncidentCorrelationOutboxEvents({
        body: replayBody([
          {
            id: changed.id,
            expectedAttempts: changed.attempts,
            expectedUpdatedAt: changed.updatedAt.toISOString(),
            expectedPayloadHash: "f".repeat(64),
          },
          {
            id: stale.id,
            expectedAttempts: stale.attempts - 1,
            expectedUpdatedAt: stale.updatedAt.toISOString(),
            expectedPayloadHash: canonicalSha256(stale.payload),
          },
          {
            id: invalid.id,
            expectedAttempts: invalid.attempts,
            expectedUpdatedAt: invalid.updatedAt.toISOString(),
            expectedPayloadHash: canonicalSha256(invalid.payload),
          },
          {
            id: missing.id,
            expectedAttempts: missing.attempts,
            expectedUpdatedAt: missing.updatedAt.toISOString(),
            expectedPayloadHash: canonicalSha256(missing.payload),
          },
          {
            id: notCorrelatable.id,
            expectedAttempts: notCorrelatable.attempts,
            expectedUpdatedAt: notCorrelatable.updatedAt.toISOString(),
            expectedPayloadHash: canonicalSha256(notCorrelatable.payload),
          },
        ]),
        actor: { id: routeActors.authorized, role: "admin" },
        requestId: `${prefix}-partial-request`,
      }, tx);
    });
    expect(result).toMatchObject({
      requeuedCount: 0,
      results: [
        { id: changed.id, outcome: "payload_hash_mismatch" },
        { id: stale.id, outcome: "stale" },
        { id: invalid.id, outcome: "invalid_payload" },
        { id: missing.id, outcome: "attempt_missing" },
        { id: notCorrelatable.id, outcome: "attempt_not_correlatable" },
      ],
    });
    await expect(prisma.mainOutboxEvent.count({
      where: {
        id: { in: [changed.id, stale.id, invalid.id, missing.id, notCorrelatable.id] },
        status: "failed",
        attempts: 8,
      },
    })).resolves.toBe(5);
  });
});
