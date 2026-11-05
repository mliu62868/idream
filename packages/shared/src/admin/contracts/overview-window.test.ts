import { describe, expect, it } from "vitest";
import { adminOverviewWindowQuerySchema } from "./overviews";
import { generationProviderOpsQuerySchema } from "./generation-ops";
import { riskAbuseQuerySchema } from "./risk";

describe.each([
  ["Product Health legacy", adminOverviewWindowQuerySchema],
  ["Providers", generationProviderOpsQuerySchema],
  ["Risk", riskAbuseQuerySchema],
] as const)("%s window query", (_name, schema) => {
  it("rejects an inverted window using absolute instants rather than string order", () => {
    expect(schema.safeParse({ from: "2026-10-06T02:00:00.000Z", to: "2026-10-06T01:00:00.000Z" }).success).toBe(false);
    expect(schema.safeParse({ from: "2026-10-06T00:00:00+00:00", to: "2026-10-06T01:00:00+02:00" }).success).toBe(false);
  });

  it("refuses text and calendar days that Date.parse would have guessed at", () => {
    expect(schema.safeParse({ from: "foo 1" }).success).toBe(false);
    expect(schema.safeParse({ from: "2026-02-31", to: "2026-03-05" }).success).toBe(false);
  });

  it("keeps inclusive instants, future windows, defaults, and date-only callers", () => {
    expect(schema.parse({})).toEqual({});
    // Relative to today: an open-ended window is measured against now, so a fixed date would expire.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(schema.parse({ from: yesterday })).toEqual({ from: yesterday });
    expect(schema.safeParse({ from: "2100-10-06T00:00:00.000Z", to: "2100-10-06T01:00:00.000Z" }).success).toBe(true);
    expect(schema.safeParse({ from: "2026-10-06T02:00:00+02:00", to: "2026-10-06T00:00:00.000Z" }).success).toBe(true);
  });
});
