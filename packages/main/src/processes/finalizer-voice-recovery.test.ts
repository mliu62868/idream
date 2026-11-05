import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drain: vi.fn(async () => ({ processed: 0 })),
  recover: vi.fn(),
  advanceVideos: vi.fn(),
  reconcileStale: vi.fn(async (_input?: unknown) => ({ enqueued: 0, quarantined: 0, nextCursor: null as unknown })),
  dispatchTerminal: vi.fn(async () => 0),
  closeQueue: vi.fn(async () => undefined),
}));
vi.mock("@/server/ai/local-pipeline", () => ({
  drainLocalAiPipeline: mocks.drain,
  reconcileStaleGenerationJobs: mocks.reconcileStale,
}));
vi.mock("@/server/jobs/queue", () => ({ jobQueue: { close: mocks.closeQueue } }));
vi.mock("@/server/ai/generation-terminal-record-ingest", () => ({ dispatchPendingGenerationTerminalRecords: mocks.dispatchTerminal }));
vi.mock("@/server/ai/generation-terminal-relay", () => ({ redriveFailedGenerationTerminalRelays: async () => ({ redriven: 0, deferredPaused: 0, invalid: [], retryErrors: [] }) }));
vi.mock("@/server/modules/admin-v2/jobs/unknown-review-reminder", () => ({ scanDueUnknownGenerationReviews: async () => ({ reminded: 0 }) }));
vi.mock("@/server/modules/ourdream/voice-clip-recovery", () => ({ recoverExpiredVoiceClips: mocks.recover }));
vi.mock("@/server/modules/ourdream/subscription-lifecycle", () => ({ entitlementMap: vi.fn() }));
vi.mock("@/server/modules/ourdream/generation-character-authority", () => ({ readableCharacter: vi.fn() }));
vi.mock("@/server/modules/chat/voice-call", () => ({ expireVoiceCalls: vi.fn(async () => undefined) }));
vi.mock("@/server/modules/ourdream/video-sequence", () => ({ advanceVideoSequences: mocks.advanceVideos }));
vi.mock("./process-entrypoint", () => ({ isProcessEntrypoint: () => false }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.advanceVideos.mockResolvedValue({ nextCursor: null }); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("keeps finalizing images while one voice recovers and drains that recovery on shutdown", async () => {
  let finish!: (result: { examined: number; recovered: number; nextCursorId: string }) => void;
  mocks.recover.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const { runFinalizerLoop, awaitFinalizerShutdown } = await import("./finalizer");
  const loop = runFinalizerLoop();
  await vi.advanceTimersByTimeAsync(61_000);
  expect(mocks.drain.mock.calls.length).toBeGreaterThan(1);
  expect(mocks.recover).toHaveBeenCalledTimes(1);
  let stopped = false;
  const shutdown = awaitFinalizerShutdown(loop).then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(stopped).toBe(false);
  finish({ examined: 1, recovered: 1, nextCursorId: "voice-a" });
  await shutdown;
  expect(stopped).toBe(true);
});

it("keeps ingesting terminal records during a slow stale scan and drains it on shutdown", async () => {
  mocks.recover.mockResolvedValue({ examined: 0, recovered: 0, nextCursorId: null });
  let finish!: (result: { enqueued: number; quarantined: number; nextCursor: null }) => void;
  mocks.reconcileStale.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const { runFinalizerLoop, awaitFinalizerShutdown } = await import("./finalizer");
  const loop = runFinalizerLoop();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.reconcileStale).toHaveBeenCalledTimes(1);
  expect(mocks.drain.mock.calls.length).toBeGreaterThan(5);
  expect(mocks.dispatchTerminal.mock.calls.length).toBeGreaterThan(5);
  let stopped = false;
  const shutdown = awaitFinalizerShutdown(loop).then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(stopped).toBe(false);
  expect(mocks.closeQueue).not.toHaveBeenCalled();
  finish({ enqueued: 0, quarantined: 0, nextCursor: null });
  await shutdown;
  expect(mocks.closeQueue).toHaveBeenCalledTimes(1);
});

it("carries the stale scan cursor into the next scan and wraps after the last page", async () => {
  mocks.recover.mockResolvedValue({ examined: 0, recovered: 0, nextCursorId: null });
  const cursor = { updatedAt: new Date("2026-10-01T00:00:00.000Z"), id: "legitimately-old" };
  mocks.reconcileStale.mockResolvedValueOnce({ enqueued: 0, quarantined: 0, nextCursor: cursor });
  mocks.reconcileStale.mockResolvedValueOnce({ enqueued: 0, quarantined: 0, nextCursor: null });
  const { runFinalizerLoop, awaitFinalizerShutdown } = await import("./finalizer");
  const loop = runFinalizerLoop();
  await vi.advanceTimersByTimeAsync(121_000);
  expect(mocks.reconcileStale.mock.calls.map(([input]) => input)).toEqual([{ cursor: null }, { cursor }, { cursor: null }]);
  const shutdown = awaitFinalizerShutdown(loop);
  await vi.advanceTimersByTimeAsync(1_000);
  await shutdown;
});

it("carries the recovery cursor into the next bounded scan", async () => {
  mocks.recover.mockResolvedValue({ examined: 1, recovered: 0, nextCursorId: "blocked-legacy-row" });
  const { runFinalizerLoop, awaitFinalizerShutdown } = await import("./finalizer");
  const loop = runFinalizerLoop();
  await vi.advanceTimersByTimeAsync(61_000);
  expect(mocks.recover).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursorId: "blocked-legacy-row" }));
  const shutdown = awaitFinalizerShutdown(loop);
  await vi.advanceTimersByTimeAsync(1_000);
  await shutdown;
});

