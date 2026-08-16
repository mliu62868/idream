import { describe, expect, it } from "vitest";
import { overviewPath, overviewQueryFromSearch, overviewWorkspaceUrl } from "./query";

describe("overview query", () => {
  it("maps scoped windows to server queries", () => {
    const query = overviewQueryFromSearch("?providerFrom=2026-07-01&providerTo=2026-07-12", "provider");
    expect(overviewPath("/api/v2/admin/ops/providers", query)).toBe(
      "/api/v2/admin/ops/providers?from=2026-07-01&to=2026-07-12",
    );
  });

  it("preserves unrelated URL state", () => {
    expect(
      overviewWorkspaceUrl("/admin/ops/providers", "?view=health", "provider", {
        from: "",
        to: "",
      }),
    ).toBe("/admin/ops/providers?view=health");
  });
});
