import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mainToChatOutboxReplayRequestSchema,
  mainToChatOutboxReplayResultSchema,
  mainToChatOutboxEventListResponseSchema,
  mainToChatOutboxTargetMissingDispositionRequestSchema,
  mainToChatOutboxTargetMissingDispositionResultSchema,
} from "@idream/shared/admin";
import {
  MAIN_TO_CHAT_EVENTS,
  durableEnvelopeHash,
  type DurableEventEnvelope,
} from "@idream/shared/contracts";
import { POST as replayMainToChatOutboxRoute } from "@/app/api/v2/admin/chat/main-outbox-events/commands/replay/route";
import { GET as listMainToChatOutboxRoute } from "@/app/api/v2/admin/chat/main-outbox-events/route";
import { POST as discardTargetMissingRoute } from "@/app/api/v2/admin/chat/main-outbox-events/commands/discard-target-missing/route";
import { prisma } from "@/server/lib/db";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { replayFailedMainToChatOutboxEvents } from "./main-outbox-events";
import { discardTargetMissingMainToChatOutboxEvents } from "./main-outbox-events";

const prefix = `main-chat-replay-${process.pid}`;
const actor = { id: `${prefix}-admin`, role: "admin" as const };
const routeActors = {
  authorized: `${prefix}-route-admin`,
  missingChatRead: `${prefix}-route-no-chat-read`,
  missingDeadletterWrite: `${prefix}-route-no-deadletter-write`,
} as const;
const routeActorIds = Object.values(routeActors);
const originalFetch = globalThis.fetch;

function envelope(id: string, eventType = MAIN_TO_CHAT_EVENTS.chatImageFailed) {
  return {
    sourceService: "main",
    sourceEventId: id,
    eventType,
    schemaVersion: 1,
    occurredAt: "2026-08-11T12:00:00.000Z",
    aggregateType: "chat_image",
    aggregateId: `${id}-aggregate`,
    payload: {
      version: 1,
      kind: "chat.image.failed",
      attachmentId: `${id}-attachment`,
      generationJobId: `${id}-request`,
      status: "failed",
      errorCode: "provider_unavailable",
    },
  };
}

async function failedRow(id: string, payload: unknown = envelope(id)) {
  const parsed = payload as ReturnType<typeof envelope>;
  return prisma.mainOutboxEvent.create({
    data: {
      id,
      eventType: parsed.eventType ?? MAIN_TO_CHAT_EVENTS.chatImageFailed,
      aggregateType: parsed.aggregateType ?? "chat_image",
      aggregateId: parsed.aggregateId ?? `${id}-aggregate`,
      payload: toInputJson(payload),
      status: "failed",
      attempts: 8,
      lastError: toInputJson({ message: "chat durable ingest returned 503" }),
    },
  });
}

async function replay(
  events: Array<{ id: string; expectedAttempts: number; expectedUpdatedAt: string }>,
) {
  const body = replayBody(events);
  return prisma.$transaction((tx) =>
    replayFailedMainToChatOutboxEvents(
      { body, actor, requestId: `${prefix}-request` },
      tx,
    ),
  );
}

function replayBody(
  events: Array<{ id: string; expectedAttempts: number; expectedUpdatedAt: string }>,
) {
  return mainToChatOutboxReplayRequestSchema.parse({
    events,
    reason: {
      code: "chat_ingest_recovered",
      summary: "Replay exact failed envelopes",
    },
    confirmation: "REPLAY_MAIN_TO_CHAT_FAILED",
  });
}

function routeRequest(input: {
  readonly actorId?: string;
  readonly body: ReturnType<typeof replayBody>;
  readonly idempotencyKey?: string;
}) {
  return new Request(
    "http://localhost/api/v2/admin/chat/main-outbox-events/commands/replay",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": input.actorId ?? routeActors.authorized,
        "x-idream-role": "admin",
        "x-request-id": crypto.randomUUID(),
        ...(input.idempotencyKey
          ? { "idempotency-key": input.idempotencyKey }
          : {}),
      },
      body: JSON.stringify(input.body),
    },
  );
}

async function routeData(response: Response) {
  const envelope = await response.json() as { readonly data?: unknown };
  return mainToChatOutboxReplayResultSchema.parse(envelope.data);
}

