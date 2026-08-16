import { describe, expect, it } from "vitest";
import {
  auditCommandPath,
  auditListPath,
  auditQueryFromSearch,
  auditWorkspaceUrl,
  isAuditQueryFiltered,
} from "./query";

describe("Audit workspace query contract", () => {
  it("maps canonical URL state to the complete server-side audit query", () => {
    const query = auditQueryFromSearch(
      "?auditSearch=release&auditAction=character.release.publish&auditActor=operator-1&auditTargetType=character_release&auditCursor=cursor-2&commandId=command-9",
    );

    expect(query).toEqual({
      search: "release",
      action: "character.release.publish",
      actorId: "operator-1",
      targetType: "character_release",
      cursor: "cursor-2",
      commandId: "command-9",
    });
    expect(auditListPath(query)).toBe(
      "/api/v2/admin/audit-log?search=release&action=character.release.publish&actorId=operator-1&targetType=character_release&cursor=cursor-2&limit=25",
    );
    expect(auditCommandPath(query.commandId)).toBe("/api/v2/admin/commands/command-9");
  });

  it("preserves unrelated deep-link state, clears the cursor on a new filter, and omits empty values", () => {
    expect(auditWorkspaceUrl(
      "/admin/system/audit",
      "?commandId=command-9&auditCursor=old&auditSearch=before",
      { auditSearch: " after ", auditAction: null },
      ["auditCursor"],
    )).toBe("/admin/system/audit?commandId=command-9&auditSearch=after");
  });

  it("distinguishes filtered empty results from a true empty authority", () => {
    expect(isAuditQueryFiltered(auditQueryFromSearch("?auditCursor=page-2&commandId=command-9"))).toBe(false);
    expect(isAuditQueryFiltered(auditQueryFromSearch("?auditActor=operator-1"))).toBe(true);
  });
});
