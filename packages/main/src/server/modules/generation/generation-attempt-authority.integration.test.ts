import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EnqueueJobInput } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { checkExactGenerationDispatchAuthority } from "@/server/ai/generation-dispatch-evidence-authority";
import { generationWorkflowDescriptor } from "@/server/modules/admin/generation-catalog";
import {
  dispatchGenerationAttemptOutbox,
  reserveInitialGenerationAttempt,
  reserveRetryGenerationAttempt,
} from "./generation-attempt-authority";

describe("GenerationAttemptAuthority", () => {
  const suffix = randomUUID();
  const prefix = `attempt-authority-${suffix}`;
  const userId = `${prefix}-user`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@idream.internal`,
        role: "user",
        status: "active",
      },
    });
  });

  afterAll(async () => {
    const jobs = await prisma.generationJob.findMany({
      where: { id: { startsWith: prefix } },
      select: { id: true },
    });
    const jobIds = jobs.map((job) => job.id);
    const attempts = await prisma.generationAttempt.findMany({
      where: { requestId: { in: jobIds } },
      select: { id: true },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: jobIds } },
    });
    await prisma.generationDelivery.deleteMany({
      where: { requestId: { in: jobIds } },
    });
    await prisma.generationAttemptEvent.deleteMany({
      where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
    });
    await prisma.generationAttempt.deleteMany({
      where: { requestId: { in: jobIds } },
    });
    await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.generationModelProfile.deleteMany({
      where: { id: { startsWith: prefix } },
    });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function createJob(label: string) {
    return prisma.generationJob.create({
      data: {
        id: `${prefix}-${label}`,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 1,
        status: "queued",
        provider: "mock",
      },
    });
  }

  function reservationFor(job: Awaited<ReturnType<typeof createJob>>) {
    return {
      requestId: job.id,
      dispatch: {
        outboxId: `generation_initial_${job.id}`,
        eventType: "generation.retry.dispatch.v2" as const,
        payload: { source: "user_create" },
      },
    };
  }

  async function createUnknownRetryDecisionFixture(
    label: string,
    resolution: "remain_unknown" | "adopt_succeeded" | "confirm_failed",
    delivered = false,
  ) {
    const job = await createJob(label);
    const initial = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, reservationFor(job)),
    );
    await prisma.generationAttempt.update({
      where: { id: initial.attempt.id },
      data: { status: "unknown", retryability: "not_retryable" },
    });
    const failed = await prisma.generationJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        errorCode: "operator_confirmed_provider_failure",
        version: { increment: 1 },
      },
    });
    await prisma.generationJobEvent.create({
      data: {
        jobId: job.id,
        type: `unknown_reconciliation_${resolution}`,
        metadata: {
          attemptId: initial.attempt.id,
          resolution,
        },
      },
    });
    if (delivered) {
      await prisma.generationDelivery.create({
        data: {
          requestId: job.id,
          artifactId: `${job.id}-artifact`,
          targetType: "user_library",
          targetId: userId,
          status: "delivered",
          deliveredAt: new Date(),
        },
      });
    }
    return { job: failed, attempt: initial.attempt };
  }

  // SPEC: the Attempt pin and the dispatched controls must name one workflow
  // version. The Attempt pin falls back to the Profile's runnerConfig when no
  // descriptor file resolves; the dispatched controls used to read the
  // descriptor alone, so a profile pointing at an absent descriptor pinned a
  // version the envelope silently dropped — and dispatch authority then
  // rejected its own envelope as a workflow pin mismatch.
  it("dispatches the Attempt workflow pin when no descriptor resolves", async () => {
    const workflowKey = `${prefix}-absent-descriptor`;
    await expect(generationWorkflowDescriptor(workflowKey)).resolves.toBeNull();
    const profile = await prisma.generationModelProfile.create({
      data: {
        id: `${prefix}-profile`,
        profileKey: `${prefix}-profile-key`,
        label: "Absent descriptor profile",
        mode: "image",
        runner: "comfyui",
        pipelineModel: `${prefix}-model`,
        workflowKey,
        runnerConfig: { workflowVersion: 5 },
        allowedOrientations: ["portrait"],
        status: "active",
      },
    });
    const job = await prisma.generationJob.create({
      data: {
        id: `${prefix}-pinned-workflow-version`,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 1,
        status: "queued",
        provider: "mock",
        profileId: profile.profileKey,
        profileVersion: profile.version,
      },
    });

    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, reservationFor(job)),
    );

    expect(reserved.attempt.workflowVersion).toBe(5);
    const queueInput = (reserved.outbox.payload as Record<string, unknown>)
      .queueInput as Record<string, unknown>;
    const queuePayload = queueInput.payload as Record<string, unknown>;
    expect((queuePayload.controls as Record<string, unknown>).workflowVersion)
      .toBe(5);
    expect(
      checkExactGenerationDispatchAuthority({
        job,
        attempt: reserved.attempt,
        dispatch: reserved.outbox,
      }),
    ).toMatchObject({ ok: true });
  });

  it("persists the dispatch intent before enqueue and recovers it exactly once", async () => {
    const job = await createJob("crash-window");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, reservationFor(job)),
    );
    expect(reserved.outbox).toMatchObject({
      aggregateType: "generation_request",
      aggregateId: job.id,
    });
    const enqueued: EnqueueJobInput[] = [];
    const queue = {
      enqueue: async (input: EnqueueJobInput) => {
        enqueued.push(input);
        return {
          id: `fake-${enqueued.length}`,
          queue: input.queue,
          payload: input.payload,
          attemptsMade: 0,
          maxAttempts: input.maxAttempts ?? 1,
          dedupeKey: input.dedupeKey,
          priority: input.priority,
        };
      },
      removeByDedupeKey: async () => false,
    };

    expect(enqueued).toHaveLength(0);
    await prisma.generationJob.update({
      where: { id: job.id },
      data: {
        prompt: "mutable value written after reservation",
        controls: { mutable: true },
        provider: "pipeline",
      },
    });
    await expect(
      prisma.generationAttempt.findUnique({ where: { id: reserved.attempt.id } }),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      prisma.mainOutboxEvent.findUnique({ where: { id: reserved.outbox.id } }),
    ).resolves.toMatchObject({ status: "pending" });

    const outcomes = await Promise.all([
      dispatchGenerationAttemptOutbox(prisma, {
        outboxIds: [reserved.outbox.id],
        queue,
      }),
      dispatchGenerationAttemptOutbox(prisma, {
        outboxIds: [reserved.outbox.id],
        queue,
      }),
    ]);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      queue: "ai.image.generate",
      dedupeKey: `generation:${job.id}:attempt:1`,
      payload: expect.objectContaining({
        generationJobId: job.id,
        attemptId: reserved.attempt.id,
        attemptNo: 1,
        provider: "mock",
        controls: {},
      }),
    });
    expect(outcomes.reduce((sum, outcome) => sum + outcome.delivered, 0)).toBe(1);
    await expect(
      prisma.mainOutboxEvent.findUnique({ where: { id: reserved.outbox.id } }),
    ).resolves.toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("rejects 25 oldest malformed rows so they cannot starve the next valid dispatch", async () => {
    const job = await createJob("malformed-batch");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, reservationFor(job)),
    );
    const poisonIds = Array.from(
      { length: 25 },
      (_, index) => `${job.id}-poison-${index + 1}`,
    );
    await prisma.mainOutboxEvent.createMany({
      data: poisonIds.map((id, index) => ({
        id,
        eventType: "generation.retry.dispatch.v2",
        aggregateType: "generation_request",
        aggregateId: job.id,
        createdAt: new Date(1_000 + index),
        nextRunAt: new Date(0),
        payload: index < 13
          ? { malformedIdentity: index }
          : {
              generationJobId: job.id,
              attemptId: reserved.attempt.id,
              attemptNo: 1,
              queueInput: { queue: "invalid-generation-queue" },
            },
      })),
    });
    const enqueued: EnqueueJobInput[] = [];
    const queue = {
      enqueue: async (queueJob: EnqueueJobInput) => {
        enqueued.push(queueJob);
      },
      removeByDedupeKey: async () => false,
    };

    const first = await dispatchGenerationAttemptOutbox(prisma, {
      limit: 25,
      outboxIds: [...poisonIds, reserved.outbox.id],
      queue,
    });
    expect(first).toEqual({ examined: 25, delivered: 0, failed: 25 });
    expect(enqueued).toEqual([]);
    const rejected = await prisma.mainOutboxEvent.findMany({
      where: { id: { in: poisonIds } },
      orderBy: { createdAt: "asc" },
    });
    expect(rejected).toHaveLength(25);
    expect(rejected.every((row) => row.status === "rejected")).toBe(true);
    expect(rejected.every((row) => (
      row.lastError as Record<string, unknown>
    ).code === "generation_dispatch_payload_invalid")).toBe(true);
    expect(rejected[0]).toMatchObject({
      attempts: 0,
      deliveredAt: null,
      lastError: expect.objectContaining({
        originalStatus: "pending",
        originalNextRunAt: new Date(0).toISOString(),
      }),
    });

    const second = await dispatchGenerationAttemptOutbox(prisma, {
      limit: 25,
      outboxIds: [...poisonIds, reserved.outbox.id],
      queue,
    });
    expect(second).toEqual({ examined: 1, delivered: 1, failed: 0 });
    expect(enqueued).toHaveLength(1);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: reserved.outbox.id },
    })).resolves.toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("does not remove a valid dedupe job after another dispatcher turns over the expired lease", async () => {
    const job = await createJob("lease-turnover");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, reservationFor(job)),
    );
    const firstNow = new Date(Date.now() + 1_000);
    let enqueueCount = 0;
    let releaseFirstEnqueue!: () => void;
    let notifyFirstEnqueue!: () => void;
    const firstEnqueueStarted = new Promise<void>((resolve) => {
      notifyFirstEnqueue = resolve;
    });
    const firstEnqueueRelease = new Promise<void>((resolve) => {
      releaseFirstEnqueue = resolve;
    });
    const removals: Array<{ queue: string; dedupeKey: string }> = [];
    const queue = {
      enqueue: async () => {
        enqueueCount += 1;
        if (enqueueCount === 1) {
          notifyFirstEnqueue();
          await firstEnqueueRelease;
        }
      },
      removeByDedupeKey: async (queueName: string, dedupeKey: string) => {
        removals.push({ queue: queueName, dedupeKey });
        return true;
      },
    };

    const slowDispatcher = dispatchGenerationAttemptOutbox(prisma, {
      outboxIds: [reserved.outbox.id],
      queue,
      now: firstNow,
    });
    await firstEnqueueStarted;
    const turnover = await dispatchGenerationAttemptOutbox(prisma, {
      outboxIds: [reserved.outbox.id],
      queue,
      now: new Date(firstNow.getTime() + 61_000),
    });
    releaseFirstEnqueue();
    const slow = await slowDispatcher;

    expect(turnover).toEqual({ examined: 1, delivered: 1, failed: 0 });
    expect(slow).toEqual({ examined: 1, delivered: 0, failed: 0 });
    expect(enqueueCount).toBe(2);
    expect(removals).toEqual([]);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: reserved.outbox.id },
    })).resolves.toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("replays the same reservation as the same Attempt without duplicating facts", async () => {
    const job = await createJob("replay");
    const first = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, reservationFor(job)),
    );
    const replay = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, reservationFor(job)),
    );

    expect(replay.attempt.id).toBe(first.attempt.id);
    expect(replay.outbox.id).toBe(first.outbox.id);
    await expect(
      prisma.generationAttempt.count({ where: { requestId: job.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.generationAttemptEvent.count({ where: { attemptId: first.attempt.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.mainOutboxEvent.count({ where: { id: first.outbox.id } }),
    ).resolves.toBe(1);
  });

  it("fails closed when an Outbox id is replayed with a different payload", async () => {
    const job = await createJob("payload-conflict");
    const input = reservationFor(job);
    const first = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, input),
    );

    await expect(
      prisma.$transaction((tx) =>
        reserveInitialGenerationAttempt(tx, {
          ...input,
          dispatch: {
            ...input.dispatch,
            payload: { source: "different_create" },
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      prisma.generationAttempt.count({ where: { requestId: job.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.mainOutboxEvent.findUnique({ where: { id: first.outbox.id } }),
    ).resolves.toMatchObject({ payload: expect.objectContaining({ source: "user_create" }) });
  });

  it("rejects a request-level queue key that is not bound to the exact Attempt", async () => {
    const job = await createJob("request-level-dedupe");

    await expect(
      prisma.$transaction((tx) =>
        reserveInitialGenerationAttempt(tx, {
          ...reservationFor(job),
          dispatch: {
            ...reservationFor(job).dispatch,
            dedupeKey: `generation:${job.id}`,
          },
        }),
      ),
    ).rejects.toThrow("must be bound to the exact Attempt");
    await expect(
      prisma.generationAttempt.count({ where: { requestId: job.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.mainOutboxEvent.count({ where: { aggregateId: job.id } }),
    ).resolves.toBe(0);
  });

  it("owns retry locking, request transition, attempt numbering, and immutable pins", async () => {
    const job = await createJob("retry-intent");
    const initial = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, reservationFor(job)),
    );
    await prisma.generationAttempt.update({
      where: { id: initial.attempt.id },
      data: { status: "failed", retryability: "operator_retry" },
    });
    const failed = await prisma.generationJob.update({
      where: { id: job.id },
      data: { status: "failed", errorCode: "provider_error", version: { increment: 1 } },
    });

    const reserved = await prisma.$transaction((tx) =>
      reserveRetryGenerationAttempt(tx, {
        requestId: job.id,
        expectedRequestVersion: failed.version,
        sourceCommandId: `${job.id}-retry-command`,
        dispatch: {
          outboxId: `${job.id}-retry-outbox`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );

    expect(reserved.request).toMatchObject({
      status: "queued",
      version: failed.version + 1,
      errorCode: null,
    });
    expect(reserved.attempt).toMatchObject({
      attemptNo: 2,
      provider: initial.attempt.provider,
      profileKey: initial.attempt.profileKey,
      workflowKey: initial.attempt.workflowKey,
      status: "queued",
    });
    expect(reserved.outbox.payload).toEqual(expect.objectContaining({
      generationJobId: job.id,
      attemptId: reserved.attempt.id,
      attemptNo: 2,
      queueInput: expect.objectContaining({
        payload: expect.objectContaining({
          provider: "mock",
          attemptNo: 2,
          outputPrefix:
            `gen/${job.id}/attempts/${reserved.attempt.id}/`,
        }),
      }),
    }));
    const initialPayload = initial.outbox.payload as {
      queueInput: { payload: { outputPrefix: string } };
    };
    const retryPayload = reserved.outbox.payload as {
      queueInput: { payload: { outputPrefix: string } };
    };
    expect(initialPayload.queueInput.payload.outputPrefix).toBe(
      `gen/${job.id}/attempts/${initial.attempt.id}/`,
    );
    expect(retryPayload.queueInput.payload.outputPrefix).not.toBe(
      initialPayload.queueInput.payload.outputPrefix,
    );
  });

  it.each([
    {
      label: "remain-unknown",
      resolution: "remain_unknown" as const,
      delivered: false,
      message: "requires a terminal confirm_failed decision",
    },
    {
      label: "adopt-succeeded",
      resolution: "adopt_succeeded" as const,
      delivered: false,
      message: "requires a terminal confirm_failed decision",
    },
    {
      label: "delivered-output",
      resolution: "confirm_failed" as const,
      delivered: true,
      message: "Partially delivered requests require failed-output reconciliation",
    },
  ])(
    "refuses $resolution authority when a new Attempt is not safe",
    async ({ label, resolution, delivered, message }) => {
      const fixture = await createUnknownRetryDecisionFixture(
        label,
        resolution,
        delivered,
      );
      const retryOutboxId = `${fixture.job.id}-unsafe-retry-outbox`;

      await expect(
        prisma.$transaction((tx) =>
          reserveRetryGenerationAttempt(tx, {
            requestId: fixture.job.id,
            expectedRequestVersion: fixture.job.version,
            dispatch: {
              outboxId: retryOutboxId,
              eventType: "generation.retry.dispatch.v2",
            },
          }),
        ),
      ).rejects.toThrow(message);
      await expect(
        prisma.generationAttempt.count({
          where: { requestId: fixture.job.id },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.mainOutboxEvent.count({ where: { id: retryOutboxId } }),
      ).resolves.toBe(0);
      await expect(
        prisma.generationAttempt.findUniqueOrThrow({
          where: { id: fixture.attempt.id },
        }),
      ).resolves.toMatchObject({
        status: "unknown",
        retryability: "not_retryable",
      });
    },
  );

  it("rolls back retry reservation when no durable provider pin exists", async () => {
    const job = await prisma.generationJob.create({
      data: {
        id: `${prefix}-retry-without-provider`,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 1,
        status: "failed",
        provider: null,
      },
    });
    await prisma.generationAttempt.create({
      data: {
        requestId: job.id,
        attemptNo: 1,
        provider: null,
        status: "failed",
        retryability: "operator_retry",
      },
    });

    await expect(
      prisma.$transaction((tx) =>
        reserveRetryGenerationAttempt(tx, {
          requestId: job.id,
          expectedRequestVersion: job.version,
          dispatch: {
            outboxId: `${job.id}-retry-outbox`,
            eventType: "generation.retry.dispatch.v2",
          },
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "Generation dispatch requires a pinned provider",
    });
    await expect(
      prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ status: "failed", version: job.version });
    await expect(
      prisma.generationAttempt.count({ where: { requestId: job.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.mainOutboxEvent.count({ where: { aggregateId: job.id } }),
    ).resolves.toBe(0);
  });

  it("serializes concurrent retry intents so only one next Attempt exists", async () => {
    const job = await createJob("retry-race");
    const initial = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, reservationFor(job)),
    );
    await prisma.generationAttempt.update({
      where: { id: initial.attempt.id },
      data: { status: "failed", retryability: "operator_retry" },
    });
    const failed = await prisma.generationJob.update({
      where: { id: job.id },
      data: { status: "failed", version: { increment: 1 } },
    });
    const intent = (suffix: string) =>
      prisma.$transaction((tx) =>
        reserveRetryGenerationAttempt(tx, {
          requestId: job.id,
          expectedRequestVersion: failed.version,
          dispatch: {
            outboxId: `${job.id}-race-${suffix}`,
            eventType: "generation.retry.dispatch.v2",
          },
        }),
      );

    const outcomes = await Promise.allSettled([intent("a"), intent("b")]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    await expect(
      prisma.generationAttempt.count({ where: { requestId: job.id } }),
    ).resolves.toBe(2);
  });
});
