// @vitest-environment happy-dom

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request, runCommittedMutationSpy } = vi.hoisted(() => ({
  adminV2Request: vi.fn(),
  runCommittedMutationSpy: vi.fn(),
}));

async function runCommittedMutation<T>(input: {
  commit: () => Promise<T>;
  afterRefresh?: () => void;
}) {
  runCommittedMutationSpy(input);
  const result = await input.commit();
  input.afterRefresh?.();
  return { result, refreshed: true };
}

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});
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
import { readActiveDurableMutationIntent } from "@/lib/durable-mutation-intent";

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

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
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

const readyRun = {
  ...pendingRun,
  lifecycleState: "closed",
  workflowStage: "review",
  executionOutcome: "succeeded",
  reviewState: "pending",
  counts: {
    generated: 1,
    failed: 0,
    reviewed: 0,
    approved: 0,
    placed: 0,
    total: 1,
  },
  version: 2,
  items: [{
    ...pendingRun.items[0],
    status: "generated",
    executionState: "ready",
    version: 2,
    lineage: {
      ...pendingRun.items[0].lineage,
      assetId: "video-asset-1",
    },
    asset: {
      id: "video-asset-1",
      url: "/video-1.mp4",
      thumbnailUrl: null,
      width: 768,
      height: 1152,
    },
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
    runCommittedMutationSpy.mockClear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
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
        actorId="actor-1"
        data={data}
        onCreateImage={vi.fn()}
        permissions={{ create: true, read: true, review: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    ));
    await waitUntil(() => container.textContent?.includes("Create video") === true);

    expect(container.textContent).toContain("LTX 2.3 GTAnimation");
    expect(container.textContent).toContain("4 seconds");
    await waitUntil(() => adminV2Request.mock.calls.some(
      ([path, options]) => path.includes("/api/v2/admin/creative/runs?") && !options?.method,
    ));
    const listCall = adminV2Request.mock.calls.find(
      ([path, options]) => path.includes("/api/v2/admin/creative/runs?") && !options?.method,
    );
    expect(new URL(String(listCall?.[0]), "http://localhost").searchParams.get("purpose"))
      .toBe("character_video");
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
        actorId="actor-1"
        data={noSourceData}
        onCreateImage={onCreateImage}
        permissions={{ create: true, read: true, review: true }}
        runCommittedMutation={runCommittedMutation}
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

  it("recovers a lost create response after remount with the exact same request key", async () => {
    let createAttempts = 0;
    adminV2Request.mockImplementation(async (path: string, options?: {
      method?: string;
      idempotencyKey?: string;
      body?: unknown;
    }) => {
      if (path === "/api/v2/admin/creative/runs" && options?.method === "POST") {
        createAttempts += 1;
        if (createAttempts === 1) throw new Error("connection closed after submit");
        return { batch: { id: "video-run-1" }, replayed: true };
      }
      if (path === "/api/v2/admin/creative/runs/video-run-1") {
        return {
          ...pendingRun,
          reviewContext: {
            ...pendingRun.reviewContext,
            brief: "Locked motion brief for response recovery",
          },
        };
      }
      return { items: [], pageInfo: { endCursor: null, hasNextPage: false } };
    });

    const renderStudio = async () => {
      await act(async () => root.render(
        <CharacterVideoStudio
          actorId="actor-1"
          data={data}
          onCreateImage={vi.fn()}
          permissions={{ create: true, read: true, review: true }}
          runCommittedMutation={runCommittedMutation}
        />,
      ));
      await waitUntil(() => container.textContent?.includes("New video") === true);
    };
    await renderStudio();
    const motionBrief = container.querySelector<HTMLTextAreaElement>("textarea");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(motionBrief, "Locked motion brief for response recovery");
      motionBrief?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const firstCreate = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Create video"));
    await act(async () => firstCreate?.click());
    await waitUntil(() => container.textContent?.includes("outcome is unknown") === true);

    const firstCall = adminV2Request.mock.calls.find(
      ([path, options]) => path === "/api/v2/admin/creative/runs" && options?.method === "POST",
    );
    const firstKey = firstCall?.[1]?.idempotencyKey;
    expect(readActiveDurableMutationIntent({
      scope: "character-video:create:actor-1:character-video-1",
    })?.status).toBe("outcome_unknown");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderStudio();
    await waitUntil(() => container.textContent?.includes("Resume video creation") === true);
    const resume = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Resume video creation"));
    await waitUntil(() => resume?.disabled === false);
    await act(async () => resume?.click());
    await waitUntil(() => createAttempts === 2);
    expect(container.textContent).toContain("Generating video");

    const createCalls = adminV2Request.mock.calls.filter(
      ([path, options]) => path === "/api/v2/admin/creative/runs" && options?.method === "POST",
    );
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]?.[1]).toMatchObject({
      idempotencyKey: firstKey,
      body: expect.objectContaining({
        brief: "Locked motion brief for response recovery",
      }),
    });
    expect(readActiveDurableMutationIntent({
      scope: "character-video:create:actor-1:character-video-1",
    })).toBeNull();
    expect(runCommittedMutationSpy).toHaveBeenCalledTimes(2);
  });

  it("recovers a lost review response and unlocks only after the exact decision is projected", async () => {
    const expectedDecisionId = "video-review-expected";
    let reviewAttempts = 0;
    let projectedDecisionId: string | null = null;
    adminV2Request.mockImplementation(async (path: string, options?: {
      method?: string;
      idempotencyKey?: string;
    }) => {
      if (path.includes("/decisions") && options?.method === "POST") {
        reviewAttempts += 1;
        if (reviewAttempts === 1) throw new Error("connection closed after review submit");
        return { decisionId: expectedDecisionId, replayed: true };
      }
      if (path === "/api/v2/admin/creative/runs/video-run-1") {
        return {
          ...readyRun,
          items: [{
            ...readyRun.items[0],
            review: projectedDecisionId ? {
              id: projectedDecisionId,
              supersedesDecisionId: null,
              decision: "approved",
              identityConsistency: "passed",
              score: 90,
              quality: {
                artifactFree: true,
                singleSubject: true,
                intentMatch: true,
                noVisibleText: true,
              },
              reason: "Visible motion evidence passed",
              reviewerId: "actor-1",
              createdAt: "2026-07-30T12:05:00.000Z",
            } : null,
          }],
        };
      }
      return {
        items: [readyRun],
        pageInfo: { endCursor: null, hasNextPage: false },
      };
    });
    await act(async () => root.render(
      <CharacterVideoStudio
        actorId="actor-1"
        data={data}
        onCreateImage={vi.fn()}
        permissions={{ create: true, read: true, review: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    ));
    await waitUntil(() => container.textContent?.includes("Approve video") === true);
    for (const checkbox of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      await act(async () => checkbox.click());
      expect(checkbox.checked).toBe(true);
    }
    await act(async () => {
      const reason = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")].find(
        (textarea) => textarea.placeholder.includes("Describe motion"),
      );
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(reason, "Visible motion evidence passed");
      reason?.dispatchEvent(new Event("input", { bubbles: true }));
      expect(reason?.value).toBe("Visible motion evidence passed");
    });
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .every((checkbox) => checkbox.checked)).toBe(true);
    const approve = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Approve video"));
    expect(approve?.disabled).toBe(false);
    await act(async () => approve?.click());
    await waitUntil(() => container.textContent?.includes("Review outcome is unknown") === true);
    const firstReviewCall = adminV2Request.mock.calls.find(
      ([path, options]) => path.includes("/decisions") && options?.method === "POST",
    );

    const resume = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Resume saved review"));
    await act(async () => resume?.click());
    await waitUntil(() => container.textContent?.includes("exact decision") === true);
    const reviewCalls = adminV2Request.mock.calls.filter(
      ([path, options]) => path.includes("/decisions") && options?.method === "POST",
    );
    expect(reviewCalls).toHaveLength(2);
    expect(reviewCalls[1]?.[1]?.idempotencyKey).toBe(firstReviewCall?.[1]?.idempotencyKey);
    expect(readActiveDurableMutationIntent({
      scope: "character-video:review:actor-1:character-video-1",
    })?.committedTargetId).toBe(expectedDecisionId);

    projectedDecisionId = expectedDecisionId;
    const verify = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Verify saved review"));
    await act(async () => verify?.click());
    await waitUntil(() => container.textContent?.includes("Nothing was published automatically") === true);
    expect(readActiveDurableMutationIntent({
      scope: "character-video:review:actor-1:character-video-1",
    })).toBeNull();
    expect(container.textContent).not.toContain("Publish video");
  });
});
