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
vi.mock("@/components/admin/i18n", () => {
  const context = {
    t: (value: string, values?: Readonly<Record<string, string | number>>) =>
      Object.entries(values ?? {}).reduce(
        (text, [key, replacement]) =>
          text.replaceAll(`{${key}}`, String(replacement)),
        value,
      ),
  };
  return { useAdminI18n: () => context };
});
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

  it("reopens an active image creator after remount even when identity bootstrap is complete", async () => {
    adminV2Operation.mockResolvedValue({ items: [], nextCursor: null });
    const data = structuredClone(characterWorkspaceDetail());
    data.visual.identityBootstrap.allowed = false;
    const operation = data.mediaOperations.operations.find((item) => item.modality === "image")!;
    operation.requestId = "running-image-request";
    operation.status = "running";
    const render = () => root.render(<CharacterImageLibrary actorId="operator-1" data={data}
      canRead canReadProduction canCreate canReview canArchive={false}
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      onContinue={() => undefined} onProjectReload={async () => undefined} />);
    await act(async () => render());
    await waitUntil(() => adminV2Operation.mock.calls.length > 0);
    expect(container.querySelector('[data-testid="character-asset-studio"]')).not.toBeNull();
    expect(container.textContent).toContain("Image request in progress");
    expect(container.textContent).not.toContain("No images yet");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => render());
    expect(container.querySelector('[data-testid="character-asset-studio"]')).not.toBeNull();
    expect(adminV2Operation.mock.calls.every(([operation]) => operation.startsWith("GET "))).toBe(true);
  });

  it("refreshes completed image facts from the shell without losing the library filter", async () => {
    let current = importedAsset();
    adminV2Operation.mockImplementation(async () => ({ items: [current] }));
    await act(async () => root.render(
      <CharacterImageLibrary actorId="operator-1" canArchive={false} canCreate canRead
        canReadProduction canReview
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

  it("shows imported images without an artificial review action", async () => {
    adminV2Operation.mockResolvedValue({ items: [importedAsset("selectable")], nextCursor: null });
    await act(async () => root.render(
      <CharacterImageLibrary actorId="operator-1" canArchive={false} canCreate canRead
        canReadProduction canReview
        commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
        data={characterWorkspaceDetail()} onContinue={() => undefined}
        onProjectReload={async () => undefined} />,
    ));
    await waitUntil(() => container.textContent?.includes("final-character.webp") === true);
    expect(container.textContent).not.toContain("Review image candidate");
    expect(container.textContent).not.toContain("Approve for placement");
    expect(container.querySelector('input[type="number"]')).toBeNull();
    expect(adminV2Operation.mock.calls.every(([operation]) => operation.startsWith("GET "))).toBe(true);
  });

  it("loads older pages and sends searches to the full library", async () => {
    const older = { ...importedAsset("selectable"), id: "older", filename: "older.webp" };
    adminV2Operation.mockImplementation(async (_operation, options) => {
      const query = options.query as URLSearchParams;
      return query.get("cursor") || query.get("search")
        ? { items: [older], nextCursor: null }
        : { items: [importedAsset("selectable")], nextCursor: "next-page" };
    });
    await act(async () => root.render(
      <CharacterImageLibrary actorId="operator-1" canArchive={false} canCreate canRead
        canReadProduction canReview
        commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
        data={characterWorkspaceDetail()} onContinue={() => undefined}
        onProjectReload={async () => undefined} />,
    ));
    await waitUntil(() => container.textContent?.includes("Load more images") === true);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Load more images"))?.click());
    await waitUntil(() => container.textContent?.includes("older.webp") === true);
    expect(container.textContent).toContain("final-character.webp");
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Search images"]')!;
    await act(async () => setInputValue(input, "older"));
    await waitUntil(() => adminV2Operation.mock.calls.some(([, options]) => options.query?.get("search") === "older"));
    await waitUntil(() => !container.textContent?.includes("final-character.webp"));
    expect(container.textContent).toContain("older.webp");
  });
});
