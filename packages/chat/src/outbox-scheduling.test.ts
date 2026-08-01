import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_QUEUES } from "@idream/shared/contracts";
import { scheduleOutboxDelivery } from "./outbox.js";

const enqueueMock = vi.fn(async (_input: unknown) => ({ id: "job" }));

describe("outbox scheduling", () => {
  beforeEach(() => enqueueMock.mockClear());

  it("schedules every finalized turn even while prior completed jobs are retained", async () => {
    await scheduleOutboxDelivery(enqueueMock as never);
    await scheduleOutboxDelivery(enqueueMock as never);

    expect(enqueueMock).toHaveBeenCalledTimes(2);
    for (const [input] of enqueueMock.mock.calls) {
      expect(input).toEqual({ queue: CHAT_QUEUES.outboxDeliver, payload: {} });
    }
  });
});
