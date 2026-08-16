import { describe, expect, it } from "vitest";
import {
  chatOpsPath,
  chatOpsQueryFromSearch,
  chatOpsWorkspaceUrl,
} from "./query";

describe("Chat Ops query", () => {
  it("maps filters and authority-specific cursors to server requests", () => {
    const query = chatOpsQueryFromSearch(
      "?chatUserId=u1&chatCharacterId=c1&chatSessionStatus=active&chatEventStatus=blocked&chatEventLayer=output&chatPolicyCode=p1&chatTargetId=t1&chatLimit=25&chatSessionCursor=s&chatUsageCursor=u&chatEventCursor=e",
    );
    expect(chatOpsPath(query, "sessions")).toBe(
      "/api/v2/admin/chat/sessions?limit=25&userId=u1&characterId=c1&status=active&cursor=s",
    );
    expect(chatOpsPath(query, "usage")).toBe(
      "/api/v2/admin/chat/usage?limit=25&userId=u1&cursor=u",
    );
    expect(chatOpsPath(query, "events")).toBe(
      "/api/v2/admin/chat/moderation-events?limit=25&status=blocked&layer=output&policyCode=p1&targetId=t1&cursor=e",
    );
  });

  it("round-trips URL state without dropping unrelated route values", () => {
    const query = chatOpsQueryFromSearch("");
    expect(chatOpsWorkspaceUrl("/admin/chat", "?view=ops", query)).toBe(
      "/admin/chat?view=ops",
    );
  });
});
