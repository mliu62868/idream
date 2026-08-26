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
    await act(async () => root.render(<ToastProvider><JobsView /></ToastProvider>));
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
});

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
