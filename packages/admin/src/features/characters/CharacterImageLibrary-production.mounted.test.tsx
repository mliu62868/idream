// @vitest-environment happy-dom

import type { CharacterImageSourceAsset } from "@idream/shared/admin";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({ adminV2Request: vi.fn() }));
vi.mock("@/lib/admin-v2-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/admin-v2-api")>(),
  adminV2Request,
}));
vi.mock("next/image", () => ({ default: ({ alt = "" }: { alt?: string }) => <span data-image-alt={alt} /> }));
vi.mock("@/components/admin/i18n", () => {
  const i18n = {
    locale: "en" as const,
    t: (value: string, values?: Readonly<Record<string, string | number>>) =>
      Object.entries(values ?? {}).reduce((text, [key, replacement]) => text.replaceAll(`{${key}}`, String(replacement)), value),
    value: (value: string) => value.replaceAll("_", " "),
  };
  return { adminDateLocale: () => undefined, useAdminI18n: () => i18n };
});

import { CharacterImageLibrary } from "./CharacterImageLibrary";
import { characterWorkspaceDetail } from "./character-workspace-fixture";

it.each([false, true])("refreshes the library when a generated candidate is delivered (polling: %s)", async (polling) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  window.localStorage.clear();
  adminV2Request.mockReset();
  let delivered = !polling;
  const rejected = false;
  const onProjectReload = vi.fn(async () => undefined);
  const quality = { artifactFree: false, singleSubject: false, intentMatch: false, noVisibleText: false };
  const review = () => rejected ? {
    id: "rejected-review", decision: "rejected" as const, identityConsistency: "unscored" as const,
    score: null, quality, reason: "Reject this candidate", createdAt: "2026-09-02T12:01:00.000Z",
  } : null;
  const run = {
    id: "review-refresh-run", purpose: "character_cover", lifecycleState: "active",
    executionOutcome: polling ? "running" : "succeeded", reviewState: "pending",
    counts: { total: 1, generated: 1, reviewed: 0, approved: 0, placed: 0, failed: 0 },
    updatedAt: "2026-09-02T12:00:00.000Z",
  };
  adminV2Request.mockImplementation(async (path: string) => {
    if (path.includes("/image-sources")) {
      if (!delivered) return { items: [], nextCursor: null };
      const asset: CharacterImageSourceAsset = {
        id: "review-refresh-asset", url: "/portrait.png", thumbnailUrl: null,
        filename: "review-refresh.png", contentType: "image/png", sizeBytes: 100, width: 100, height: 100,
        createdAt: "2026-09-02T12:00:00.000Z",
        qualification: {
          source: "generation", state: rejected ? "rejected" : "candidate",
          selectablePurposes: [], selectedPurposes: [], releaseQualifiedPurposes: [],
          blockers: [rejected ? "review_rejected" : "review_pending"],
          authority: { runId: run.id, itemId: "review-refresh-item", generationJobId: "review-refresh-job", reviewDecisionId: rejected ? "rejected-review" : null },
          review: review(),
        },
      };
      return { items: [asset], nextCursor: null };
    }
    if (path.includes("/creative/runs?")) return {
      items: polling ? [{ ...run, id: "historical-completed-run", executionOutcome: "succeeded" }, run] : [run],
      pageInfo: { endCursor: null, hasNextPage: false },
    };
    if (path.endsWith(`/creative/runs/${run.id}`)) return {
      ...run, version: rejected ? 2 : 1,
      items: [{
        id: "review-refresh-item", ordinal: 0, status: !delivered ? "running" : rejected ? "rejected" : "generated", version: 1,
        executionState: delivered ? "ready" : "generating",
        identityReviewMode: "defines_identity",
        asset: delivered ? { id: "review-refresh-asset", url: "/portrait.png", thumbnailUrl: "/portrait.png" } : null,
        review: review(), lineage: { requestId: "review-refresh-job" },
      }],
    };
    throw new Error(`Unexpected request ${path}`);
  });
  const waitUntil = async (predicate: () => boolean) => {
    const deadline = Date.now() + 6_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Image library state did not refresh");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  try {
    await act(async () => root.render(<CharacterImageLibrary
      actorId="operator-review-refresh"
      data={characterWorkspaceDetail({
        journey: { assetPack: { draft: { missingPurposes: ["character_cover", "character_hero", "character_chat"] } } },
        visual: { identityBootstrap: { allowed: true } },
      })}
      canRead canReadProduction canCreate canReview canArchive={false}
      onContinue={() => undefined}
      onProjectReload={onProjectReload}
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
    />));
    const library = () => container.querySelector('section[aria-label="Character image library"]');
    if (polling) {
      await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path.endsWith(`/creative/runs/${run.id}`)));
      expect(onProjectReload).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Image request in progress");
      expect(container.textContent).not.toContain("Generating image");
      const brief = container.querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(brief, "A custom English hero scene with a red jacket.");
        brief.dispatchEvent(new Event("input", { bubbles: true }));
      });
      delivered = true;
      run.executionOutcome = "succeeded";
    }
    await waitUntil(() => library()?.textContent?.includes("review-refresh.png") === true);
    await waitUntil(() => [...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Set as identity")));
    expect(container.textContent).not.toContain("Reject current");
    expect(container.textContent).not.toContain("Approve for placement");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(adminV2Request.mock.calls.every(([path]) => !path.includes("/decisions"))).toBe(true);
    expect(onProjectReload).toHaveBeenCalledTimes(1);
    expect(adminV2Request.mock.calls.filter(([path]) => path.includes("/image-sources")).length).toBeGreaterThanOrEqual(2);
    if (polling) expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("A custom English hero scene with a red jacket.");

  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
  }
}, 10_000);

