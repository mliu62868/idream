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
vi.mock("./CharacterAssetStudio", () => ({
  CharacterAssetStudio: ({ permissions }: { permissions: { review: boolean } }) => (
    <div data-review-allowed={permissions.review} data-testid="character-asset-studio" />
  ),
}));

import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { CharacterImageLibrary } from "./CharacterImageLibrary";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Character image library");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextAreaValue(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function importedAsset(
  state: "candidate" | "selectable" = "candidate",
): CharacterImageSourceAsset {
  const approved = state === "selectable";
  return {
    id: "media-upload-1",
    url: "/uploads/media-upload-1.webp",
    thumbnailUrl: null,
    filename: "final-character.webp",
    contentType: "image/webp",
    sizeBytes: 512,
    width: 1024,
    height: 1536,
    createdAt: "2026-09-02T12:00:00.000Z",
    qualification: {
      source: "operator_upload",
      state,
      selectablePurposes: approved
        ? ["character_cover", "character_hero", "character_chat"]
        : [],
      selectedPurposes: [],
      releaseQualifiedPurposes: [],
      blockers: approved ? [] : ["review_pending"],
      authority: {
        runId: null,
        itemId: null,
        reviewDecisionId: approved ? "review-upload-1" : null,
        generationJobId: null,
      },
      review: approved
        ? {
            id: "review-upload-1",
            decision: "approved",
            identityConsistency: "passed",
            score: 95,
            quality: {
              artifactFree: true,
              singleSubject: true,
              intentMatch: true,
              noVisibleText: true,
            },
            reason: "Matches the sealed Character identity",
            createdAt: "2026-09-02T12:01:00.000Z",
          }
        : null,
    },
  };
}

describe("Character image library imported Review", () => {
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

  it("refreshes completed image facts from the shell without losing the library filter", async () => {
    let current = importedAsset();
    adminV2Operation.mockImplementation(async () => ({ items: [current] }));
    await act(async () => root.render(
      <CharacterImageLibrary actorId="operator-1" canArchive={false} canCreate canRead
        canReadProduction canReview canReviewImported={false}
        commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
        data={characterWorkspaceDetail()} onContinue={() => undefined}
        onProjectReload={async () => undefined} />,
    ));
    await waitUntil(() => container.textContent?.includes("final-character.webp") === true);
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Search images"]')!;
    await act(async () => setInputValue(input, "final-character"));
    expect(container.textContent).toContain("candidate");
    current = importedAsset("selectable");
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    await waitUntil(() => container.textContent?.includes("selectable") === true);
    expect(input.value).toBe("final-character");
    expect(container.textContent).not.toContain("Needs attention: review pending");
  });

  it("keeps generated Review separate from imported image Review permission", async () => {
    adminV2Operation.mockResolvedValue({ items: [importedAsset()] });
    await act(async () => {
      root.render(
        <CharacterImageLibrary
          actorId="operator-1"
          canArchive={false}
          canCreate
          canRead
          canReadProduction
          canReview
          canReviewImported={false}
          commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
          data={characterWorkspaceDetail({ visual: { identityBootstrap: { allowed: true } } })}
          onContinue={() => undefined}
          onProjectReload={async () => undefined}
        />,
      );
    });
    await waitUntil(() => container.textContent?.includes("final-character.webp") === true);

    expect(container.textContent).not.toContain("Review image candidate");
    expect(container.querySelector('[data-testid="character-asset-studio"]')?.getAttribute("data-review-allowed"))
      .toBe("true");
  });

  it("keeps identity bootstrap separate and grants an upload real Review authority", async () => {
    let reviewed = false;
    const onProjectReload = vi.fn(async () => undefined);
    adminV2Operation.mockImplementation(async (operationId: string) => {
      if (operationId === "GET /api/v2/admin/characters/:id/image-sources") {
        return { items: [importedAsset(reviewed ? "selectable" : "candidate")] };
      }
      if (operationId === "POST /api/v2/admin/characters/:id/image-sources/:assetId/reviews") {
        reviewed = true;
        return {
          characterId: "character-fixture",
          assetId: "media-upload-1",
          decisionId: "review-upload-1",
          qualification: importedAsset("selectable").qualification,
          replayed: false,
        };
      }
      throw new Error(`Unexpected operation ${operationId}`);
    });

    await act(async () => {
      root.render(
        <CharacterImageLibrary
          actorId="operator-1"
          canArchive={false}
          canCreate
          canRead
          canReadProduction
          canReview
          canReviewImported
          commitProjectMutation={async ({ commit }) => ({
            result: await commit(),
            refreshed: true,
          })}
          data={characterWorkspaceDetail()}
          onContinue={() => undefined}
          onProjectReload={onProjectReload}
        />,
      );
    });

    await waitUntil(() => container.textContent?.includes("Review image candidate") === true);
    const reviewButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Review image candidate"),
    );
    await act(async () => reviewButton?.click());

    expect(container.textContent).toContain("Initial identity sources belong in Identity Lab");
    const approveButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Approve for placement"),
    );
    expect(approveButton?.disabled).toBe(true);

    const score = container.querySelector<HTMLInputElement>('input[type="number"]');
    const uncheckedQuality = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .filter((checkbox) => !checkbox.checked);
    const reason = container.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () => {
      if (score) setInputValue(score, "95");
      for (const checkbox of uncheckedQuality) checkbox.click();
      if (reason) setTextAreaValue(reason, "Matches the sealed Character identity");
    });
    expect(approveButton?.disabled).toBe(false);

    await act(async () => approveButton?.click());
    await waitUntil(() => reviewed && onProjectReload.mock.calls.length === 1);

    const reviewCall = adminV2Operation.mock.calls.find(
      ([operationId]) => operationId === "POST /api/v2/admin/characters/:id/image-sources/:assetId/reviews",
    );
    expect(reviewCall?.[1]).toEqual(expect.objectContaining({
      path: { id: "character-fixture", assetId: "media-upload-1" },
      body: {
        decision: "approved",
        identityConsistency: "passed",
        score: 95,
        quality: {
          artifactFree: true,
          singleSubject: true,
          intentMatch: true,
          noVisibleText: true,
        },
        reason: "Matches the sealed Character identity",
      },
    }));
    expect(reviewCall?.[1].body).not.toHaveProperty("runId");
    expect(reviewCall?.[1].body).not.toHaveProperty("itemId");
    expect(container.textContent).toContain("selectable");
  });
});
