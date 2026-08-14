import { beforeEach, describe, expect, it, vi } from "vitest";

type WorkerHandler = (job: {
  id: string;
  payload: unknown;
  attemptsMade: number;
  maxAttempts: number;
}) => Promise<void>;

const runtime = vi.hoisted(() => ({
  handlers: new Map<string, WorkerHandler>(),
  refreshDependencies: vi.fn(),
  processGenerateJob: vi.fn(async () => ({ status: "sent" })),
  terminalizeGenerateJobFailure: vi.fn(async () => true),
  processMemoryExtract: vi.fn(async () => ({ written: 0, skipped: null })),
  deliverPendingOutbox: vi.fn(async () => 0),
  consumeDurableInbox: vi.fn(async () => ({ acknowledged: true })),
}));

vi.mock("@idream/shared/contracts", () => ({
  CHAT_QUEUES: {
    generate: "chat.generate",
    memoryExtract: "chat.memory.extract",
    outboxDeliver: "chat.outbox.deliver",
    inboxConsume: "chat.inbox.consume",
  },
  chatGeneratePayloadSchema: { parse: (value: unknown) => value },
  chatMemoryExtractPayloadSchema: { parse: (value: unknown) => value },
}));
vi.mock("./queue.js", () => ({
  runWorker: vi.fn((queue: string, handler: WorkerHandler) => {
    runtime.handlers.set(queue, handler);
    return { close: vi.fn(async () => {}) };
  }),
}));
vi.mock("./runtime-readiness.js", () => ({
  runtimeReadiness: {
    refreshDependencies: runtime.refreshDependencies,
  },
}));
vi.mock("./generate.js", () => ({
  processGenerateJob: runtime.processGenerateJob,
  terminalizeGenerateJobFailure: runtime.terminalizeGenerateJobFailure,
}));
vi.mock("./memory.js", () => ({
  processMemoryExtract: runtime.processMemoryExtract,
}));
vi.mock("./outbox.js", () => ({
  deliverPendingOutbox: runtime.deliverPendingOutbox,
}));
vi.mock("./inbox.js", () => ({
  consumeDurableInbox: runtime.consumeDurableInbox,
  reprocessPendingInbox: vi.fn(),
}));
vi.mock("./reconcile.js", () => ({ reconcile: vi.fn() }));
vi.mock("./maintain.js", () => ({ pruneExpiredSegments: vi.fn() }));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

const { startWorker } = await import("./worker.js");

describe("chat worker readiness admission", () => {
  beforeEach(() => {
    runtime.handlers.clear();
    runtime.refreshDependencies.mockReset();
    runtime.processGenerateJob.mockClear();
    runtime.terminalizeGenerateJobFailure.mockClear();
    runtime.processMemoryExtract.mockClear();
    runtime.deliverPendingOutbox.mockClear();
    runtime.consumeDurableInbox.mockClear();
  });

  it("does not admit a queued turn after runtime dependencies fail", async () => {
    runtime.refreshDependencies.mockResolvedValue(false);
    const worker = startWorker();
    const handler = runtime.handlers.get("chat.generate");
    expect(handler).toBeDefined();

    try {
      await expect(handler!({
        id: "job-1",
        payload: { assistantMessageId: "message-1" },
        attemptsMade: 0,
        maxAttempts: 5,
      })).rejects.toThrow("chat runtime is not ready");
      expect(runtime.processGenerateJob).not.toHaveBeenCalled();
    } finally {
      await worker.close();
    }
  });

  it("terminalizes the assistant when the final queued attempt is rejected by readiness", async () => {
    runtime.refreshDependencies.mockResolvedValue(false);
    const worker = startWorker();
    const handler = runtime.handlers.get("chat.generate");
    const payload = {
      sessionId: "session-1",
      assistantMessageId: "message-1",
      userMessageId: "user-message-1",
      attempt: 1,
    };

    try {
      await expect(handler!({
        id: "job-final",
        payload,
        attemptsMade: 4,
        maxAttempts: 5,
      })).rejects.toThrow("chat runtime is not ready");
      expect(runtime.processGenerateJob).not.toHaveBeenCalled();
      expect(runtime.terminalizeGenerateJobFailure).toHaveBeenCalledWith(payload);
    } finally {
      await worker.close();
    }
  });

  it("keeps durable convergence workers running while turn admission is down", async () => {
    runtime.refreshDependencies.mockResolvedValue(false);
    const worker = startWorker();

    try {
      await expect(runtime.handlers.get("chat.memory.extract")!({
        id: "memory-job",
        payload: { assistantMessageId: "message-1" },
        attemptsMade: 0,
        maxAttempts: 5,
      })).resolves.toBeUndefined();
      await expect(runtime.handlers.get("chat.outbox.deliver")!({
        id: "outbox-job",
        payload: {},
        attemptsMade: 0,
        maxAttempts: 5,
      })).resolves.toBeUndefined();
      await expect(runtime.handlers.get("chat.inbox.consume")!({
        id: "inbox-job",
        payload: { receiptId: "receipt-1" },
        attemptsMade: 0,
        maxAttempts: 5,
      })).resolves.toBeUndefined();

      expect(runtime.processMemoryExtract).toHaveBeenCalledOnce();
      expect(runtime.deliverPendingOutbox).toHaveBeenCalledOnce();
      expect(runtime.consumeDurableInbox).toHaveBeenCalledWith("receipt-1");
      expect(runtime.refreshDependencies).not.toHaveBeenCalled();
    } finally {
      await worker.close();
    }
  });
});
