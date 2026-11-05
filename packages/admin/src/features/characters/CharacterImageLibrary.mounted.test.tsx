// @vitest-environment happy-dom

import type { CharacterImageSourceAsset } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Operation } = vi.hoisted(() => ({
  adminV2Operation: vi.fn(),
}));

vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));
// Chat-library membership has its own mounted behavior suite.
vi.mock("./CharacterChatLibrary", () => ({ CharacterChatLibrary: () => <div /> }));
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
  return { adminDateLocale: () => "en-US", useAdminI18n: () => context };
});
vi.mock("./CharacterAssetStudio", () => ({
  CharacterAssetStudio: () => <div data-testid="character-asset-studio" />,
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
      canRead canReadProduction canCreate canArchive={false}
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
        canReadProduction
        commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
        data={characterWorkspaceDetail()} onContinue={() => undefined}
        onProjectReload={async () => undefined} />,
    ));
    await waitUntil(() => container.textContent?.includes("final-character.webp") === true);
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Search by file name, tag, description or date"]')!;
    await act(async () => setInputValue(input, "final-character"));
    expect(container.textContent).toContain("candidate");
    current = importedAsset("selectable");
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    await waitUntil(() => container.textContent?.includes("selectable") === true);
    expect(input.value).toBe("final-character");
    expect(container.textContent).not.toContain("Needs attention: review pending");
  });

  const libraryProps = {
    actorId: "operator-1",
    canCreate: true,
    canRead: true,
    canReadProduction: false,
    commitProjectMutation: async <T,>({ commit, afterRefresh }: { commit: () => Promise<T>; afterRefresh?: () => void }) => {
      const result = await commit();
      afterRefresh?.();
      return { result, refreshed: true };
    },
    onContinue: () => undefined,
    onProjectReload: async () => undefined,
  };

  it("shows which placement an image fills and places an unused image in one click", async () => {
    const used = importedAsset();
    used.id = "used-cover";
    used.qualification!.selectedPurposes = ["character_cover"];
    const free = importedAsset("selectable");
    free.id = "free-image";
    free.filename = "image-source.png";
    adminV2Operation.mockImplementation(async (operationId: string) => {
      if (operationId.startsWith("GET ")) return { items: [used, free] };
      if (operationId === "PATCH /api/v2/admin/characters/:id/draft-image") return { selectedAssetId: "free-image" };
      throw new Error(`Unexpected operation ${operationId}`);
    });
    await act(async () => root.render(<CharacterImageLibrary {...libraryProps} canArchive={false} data={characterWorkspaceDetail()} />));
    await waitUntil(() => container.querySelectorAll("article").length === 2);
    const [usedCard, freeCard] = [...container.querySelectorAll("article")];
    expect(usedCard.querySelector('[data-testid="image-placements"]')?.textContent).toContain("Cover");
    expect(usedCard.querySelector('[data-testid="image-placement-actions"]')).toBeNull();
    // The server's placeholder name is replaced by when the image was made.
    expect(freeCard.textContent).not.toContain("image-source.png");
    expect(freeCard.textContent).toMatch(/20\d\d/);
    await act(async () => [...freeCard.querySelectorAll("button")].find((button) => button.textContent === "Use as hero")!.click());
    await waitUntil(() => adminV2Operation.mock.calls.some(([operationId]) => String(operationId).startsWith("PATCH ")));
    const call = adminV2Operation.mock.calls.find(([operationId]) => String(operationId).startsWith("PATCH "))!;
    expect(call[1]).toMatchObject({ ifMatch: 1, body: { purpose: "character_hero", assetId: "free-image" } });
  });

  it("sends one search request per settled word", async () => {
    vi.useFakeTimers();
    try {
      adminV2Operation.mockResolvedValue({ items: [] });
      await act(async () => root.render(<CharacterImageLibrary {...libraryProps} canArchive={false} data={characterWorkspaceDetail()} />));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const reads = () => adminV2Operation.mock.calls.filter(([operationId]) => String(operationId).startsWith("GET "));
      const before = reads().length;
      const input = container.querySelector<HTMLInputElement>('input[placeholder="Search by file name, tag, description or date"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      for (const value of ["w", "wi", "win"]) {
        await act(async () => {
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      expect(reads()).toHaveLength(before);
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(reads()).toHaveLength(before + 1);
      expect((reads().at(-1)?.[1] as { query: URLSearchParams }).query.get("search")).toBe("win");
    } finally {
      vi.useRealTimers();
    }
  });

  it("archives several images at once without asking for a reason", async () => {
    const first = importedAsset();
    first.id = "image-one";
    const second = importedAsset();
    second.id = "image-two";
    adminV2Operation.mockResolvedValue({ items: [first, second] });
    await act(async () => root.render(<CharacterImageLibrary {...libraryProps} canArchive data={characterWorkspaceDetail()} />));
    await waitUntil(() => container.querySelectorAll("article").length === 2);
    for (const box of container.querySelectorAll<HTMLInputElement>('article input[type="checkbox"]')) {
      await act(async () => box.click());
    }
    const bulk = container.querySelector('[data-testid="image-library-bulk-actions"]')!;
    expect(bulk.textContent).toContain("2 selected");
    await act(async () => [...bulk.querySelectorAll("button")].find((button) => button.textContent?.includes("Remove from library"))!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const submit = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Remove from library")!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    const archive = adminV2Operation.mock.calls.find(([operationId]) => operationId === "POST /api/v2/admin/assets/bulk");
    expect(archive?.[1]).toMatchObject({ body: { assetIds: ["image-one", "image-two"], status: "archived", reason: "Removed from the Character library" } });
  });

  it("does not ask for an image review while generation is available", async () => {
    adminV2Operation.mockResolvedValue({ items: [importedAsset()] });
    await act(async () => {
      root.render(
        <CharacterImageLibrary
          actorId="operator-1"
          canArchive={false}
          canCreate
          canRead
          canReadProduction
          commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
          data={characterWorkspaceDetail({ visual: { identityBootstrap: { allowed: true } } })}
          onContinue={() => undefined}
          onProjectReload={async () => undefined}
        />,
      );
    });
    await waitUntil(() => container.textContent?.includes("final-character.webp") === true);

    expect(container.textContent).not.toContain("Review image candidate");
    expect(container.querySelector('[data-testid="character-asset-studio"]')).not.toBeNull();
  });

  it("shows imported images without an artificial review action", async () => {
    adminV2Operation.mockResolvedValue({ items: [importedAsset("selectable")], nextCursor: null });
    await act(async () => root.render(
      <CharacterImageLibrary actorId="operator-1" canArchive={false} canCreate canRead
        canReadProduction
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
        canReadProduction
        commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
        data={characterWorkspaceDetail()} onContinue={() => undefined}
        onProjectReload={async () => undefined} />,
    ));
    await waitUntil(() => container.textContent?.includes("Load more images") === true);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Load more images"))?.click());
    await waitUntil(() => container.textContent?.includes("older.webp") === true);
    expect(container.textContent).toContain("final-character.webp");
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Search by file name, tag, description or date"]')!;
    await act(async () => setInputValue(input, "older"));
    await waitUntil(() => adminV2Operation.mock.calls.some(([, options]) => options.query?.get("search") === "older"));
    await waitUntil(() => !container.textContent?.includes("final-character.webp"));
    expect(container.textContent).toContain("older.webp");
  });
});