describe("Main to Chat failed outbox replay", () => {
  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/internal/events/main-outbox-authority")) {
        const body = JSON.parse(String(init?.body)) as {
          events: ReturnType<typeof envelope>[];
        };
        return Response.json({
          results: body.events.map((event) => ({
            sourceEventId: event.sourceEventId,
            envelopeHash: durableEnvelopeHash(event),
            disposition: event.sourceEventId.includes("list-target-missing")
              ? "expected_target_missing"
              : "target_present",
            target: {
              kind: "attachment",
              id: event.payload.attachmentId,
            },
            targetStatus: event.sourceEventId.includes("list-target-missing")
              ? null
              : "failed",
            receipt: null,
          })),
        });
      }
      if (url.endsWith("/internal/events/discard-target-missing")) {
        const body = JSON.parse(String(init?.body)) as {
          events: Array<{
            envelope: ReturnType<typeof envelope>;
            expectedEnvelopeHash: string;
            expectedTarget: { kind: "attachment" | "session"; id: string };
          }>;
        };
        return Response.json({
          results: body.events.map((event) => ({
            sourceEventId: event.envelope.sourceEventId,
            outcome: "discarded_target_missing",
            envelopeHash: event.expectedEnvelopeHash,
            target: event.expectedTarget,
            targetStatus: null,
            receiptId: `main:${event.envelope.sourceEventId}`,
          })),
        });
      }
      return originalFetch(input, init);
    });
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId: { in: routeActorIds } },
    });
    await prisma.adminUserPermission.deleteMany({
      where: { userId: { in: routeActorIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: routeActorIds } } });
    await prisma.adminAuditLog.deleteMany({
      where: { targetId: { startsWith: prefix } },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: { id: { startsWith: prefix } },
    });
    await prisma.user.createMany({
      data: routeActorIds.map((id) => ({
        id,
        email: `${id}@example.test`,
        role: "admin",
        status: "active",
      })),
    });
    await prisma.adminUserPermission.createMany({
      data: [
        {
          userId: routeActors.missingChatRead,
          permissionKey: "chat.ops.read",
          effect: "revoke",
          reason: "Main to Chat route permission regression",
          createdById: routeActors.authorized,
        },
        {
          userId: routeActors.missingDeadletterWrite,
          permissionKey: "ops.deadletter.write",
          effect: "revoke",
          reason: "Main to Chat route permission regression",
          createdById: routeActors.authorized,
        },
      ],
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId: { in: routeActorIds } },
    });
    await prisma.adminAuditLog.deleteMany({
      where: { targetId: { startsWith: prefix } },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: { id: { startsWith: prefix } },
    });
    await prisma.adminUserPermission.deleteMany({
      where: { userId: { in: routeActorIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: routeActorIds } } });
  });

  it.each([
    [routeActors.missingChatRead, "chat.ops.read"],
    [routeActors.missingDeadletterWrite, "ops.deadletter.write"],
  ] as const)(
    "rejects replay when %s lacks %s",
    async (actorId, missingPermission) => {
      const response = await replayMainToChatOutboxRoute(routeRequest({
        actorId,
        body: replayBody([{
          id: `${prefix}-permission-probe`,
          expectedAttempts: 8,
          expectedUpdatedAt: "2026-08-11T12:00:00.000Z",
        }]),
        idempotencyKey: `${prefix}-permission-key`,
      }));

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: {
          code: "forbidden",
          details: { permission: missingPermission },
        },
      });
      await expect(prisma.controlPlaneCommand.count({ where: { actorId } }))
        .resolves.toBe(0);
    },
  );

  it("requires Idempotency-Key before replaying a failed envelope", async () => {
    const row = await failedRow(`${prefix}-missing-idempotency-key`);
    const response = await replayMainToChatOutboxRoute(routeRequest({
      body: replayBody([{
        id: row.id,
        expectedAttempts: row.attempts,
        expectedUpdatedAt: row.updatedAt.toISOString(),
      }]),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "bad_request",
        message: "Idempotency-Key header is required",
      },
    });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ status: "failed", attempts: 8 });
    await expect(prisma.adminAuditLog.count({ where: { targetId: row.id } }))
      .resolves.toBe(0);
  });

  it("lists current Chat receiver target-missing evidence without mutating the row", async () => {
    const row = await failedRow(`${prefix}-list-target-missing`);
    const response = await listMainToChatOutboxRoute(new Request(
      "http://localhost/api/v2/admin/chat/main-outbox-events?status=failed&limit=100",
      {
        headers: {
          "x-idream-user-id": routeActors.authorized,
          "x-idream-role": "admin",
        },
      },
    ));
    expect(response.status).toBe(200);
    const payload = await response.json() as { data?: unknown };
    const list = mainToChatOutboxEventListResponseSchema.parse(payload.data);
    expect(list.items.find(({ id }) => id === row.id)).toMatchObject({
      id: row.id,
      status: "failed",
      receiverAuthority: {
        disposition: "expected_target_missing",
        target: { kind: "attachment", id: `${row.id}-attachment` },
        targetStatus: null,
        receiptId: null,
      },
    });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ status: "failed", attempts: 8 });
  });

  it("returns replayed=true for the same idempotency key and canonical body", async () => {
    const row = await failedRow(`${prefix}-route-replay`);
    const body = replayBody([{
      id: row.id,
      expectedAttempts: row.attempts,
      expectedUpdatedAt: row.updatedAt.toISOString(),
    }]);
    const idempotencyKey = `${prefix}-same-request`;
    const firstResponse = await replayMainToChatOutboxRoute(routeRequest({
      body,
      idempotencyKey,
    }));
    expect(firstResponse.status).toBe(200);
    const first = await routeData(firstResponse);
    expect(first).toMatchObject({
      replayed: false,
      requeuedCount: 1,
      results: [{ id: row.id, outcome: "requeued" }],
    });

    const replayResponse = await replayMainToChatOutboxRoute(routeRequest({
      body,
      idempotencyKey,
    }));
    expect(replayResponse.status).toBe(200);
    expect(await routeData(replayResponse)).toEqual({ ...first, replayed: true });
    await expect(prisma.adminAuditLog.count({
      where: { targetId: row.id, action: "chat.main_outbox.replayed" },
    })).resolves.toBe(1);
    await expect(prisma.controlPlaneCommand.count({
      where: { actorId: routeActors.authorized, idempotencyKey },
    })).resolves.toBe(1);
  });

  it("journals an exact target-missing command once and replays its stored result", async () => {
    const row = await failedRow(`${prefix}-route-discard-target-missing`);
    const body = mainToChatOutboxTargetMissingDispositionRequestSchema.parse({
      events: [{
        id: row.id,
        expectedAttempts: row.attempts,
        expectedUpdatedAt: row.updatedAt.toISOString(),
        expectedEnvelopeHash: durableEnvelopeHash(envelope(row.id)),
        expectedTarget: { kind: "attachment", id: `${row.id}-attachment` },
      }],
      reason: {
        code: "receiver_target_missing",
        summary: "Target absence was reviewed by the operator",
      },
      confirmation: "DISCARD_MAIN_TO_CHAT_TARGET_MISSING",
    });
    const idempotencyKey = `${prefix}-discard-same-request`;
    const request = () => new Request(
      "http://localhost/api/v2/admin/chat/main-outbox-events/commands/discard-target-missing",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": routeActors.authorized,
          "x-idream-role": "admin",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    );
    const firstResponse = await discardTargetMissingRoute(request());
    expect(firstResponse.status).toBe(200);
    const firstEnvelope = await firstResponse.json() as { data?: unknown };
    const first = mainToChatOutboxTargetMissingDispositionResultSchema.parse(
      firstEnvelope.data,
    );
    expect(first).toMatchObject({
      replayed: false,
      discardedCount: 1,
      results: [{ id: row.id, outcome: "discarded_target_missing" }],
    });
    const replayResponse = await discardTargetMissingRoute(request());
    expect(replayResponse.status).toBe(200);
    const replayEnvelope = await replayResponse.json() as { data?: unknown };
    expect(mainToChatOutboxTargetMissingDispositionResultSchema.parse(
      replayEnvelope.data,
    )).toEqual({ ...first, replayed: true });
    await expect(prisma.controlPlaneCommand.count({
      where: { actorId: routeActors.authorized, idempotencyKey },
    })).resolves.toBe(1);
    await expect(prisma.adminAuditLog.count({
      where: {
        targetId: row.id,
        action: "chat.main_outbox.discarded_target_missing",
      },
    })).resolves.toBe(1);
  });

  it("rejects the same idempotency key with a different canonical body", async () => {
    const row = await failedRow(`${prefix}-route-conflict`);
    const body = replayBody([{
      id: row.id,
      expectedAttempts: row.attempts,
      expectedUpdatedAt: row.updatedAt.toISOString(),
    }]);
    const idempotencyKey = `${prefix}-conflicting-request`;
    const first = await replayMainToChatOutboxRoute(routeRequest({
      body,
      idempotencyKey,
    }));
    expect(first.status).toBe(200);

    const collision = await replayMainToChatOutboxRoute(routeRequest({
      body: {
        ...body,
        reason: {
          ...body.reason,
          summary: "A different operator claim for the same key",
        },
      },
      idempotencyKey,
    }));
    expect(collision.status).toBe(409);
    expect(await collision.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "Idempotency key is bound to another mutation",
      },
    });
    await expect(prisma.adminAuditLog.count({
      where: { targetId: row.id, action: "chat.main_outbox.replayed" },
    })).resolves.toBe(1);
    await expect(prisma.controlPlaneCommand.count({
      where: { actorId: routeActors.authorized, idempotencyKey },
    })).resolves.toBe(1);
  });

  it("requeues the exact failed envelope and preserves failure evidence in audit", async () => {
    const row = await failedRow(`${prefix}-valid`);
    const result = await replay([{
      id: row.id,
      expectedAttempts: row.attempts,
      expectedUpdatedAt: row.updatedAt.toISOString(),
    }]);

    expect(result).toMatchObject({
      requeuedCount: 1,
      results: [{
        id: row.id,
        outcome: "requeued",
        priorAttempts: 8,
        envelopeHash: durableEnvelopeHash(envelope(row.id)),
      }],
    });
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    })).toMatchObject({
      status: "pending",
      attempts: 0,
      deliveredAt: null,
      lastError: null,
    });
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "chat.main_outbox.replayed", targetId: row.id },
    });
    expect(audit.before).toMatchObject({
      status: "failed",
      attempts: 8,
      lastErrorCode: null,
    });
    expect(audit.before).not.toHaveProperty("lastError");
    expect(audit.before).toHaveProperty("lastErrorHash");
    expect(audit.after).toMatchObject({ status: "pending", attempts: 0 });

    expect(await replay([{
      id: row.id,
      expectedAttempts: 8,
      expectedUpdatedAt: row.updatedAt.toISOString(),
    }])).toMatchObject({
      requeuedCount: 0,
      results: [{ outcome: "already_requeued" }],
    });
  });

  it("leaves malformed and stale failed rows untouched", async () => {
    const malformed = await failedRow(`${prefix}-malformed`, { broken: true });
    const stale = await failedRow(`${prefix}-stale`);
    const result = await replay([
      {
        id: malformed.id,
        expectedAttempts: malformed.attempts,
        expectedUpdatedAt: malformed.updatedAt.toISOString(),
      },
      {
        id: stale.id,
        expectedAttempts: stale.attempts - 1,
        expectedUpdatedAt: stale.updatedAt.toISOString(),
      },
      {
        id: `${prefix}-missing`,
        expectedAttempts: 8,
        expectedUpdatedAt: new Date().toISOString(),
      },
    ]);

    expect(result).toMatchObject({
      requeuedCount: 0,
      results: [
        { id: malformed.id, outcome: "invalid_envelope" },
        { id: stale.id, outcome: "stale" },
        { id: `${prefix}-missing`, outcome: "not_found" },
      ],
    });
    expect(await prisma.mainOutboxEvent.findMany({
      where: { id: { in: [malformed.id, stale.id] } },
      select: { status: true, attempts: true },
    })).toEqual([
      { status: "failed", attempts: 8 },
      { status: "failed", attempts: 8 },
    ]);
  });

  it("does not requeue a generic envelope with a malformed Chat payload", async () => {
    const id = `${prefix}-invalid-chat-payload`;
    const invalidPayload = envelope(id);
    invalidPayload.payload.status = "mystery";
    const row = await failedRow(id, invalidPayload);

    expect(await replay([{
      id: row.id,
      expectedAttempts: row.attempts,
      expectedUpdatedAt: row.updatedAt.toISOString(),
    }])).toMatchObject({
      requeuedCount: 0,
      results: [{ id: row.id, outcome: "invalid_envelope" }],
    });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ status: "failed", attempts: 8 });
    await expect(prisma.adminAuditLog.count({ where: { targetId: row.id } }))
      .resolves.toBe(0);
  });

  it("does not disclose or mutate an outbox row owned by another dispatcher", async () => {
    const id = `${prefix}-foreign`;
    await prisma.mainOutboxEvent.create({
      data: {
        id,
        eventType: "generation.finalize.v2",
        aggregateType: "generation_attempt",
        aggregateId: `${id}-attempt`,
        payload: toInputJson({ attemptId: `${id}-attempt` }),
        status: "failed",
        attempts: 8,
        lastError: toInputJson({ message: "foreign dispatcher failed" }),
      },
    });
    const row = await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id } });

    expect(await replay([{
      id,
      expectedAttempts: row.attempts,
      expectedUpdatedAt: row.updatedAt.toISOString(),
    }])).toEqual({
      requeuedCount: 0,
      results: [{
        id,
        outcome: "not_found",
        priorAttempts: null,
        envelopeHash: null,
        storedEnvelopeHash: null,
      }],
    });
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id } }))
      .toMatchObject({ status: "failed", attempts: 8 });
  });

  it("refuses replay when current Chat authority says the expected target is missing", async () => {
    const row = await failedRow(`${prefix}-replay-target-missing`);
    const validationHash = durableEnvelopeHash(envelope(row.id));
    const result = await prisma.$transaction((tx) =>
      replayFailedMainToChatOutboxEvents(
        {
          body: replayBody([{
            id: row.id,
            expectedAttempts: row.attempts,
            expectedUpdatedAt: row.updatedAt.toISOString(),
          }]),
          actor,
          requestId: `${prefix}-target-missing-request`,
          receiverAuthority: new Map([[row.id, {
            sourceEventId: row.id,
            envelopeHash: validationHash,
            disposition: "expected_target_missing",
            target: { kind: "attachment", id: `${row.id}-attachment` },
            targetStatus: null,
            receipt: null,
          }]]),
        },
        tx,
      ),
    );
    expect(result).toMatchObject({
      requeuedCount: 0,
      results: [{ id: row.id, outcome: "receiver_target_missing" }],
    });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ status: "failed", attempts: 8 });
  });

  it("terminalizes only after Chat returns the exact target-missing receipt", async () => {
    const row = await failedRow(`${prefix}-discard-target-missing`);
    const body = mainToChatOutboxTargetMissingDispositionRequestSchema.parse({
      events: [{
        id: row.id,
        expectedAttempts: row.attempts,
        expectedUpdatedAt: row.updatedAt.toISOString(),
        expectedEnvelopeHash: durableEnvelopeHash(envelope(row.id)),
        expectedTarget: { kind: "attachment", id: `${row.id}-attachment` },
      }],
      reason: {
        code: "receiver_target_missing",
        summary: "Verified the original attachment target does not exist",
      },
      confirmation: "DISCARD_MAIN_TO_CHAT_TARGET_MISSING",
    });
    const receiver = vi.fn(async (events: readonly {
      envelope: DurableEventEnvelope;
      expectedEnvelopeHash: string;
      expectedTarget: { kind: "attachment" | "session"; id: string };
    }[]) => events.map((event) => ({
      sourceEventId: event.envelope.sourceEventId,
      outcome: "discarded_target_missing" as const,
      envelopeHash: event.expectedEnvelopeHash,
      target: event.expectedTarget,
      targetStatus: null,
      receiptId: `main:${event.envelope.sourceEventId}`,
    })));

    const result = await prisma.$transaction((tx) =>
      discardTargetMissingMainToChatOutboxEvents(
        { body, actor, requestId: `${prefix}-discard-request` },
        tx,
        receiver,
      ),
    );
    expect(result).toMatchObject({
      discardedCount: 1,
      results: [{
        id: row.id,
        outcome: "discarded_target_missing",
        priorAttempts: 8,
        receiverReceiptId: `main:${row.id}`,
      }],
    });
    expect(receiver).toHaveBeenCalledTimes(1);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({
        status: "discarded_target_missing",
        attempts: 8,
        payload: row.payload,
        lastError: row.lastError,
        deliveredAt: null,
      });
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: {
        action: "chat.main_outbox.discarded_target_missing",
        targetId: row.id,
      },
    });
    expect(audit.reason).toContain("receiver_target_missing");
    expect(audit.before).toMatchObject({
      status: "failed",
      attempts: 8,
      target: { kind: "attachment", id: `${row.id}-attachment` },
    });
    expect(audit.before).not.toHaveProperty("lastError");
    expect(audit.after).toMatchObject({
      status: "discarded_target_missing",
      attempts: 8,
      receiverReceiptId: `main:${row.id}`,
      receiverTargetState: "missing",
      userEffectApplied: false,
    });
  });
});
