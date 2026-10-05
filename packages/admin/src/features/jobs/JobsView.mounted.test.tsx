// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request, apiGet } = vi.hoisted(() => ({
  adminV2Request: vi.fn(),
  apiGet: vi.fn(),
}));
vi.mock("@/components/admin/api", () => ({ apiGet }));
vi.mock("@/lib/admin-v2-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin-v2-api")>("@/lib/admin-v2-api");
  return { ...actual, adminV2Request };
});

import { ToastProvider } from "@/components/admin/ui/Toast";
import { generationJobDetailResponseSchema } from "@idream/shared/admin";
import { JobsView } from "./JobsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("JobsView request cancellation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/generation/jobs");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    apiGet.mockReset();
    adminV2Request.mockReset();
    apiGet.mockResolvedValue(jobList("running"));
    adminV2Request.mockResolvedValue({
      requestId: "job-1",
      status: "cancelled",
      version: 4,
      finishedAt: "2026-08-25T12:10:00.000Z",
      refundAmount: 8,
    });
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("44444444-4444-4444-8444-444444444444");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("sends the authoritative cancel command and reloads the list", async () => {
    await act(async () => root.render(<ToastProvider><JobsView permissions={allowed} /></ToastProvider>));
    await waitUntil(() => findButton("Abort") !== null);
    await click(findButton("Abort"));

    const dialog = await waitForDialog();
    await type(dialog, "Reason (≥3)", "Request has stalled");
    await type(dialog, "Type the name to confirm", "job-1:cancel");
    await click(findButton("Cancel request", dialog));
    await waitUntil(() => adminV2Request.mock.calls.length === 1);

    expect(adminV2Request).toHaveBeenCalledWith(
      "/api/v2/admin/generation/requests/job-1/commands/cancel",
      expect.objectContaining({
        method: "POST",
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
        body: {
          entityVersion: 3,
          reason: "Request has stalled",
          confirmation: "job-1:cancel",
        },
      }),
    );
    await waitUntil(() => apiGet.mock.calls.length >= 2);
    expect(document.body.textContent).toContain("8 Dreamcoins refunded");
  });

  it("hides Abort and Retry from a read-only role instead of letting the server 403 them", async () => {
    const running = jobList("running");
    apiGet.mockResolvedValue({ ...running, items: [...running.items, { ...jobList("failed").items[0]!, id: "job-2" }] });
    const readOnly = { retry: false, cancel: false, reconcile: false };
    await act(async () => root.render(<ToastProvider><JobsView permissions={readOnly} /></ToastProvider>));
    await waitUntil(() => findButton("Details") !== null);
    expect(findButton("Abort")).toBeNull();
    expect(findButton("Retry")).toBeNull();
  });

  it("copies complete evidence identifiers even when their displayed prefixes collide", async () => {
    const detail = jobDetail("shared-prefix-request-A");
    apiGet.mockImplementation(async (path: string) => path.includes(`/jobs/${detail.request.id}`)
      ? detail : { ...jobList("running"), items: [detail.request] });
    await act(async () => root.render(<ToastProvider><JobsView permissions={allowed} /></ToastProvider>));
    await waitUntil(() => findButton("Details") !== null);
    await click(findButton("Details"));
    await waitUntil(() => container.textContent?.includes("Generation Attempts") === true);
    const inspector = container.querySelector('[aria-labelledby="generation-job-detail-title"]')!;
    const identifiers = [detail.request.id, detail.attempts[0]!.id, detail.transportExecutions[0]!.id,
      detail.artifacts[0]!.id, detail.artifacts[0]!.assetId, detail.deliveries[0]!.targetId,
      detail.settlementEntries[0]!.ledgerEntryId].filter((id): id is string => id !== null);
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    for (const identifier of identifiers) {
      const copy = inspector.querySelector<HTMLButtonElement>(`button[aria-label="Copy ${identifier}"]`);
      expect(copy).not.toBeNull();
      await click(copy);
      expect(writeText).toHaveBeenLastCalledWith(identifier);
    }
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("ignores a stale detail %s after selecting another job", async (outcome) => {
    const first = jobDetail("shared-prefix-request-A");
    const second = jobDetail("shared-prefix-request-B");
    let resolveFirst!: (value: typeof first) => void;
    let rejectFirst!: (reason: Error) => void;
    const pendingFirst = new Promise<typeof first>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    apiGet.mockImplementation(async (path: string) => {
      if (path === `/api/v2/admin/jobs/${first.request.id}`) return pendingFirst;
      if (path === `/api/v2/admin/jobs/${second.request.id}`) return second;
      return { ...jobList("running"), items: [first.request, second.request] };
    });
    await act(async () => root.render(<ToastProvider><JobsView permissions={allowed} /></ToastProvider>));
    await waitUntil(() => container.querySelectorAll('[aria-label="Generation Jobs scrollable table"] tbody tr').length === 2);
    const row = (id: string) => container.querySelector(`button[aria-label="Copy ${id}"]`)!.closest("tr")!;
    await click(findButton("Details", row(first.request.id)));
    await waitUntil(() => apiGet.mock.calls.some(([path]) => path === `/api/v2/admin/jobs/${first.request.id}`));
    await click(findButton("Details", row(second.request.id)));
    await waitUntil(() => container.textContent?.includes(`route-${second.request.id}`) === true);
    await act(async () => {
      if (outcome === "success") resolveFirst(first);
      else rejectFirst(new Error("Stale first job read failed"));
    });
    const inspector = container.querySelector('[aria-labelledby="generation-job-detail-title"]')!;
    expect(inspector.textContent).toContain(`route-${second.request.id}`);
    expect(inspector.textContent).not.toContain(`route-${first.request.id}`);
    expect(inspector.textContent).not.toContain("Stale first job read failed");
    expect(window.location.search).toContain(`job=${second.request.id}`);
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it("restores browser page positions and clears off-page selections on back and forward", async () => {
    window.history.replaceState(null, "", "/admin/ops/jobs?limit=10&userId=user-1&from=2026-08-01T00%3A00%3A00.000Z&to=2026-09-01T00%3A00%3A00.000Z");
    pagedJobs();
    await act(async () => root.render(<ToastProvider><JobsView permissions={allowed} /></ToastProvider>));
    await waitUntil(() => rowCheckbox("page-first") !== null);
    const firstUrl = window.location.href;
    await click(findButton("Next page"));
    await waitUntil(() => rowCheckbox("page-cursor-two") !== null);
    const secondUrl = window.location.href;
    await click(rowCheckbox("page-cursor-two"));
    expect(container.textContent).toContain("1 selected");

    await restoreUrl(firstUrl);
    await waitUntil(() => rowCheckbox("page-first") !== null);
    expect(pager().textContent).toContain("Page 1 of 3");
    expect(pager().textContent).toContain("Showing 1–1 of 30");
    expect(findButton("Previous page")?.hasAttribute("disabled")).toBe(true);
    expect(container.textContent).not.toContain("1 selected");

    await restoreUrl(secondUrl);
    await waitUntil(() => rowCheckbox("page-cursor-two") !== null);
    expect(pager().textContent).toContain("Page 2 of 3");
    expect(pager().textContent).toContain("Showing 11–11 of 30");
    expect(container.textContent).not.toContain("1 selected");
    expect(new URLSearchParams(window.location.search).get("userId")).toBe("user-1");
    expect(new URLSearchParams(window.location.search).get("from")).toBe("2026-08-01T00:00:00.000Z");
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it("does not invent page positions for a shared cursor or its following pages", async () => {
    window.history.replaceState(null, "", "/admin/ops/jobs?limit=10&cursor=cursor-two");
    pagedJobs();
    await act(async () => root.render(<ToastProvider><JobsView permissions={allowed} /></ToastProvider>));
    await waitUntil(() => rowCheckbox("page-cursor-two") !== null);
    expect(pager().textContent).toContain("Page position unknown");
    expect(pager().textContent).toContain("Showing 1 rows");
    expect(pager().textContent).not.toMatch(/Page \d|Showing \d+–\d+/);

    await click(findButton("Next page"));
    await waitUntil(() => rowCheckbox("page-cursor-three") !== null);
    expect(pager().textContent).toContain("Page position unknown");
    await click(findButton("Previous page"));
    await waitUntil(() => rowCheckbox("page-cursor-two") !== null);
    expect(pager().textContent).toContain("Page position unknown");
    await click(findButton("Back to first page"));
    await waitUntil(() => rowCheckbox("page-first") !== null);
    expect(pager().textContent).toContain("Page 1 of 3");
    expect(new URLSearchParams(window.location.search).has("cursor")).toBe(false);
    expect(findButton("Previous page")?.hasAttribute("disabled")).toBe(true);
  });

  it("keeps the table selection and page when only job detail history changes", async () => {
    window.history.replaceState(null, "", "/admin/ops/jobs?limit=10");
    pagedJobs();
    await act(async () => root.render(<ToastProvider><JobsView permissions={allowed} /></ToastProvider>));
    await waitUntil(() => rowCheckbox("page-first") !== null);
    await click(findButton("Next page"));
    await waitUntil(() => rowCheckbox("page-cursor-two") !== null);
    const tableUrl = window.location.href;
    await click(rowCheckbox("page-cursor-two"));
    await click(findButton("Details"));
    await waitUntil(() => container.textContent?.includes("route-page-cursor-two") === true);
    await restoreUrl(tableUrl);
    await waitUntil(() => container.querySelector('[aria-labelledby="generation-job-detail-title"]') === null);
    expect(pager().textContent).toContain("Page 2 of 3");
    expect(container.textContent).toContain("1 selected");
    expect(rowCheckbox("page-cursor-two")?.checked).toBe(true);
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it.each(["Abort", "Retry"])("does not let a late %s receipt replace a restored query or close its new confirmation", async (action) => {
    window.history.replaceState(null, "", "/admin/ops/jobs?limit=10");
    pagedJobs(action === "Retry" ? "failed" : "running");
    let finish!: (result: unknown) => void;
    adminV2Request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<ToastProvider><JobsView permissions={allowed} /></ToastProvider>));
    await waitUntil(() => rowCheckbox("page-first") !== null);
    await click(findButton(action));
    const firstDialog = await waitForDialog();
    await type(firstDialog, "Reason (≥3)", "Old explicitly submitted intent");
    await type(firstDialog, "Type the name to confirm", `page-first:${action === "Retry" ? "retry" : "cancel"}`);
    await click(findButton(action === "Retry" ? "Create retry attempt" : "Cancel request", firstDialog));
    await waitUntil(() => adminV2Request.mock.calls.length === 1);

    await restoreUrl(`${window.location.origin}/admin/ops/jobs?limit=10&cursor=cursor-two`);
    await waitUntil(() => rowCheckbox("page-cursor-two") !== null);
    await click(findButton(action));
    const secondDialog = await waitForDialog();
    await type(secondDialog, "Reason (≥3)", "New current query intent");
    const readsBeforeReceipt = apiGet.mock.calls.length;
    await act(async () => finish({ requestId: "page-first", status: "cancelled", version: 4, refundAmount: 8 }));
    expect(apiGet.mock.calls).toHaveLength(readsBeforeReceipt);
    expect(rowCheckbox("page-cursor-two")).not.toBeNull();
    expect(new URLSearchParams(window.location.search).get("cursor")).toBe("cursor-two");
    expect(document.querySelector('[role="dialog"]')).toBe(secondDialog);
    expect(secondDialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!.value).toBe("New current query intent");
    expect(adminV2Request.mock.calls).toHaveLength(1);
  });

  function pager() {
    return container.querySelector<HTMLElement>('[data-testid="admin-pagination"]')!;
  }

  function rowCheckbox(id: string) {
    return container.querySelector<HTMLInputElement>(`input[aria-label="Select row ${id}"]`);
  }

  function pagedJobs(status: "running" | "failed" = "running") {
    apiGet.mockImplementation(async (path: string) => {
      const url = new URL(path, window.location.origin);
      if (url.pathname.startsWith("/api/v2/admin/jobs/")) return jobDetail(url.pathname.split("/").at(-1)!);
      const cursor = url.searchParams.get("cursor");
      const list = jobList(status);
      return {
        ...list,
        items: [{ ...list.items[0]!, id: `page-${cursor || "first"}` }],
        summary: { ...list.summary, totalCount: 30 },
        pageInfo: { endCursor: cursor === "cursor-three" ? null : cursor ? "cursor-three" : "cursor-two", hasNextPage: cursor !== "cursor-three" },
      };
    });
  }
});

async function restoreUrl(href: string) {
  await act(async () => {
    window.history.replaceState(window.history.state, "", href);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  });
}

const allowed = { retry: true, cancel: true, reconcile: true };

function jobList(legacyStatus: "running" | "failed") {
  return {
    items: [{
      id: "job-1",
      userId: "user-1",
      characterId: null,
      derivedFromJobId: null,
      mode: "image",
      requestOutcome: legacyStatus === "running" ? "processing" : "failed",
      legacyStatus,
      latestAttempt: null,
      unknownReview: { status: "not_applicable", nextReviewAt: null },
      delivery: { expectedOutputCount: 1, deliveredCount: 0, pendingCount: 1, failedCount: 0, suppressedCount: 0 },
      settlement: { view: "captured", capturedDreamcoins: 8, refundedDreamcoins: 0 },
      provider: "local",
      model: "flux",
      profileId: "profile-1",
      profileVersion: 1,
      recipeId: null,
      recipeVersion: null,
      sourceType: "generator",
      sourceId: null,
      errorCode: null,
      outputCount: 1,
      deliveredOutputCount: 0,
      assetCount: 0,
      costDreamcoins: 8,
      promptHidden: false,
      negativePromptHidden: false,
      version: 3,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:01:00.000Z",
      finishedAt: null,
    }],
    pageInfo: { endCursor: null, hasNextPage: false },
    facets: { legacyStatuses: [], modes: [], providers: [], sourceTypes: [] },
    summary: { totalCount: 1, totalCostDreamcoins: 8, totalOutputCount: 1, totalDeliveredOutputCount: 0 },
    dataScope: { kind: "operational", includedDataClasses: ["customer", "internal"], excludedDataClasses: ["fixture", "audit"] },
    asOf: "2026-08-25T12:02:00.000Z",
    freshness: "fresh",
  };
}

function jobDetail(id: string) {
  const at = "2026-08-25T12:02:00.000Z";
  const attemptId = `shared-prefix-attempt-${id}`;
  const artifactId = `shared-prefix-artifact-${id}`;
  return generationJobDetailResponseSchema.parse({
    request: { ...jobList("running").items[0], id, requestOutcome: "succeeded", legacyStatus: "completed", deliveredOutputCount: 1,
      assetCount: 1, delivery: { expectedOutputCount: 1, deliveredCount: 1, pendingCount: 0, failedCount: 0, suppressedCount: 0 }, finishedAt: at },
    attempts: [{ id: attemptId, attemptNo: 1, status: "succeeded", provider: "local", profileKey: "profile-1", profileVersion: 1,
      workflowKey: `route-${id}`, workflowVersion: 1, errorClass: null, errorCode: null, errorSignature: null, retryability: null,
      operatorGuidance: null, startedAt: at, finishedAt: at, createdAt: at }],
    transportExecutions: [{ id: `shared-prefix-transport-${id}`, attemptId, transportAttemptNo: 1, provider: "local",
      providerRequestId: "provider-request-1", idempotencyKey: "transport-key-1", status: "succeeded", latencyMs: 1000,
      costMicros: null, pricingVersion: null, terminalRecordRef: "terminal/attempt.json", startedAt: at, finishedAt: at }],
    artifacts: [{ id: artifactId, attemptId, ordinal: 0, validationState: "valid", archiveState: "active", assetId: `shared-prefix-asset-${id}`, createdAt: at }],
    deliveries: [{ id: `shared-prefix-delivery-${id}`, artifactId, targetType: "user_library", targetId: "shared-prefix-target-user", status: "delivered", deliveredAt: at, createdAt: at }],
    events: [{ id: "event-1", attemptId, sequence: 1, eventType: "generation.attempt.succeeded.v1", outcome: "succeeded", occurredAt: at }],
    settlementEntries: [{ ledgerEntryId: `shared-prefix-ledger-${id}`, kind: "generation_spend", deltaDreamcoins: -8, reason: "generation_spend", createdAt: at }],
    unknownReconciliations: [], unknownTerminalEvidence: null, feedback: [], asOf: at, freshness: "fresh",
  });
}

function findButton(label: string, root: ParentNode = document) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes(label),
  ) ?? null;
}

async function waitForDialog() {
  await waitUntil(() => document.querySelector('[role="dialog"]') !== null);
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

async function type(root: ParentNode, label: string, value: string) {
  const input = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input).toBeTruthy();
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement | null) {
  expect(element).toBeTruthy();
  await act(async () => element?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("condition not met");
}
