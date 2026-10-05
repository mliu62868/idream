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

  it("keeps inclusive instants, future windows, defaults, and date-only callers", () => {
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ from: "2026-10-06" })).toEqual({ from: "2026-10-06" });
    expect(schema.safeParse({ from: "2100-10-06T00:00:00.000Z", to: "2100-10-06T01:00:00.000Z" }).success).toBe(true);
    expect(schema.safeParse({ from: "2026-10-06T02:00:00+02:00", to: "2026-10-06T00:00:00.000Z" }).success).toBe(true);
  });
});
