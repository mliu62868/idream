import { describe, expect, it } from "vitest";

import { FREE_DAILY_MESSAGES } from "./limits";

describe("chat quota product authority", () => {
  it("keeps the documented free daily allowance at 30 messages", () => {
    expect(FREE_DAILY_MESSAGES).toBe(30);
  });
});
