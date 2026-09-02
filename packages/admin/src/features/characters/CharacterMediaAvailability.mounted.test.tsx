// @vitest-environment happy-dom

import type { CharacterImageSourceAsset, ContentAsset } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Operation, apiGet } = vi.hoisted(() => ({
  adminV2Operation: vi.fn(),
  apiGet: vi.fn(),
}));

vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));
vi.mock("@/components/admin/api", () => ({ apiGet }));
vi.mock("next/image", () => ({
  default: ({ alt = "" }: { alt?: string }) => <span data-image-alt={alt} />,
}));
vi.mock("@/components/admin/i18n", () => {
  const context = {
    t: (value: string, values?: Readonly<Record<string, string | number>>) =>
      Object.entries(values ?? {}).reduce(
        (text, [key, replacement]) => text.replaceAll(`{${key}}`, String(replacement)),
        value,
      ),
  };
  return { useAdminI18n: () => context };
});
vi.mock("./CharacterAssetStudio", () => ({
  CharacterAssetStudio: ({ onProjectReload }: { onProjectReload: () => Promise<void> }) => (
    <button onClick={() => void onProjectReload()} type="button">Finish production</button>
  ),
}));
vi.mock("./CharacterVideoStudio", () => ({
  CharacterVideoStudio: ({ onProjectReload }: { onProjectReload: () => Promise<void> }) => (
    <button onClick={() => void onProjectReload()} type="button">Finish production</button>
  ),
}));

import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { CharacterImageLibrary } from "./CharacterImageLibrary";
import { CharacterVideoLibrary } from "./CharacterVideoLibrary";
import { CharacterPlacementEditor } from "./CharacterPlacementEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const image: CharacterImageSourceAsset = {
  id: "retained-image",
  url: "/uploads/retained-image.webp",
  thumbnailUrl: null,
  filename: "retained-image.webp",
  contentType: "image/webp",
  sizeBytes: 512,
  width: 1024,
  height: 1536,
  createdAt: "2026-09-02T12:00:00.000Z",
  qualification: {
    source: "operator_upload",
    state: "selectable",
    selectablePurposes: ["character_cover", "character_hero", "character_chat"],
    selectedPurposes: [],
    releaseQualifiedPurposes: [],
    blockers: [],
    authority: { runId: null, itemId: null, reviewDecisionId: "review-image", generationJobId: null },
    review: null,
  },
};

