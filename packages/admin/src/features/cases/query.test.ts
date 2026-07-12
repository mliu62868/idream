import { describe, expect, it } from "vitest";
import { buildCaseQuery, buildCaseWorkspaceParams, caseWorkspacePath, parseCaseWorkspaceParams } from "./query";

describe("case workspace query", () => {
  it("keeps saved view and deterministic cursor in the authority query", () => {
    expect(
      buildCaseQuery({
        view: "overdue",
        search: "character_7",
        type: "content_report",
        status: "",
        priority: "urgent",
        ownerId: "",
        sort: "updated_asc",
        cursor: "case_42",
        limit: 50,
      }),
    ).toBe(
      "view=overdue&search=character_7&type=content_report&priority=urgent&sort=updated_asc&cursor=case_42&limit=50",
    );
  });

  it("round-trips filters, cursor, selection, and saved view through the URL", () => {
    const params = buildCaseWorkspaceParams({
      query: {
        view: "appeals",
        search: "character 7",
        type: "appeal",
        status: "waiting",
        priority: "high",
        ownerId: "operator-1",
        sort: "updated_asc",
        cursor: "opaque:case:cursor",
        limit: 40,
      },
      selectedId: "case-7",
      savedViewId: "saved-2",
    });

    expect(parseCaseWorkspaceParams(params)).toEqual({
      query: {
        view: "appeals",
        search: "character 7",
        type: "appeal",
        status: "waiting",
        priority: "high",
        ownerId: "operator-1",
        sort: "updated_asc",
        cursor: "opaque:case:cursor",
        limit: 40,
      },
      selectedId: "case-7",
      savedViewId: "saved-2",
    });
  });

  it("keeps canonical detail routes stable", () => {
    expect(caseWorkspacePath("case/7")).toBe("/admin/cases/case%2F7");
    expect(caseWorkspacePath(null)).toBe("/admin/cases");
  });
});
