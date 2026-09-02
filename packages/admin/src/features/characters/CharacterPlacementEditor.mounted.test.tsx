// @vitest-environment happy-dom

import type { CharacterImageSourceAsset } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Operation } = vi.hoisted(() => ({
  adminV2Operation: vi.fn(),
}));

vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));
vi.mock("next/image", () => ({
  default: ({ alt = "" }: { alt?: string }) => <span data-image-alt={alt} />,
}));
vi.mock("@/components/admin/i18n", () => ({
  useAdminI18n: () => ({
    t: (value: string, values?: Readonly<Record<string, string | number>>) =>
      Object.entries(values ?? {}).reduce(
        (text, [key, replacement]) =>
          text.replaceAll(`{${key}}`, String(replacement)),
        value,
      ),
  }),
}));

import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { CharacterPlacementEditor } from "./CharacterPlacementEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Character placement editor");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function reviewedUpload(
  id: string,
  reviewDecisionId: string,
  selectedPurposes: NonNullable<
    CharacterImageSourceAsset["qualification"]
  >["selectedPurposes"] = [],
): CharacterImageSourceAsset {
  return {
    id,
    url: `/uploads/${id}.webp`,
    thumbnailUrl: null,
    filename: `${id}.webp`,
    contentType: "image/webp",
    sizeBytes: 512,
    width: 1024,
    height: 1536,
    createdAt: "2026-09-02T12:00:00.000Z",
    qualification: {
      source: "operator_upload",
      state: selectedPurposes.length > 0 ? "selected" : "selectable",
      selectablePurposes: ["character_cover", "character_hero", "character_chat"],
      selectedPurposes,
      releaseQualifiedPurposes: [],
      blockers: [],
      authority: {
        runId: null,
        itemId: null,
        reviewDecisionId,
        generationJobId: null,
      },
      review: {
        id: reviewDecisionId,
        decision: "approved",
        identityConsistency: "passed",
        score: 95,
        quality: {
          artifactFree: true,
          singleSubject: true,
          intentMatch: true,
          noVisibleText: true,
        },
        reason: "Reviewed against sealed identity",
        createdAt: "2026-09-02T12:01:00.000Z",
      },
    },
  };
}

describe("Character placement qualification", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Operation.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("submits the visible Review pin and keeps an image used elsewhere disabled", async () => {
    const used = reviewedUpload("used-cover", "review-cover", ["character_cover"]);
    const available = reviewedUpload("available-hero", "review-hero");
    adminV2Operation.mockImplementation(async (operationId: string) => {
      if (operationId === "GET /api/v2/admin/characters/:id/image-sources") {
        return { items: [used, available] };
      }
      if (operationId === "PATCH /api/v2/admin/characters/:id/draft-image") {
        return {
          characterId: "character-fixture",
          projectVersion: 2,
          selectedPurpose: "character_hero",
          selectedAssetId: "available-hero",
          draftImageAssetId: "used-cover",
          draftAssetPack: {
            character_cover: "used-cover",
            character_hero: "available-hero",
          },
          deepLink: "/admin/characters/character-fixture?tab=preview",
        };
      }
      throw new Error(`Unexpected operation ${operationId}`);
    });
    const runCommittedMutation = vi.fn(async ({ commit, afterRefresh }) => {
      const result = await commit();
      afterRefresh?.();
      return { result, refreshed: true };
    });

    await act(async () => {
      root.render(
        <CharacterPlacementEditor
          canWrite
          data={characterWorkspaceDetail({
            preview: {
              draft: {
                assetPack: {
                  character_cover: {
                    assetId: "used-cover",
                    imageUrl: "/uploads/used-cover.webp",
                    status: "available",
                  },
                },
              },
            },
          })}
          runCommittedMutation={runCommittedMutation}
        />,
      );
    });

    // The project DTO intentionally has no draftAssetPack entry. Current/used
    // actions must come from the server-owned image qualification projection.
    const coverCard = [...container.querySelectorAll("article")].find(
      (article) => article.querySelector("h4")?.textContent === "Cover",
    );
    const replaceButton = [...(coverCard?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Replace image"),
    );
    await act(async () => replaceButton?.click());
    await waitUntil(() => container.textContent?.includes("Update Review authority") === true);
    const staleCurrentButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Update Review authority"),
    );
    expect(staleCurrentButton?.disabled).toBe(false);
    const cancelButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Cancel",
    );
    await act(async () => cancelButton?.click());

    const heroCard = [...container.querySelectorAll("article")].find(
      (article) => article.querySelector("h4")?.textContent === "Hero",
    );
    const chooseButton = [...(heroCard?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Choose image"),
    );
    await act(async () => chooseButton?.click());
    await waitUntil(() => container.textContent?.includes("Used in another placement") === true);

    const usedButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Used in another placement"),
    );
    const useButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Use image",
    );
    expect(usedButton?.disabled).toBe(true);
    expect(useButton?.disabled).toBe(false);

    await act(async () => useButton?.click());
    await waitUntil(() => runCommittedMutation.mock.calls.length === 1);

    const selectionCall = adminV2Operation.mock.calls.find(
      ([operationId]) => operationId === "PATCH /api/v2/admin/characters/:id/draft-image",
    );
    expect(selectionCall?.[1]).toEqual(expect.objectContaining({
      path: { id: "character-fixture" },
      ifMatch: 1,
      body: {
        entityVersion: 1,
        purpose: "character_hero",
        assetId: "available-hero",
        reviewDecisionId: "review-hero",
        reason: "Selected from Mira's image library",
      },
    }));
    expect(selectionCall?.[1].body).not.toHaveProperty("runId");
    expect(selectionCall?.[1].body).not.toHaveProperty("itemId");
  });
});
