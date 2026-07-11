import { describe, expect, it } from "vitest";
import { buildCaseQuery } from "./query";

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
});
