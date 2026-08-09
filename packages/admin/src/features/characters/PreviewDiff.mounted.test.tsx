// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { PreviewDiff } from "./PreviewDiff";

const blockedPreviewWorkspace = characterWorkspaceDetail({
  character: { id: "alexa-reeves" },
  project: {
    draftAssetRouteAuthority: {
      qaReady: false,
      status: "current",
      qaBlockers: [],
    },
  },
  // 图池完成度读服务端 journey 投影，不数 preview 快照的槽位。
  journey: {
    assetPack: {
      draft: {
        availablePurposes: ["character_cover"],
        missingPurposes: ["character_hero", "character_chat"],
        completed: 1,
        total: 3,
      },
      live: {
        availablePurposes: ["character_cover"],
        missingPurposes: ["character_hero", "character_chat"],
        completed: 1,
        total: 3,
      },
    },
  },
  preview: {
    changedFields: ["imageUrl", "assetPack"],
    live: {
      label: "Live",
      name: "Alexa Reeves",
      assetPack: {
        character_cover: { imageUrl: "/live.webp" },
        character_hero: { imageUrl: null },
        character_chat: { imageUrl: null },
      },
    },
    draft: {
      label: "Draft Preview",
      name: "Alexa Reeves",
      assetPackReady: false,
      assetPack: {
        character_cover: { imageUrl: "/draft.webp" },
        character_hero: { imageUrl: null },
        character_chat: { imageUrl: null },
      },
    },
  },
  releases: [],
  qaRuns: [],
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Character launch preview — zh operators", () => {
  it("stops a blocked launch preview at the blocker and compact comparison", () => {
    act(() => {
      root.render(
        <AdminI18nProvider locale="zh">
          <PreviewDiff
            data={blockedPreviewWorkspace}
            permissions={{ reviewRelease: true } as never}
            runCommittedMutation={(async () => ({ result: undefined, refreshed: false })) as never}
          />
        </AdminI18nProvider>,
      );
    });
    expect(container.textContent).toContain("上线预览正在等待图片资产包");
    expect(container.textContent).toContain("缺少 2 个图片位");
    expect(container.textContent).not.toContain("Launch QA");
    expect(container.textContent).not.toContain("上线 QA");
    expect(container.querySelectorAll("article")).toHaveLength(2);
  });
});
