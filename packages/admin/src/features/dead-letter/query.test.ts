import { describe, expect, it } from "vitest";
import {
  deadLetterConfirmation,
  deadLetterListPath,
  deadLetterQueryFromSearch,
  deadLetterWorkspaceUrl,
  defaultDeadLetterQuery,
} from "./query";

describe("dead-letter query", () => {
  it("restores server query and cursor state from browser history", () => {
    expect(deadLetterQueryFromSearch("?deadSearch=owner&deadMode=image&deadStatus=failed&deadError=timeout&deadCursor=next"))
      .toEqual({ search: "owner", mode: "image", status: "failed", errorCode: "timeout", cursor: "next" });
  });

  it("maps filters to the authority endpoint without client-side filtering", () => {
    expect(deadLetterListPath(deadLetterQueryFromSearch("?deadSearch=owner&deadMode=video&deadStatus=blocked&deadError=policy&deadCursor=c1")))
      .toBe("/api/v1/admin/generation/dead-letter?search=owner&mode=video&status=blocked&errorCode=policy&cursor=c1&limit=25");
  });

  it("preserves canonical view state and uses the server confirmation contract", () => {
    expect(deadLetterWorkspaceUrl("/admin/ops/jobs", "?view=dead-letter", defaultDeadLetterQuery))
      .toBe("/admin/ops/jobs?view=dead-letter");
    expect(deadLetterConfirmation(["job-a", "job-b"])).toBe("job-a,job-b");
  });
});
