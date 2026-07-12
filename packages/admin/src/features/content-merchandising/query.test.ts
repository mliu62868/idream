import { describe, expect, it } from "vitest";
import { contentListPath, contentQueryFromSearch, contentWorkspaceUrl } from "./query";

describe("content merchandising query", () => {
  it("maps server filters and stable cursor", () => {
    const query = contentQueryFromSearch("?contentSearch=ava&contentStatus=approved&contentVisibility=public&contentCursor=next");
    expect(contentListPath(query)).toBe("/api/v1/admin/content/characters?limit=25&search=ava&status=approved&visibility=public&cursor=next");
  });

  it("preserves unrelated URL state", () => {
    expect(contentWorkspaceUrl("/admin/content", "?view=featured", contentQueryFromSearch(""))).toBe("/admin/content?view=featured");
  });
});
