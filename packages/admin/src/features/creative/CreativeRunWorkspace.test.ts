import { describe, expect, it } from "vitest";
import {
  authoredCampaignPlacementCopy,
  committedProjectionWarning,
  nonCampaignAssetSummary,
} from "./CreativeRunWorkspace";

// INTENT: 这个文件曾经有 36 条断言在读 CreativeRunWorkspace.tsx 的源码字符串——按
//         `indexOf("function ReviewForm")` 切片、比较两行文本的先后顺序。锁的是实现
//         文本不是行为：改个函数名切片会静默变空，重构必挂，真出回归照过。它们已经
//         搬进 CreativeRunWorkspace.mounted.test.tsx 里，用真渲染 + 真请求体去断。
//         这里只留下不需要渲染就能验的纯函数。

describe("Creative Run review handoff", () => {
  it("offers generated assets directly without requiring a review or closed lifecycle", () => {
    expect(nonCampaignAssetSummary(false)).toMatchObject({ title: "Waiting for an asset", complete: false });
    expect(nonCampaignAssetSummary(true)).toMatchObject({ title: "Asset ready", complete: true });
  });

  it("describes committed mutations separately from projection refresh failures", () => {
    // INVARIANT: 返回词典 key + 插值实参，不返回成品句子 —— 成品句子在中文后台里
    //            只能原样吐英文。权威原话仍然原样落在 {detail} 里，不加工。
    expect(committedProjectionWarning(
      "Placement activation",
      new Error("gateway unavailable"),
    )).toEqual({
      key: "{action} was committed, but the latest projection could not be refreshed{detail}. Retry the same command safely or refresh the workspace.",
      values: { action: "Placement activation", detail: ": gateway unavailable" },
    });
  });

  it("normalizes authored campaign copy", () => {
    expect(authoredCampaignPlacementCopy({
      eyebrow: "  Featured  ",
      title: "  Summer dreamers  ",
      ctaLabel: "  Open collection  ",
      href: "  /community?collection=summer  ",
    })).toEqual({
      eyebrow: "Featured",
      title: "Summer dreamers",
      ctaLabel: "Open collection",
      href: "/community?collection=summer",
    });
  });
});
