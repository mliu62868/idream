// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenerationMetricsView } from "./GenerationMetricsView";
import { JobsView } from "@/features/jobs/JobsView";
import { ToastProvider } from "./ui/Toast";
import { GENERATION_JOBS_REFRESH_EVENT } from "@/features/jobs/query";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("generation health failure drilldown through the real transport", () => {
  let root: Root;
  let container: HTMLDivElement;
  let reads: URL[];
  let includePeriod: boolean;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/ops/generation-metrics");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    reads = [];
    includePeriod = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = new URL(String(input), "http://localhost");
      reads.push(url);
      let data: unknown;
      if (url.pathname === "/api/v2/admin/generation/metrics") {
        const days = Number(url.searchParams.get("days"));
        data = snapshot(days, includePeriod);
      } else if (url.pathname === "/api/v2/admin/jobs") {
        data = jobs(url.searchParams.has("cursor"));
      } else throw new Error(`Unexpected request ${url}`);
      return Response.json({ ok: true, data });
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("reloads the selected metrics window once through shell refresh", async () => {
    await act(async () => root.render(<GenerationMetricsView />));
    await waitUntil(() => reads.some(url => url.searchParams.get("days") === "14"));
    const thirty = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "30 days")!;
    await act(async () => thirty.click());
    await waitUntil(() => reads.some(url => url.searchParams.get("days") === "60"));
    reads = [];
    const href = window.location.href;
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(reads.map(url => url.searchParams.get("days"))).toEqual(["30", "60"]);
    expect(window.location.href).toBe(href);
    expect(thirty.className).toContain("bg-black/[0.05]");
  });

  it("reloads the Jobs scope through the shell event as well as its internal event", async () => {
    window.history.replaceState(null, "", "/admin/ops/jobs?mode=all&profileId=profile-exact");
    await act(async () => root.render(<ToastProvider><JobsView permissions={{ retry: false, cancel: false, reconcile: false }} /></ToastProvider>));
    await waitUntil(() => reads.length === 1);
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(reads).toHaveLength(2);
    expect(reads[1]!.search).toBe(reads[0]!.search);
    await act(async () => { window.dispatchEvent(new Event(GENERATION_JOBS_REFRESH_EVENT)); });
    expect(reads).toHaveLength(3);
  });

  it("uses each received 7/30-day period and exact profile version, recipe and source in failure links", async () => {
    await act(async () => root.render(<GenerationMetricsView />));
    await waitUntil(() => container.querySelectorAll('a[href^="/admin/ops/jobs?"]').length === 4);
    assertLinks(7);
    const thirty = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "30 days")!;
    await act(async () => thirty.click());
    await waitUntil(() => reads.some(url => url.searchParams.get("days") === "60"));
    assertLinks(30);
    expect(container.querySelector('[aria-label="Sources scrollable table"] a')).not.toBeNull();
  });

  it("keeps the deep-link scope visible through Jobs normalization, paging, reload and sorting", async () => {
    const bounds = period(7);
    const scope = { mode: "all", legacyStatus: "failed", ...bounds, profileId: "profile-exact", profileVersion: "2", recipeId: "recipe-exact", sourceType: "generator", limit: "10" };
    window.history.replaceState(null, "", `/admin/ops/jobs?${new URLSearchParams(scope)}`);
    await act(async () => root.render(<ToastProvider><JobsView permissions={{ retry: false, cancel: false, reconcile: false }} /></ToastProvider>));
    await waitUntil(() => container.textContent?.includes("Matching jobs") === true);
    const assertScope = (url: URL) => {
      for (const [key, value] of Object.entries(scope)) expect(url.searchParams.get(key), key).toBe(value);
    };
    assertScope(reads[0]!);
    assertScope(new URL(window.location.href));
    expect(container.textContent).toContain(bounds.from);
    expect(container.textContent).toContain(bounds.to);
    expect(container.textContent).toContain("profile-exact");
    expect(container.textContent).toContain("recipe-exact");
    const next = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Next page")!;
    expect(next).not.toBeNull();
    await act(async () => next.click());
    await waitUntil(() => reads.length === 2);
    assertScope(reads[1]!);
    expect(reads[1]!.searchParams.get("cursor")).toBe("opaque-window-page-2");
    await act(async () => window.dispatchEvent(new Event(GENERATION_JOBS_REFRESH_EVENT)));
    await waitUntil(() => reads.length === 3);
    assertScope(reads[2]!);
    const created = [...container.querySelectorAll<HTMLButtonElement>("th button")].find(button => button.textContent?.includes("Created"))!;
    await act(async () => created.click());
    await waitUntil(() => reads.length === 4);
    assertScope(reads[3]!);
    expect(reads[3]!.searchParams.get("cursor")).toBeNull();
    expect(reads[3]!.searchParams.get("sort")).toBe("created_asc");
    const clearVersion = container.querySelector<HTMLButtonElement>('button[aria-label="Clear filter Version"]')!;
    await act(async () => clearVersion.click());
    await waitUntil(() => reads.length === 5);
    expect(reads[4]!.searchParams.get("profileVersion")).toBeNull();
    expect(reads[4]!.searchParams.get("profileId")).toBe(scope.profileId);
    expect(reads[4]!.searchParams.get("from")).toBe(bounds.from);
    expect(reads[4]!.searchParams.get("to")).toBe(bounds.to);
    const reset = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Reset all")!;
    await act(async () => reset.click());
    await waitUntil(() => reads.length === 6);
    for (const key of ["from", "to", "profileId", "profileVersion", "recipeId", "legacyStatus", "sourceType", "cursor"]) {
      expect(reads[5]!.searchParams.has(key), key).toBe(false);
      expect(new URL(window.location.href).searchParams.has(key), key).toBe(false);
    }
    expect(reads[5]!.searchParams.get("mode")).toBe("image");
  });

  it("does not fabricate an all-time drilldown when the authority has not supplied a period", async () => {
    includePeriod = false;
    await act(async () => root.render(<GenerationMetricsView />));
    await waitUntil(() => container.querySelector('[aria-label="Profiles scrollable table"]') !== null);
    expect(container.querySelector('a[href^="/admin/ops/jobs?"]')).toBeNull();
    expect(container.querySelector('[aria-label="Profiles scrollable table"]')?.textContent).toContain("profile-exact");
  });

  function assertLinks(days: number) {
    const expected = period(days);
    const linkParams = (caption: string) => [...container.querySelectorAll<HTMLAnchorElement>(`[aria-label="${caption} scrollable table"] a`)]
      .map(anchor => new URL(anchor.href).searchParams);
    const profiles = linkParams("Profiles");
    expect(profiles.map(params => params.get("profileVersion")).sort()).toEqual(["2", "null"]);
    for (const params of profiles) {
      expect(params.get("profileId")).toBe("profile-exact");
      expect(params.has("search")).toBe(false);
    }
    const recipes = linkParams("Recipes");
    expect(recipes[0]!.get("recipeId")).toBe("recipe-exact");
    expect(recipes[0]!.has("search")).toBe(false);
    const sources = linkParams("Sources");
    expect(sources[0]!.get("sourceType")).toBe("generator");
    for (const params of [...profiles, ...recipes, ...sources]) {
      expect(params.get("from")).toBe(expected.from);
      expect(params.get("to")).toBe(expected.to);
      expect(params.get("mode")).toBe("all");
      expect(params.get("legacyStatus")).toBe("failed");
    }
  }
});

