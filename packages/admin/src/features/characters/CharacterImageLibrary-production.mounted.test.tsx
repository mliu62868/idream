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

it("refreshes the surrounding image library after rejecting a generated candidate", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  window.localStorage.clear();
  let rejected = false;
  const onProjectReload = vi.fn(async () => undefined);
  const quality = { artifactFree: false, singleSubject: false, intentMatch: false, noVisibleText: false };
  const review = () => rejected ? {
    id: "rejected-review", decision: "rejected" as const, identityConsistency: "unscored" as const,
    score: null, quality, reason: "Reject this candidate", createdAt: "2026-09-02T12:01:00.000Z",
  } : null;
  const run = {
    id: "review-refresh-run", purpose: "character_cover", lifecycleState: "active",
    executionOutcome: "succeeded", reviewState: "pending",
    counts: { total: 1, generated: 1, reviewed: 0, approved: 0, placed: 0, failed: 0 },
    updatedAt: "2026-09-02T12:00:00.000Z",
  };
  adminV2Request.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path.includes("/image-sources")) {
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
      return { items: [asset] };
    }
    if (path.includes("/creative/runs?")) return { items: [run], pageInfo: { endCursor: null, hasNextPage: false } };
    if (path.endsWith("/decisions") && options?.method === "POST") {
      rejected = true;
      return { decisionId: "rejected-review" };
    }
    if (path.endsWith(`/creative/runs/${run.id}`)) return {
      ...run, version: rejected ? 2 : 1,
      items: [{
        id: "review-refresh-item", ordinal: 0, status: rejected ? "rejected" : "generated", version: 1,
        identityReviewMode: "defines_identity",
        asset: { id: "review-refresh-asset", url: "/portrait.png", thumbnailUrl: "/portrait.png" },
        review: review(), lineage: { requestId: "review-refresh-job" },
      }],
    };
    throw new Error(`Unexpected request ${path}`);
  });
  const waitUntil = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000;
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
      canRead canReadProduction canCreate canReview canReviewImported={false} canArchive={false}
      onContinue={() => undefined}
      onProjectReload={onProjectReload}
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
    />));
    const library = () => container.querySelector('section[aria-label="Character image library"]');
    await waitUntil(() => library()?.textContent?.includes("review pending") === true);
    await waitUntil(() => [...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Reject current")));
    const reject = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Reject current"));
    await act(async () => reject?.click());
    await waitUntil(() => rejected);
    await waitUntil(() => library()?.textContent?.includes("review rejected") === true);
    expect(library()?.textContent).not.toContain("review pending");
    expect(onProjectReload).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
  }
});
