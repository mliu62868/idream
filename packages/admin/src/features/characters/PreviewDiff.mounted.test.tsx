// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { PreviewDiff, ReleaseChangeSummary, releasePreviewChangeSummary } from "./PreviewDiff";

const blockedPreviewWorkspace = characterWorkspaceDetail({
  character: { id: "alexa-reeves" },
  project: {
    draftAssetRouteAuthority: {
      releaseReady: false,
      status: "current",
      releaseBlockers: [],
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
      ...characterWorkspaceDetail().preview.draft,
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
});

function ReleasePreview({ data }: { data: Parameters<typeof PreviewDiff>[0]["data"] }) {
  return <><ReleaseChangeSummary data={data} /><PreviewDiff data={data} /></>;
}

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
  it("compares saved text even while the image pack is incomplete", () => {
    const base = characterWorkspaceDetail();
    act(() => root.render(<ReleasePreview data={characterWorkspaceDetail({
      project: { draftAssetRouteAuthority: { releaseReady: false } },
      preview: {
        changedFields: ["name", "opening"],
        live: { ...base.preview.draft, label: "Live", name: "Live name", description: "Live description", opening: { firstMessage: "Live opening" } },
        draft: { name: "Draft name", description: "Draft description", opening: { firstMessage: "Draft opening" }, assetPackReady: false },
      },
    })} />));
    expect(container.textContent).toContain("Live name");
    expect(container.textContent).toContain("Draft name");
    expect(container.textContent).toContain("Live description");
    expect(container.textContent).toContain("Draft description");
    expect(container.textContent).toContain("Live opening");
    expect(container.textContent).toContain("Draft opening");
    expect(container.querySelector("iframe")).toBeNull();
  });
  it("turns authority field keys into an operator-readable release summary", () => {
    expect(
      releasePreviewChangeSummary(["name", "opening", "assetPack"]),
    ).toEqual({
      firstRelease: false,
      labels: ["Character name", "Opening message", "Image pack"],
    });
    expect(releasePreviewChangeSummary(["new_release"])).toEqual({
      firstRelease: true,
      labels: ["First release"],
    });
  });

  it("stops a blocked launch preview at the blocker and compact comparison", () => {
    act(() => {
      root.render(
        <AdminI18nProvider locale="zh">
          <ReleasePreview data={blockedPreviewWorkspace} />
        </AdminI18nProvider>,
      );
    });
    expect(container.textContent).toContain("上线预览正在等待图片资产包");
    expect(container.textContent).toContain("发布变更摘要");
    expect(container.textContent).toContain("草稿与当前发布版本有 2 处不同");
    expect(container.textContent).toContain("封面图片");
    expect(container.textContent).toContain("图片资产包");
    expect(container.textContent).toContain("缺少 2 个图片位");
    expect(container.textContent).not.toContain("Launch QA");
    expect(container.textContent).not.toContain("上线 QA");
    expect(container.querySelectorAll("article")).toHaveLength(2);
  });

  it("compares a paused Character to its retained release", () => {
    act(() => root.render(<AdminI18nProvider locale="zh"><ReleasePreview data={characterWorkspaceDetail({
      journey: { release: { servingState: "paused", currentReleaseId: "release-2" } },
      preview: {
        live: null,
        changedFields: ["opening"],
        comparison: { name: "Mira", description: "A warm host", opening: { firstMessage: "Original opening" } },
        draft: { opening: { firstMessage: "Changed opening" } },
      },
    })} /></AdminI18nProvider>));
    const summary = container.querySelector('[data-testid="release-change-summary"]');
    expect(summary?.textContent).toContain("Original opening");
    expect(summary?.textContent).toContain("Changed opening");
    expect(container.querySelector('iframe[title^="已上线"]')).toBeNull();
    expect(container.textContent).not.toContain("首次发布");
  });

  it("closes preview when the live and draft snapshots are already identical", () => {
    const unchanged = characterWorkspaceDetail({
      preview: {
        live: {
          ...characterWorkspaceDetail().preview.draft,
          label: "Live",
          name: "Mira",
        },
        changedFields: [],
      },
      journey: { release: { candidateReleaseId: null } },
    });

    act(() => {
      root.render(
        <AdminI18nProvider locale="en">
          <ReleasePreview data={unchanged} />
        </AdminI18nProvider>,
      );
    });

    expect(container.textContent).toContain("Draft matches the current release.");
    expect(container.textContent).not.toContain(
      "Full launch preview is waiting for the image pack",
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("still renders what customers see when live and draft are identical", () => {
    act(() => {
      root.render(
        <AdminI18nProvider locale="en">
          <ReleasePreview data={characterWorkspaceDetail({
            preview: {
              live: { ...characterWorkspaceDetail().preview.draft, label: "Live", name: "Mira", renderUrl: "about:blank#live-render" },
              changedFields: [],
            },
            journey: { release: { candidateReleaseId: null } },
          })} />
        </AdminI18nProvider>,
      );
    });

    expect(container.textContent).toContain("Draft matches the current release.");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      "about:blank#live-render",
    );
  });

  it("shows a ready preview without confirmation forms", () => {
    const ready = characterWorkspaceDetail({
      project: {
        draftAssetRouteAuthority: {
          releaseReady: true,
          status: "current",
          releaseBlockers: [],
        },
      },
      journey: { release: { candidateReleaseId: null } },
      preview: {
        changedFields: ["new_release"],
        live: null,
        draft: {
          contentVersionId: "content-ready",
          assetPackReady: true,
        },
      },
      releases: [],
    });

    act(() => {
      root.render(
        <AdminI18nProvider locale="en">
          <ReleasePreview data={ready} />
        </AdminI18nProvider>,
      );
    });

    expect(container.textContent).toContain("Real user-surface renderer");
    expect(container.textContent).toContain("Current and draft assets");
    expect(container.textContent).not.toContain("Launch checks");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("First release — nothing is live yet.");
  });
});