function period(days: number) {
  const to = "2026-10-05T12:34:56.123Z";
  return { from: new Date(new Date(to).getTime() - days * 86_400_000).toISOString(), to };
}

function snapshot(days: number, includePeriod: boolean) {
  const counts = { total: 4, completed: 1, failed: 3, blocked: 0, costDreamcoins: 3 };
  const current = { ...period(days), ...counts, impressions: 0, clicks: 0, remixTotal: 0 };
  return {
    windowDays: days,
    profiles: [2, null].map(profileVersion => ({ ...counts, profileId: "profile-exact", profileVersion, label: null, workflowKey: null, avgDurationMs: null })),
    recipes: [{ ...counts, recipeId: "recipe-exact" }], sources: [{ ...counts, sourceType: "generator" }],
    placements: [], placementEngagement: [], remix: { total: 0 },
    ...(includePeriod ? { periods: { current, previous: { ...current, ...period(days * 2), to: current.from } } } : {}),
  };
}

function jobs(secondPage: boolean) {
  return {
    items: Array.from({ length: secondPage ? 1 : 10 }, (_, index) => ({ id: `job-${secondPage ? 11 : index + 1}`, userId: "customer", characterId: null, derivedFromJobId: null,
      mode: "image", requestOutcome: "failed", legacyStatus: "failed", latestAttempt: null,
      unknownReview: { status: "not_applicable", nextReviewAt: null },
      delivery: { expectedOutputCount: 1, deliveredCount: 0, pendingCount: 0, failedCount: 0, suppressedCount: 0 },
      settlement: { view: "not_required", capturedDreamcoins: 0, refundedDreamcoins: 0 }, provider: null, model: null,
      profileId: "profile-exact", profileVersion: 2, recipeId: "recipe-exact", recipeVersion: 1, sourceType: "generator", sourceId: null,
      errorCode: "timeout", outputCount: 1, deliveredOutputCount: 0, assetCount: 0, costDreamcoins: 0,
      promptHidden: true, negativePromptHidden: true, version: 1, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z", finishedAt: null })),
    pageInfo: { endCursor: secondPage ? null : "opaque-window-page-2", hasNextPage: !secondPage },
    facets: { legacyStatuses: [], modes: [], providers: [], sourceTypes: [] },
    summary: { totalCount: 11, totalCostDreamcoins: 0, totalOutputCount: 11, totalDeliveredOutputCount: 0 },
    dataScope: { kind: "operational", includedDataClasses: ["customer", "internal"], excludedDataClasses: ["fixture", "audit"] },
    asOf: "2026-10-05T12:34:56.123Z", freshness: "fresh",
  };
}

async function waitUntil(assertion: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (assertion()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(assertion()).toBe(true);
}