const video: ContentAsset = {
  id: "retained-video",
  type: "video",
  url: "/uploads/retained-video.mp4",
  thumbnailUrl: "/uploads/retained-video.webp",
  contentType: "video/mp4",
  width: 1024,
  height: 768,
  safetyStatus: "safe",
  sourceJobId: null,
  isSynthetic: false,
  customerPublishable: true,
  publishabilityReasons: [],
  promptSummary: null,
  metadata: {},
  createdAt: "2026-09-02T12:00:00.000Z",
  platformStatus: "active",
  purpose: "character_video_library",
  targetType: "character",
  targetId: "character-fixture",
  tags: [],
  description: null,
  sourceJob: null,
  sourceBatch: null,
  placements: [],
};

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Character media");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("Character media availability", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Operation.mockReset();
    apiGet.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function button(label: string) {
    const element = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === label);
    expect(element, `Missing button: ${label}`).toBeDefined();
    return element!;
  }

  async function renderLibrary(
    kind: "images" | "videos",
    canImport = true,
    onProjectReload = async () => undefined,
  ) {
    const data = characterWorkspaceDetail({ visual: { identityBootstrap: { allowed: false } } });
    await act(async () => {
      root.render(kind === "images" ? (
        <CharacterImageLibrary
          actorId="operator-1"
          canArchive={false}
          canCreate
          canRead
          canReadProduction
          canReview
          canReviewImported
          commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
          data={data}
          onContinue={() => undefined}
          onProjectReload={onProjectReload}
        />
      ) : (
        <CharacterVideoLibrary
          actorId="operator-1"
          canArchive={false}
          canCreate
          canImport={canImport}
          canRead
          canReadProduction
          data={data}
          onCreateImage={() => undefined}
          onProjectReload={onProjectReload}
          runCommittedMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
        />
      ));
    });
  }

  async function renderPlacement() {
    await act(async () => {
      root.render(
        <CharacterPlacementEditor
          canWrite
          data={characterWorkspaceDetail()}
          runCommittedMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
        />,
      );
    });
    const choose = container.querySelector<HTMLButtonElement>("article button");
    expect(choose).not.toBeNull();
    await act(async () => choose?.click());
  }

  for (const kind of ["images", "videos"] as const) {
    const emptyLabel = `No ${kind} yet`;
    const asset = kind === "images" ? image : video;
    const request = () => kind === "images" ? adminV2Operation : apiGet;

    it(`${kind}: a failed read is recoverable and does not claim the library is empty`, async () => {
      request().mockRejectedValueOnce(new Error("Authority returned a non-JSON 500 response"))
        .mockResolvedValue({ items: [] });
      await renderLibrary(kind);
      await waitUntil(() => container.querySelector('[role="alert"]') !== null);

      expect(container.textContent).not.toContain(emptyLabel);
      expect(container.textContent).toContain(kind === "images"
        ? "Character images could not be loaded"
        : "Character videos could not be loaded");
      await act(async () => button("Retry").click());
      await waitUntil(() => container.textContent?.includes(emptyLabel) === true);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(request()).toHaveBeenCalledTimes(2);
    });

    it(`${kind}: unmatched search has a clear action and keeps the existing library`, async () => {
      request().mockResolvedValue({ items: [asset] });
      await renderLibrary(kind);
      await waitUntil(() => container.querySelector("article") !== null);
      const search = container.querySelector<HTMLInputElement>(`input[placeholder="Search ${kind}"]`);
      expect(search).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "no-such-asset");
        search?.dispatchEvent(new Event("input", { bubbles: true }));
      });

      expect(container.textContent).not.toContain(emptyLabel);
      expect(container.textContent).toContain(`No matching ${kind}`);
      await act(async () => button("Clear search").click());
      expect(container.querySelectorAll("article")).toHaveLength(1);
      expect(search?.value).toBe("");
      expect(request()).toHaveBeenCalledTimes(1);
    });

    it(`${kind}: a refresh failure preserves loaded assets with a stale-data notice`, async () => {
      request().mockResolvedValueOnce({ items: [asset] })
        .mockRejectedValueOnce(new Error("Refresh unavailable"))
        .mockResolvedValue({ items: [asset] });
      await renderLibrary(kind);
      await waitUntil(() => container.querySelector("article") !== null);
      await act(async () => button(kind === "images" ? "Create images" : "Create video").click());
      await act(async () => button("Finish production").click());
      await waitUntil(() => container.querySelector('[role="alert"]') !== null);

      expect(container.querySelectorAll("article")).toHaveLength(1);
      expect(container.textContent).toContain("Showing previously loaded items.");
      expect(container.textContent).not.toContain(emptyLabel);
      await act(async () => button("Retry").click());
      await waitUntil(() => container.querySelector('[role="alert"]') === null);
      expect(container.querySelectorAll("article")).toHaveLength(1);
    });

    it(`${kind}: failed import keeps the library and lets the operator retry the same file`, async () => {
      let imports = 0;
      apiGet.mockResolvedValue({ items: [video] });
      adminV2Operation.mockImplementation(async (operationId: string) => {
        if (operationId.startsWith("GET ")) return { items: [image] };
        imports += 1;
        if (imports === 1) throw new Error("Import unavailable");
        return {};
      });
      await renderLibrary(kind);
      await waitUntil(() => container.querySelector("article") !== null);
      const input = container.querySelector<HTMLInputElement>('input[type="file"]');
      expect(input).not.toBeNull();
      const file = new File(["asset"], kind === "images" ? "retry.webp" : "retry.mp4", {
        type: kind === "images" ? "image/webp" : "video/mp4",
      });
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      await act(async () => input?.dispatchEvent(new Event("change", { bubbles: true })));
      await waitUntil(() => container.querySelector('[role="alert"]') !== null);
      expect(container.querySelectorAll("article")).toHaveLength(1);
      expect(button(kind === "images" ? "Import image" : "Import video").disabled).toBe(false);

      await act(async () => input?.dispatchEvent(new Event("change", { bubbles: true })));
      await waitUntil(() => imports === 2 && container.querySelector('[role="status"]') !== null);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelectorAll("article")).toHaveLength(1);
    });
  }

  it("Review: failed submission keeps the draft, and committed Review is not relabeled as failed by a workspace refresh", async () => {
    let reviews = 0;
    adminV2Operation.mockImplementation(async (operationId: string) => {
      if (operationId.startsWith("GET ")) return { items: [image] };
      reviews += 1;
      if (reviews === 1) throw new Error("Review unavailable");
      return {};
    });
    const onProjectReload = vi.fn(async () => {
      throw new Error("Workspace refresh unavailable");
    });
    await renderLibrary("images", true, onProjectReload);
    await waitUntil(() => container.querySelector("article") !== null);
    await act(async () => button("Review image candidate").click());
    const reason = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(reason).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(reason, "Does not match the intended identity");
      reason?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Reject candidate").click());
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);
    expect(reason?.value).toBe("Does not match the intended identity");
    expect(button("Reject candidate").disabled).toBe(false);

    await act(async () => button("Reject candidate").click());
    await waitUntil(() => reviews === 2 && onProjectReload.mock.calls.length === 1);
    expect(container.textContent).toContain("Review rejected. This image remains in the library but cannot be selected.");
    expect(container.querySelector("textarea")).toBeNull();
    // Workspace refresh owns its own error and retry UI in CharacterWorkspace.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("video import permission is independent from video production permission", async () => {
    apiGet.mockResolvedValue({ items: [] });
    await renderLibrary("videos", false);
    await waitUntil(() => container.textContent?.includes("No videos yet") === true);

    expect(button("Import video").disabled).toBe(true);
    expect(button("Create video").disabled).toBe(false);
    await act(async () => button("Create video").click());
    expect(button("Finish production")).toBeDefined();
  });

  it("placement: a failed read does not claim no reviewed images are available", async () => {
    adminV2Operation.mockRejectedValueOnce(new Error("Authority returned a non-JSON 500 response"))
      .mockResolvedValue({ items: [image] });
    await renderPlacement();
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);

    expect(container.textContent).not.toContain("No reviewed images are selectable");
    await act(async () => button("Retry").click());
    await waitUntil(() => container.querySelector('button[aria-label="Use image for character_cover"]') !== null);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(adminV2Operation).toHaveBeenCalledTimes(2);
  });

  it("placement: reopening during an outage keeps the previously loaded choices", async () => {
    adminV2Operation.mockResolvedValueOnce({ items: [image] })
      .mockRejectedValue(new Error("Refresh unavailable"));
    await renderPlacement();
    await waitUntil(() => container.querySelector('button[aria-label="Use image for character_cover"]') !== null);
    await act(async () => button("Cancel").click());
    const choose = container.querySelector<HTMLButtonElement>("article button");
    await act(async () => choose?.click());
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);

    expect(container.querySelector('button[aria-label="Use image for character_cover"]')).not.toBeNull();
    expect(container.textContent).toContain("Showing previously loaded items.");
    expect(container.textContent).not.toContain("No reviewed images are selectable");
    expect(button("Retry").disabled).toBe(false);
  });

  it("placement: a failed selection keeps the choice available for another attempt", async () => {
    let selections = 0;
    adminV2Operation.mockImplementation(async (operationId: string) => {
      if (operationId.startsWith("GET ")) return { items: [image] };
      selections += 1;
      if (selections === 1) throw new Error("Placement unavailable");
      return {};
    });
    await renderPlacement();
    await waitUntil(() => container.querySelector('button[aria-label="Use image for character_cover"]') !== null);
    await act(async () => button("Use image").click());
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);
    expect(button("Use image").disabled).toBe(false);

    await act(async () => button("Use image").click());
    await waitUntil(() => selections === 2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
