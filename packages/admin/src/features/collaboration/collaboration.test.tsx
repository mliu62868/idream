import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollaborationPanel, parseAttachmentIds, parseChecklist, parseMentionIds } from "./CollaborationPanel";
import {
  applySavedView,
  caseQueryFromSavedState,
  caseSavedState,
  incidentQueryFromSavedState,
  incidentSavedState,
  withoutSavedViewParam,
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

  it("turns checklist and attachment input into structured evidence", () => {
    expect(parseChecklist("[x] Disabled provider\n[ ] Verify recovery")).toEqual([
      { id: "item-1", completed: true, label: "Disabled provider" },
      { id: "item-2", completed: false, label: "Verify recovery" },
    ]);
    expect(parseAttachmentIds("asset-1, asset-1, asset-2")).toEqual([
      { id: "asset-1", label: "asset-1" },
      { id: "asset-2", label: "asset-2" },
    ]);
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

  it("applies an updated Saved View and clears stale URL selection without losing filters", () => {
    const selected: string[] = [];
    const applied: string[] = [];
    const now = new Date().toISOString();
    const view = { id: "view-2", scope: "incident" as const, label: "Critical", queryState: { search: "", filters: { severity: "critical" }, sort: { field: "id", direction: "asc" as const }, pageSize: 30 }, version: 2, createdAt: now, updatedAt: now };
    applySavedView(view, (id) => { if (id) selected.push(id); }, (next) => applied.push(next.id));
    expect(selected).toEqual(["view-2"]);
    expect(applied).toEqual(["view-2"]);
    expect(withoutSavedViewParam("?severity=critical&savedView=view-1&limit=30").toString()).toBe("severity=critical&limit=30");
  });
});
