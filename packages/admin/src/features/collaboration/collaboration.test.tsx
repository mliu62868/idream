import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollaborationPanel, parseMentionIds } from "./CollaborationPanel";
import {
  caseQueryFromSavedState,
  caseSavedState,
  incidentQueryFromSavedState,
  incidentSavedState,
} from "./saved-views";

describe("Admin collaboration UI", () => {
  it("renders a structure-matched loading timeline and hides writes without permission", () => {
    const html = renderToStaticMarkup(<CollaborationPanel canWrite={false} targetId="incident-1" targetType="incident" />);
    expect(html).toContain("Collaboration");
    expect(html).toContain("Loading collaboration activity");
    expect(html).toContain("Read access only");
    expect(html).not.toContain("Add activity");
  });

  it("deduplicates bounded mention IDs", () => {
    expect(parseMentionIds(" a, b, a, , c ")).toEqual(["a", "b", "c"]);
    expect(parseMentionIds(Array.from({ length: 60 }, (_, index) => `u${index}`).join(","))).toHaveLength(50);
  });

  it("round trips supported Incident server-query fields", () => {
    const query = { search: "timeout", status: "triaged", severity: "critical", ownerId: "user-1", limit: 75 };
    expect(incidentQueryFromSavedState(incidentSavedState(query))).toEqual(query);
  });

  it("round trips supported Case server-query fields", () => {
    const query = { view: "overdue", search: "case-7", type: "billing_dispute", status: "in_progress", priority: "urgent", ownerId: "user-2", sort: "updated_asc" as const, limit: 40 };
    expect(caseQueryFromSavedState(caseSavedState(query))).toEqual(query);
  });

  it("fails closed to supported filters when a saved view contains stale values", () => {
    expect(incidentQueryFromSavedState({ search: "", filters: { severity: "catastrophic" }, sort: { field: "id", direction: "asc" }, pageSize: 25 }).severity).toBe("");
    expect(caseQueryFromSavedState({ search: "", filters: { view: "deleted_view" }, sort: { field: "updated_at", direction: "asc" }, pageSize: 25 }).view).toBe("mine");
  });
});
