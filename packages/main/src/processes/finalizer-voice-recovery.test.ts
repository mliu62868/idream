import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drain: vi.fn(async () => ({ processed: 0 })),
  recover: vi.fn(),
  advanceVideos: vi.fn(),
}));
vi.mock("@/server/ai/local-pipeline", () => ({
  drainLocalAiPipeline: mocks.drain,
  reconcileStaleGenerationJobs: async () => ({ enqueued: 0, quarantined: 0 }),
}));
vi.mock("@/server/ai/generation-terminal-record-ingest", () => ({ dispatchPendingGenerationTerminalRecords: async () => undefined }));
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
    expect(mocks.advanceVideos).toHaveBeenNthCalledWith(1, 10, null);
    expect(mocks.advanceVideos).toHaveBeenNthCalledWith(2, 10, cursor);
    expect(mocks.advanceVideos).toHaveBeenNthCalledWith(3, 10, null);
  } finally {
    const shutdown = awaitFinalizerShutdown(loop);
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdown;
  }
});
