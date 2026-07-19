import { describe, expect, it, vi } from "vitest";

const recordOutboxMock = vi.hoisted(() => vi.fn(async () => "evt_correction"));
vi.mock("./outbox.js", () => ({ recordOutbox: recordOutboxMock }));

const { recordExchangeCorrection } = await import("./exchange-corrections.js");

describe("recordExchangeCorrection", () => {
  it.each([
    ["selected", "assistant_2"],
    ["edited", undefined],
    ["deleted", undefined],
    ["superseded", undefined],
  ] as const)("publishes a typed %s correction through the transactional seam", async (correctionType, selectedAssistantMessageId) => {
    const tx = {} as Parameters<typeof recordExchangeCorrection>[0];
    await recordExchangeCorrection(tx, {
      exchangeId: "exchange_1",
      correctionType,
      correctionRevision: 2,
      userId: "user_1",
      ...(selectedAssistantMessageId ? { selectedAssistantMessageId } : {}),
    });

    expect(recordOutboxMock).toHaveBeenLastCalledWith(tx, expect.objectContaining({
      eventType: "chat.exchange.corrected.v2",
      schemaVersion: 2,
      aggregateId: "exchange_1",
      payload: expect.objectContaining({ correctionType, correctionRevision: 2 }),
    }));
  });

  it("rejects a selection correction without its selected assistant message", async () => {
    await expect(recordExchangeCorrection({} as Parameters<typeof recordExchangeCorrection>[0], {
      exchangeId: "exchange_1",
      correctionType: "selected",
      correctionRevision: 2,
      userId: "user_1",
    })).rejects.toThrow("Selection corrections require the selected assistant message id");
  });

  it("preserves optional privacy authority for downstream derived-data redaction", async () => {
    const tx = {} as Parameters<typeof recordExchangeCorrection>[0];
    await recordExchangeCorrection(tx, {
      exchangeId: "exchange_1",
      correctionType: "deleted",
      correctionRevision: 2,
      userId: "user_1",
      sessionId: "session_1",
      messageIds: ["exchange_1", "assistant_2"],
    });

    expect(recordOutboxMock).toHaveBeenLastCalledWith(tx, expect.objectContaining({
      payload: expect.objectContaining({
        sessionId: "session_1",
        messageIds: ["exchange_1", "assistant_2"],
      }),
    }));
  });
});
