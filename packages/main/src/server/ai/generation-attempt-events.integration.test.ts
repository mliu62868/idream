import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  GenerationAttemptEventConflictError,
  recordGenerationAttemptEvent,
} from "./generation-attempt-events";

describe("GenerationAttemptEvent authority", () => {
  const suffix = randomUUID();
  const userId = `attempt-event-user-${suffix}`;
  const jobId = `attempt-event-job-${suffix}`;
  const attemptId = `attempt-event-attempt-${suffix}`;

  beforeAll(async () => {
    // db-push intentionally cannot install migration-only triggers. Install the
    // same guard here so this integration test exercises PostgreSQL immutability.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION reject_generation_attempt_event_update()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'generation_attempt_events are immutable';
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS generation_attempt_events_immutable
      ON "generation_attempt_events"
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER generation_attempt_events_immutable
      BEFORE UPDATE ON "generation_attempt_events"
      FOR EACH ROW EXECUTE FUNCTION reject_generation_attempt_event_update()
    `);
  });

  beforeEach(async () => {
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
    await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.user.upsert({
      where: { email: `${userId}@example.test` },
      create: { id: userId, email: `${userId}@example.test` },
      update: {},
    });
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
      },
    });
    await prisma.generationAttempt.create({
      data: { id: attemptId, requestId: jobId, attemptNo: 1, status: "queued" },
    });
  });

  afterAll(async () => {
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
    await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("records ordered non-terminal events and exactly one terminal outcome atomically", async () => {
    await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      eventId: `${attemptId}:queued`,
      attemptId,
      expectedSequence: 1,
      eventType: "generation.attempt.queued.v1",
      occurredAt: new Date("2026-07-11T12:00:00.000Z"),
      payload: { source: "test" },
      status: "queued",
    }));
    await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      eventId: `${attemptId}:running`,
      attemptId,
      expectedSequence: 2,
      eventType: "generation.attempt.running.v1",
      occurredAt: new Date("2026-07-11T12:00:01.000Z"),
      payload: { provider: "mock-image" },
      status: "running",
    }));
    const terminal = await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      eventId: `${attemptId}:terminal`,
      attemptId,
      expectedSequence: 3,
      eventType: "generation.attempt.succeeded.v1",
      outcome: "succeeded",
      occurredAt: new Date("2026-07-11T12:00:02.000Z"),
      payload: { delivered: 1 },
    }));

    expect(terminal).toMatchObject({ disposition: "created", sequence: 3, outcome: "succeeded" });
    expect(await prisma.generationAttempt.findUnique({ where: { id: attemptId } })).toMatchObject({
      status: "succeeded",
      terminalSequence: 3,
      finishedAt: new Date("2026-07-11T12:00:02.000Z"),
    });
    expect(await prisma.generationAttemptEvent.findMany({
      where: { attemptId },
      orderBy: { sequence: "asc" },
    })).toEqual([
      expect.objectContaining({ sequence: 1, outcome: null, terminalScope: null }),
      expect.objectContaining({ sequence: 2, outcome: null, terminalScope: null }),
      expect.objectContaining({ sequence: 3, outcome: "succeeded", terminalScope: "terminal" }),
    ]);
  });

  it("collapses an identical terminal retry and rejects a conflicting terminal outcome", async () => {
    const input = {
      eventId: `${attemptId}:terminal`,
      attemptId,
      eventType: "generation.attempt.failed.v1",
      outcome: "failed" as const,
      occurredAt: new Date("2026-07-11T12:00:00.000Z"),
      payload: { errorCode: "provider_timeout" },
      errorCode: "provider_timeout",
    };
    expect(await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, input)))
      .toMatchObject({ disposition: "created", sequence: 1 });
    expect(await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, input)))
      .toMatchObject({ disposition: "duplicate", sequence: 1 });

    await expect(prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      ...input,
      eventId: `${attemptId}:other-terminal`,
      eventType: "generation.attempt.succeeded.v1",
      outcome: "succeeded",
      payload: { assets: 1 },
    }))).rejects.toBeInstanceOf(GenerationAttemptEventConflictError);
    expect(await prisma.generationAttemptEvent.count({ where: { attemptId, terminalScope: "terminal" } })).toBe(1);
    expect(await prisma.generationAttempt.findUnique({ where: { id: attemptId } })).toMatchObject({
      status: "failed",
      errorCode: "provider_timeout",
    });
  });

  it("preserves a blocked terminal record as a blocked Attempt outcome", async () => {
    const occurredAt = new Date("2026-07-11T12:00:00.000Z");
    const terminal = await prisma.$transaction((tx) =>
      recordGenerationAttemptEvent(tx, {
        eventId: `${attemptId}:terminal`,
        attemptId,
        eventType: "generation.attempt.blocked.v1",
        outcome: "blocked",
        occurredAt,
        payload: {
          policyCode: "provider_blocked",
          layer: "provider",
        },
        errorCode: "provider_blocked",
        retryability: "not_retryable",
      }),
    );

    expect(terminal).toMatchObject({ outcome: "blocked", disposition: "created" });
    await expect(
      prisma.generationAttempt.findUnique({ where: { id: attemptId } }),
    ).resolves.toMatchObject({
      status: "blocked",
      errorCode: "provider_blocked",
      retryability: "not_retryable",
      finishedAt: occurredAt,
    });
  });

  it("serializes concurrent success and failure terminals into exactly one authority outcome", async () => {
    const base = {
      attemptId,
      occurredAt: new Date("2026-07-11T12:00:00.000Z"),
    };
    const results = await Promise.allSettled([
      prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
        ...base,
        eventId: `${attemptId}:concurrent-success`,
        eventType: "generation.attempt.succeeded.v1",
        outcome: "succeeded",
        payload: { assets: 1 },
      })),
      prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
        ...base,
        eventId: `${attemptId}:concurrent-failure`,
        eventType: "generation.attempt.failed.v1",
        outcome: "failed",
        payload: { errorCode: "provider_timeout" },
        errorCode: "provider_timeout",
      })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await prisma.generationAttemptEvent.count({ where: { attemptId, terminalScope: "terminal" } })).toBe(1);
    expect((await prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status)
      .toMatch(/^(succeeded|failed)$/);
  });

  it("rejects gaps, stale sequences, and events after terminal", async () => {
    await expect(prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      eventId: `${attemptId}:gap`,
      attemptId,
      expectedSequence: 2,
      eventType: "generation.attempt.running.v1",
      occurredAt: new Date(),
      payload: {},
      status: "running",
    }))).rejects.toBeInstanceOf(GenerationAttemptEventConflictError);

    await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      eventId: `${attemptId}:terminal`,
      attemptId,
      expectedSequence: 1,
      eventType: "generation.attempt.unknown.v1",
      outcome: "unknown",
      occurredAt: new Date(),
      payload: { reason: "non_replayable" },
    }));
    await expect(prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      eventId: `${attemptId}:late-running`,
      attemptId,
      expectedSequence: 2,
      eventType: "generation.attempt.running.v1",
      occurredAt: new Date(),
      payload: {},
      status: "running",
    }))).rejects.toBeInstanceOf(GenerationAttemptEventConflictError);
  });

  it("rolls back the terminal transition when event persistence fails", async () => {
    await expect(prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      eventId: `${attemptId}:terminal`,
      attemptId,
      eventType: "generation.attempt.failed.v1",
      outcome: "failed",
      occurredAt: new Date(),
      payload: { unsupportedJsonValue: BigInt(1) },
      errorCode: "serialization_failure",
    }))).rejects.toThrow();
    expect(await prisma.generationAttemptEvent.count({ where: { attemptId } })).toBe(0);
    expect(await prisma.generationAttempt.findUnique({ where: { id: attemptId } })).toMatchObject({
      status: "queued",
      terminalSequence: null,
      finishedAt: null,
    });
  });

  it("enforces immutable event records in PostgreSQL", async () => {
    await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      eventId: `${attemptId}:queued`,
      attemptId,
      eventType: "generation.attempt.queued.v1",
      occurredAt: new Date(),
      payload: { source: "test" },
      status: "queued",
    }));
    await expect(prisma.generationAttemptEvent.update({
      where: { id: `${attemptId}:queued` },
      data: { payload: { source: "tampered" } },
    })).rejects.toThrow(/immutable/i);
  });
});
