import { describe, expect, it } from "vitest";
import { moderationDecisionConfirmation, moderationQueryFromSearch, moderationQueuePath, moderationWorkspaceUrl } from "./query";

describe("moderation query", () => {
  it("restores all three authority cursors and maps filters to scoped server queries", () => {
    const query = moderationQueryFromSearch("?moderationSearch=case&moderationStatus=open&moderationTargetType=media&reportCursor=r&mediaCursor=m&appealCursor=a");
    expect(query).toEqual({ search: "case", status: "open", targetType: "media", reportCursor: "r", mediaCursor: "m", appealCursor: "a" });
    expect(moderationQueuePath(query, "reports")).toBe("/api/v2/admin/moderation/queue?scope=reports&limit=25&search=case&status=open&targetType=media&reportCursor=r");
    expect(moderationQueuePath(query, "media")).toBe("/api/v2/admin/moderation/queue?scope=media&limit=25&search=case&status=open&targetType=media&mediaCursor=m");
    expect(moderationQueuePath(query, "appeals")).toBe("/api/v2/admin/moderation/queue?scope=appeals&limit=25&search=case&status=open&targetType=media&appealCursor=a");
  });

  it("preserves route state and exact high-risk confirmations", () => {
    const query = moderationQueryFromSearch("");
    expect(moderationWorkspaceUrl("/admin/moderation", "?view=queue", query)).toBe("/admin/moderation?view=queue");
    expect(moderationDecisionConfirmation("action", "report-1")).toBe("TAKEDOWN");
    expect(moderationDecisionConfirmation("close", "report-1")).toBe("report-1");
    expect(moderationDecisionConfirmation("overturn", "appeal-1")).toBe("OVERTURN");
  });
});