it("uses an unknown request's recovery authority without declaring failure or allowing duplicate generation", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  window.localStorage.clear();
  adminV2Request.mockReset();
  const data = structuredClone(characterWorkspaceDetail({ visual: { identityBootstrap: { allowed: true } } }));
  const operation = data.mediaOperations.operations.find((item) => item.modality === "image")!;
  operation.requestId = "unknown-image-job";
  operation.status = "unknown";
  operation.operationsHref = "/admin/generation/jobs/unknown-image-job";
  const run = {
    id: "unknown-run", purpose: "character_cover", lifecycleState: "active", executionOutcome: "running",
    reviewState: "not_ready", counts: { total: 1, generated: 0, reviewed: 0, approved: 0, placed: 0, failed: 0 },
    updatedAt: "2026-09-02T12:00:00.000Z",
  };
  adminV2Request.mockImplementation(async (path: string) => {
    if (path.includes("/image-sources")) return { items: [], nextCursor: null };
    if (path.includes("/creative/runs?")) return { items: [run], pageInfo: { endCursor: null, hasNextPage: false } };
    if (path.endsWith("/creative/runs/unknown-run")) return { ...run, version: 1, items: [{
      id: "unknown-item", ordinal: 0, version: 1, status: "running", executionState: "failed", asset: null,
      review: null, failure: null, identityReviewMode: "defines_identity", lineage: { requestId: operation.requestId },
    }] };
    throw new Error(`Unexpected request ${path}`);
  });
  try {
    await act(async () => root.render(<CharacterImageLibrary actorId="unknown-operator" data={data}
      canRead canReadProduction canCreate canReview canArchive={false} onContinue={() => undefined}
      onProjectReload={async () => undefined}
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })} />));
    const deadline = Date.now() + 2_000;
    while (!container.textContent?.includes("Open generation task")) {
      if (Date.now() > deadline) throw new Error("Unknown image recovery did not render");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(container.textContent).toContain("Generation result awaiting confirmation");
    expect(container.textContent).not.toContain("Generation failed");
    expect(container.textContent).not.toContain("Image request in progress");
    expect(container.textContent).not.toContain("Unknown error");
    expect(container.querySelector(`a[href="${operation.operationsHref}"]`)).not.toBeNull();
    const generate = [...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("Generation result awaiting confirmation"));
    expect(generate.length).toBeGreaterThan(0);
    expect(generate.every((button) => button.disabled)).toBe(true);
    expect(adminV2Request.mock.calls.every(([path]) => !path.includes("/decisions"))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
  }
});
