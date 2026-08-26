import { describe, expect, it } from "vitest";
import { siblingReportCounts } from "./sibling-reports";

// 实测抓自本地 `GET /api/v2/admin/moderation/queue`，排除审计探针后仍有一组同目标的。
const REAL_QUEUE = [
  { id: "cms0f6gpu005i70l7v4x3vzdd", targetType: "feed_item", targetId: "collection:zt-gap-feed-coll" },
  { id: "cmt7dlwn000ei3ql7pk09p66p", targetType: "feed_item", targetId: "character:lola-moonstruck" },
  { id: "cmt7dlwn000ei3ql7pk09p66q", targetType: "feed_item", targetId: "character:lola-moonstruck" },
  { id: "cmt7wi3sn00jn3ql70wcj9oz1", targetType: "chat_message", targetId: "msg_doesnotexist000000000000000000" },
];

describe("sibling reports on the same target", () => {
  it("counts the other reports on the same target, not the row itself", () => {
    const counts = siblingReportCounts(REAL_QUEUE);
    expect(counts.get("cmt7dlwn000ei3ql7pk09p66p")).toBe(1);
    expect(counts.get("cmt7dlwn000ei3ql7pk09p66q")).toBe(1);
  });

  it("says nothing about a target that appears once", () => {
    const counts = siblingReportCounts(REAL_QUEUE);
    expect(counts.has("cmt7wi3sn00jn3ql70wcj9oz1")).toBe(false);
    expect(counts.has("cms0f6gpu005i70l7v4x3vzdd")).toBe(false);
  });

  // SPEC: targetType 参与分组——同一个 id 挂在不同类型上不是同一个对象。
  // INTENT: targetId 实测长这样：`character:lola-moonstruck` 既可能是 feed_item 的 id，
  //         也可能被别的队列当成别的东西。只按 targetId 分组会把两个无关对象并成一组，
  //         然后叫审核员"一起裁决"。
  it("does not merge two different target types that share an id", () => {
    const counts = siblingReportCounts([
      { id: "a", targetType: "feed_item", targetId: "character:x" },
      { id: "b", targetType: "character", targetId: "character:x" },
    ]);
    expect(counts.size).toBe(0);
  });

  // SPEC: 坏数据不参与分组。
  // INTENT: 两条 targetType/targetId 都缺失的举报不是"同一个目标的两条举报"，
  //         把它们并成一组，等于叫审核员对着一个不存在的对象做批量判断。
  it("never groups rows that name no target at all", () => {
    const counts = siblingReportCounts([
      { id: "a", targetType: null, targetId: undefined },
      { id: "b" },
    ]);
    expect(counts.size).toBe(0);
  });

  it("ignores rows without a usable report id", () => {
    const counts = siblingReportCounts([
      { targetType: "character", targetId: "alexa-reeves" },
      { id: "b", targetType: "character", targetId: "alexa-reeves" },
    ]);
    expect(counts.size).toBe(0);
  });

  it("counts a target reported many times", () => {
    const counts = siblingReportCounts(
      ["r1", "r2", "r3", "r4"].map((id) => ({ id, targetType: "character", targetId: "alexa-reeves" })),
    );
    expect([...counts.values()]).toEqual([3, 3, 3, 3]);
  });
});
