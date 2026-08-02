import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type {
  JobQueue,
  QueueJobSnapshot,
  QueuePauseSnapshot,
} from "@/server/jobs/queue";
import {
  GENERATION_CUTOVER_QUEUES,
} from "./generation-dispatch-cutover";
import {
  pauseAndDrainGenerationCutoverQueues,
  resumeGenerationCutoverQueues,
} from "./generation-cutover-queue-control";

type CutoverQueue = Pick<
  JobQueue,
  "pause" | "resume" | "inspectPaused" | "inspectInFlight"
>;

function pausedSnapshots(paused: boolean): QueuePauseSnapshot[] {
  return GENERATION_CUTOVER_QUEUES.map((queue) => ({ queue, paused }));
}

function dbWithPendingCount(read: () => number) {
  return {
    mainOutboxEvent: { count: async () => read() },
  } as unknown as PrismaClient;
}

function activeRow(): QueueJobSnapshot {
  return {
    id: "active-bull-row",
    queue: "ai.video.generate",
    payload: {
      generationJobId: "generation-job-1",
      attemptId: "generation-attempt-1",
    },
    attemptsMade: 0,
    maxAttempts: 3,
    state: "active",
    timestamp: Date.now(),
  };
}

describe("generation cutover queue control", () => {
  it("attempts to pause every queue after an initial partial pause failure", async () => {
    const pause = vi.fn(async (queues: readonly string[]) => {
      if (queues.length > 1) throw new Error("partial Redis pause failure");
    });
    const queue: CutoverQueue = {
      pause,
      resume: vi.fn(async () => {}),
      inspectPaused: vi.fn(async () => pausedSnapshots(false)),
      inspectInFlight: vi.fn(async () => []),
    };

    await expect(
      pauseAndDrainGenerationCutoverQueues({
        db: dbWithPendingCount(() => 0),
        queue,
      }),
    ).rejects.toThrow("partial Redis pause failure");
    expect(pause.mock.calls.map(([queues]) => queues)).toEqual([
      GENERATION_CUTOVER_QUEUES,
      ["ai.image.generate"],
      ["ai.video.generate"],
      ["app.generation.terminal.ingest"],
      ["app.ai.finalize"],
    ]);
    expect(queue.resume).not.toHaveBeenCalled();
  });

  it("pauses first, waits for active work, and flushes terminal Outbox before returning", async () => {
    let inspectCount = 0;
    let pending = 1;
    const queue: CutoverQueue = {
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      inspectPaused: vi.fn(async () => pausedSnapshots(true)),
      inspectInFlight: vi.fn(async () => {
        inspectCount += 1;
        return inspectCount === 1 ? [activeRow()] : [];
      }),
    };
    const dispatchPending = vi.fn(async () => {
      pending = 0;
      return 1;
    });
    const wait = vi.fn(async () => {});

    await expect(
      pauseAndDrainGenerationCutoverQueues({
        db: dbWithPendingCount(() => pending),
        queue,
        dispatchPendingTerminalRecords: dispatchPending,
        timeoutMs: 1_000,
        sleep: wait,
      }),
    ).resolves.toMatchObject({
      ok: true,
      activeBullRows: [],
      pendingTerminalOutboxes: 0,
    });
    expect(queue.pause).toHaveBeenCalledTimes(1);
    expect(queue.resume).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledTimes(1);
    expect(dispatchPending).toHaveBeenCalledTimes(1);
  });

  it("keeps every queue paused when drain times out", async () => {
    let clock = 0;
    const queue: CutoverQueue = {
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      inspectPaused: vi.fn(async () => pausedSnapshots(true)),
      inspectInFlight: vi.fn(async () => [activeRow()]),
    };

    await expect(
      pauseAndDrainGenerationCutoverQueues({
        db: dbWithPendingCount(() => 0),
        queue,
        timeoutMs: 5,
        now: () => clock,
        sleep: async () => {
          clock = 5;
        },
      }),
    ).rejects.toThrow("drain timed out");
    expect(queue.pause).toHaveBeenCalledTimes(5);
    expect(queue.resume).not.toHaveBeenCalled();
  });

  it("rolls a partial resume back to a global pause", async () => {
    const queue: CutoverQueue = {
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      inspectPaused: vi.fn(async () => [
        ...pausedSnapshots(false).slice(0, -1),
        { queue: "app.ai.finalize", paused: true },
      ]),
      inspectInFlight: vi.fn(async () => []),
    };

    await expect(resumeGenerationCutoverQueues({ queue })).rejects.toThrow(
      "resume verification failed",
    );
    expect(queue.resume).toHaveBeenCalledTimes(1);
    expect(queue.pause).toHaveBeenCalledTimes(4);
  });

  it("returns only after all generation queues are verified resumed", async () => {
    const queue: CutoverQueue = {
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      inspectPaused: vi.fn(async () => pausedSnapshots(false)),
      inspectInFlight: vi.fn(async () => []),
    };

    await expect(resumeGenerationCutoverQueues({ queue })).resolves.toEqual(
      pausedSnapshots(false),
    );
    expect(queue.pause).not.toHaveBeenCalled();
  });
});
