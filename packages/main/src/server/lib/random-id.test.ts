import { describe, expect, it } from "vitest";
import { cryptoRandomId } from "./random-id";

describe("cryptoRandomId", () => {
  it("preserves the caller prefix and returns a UUID-backed identifier", () => {
    expect(cryptoRandomId("event")).toMatch(
      /^event_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
