// @vitest-environment happy-dom

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn(),
}));

vi.mock("@/lib/admin-v2-api", () => ({
  adminV2Request,
}));
vi.mock("@/components/admin/i18n", () => ({
  useAdminI18n: () => ({
    t: (
      value: string,
      values?: Readonly<Record<string, string | number>>,
    ) => Object.entries(values ?? {}).reduce(
      (text, [key, replacement]) =>
        text.replaceAll(`{${key}}`, String(replacement)),
      value,
    ),
  }),
}));

import {
  CharacterVideoStudio,
  characterVideoSourceOptions,
} from "./CharacterVideoStudio";

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Character Video Studio");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const data = {
  character: {
    id: "character-video-1",
    name: "Mira",
  },
  project: {
    draftAssetPack: {
      character_cover: "source-cover",
      character_hero: "source-hero",
    },
  },
  visual: {
    videoSources: [
      {
        mediaAssetId: "source-recent",
        available: true,
        url: "/recent.webp",
        thumbnailUrl: "/recent-thumb.webp",
      },
    ],
    anchors: [
      {
        mediaAssetId: "source-hero",
        role: "identity_anchor",
        available: true,
        url: "/hero.webp",
        thumbnailUrl: "/hero-thumb.webp",
      },
      {
        mediaAssetId: "source-cover",
        role: "identity_anchor",
        available: true,
        url: "/cover.webp",
        thumbnailUrl: null,
      },
    ],
    references: [
      {
        mediaAssetId: "source-cover",
        role: "identity_reference",
        available: true,
        url: "/cover.webp",
        thumbnailUrl: null,
      },
    ],
  },
} as unknown as CharacterWorkspaceDetail;

const pendingRun = {
  id: "video-run-1",
  purpose: "character_video",
  target: { type: "character", id: "character-video-1" },
  ownerId: "actor-1",
  dueAt: null,
  priority: "normal",
  lifecycleState: "active",
  workflowStage: "generation",
  executionOutcome: "running",
  reviewState: "not_ready",
  deploymentState: "unplaced",
  verificationState: "pending",
  settlementView: "not_required",
  retryEligibility: { eligibleItemIds: [], eligibleCount: 0 },
  legacyState: "queued",
  counts: {
    generated: 0,
    failed: 0,
    reviewed: 0,
    approved: 0,
    placed: 0,
    total: 1,
  },
  version: 1,
  createdAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:00:00.000Z",
  title: "Mira motion portrait",
  reviewContext: {
    brief: "A subtle smile.",
    orientation: "2:3",
    profile: {
      key: "profile_video_beta_v1",
      version: 1,
      label: "LTX 2.3 GTAnimation I2V",
    },
    recipe: {
      key: "template_video_character_default",
      version: 1,
      label: "Video character beta",
    },
    referenceAssetCount: 1,
    experiment: null,
  },
  items: [{
    id: "video-item-1",
    ordinal: 0,
    status: "queued",
    executionState: "generating",
    identityReviewMode: "preserves_identity",
    version: 1,
    retryability: "unknown",
    direction: null,
    lineage: {
      briefId: "video-run-1",
      directionId: null,
      directionHash: null,
      generationProfileKey: "profile_video_beta_v1",
      generationProfileVersion: "1",
      workflowKey: "ltx23-gtanimation-i2v",
      workflowVersion: "1",
      requestId: "video-job-1",
      attemptId: "video-attempt-1",
      providerRequestId: null,
      seed: "video-seed",
      assetId: null,
      reviewDecisionId: null,
      placementVersionId: null,
    },
    asset: null,
    review: null,
    placement: null,
  }],
};

describe("Character Video Studio", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Request.mockReset();
    adminV2Request.mockImplementation(async (path: string, options?: {
      method?: string;
    }) => {
      if (path === "/api/v2/admin/creative/runs" && options?.method === "POST") {
        return { batch: { id: "video-run-1" }, replayed: false };
      }
      if (path === "/api/v2/admin/creative/runs/video-run-1") {
        return pendingRun;
      }
      return {
        items: [],
        pageInfo: { endCursor: null, hasNextPage: false },
      };
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("puts adopted image slots first and de-duplicates the same source", () => {
    expect(characterVideoSourceOptions(data)).toEqual([
      expect.objectContaining({
        assetId: "source-cover",
        label: "Primary portrait",
      }),
      expect.objectContaining({
        assetId: "source-hero",
        label: "Character hero",
      }),
      expect.objectContaining({
        assetId: "source-recent",
        label: "Character image {id}",
      }),
    ]);
  });

  it("creates one pinned 4-second Character video Run from the selected image", async () => {
    await act(async () => root.render(
      <CharacterVideoStudio
        data={data}
        onCreateImage={vi.fn()}
        permissions={{ create: true, read: true, review: true }}
      />,
    ));
    await waitUntil(() => container.textContent?.includes("Create video") === true);

    expect(container.textContent).toContain("LTX 2.3 GTAnimation");
    expect(container.textContent).toContain("4 seconds");
    expect(container.textContent).toContain("New video");
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    const secondaryDetails = [...container.querySelectorAll("details")];
    expect(secondaryDetails.length).toBeGreaterThan(0);
    expect(secondaryDetails.every((details) => details.open === false)).toBe(true);
    const create = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Create video"));
    await waitUntil(() => create?.disabled === false);
    expect(create?.disabled).toBe(false);

    await act(async () => {
      create?.click();
    });
    await waitUntil(() => adminV2Request.mock.calls.some(
      ([path, options]) =>
        path === "/api/v2/admin/creative/runs" &&
        (options as { method?: string } | undefined)?.method === "POST",
    ));

    const createCall = adminV2Request.mock.calls.find(
      ([path, options]) =>
        path === "/api/v2/admin/creative/runs" &&
        (options as { method?: string } | undefined)?.method === "POST",
    );
    expect(createCall?.[1]).toMatchObject({
      method: "POST",
      body: {
        purpose: "character_video",
        targetType: "character",
        targetId: "character-video-1",
        profileId: "profile_video_beta_v1",
        referenceAssetIds: ["source-cover"],
        orientation: "2:3",
        count: 1,
      },
    });
    await waitUntil(() => container.textContent?.includes("Generating video") === true);
  });

  it("shows the executable prerequisite when no Character image is available", async () => {
    const noSourceData = {
      ...data,
      project: { draftAssetPack: {} },
      visual: { anchors: [], references: [], videoSources: [] },
    } as unknown as CharacterWorkspaceDetail;
    const onCreateImage = vi.fn();
    await act(async () => root.render(
      <CharacterVideoStudio
        data={noSourceData}
        onCreateImage={onCreateImage}
        permissions={{ create: true, read: true, review: true }}
      />,
    ));
    await waitUntil(() =>
      container.textContent?.includes("Create a Character image first") === true
    );
    const create = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Create video"));
    expect(create?.disabled).toBe(true);
    const createImage = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Create a Character image"));
    await act(async () => {
      createImage?.click();
    });
    expect(onCreateImage).toHaveBeenCalledOnce();
  });
});
