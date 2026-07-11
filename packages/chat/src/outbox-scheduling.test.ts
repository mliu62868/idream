import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_QUEUES } from "@idream/shared/contracts";

const enqueueMock = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ id: "job" })));

vi.mock("./queue.js", () => ({ enqueue: enqueueMock }));
vi.mock("./db.js", () => ({ chatPrisma: {} }));

const { scheduleOutboxDelivery } = await import("./outbox.js");

describe("outbox scheduling", () => {
  beforeEach(() => enqueueMock.mockClear());

  it("schedules every finalized turn even while prior completed jobs are retained", async () => {
    await scheduleOutboxDelivery();
    await scheduleOutboxDelivery();

    expect(enqueueMock).toHaveBeenCalledTimes(2);
    for (const [input] of enqueueMock.mock.calls) {
      expect(input).toEqual({ queue: CHAT_QUEUES.outboxDeliver, payload: {} });
    }
  });
});