it("carries the video sweep cursor past unresolved rows and wraps after the last page", async () => {
  const cursor = { createdAt: new Date("2026-10-01T00:00:00.000Z"), id: "unresolved-video-sequence" };
  mocks.recover.mockResolvedValue({ examined: 0, recovered: 0, nextCursorId: null });
  mocks.advanceVideos.mockResolvedValueOnce({ nextCursor: cursor }).mockResolvedValueOnce({ nextCursor: null });
  const { runFinalizerLoop, awaitFinalizerShutdown } = await import("./finalizer");
  const loop = runFinalizerLoop();
  try {
    await vi.advanceTimersByTimeAsync(2_001);
    expect(mocks.advanceVideos).toHaveBeenNthCalledWith(1, 10, null, expect.anything());
    expect(mocks.advanceVideos).toHaveBeenNthCalledWith(2, 10, cursor, expect.anything());
    expect(mocks.advanceVideos).toHaveBeenNthCalledWith(3, 10, null, expect.anything());
  } finally {
    const shutdown = awaitFinalizerShutdown(loop);
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdown;
  }
});

it("keeps sweeping while a composition runs on its lane and waits for it on shutdown", async () => {
  mocks.recover.mockResolvedValue({ examined: 0, recovered: 0, nextCursorId: null });
  let finishComposition!: () => void;
  const composition = new Promise<void>((resolve) => { finishComposition = resolve; });
  mocks.advanceVideos.mockImplementationOnce(async (_limit: number, _cursor: unknown, options: { compositionLane: { run(job: () => Promise<void>): void } }) => {
    options.compositionLane.run(() => composition);
    return { nextCursor: null };
  });
  const { runFinalizerLoop, awaitFinalizerShutdown } = await import("./finalizer");
  const loop = runFinalizerLoop();
  await vi.advanceTimersByTimeAsync(3_100);
  // Scene dispatch and failure settlement live in the sweep, so they must not wait.
  expect(mocks.advanceVideos.mock.calls.length).toBeGreaterThan(1);
  let stopped = false;
  const shutdown = awaitFinalizerShutdown(loop).then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(stopped).toBe(false);
  finishComposition();
  await vi.advanceTimersByTimeAsync(1_000);
  await shutdown;
  expect(stopped).toBe(true);
});
