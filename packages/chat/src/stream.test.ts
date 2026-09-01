import { describe, expect, it } from "vitest";
import { streamEventMatchesAttempt, streamEventRefreshesExpiry } from "./stream.js";

describe("stream attempt isolation", () => {
  it("skips terminal events left by an older regenerated attempt", () => {
    expect(streamEventMatchesAttempt({
      type: "done",
      attempt: 1,
      usage: { promptTokens: 1, completionTokens: 1 },
    }, 2)).toBe(false);
    expect(streamEventMatchesAttempt({
      type: "delta",
      attempt: 2,
      seq: 1,
      delta: "new reply",
    }, 2)).toBe(true);
  });

  it("keeps the unfiltered behavior for ordinary first-attempt streams", () => {
    expect(streamEventMatchesAttempt({ type: "start", attempt: 1 }, undefined)).toBe(true);
  });

  it("refreshes retention only at stream boundaries", () => {
    expect(streamEventRefreshesExpiry({ type: "start", attempt: 1 })).toBe(true);
    expect(streamEventRefreshesExpiry({
      type: "delta",
      attempt: 1,
      seq: 1,
      delta: "hello",
    })).toBe(false);
    expect(streamEventRefreshesExpiry({
      type: "done",
      attempt: 1,
      usage: { promptTokens: 1, completionTokens: 1 },
    })).toBe(true);
  });
});
