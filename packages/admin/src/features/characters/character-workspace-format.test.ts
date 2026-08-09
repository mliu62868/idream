import { describe, expect, it } from "vitest";
import { characterReleaseOrdinals } from "./character-workspace-format";

describe("Character release ordinals", () => {
  // SPEC: 发布序号按发布时间单调递增。
  // INTENT: CharacterRelease.version 是行级乐观锁计数，曾被当成发布号渲染，导致
  // "v2 比 v1 更早发布" —— 回滚下拉里读起来像回滚到更新的版本。
  it("numbers releases by publish time, not by the row lock version", () => {
    const ordinals = characterReleaseOrdinals([
      { release: { id: "live", publishedAt: "2026-07-24T00:40:28.924Z", createdAt: "2026-07-24T00:40:28.924Z" } },
      { release: { id: "older", publishedAt: "2026-07-20T04:13:28.650Z", createdAt: "2026-07-20T04:13:28.650Z" } },
    ]);
    expect(ordinals.get("older")).toBe(1);
    expect(ordinals.get("live")).toBe(2);
  });


  // SPEC: 还没发布的候选版本用 createdAt 排，不能因为 publishedAt 为 null 就掉到最前面。
  it("falls back to createdAt for releases that were never published", () => {
    const ordinals = characterReleaseOrdinals([
      { release: { id: "candidate", publishedAt: null, createdAt: "2026-07-28T00:00:00.000Z" } },
      { release: { id: "published", publishedAt: "2026-07-24T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z" } },
    ]);
    expect(ordinals.get("published")).toBe(1);
    expect(ordinals.get("candidate")).toBe(2);
  });
});
