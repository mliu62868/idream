// @vitest-environment happy-dom

import type {
  AdminCommandStatus,
  CreativeRunDetail,
} from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type AdminRequestOptions = {
  readonly method?: string;
  readonly idempotencyKey?: string;
  readonly body?: unknown;
};

const { adminV2Request, translate, displayValue } = vi.hoisted(() => ({
  adminV2Request: vi.fn<
    (path: string, options?: AdminRequestOptions) => Promise<unknown>
  >(),
  translate: (value: string, params?: Record<string, string | number>) =>
    value.replace(/\{(\w+)\}/g, (token, key: string) =>
      params?.[key] === undefined ? token : String(params[key])),
  displayValue: (value: string) => value.replaceAll("_", " "),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});

vi.mock("@/components/admin/i18n", () => ({
  adminDateLocale: () => undefined,
  useAdminI18n: () => ({
    t: translate,
    value: displayValue,
  }),
}));

vi.mock("@/features/collaboration/CollaborationPanel", () => ({
  CollaborationPanel: () => <div data-testid="collaboration-panel" />,
}));

import { CreativeRunWorkspace } from "./CreativeRunWorkspace";

const runId = "creative-run-retry-mounted";
const itemId = "creative-item-failed";
const retryStorageKey =
  `idream:admin:creative-retry:v2:anonymous:${runId}`;
const permissions = {
  read: true,
  write: true,
  review: true,
  place: true,
};

function runDetail(version = 7): CreativeRunDetail {
  return {
    id: runId,
    title: `Mounted retry projection v${version}`,
    purpose: "feed",
    reviewContext: {
      brief: "Create a clear, customer-ready feed image.",
      orientation: "4:5",
      profile: {
        key: "feed-image",
        version: 3,
        label: "Feed image",
      },
      recipe: {
        key: "feed-freeplay",
        version: 2,
        label: "Feed freeplay",
      },
      referenceAssetCount: 0,
    },
    target: { type: "none", id: "unassigned-destination" },
    ownerId: null,
    dueAt: null,
    priority: "normal",
    lifecycleState: "active",
    workflowStage: "generation",
    executionOutcome: "failed",
    reviewState: "not_ready",
    deploymentState: "unplaced",
    verificationState: "pending",
    settlementView: "refunded",
    retryEligibility: {
      eligibleItemIds: [itemId],
      eligibleCount: 1,
    },
    legacyState: "failed",
    counts: {
      generated: 0,
      failed: 1,
      reviewed: 0,
      approved: 0,
      placed: 0,
      total: 1,
    },
    relatedIncidentIds: [],
    version,
    createdAt: "2026-07-17T12:00:00.000Z",
    updatedAt: `2026-07-17T12:00:0${version % 10}.000Z`,
    items: [
      {
        id: itemId,
        ordinal: 0,
        status: "failed",
        executionState: "failed",
        identityReviewMode: "not_applicable",
        version: 2,
        retryability: "eligible",
        direction: null,
        lineage: {
          briefId: "creative-brief-mounted",
          directionId: null,
          directionHash: null,
          generationProfileKey: "feed-image",
          generationProfileVersion: "3",
          workflowKey: "feed-freeplay",
          workflowVersion: "2",
          requestId: "generation-job-mounted",
          attemptId: "generation-attempt-mounted",
          providerRequestId: null,
          assetId: null,
          reviewDecisionId: null,
          placementVersionId: null,
        },
        asset: null,
        review: null,
        placement: null,
      },
    ],
  };
}

function accepted(commandId: string) {
  return {
    status: "accepted" as const,
    requestId: `request-${commandId}`,
    commandId,
    verificationDeepLink: `/admin/audit?commandId=${commandId}`,
  };
}

function commandStatus(
  commandId: string,
  status: AdminCommandStatus["status"],
  error?: unknown,
): AdminCommandStatus {
  return {
    commandId,
    requestId: `request-${commandId}`,
    commandType: "creative.run.retry_failed",
    target: { type: "creative_run", id: runId },
    status,
    verificationState:
      status === "succeeded" ? "passed" : "pending",
    needsReconciliation: false,
    ...(error === undefined ? {} : { error }),
    createdAt: "2026-07-17T12:00:00.000Z",
    updatedAt: "2026-07-17T12:00:01.000Z",
  };
}

function retryButton(container: HTMLElement) {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Retry"),
  );
}

function buttonByText(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(label),
  );
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

async function advance(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("Creative Run asynchronous retry command", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Request.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    window.localStorage.clear();
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows unknown generation consistently and opens the exact recovery request without submitting a retry", async () => {
    const detail = runDetail();
    detail.executionOutcome = "running";
    detail.counts.failed = 0;
    detail.items[0]!.status = "queued";
    detail.items[0]!.executionState = "unknown";
    detail.items[0]!.retryability = "unknown";
    // A stale eligible count must not make an unresolved provider request retryable.
    adminV2Request.mockImplementation(async (path) => {
      if (path === `/api/v2/admin/creative/runs/${runId}`) return detail;
      throw new Error(`Unexpected request: ${path}`);
    });
    await act(async () => root.render(
      <CreativeRunWorkspace permissions={permissions} view={{ kind: "detail", id: runId }} />,
    ));
    await advance();
    expect(container.textContent).toContain("Needs confirmation");
    expect(container.textContent).toContain("1 item(s) need confirmation");
    expect(container.textContent).toContain("Retry unavailable");
    expect(container.textContent).not.toContain("Waiting for an asset");
    expect(container.textContent).not.toContain("No valid artifact");
    const itemTab = container.querySelector('button[aria-pressed="true"]');
    expect(itemTab?.textContent).toContain("Needs confirmation");
    expect(itemTab?.textContent).not.toContain("failed");
    expect(container.querySelector('a[href="/admin/ops/jobs?job=generation-job-mounted"]')?.textContent).toBe("Open generation recovery");
    expect(retryButton(container)?.disabled).toBe(true);
    expect(adminV2Request.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);

    detail.items[0]!.executionState = "failed";
    detail.items[0]!.status = "failed";
    detail.items[0]!.retryability = "eligible";
    detail.executionOutcome = "failed";
    detail.counts.failed = 1;
    await act(async () => buttonByText(container, "Refresh")!.click());
    await advance();
    expect(container.textContent).not.toContain("Needs confirmation");
    expect(container.querySelector('a[href="/admin/ops/jobs?job=generation-job-mounted"]')).toBeNull();
    expect(retryButton(container)?.disabled).toBe(false);
  });

  it("keeps a 202-accepted retry busy and waits for success before refreshing the Run projection", async () => {
    let runReads = 0;
    let commandReads = 0;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path === `/api/v2/admin/creative/runs/${runId}`) {
        runReads += 1;
        return runDetail(runReads === 1 ? 7 : 8);
      }
      if (
        path ===
          `/api/v2/admin/creative/runs/${runId}/commands/retry-failed` &&
        options?.method === "POST"
      ) {
        return accepted("retry-command-happy");
      }
      if (path === "/api/v2/admin/commands/retry-command-happy") {
        commandReads += 1;
        return commandStatus(
          "retry-command-happy",
          commandReads === 1 ? "running" : "succeeded",
        );
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });

    await act(async () => {
      root.render(
        <CreativeRunWorkspace
          permissions={permissions}
          view={{ kind: "detail", id: runId }}
        />,
      );
    });
    await advance();

    expect(runReads).toBe(1);
    const button = retryButton(container);
    expect(button?.disabled).toBe(false);

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Retry in progress");
    expect(retryButton(container)?.disabled).toBe(true);
    expect(container.textContent).toContain("accepted");
    expect(runReads).toBe(1);
    expect(window.localStorage.getItem(retryStorageKey)).toContain(
      "retry-command-happy",
    );

    await advance();
    expect(commandReads).toBe(1);
    expect(container.textContent).toContain("running");
    expect(runReads).toBe(1);

    await advance(1_499);
    expect(commandReads).toBe(1);
    expect(runReads).toBe(1);

    await advance(1);
    expect(commandReads).toBe(2);
    expect(runReads).toBe(2);
    expect(container.textContent).toContain(
      "Mounted retry projection v8",
    );
    expect(container.textContent).not.toContain("Retry command");
    expect(window.localStorage.getItem(retryStorageKey)).toBeNull();
    expect(retryButton(container)?.disabled).toBe(false);
    expect(retryButton(container)?.textContent).toContain(
      "Retry 1 eligible failed",
    );
  });

  it("surfaces a failed command with its audit trail and starts a new idempotent intent only after an explicit retry", async () => {
    const postKeys: string[] = [];
    let postCount = 0;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path === `/api/v2/admin/creative/runs/${runId}`) {
        return runDetail();
      }
      if (
        path ===
          `/api/v2/admin/creative/runs/${runId}/commands/retry-failed` &&
        options?.method === "POST"
      ) {
        postCount += 1;
        postKeys.push(options.idempotencyKey ?? "");
        return accepted(`retry-command-${postCount}`);
      }
      if (path === "/api/v2/admin/commands/retry-command-1") {
        return commandStatus("retry-command-1", "failed", {
          code: "source_asset_archived",
          message: "The frozen source image was archived.",
        });
      }
      if (path === "/api/v2/admin/commands/retry-command-2") {
        return commandStatus("retry-command-2", "running");
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });

    await act(async () => {
      root.render(
        <CreativeRunWorkspace
          permissions={permissions}
          view={{ kind: "detail", id: runId }}
        />,
      );
    });
    await advance();

    await act(async () => {
      retryButton(container)?.click();
      await Promise.resolve();
    });
    await advance();

    expect(postCount).toBe(1);
    expect(container.textContent).toContain(
      "The frozen source image was archived.",
    );
    expect(container.textContent).toContain("Retry 1 again");
    expect(retryButton(container)?.disabled).toBe(false);
    expect(
      container.querySelector(
        'a[href="/admin/audit?commandId=retry-command-1"]',
      ),
    ).not.toBeNull();
    expect(window.localStorage.getItem(retryStorageKey)).toContain(
      '"status":"failed"',
    );

    await act(async () => {
      retryButton(container)?.click();
      await Promise.resolve();
    });

    expect(postCount).toBe(2);
    expect(postKeys[0]).toBeTruthy();
    expect(postKeys[1]).toBeTruthy();
    expect(postKeys[1]).not.toBe(postKeys[0]);
    expect(container.textContent).toContain("Retry in progress");
    expect(container.textContent).not.toContain(
      "The frozen source image was archived.",
    );
    expect(
      container.querySelector(
        'a[href="/admin/audit?commandId=retry-command-2"]',
      ),
    ).not.toBeNull();
    expect(window.localStorage.getItem(retryStorageKey)).toContain(
      "retry-command-2",
    );

    await advance();
    expect(
      adminV2Request.mock.calls.filter(
        ([path]) =>
          path === "/api/v2/admin/commands/retry-command-1",
      ),
    ).toHaveLength(1);
    expect(
      adminV2Request.mock.calls.filter(
        ([path]) =>
          path === "/api/v2/admin/commands/retry-command-2",
      ),
    ).toHaveLength(1);
  });

  it("polls repeated running states at 1500ms instead of creating a tight zero-delay loop", async () => {
    let commandReads = 0;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path === `/api/v2/admin/creative/runs/${runId}`) {
        return runDetail();
      }
      if (
        path ===
          `/api/v2/admin/creative/runs/${runId}/commands/retry-failed` &&
        options?.method === "POST"
      ) {
        return accepted("retry-command-running");
      }
      if (path === "/api/v2/admin/commands/retry-command-running") {
        commandReads += 1;
        return commandStatus("retry-command-running", "running");
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });

    await act(async () => {
      root.render(
        <CreativeRunWorkspace
          permissions={permissions}
          view={{ kind: "detail", id: runId }}
        />,
      );
    });
    await advance();
    await act(async () => {
      retryButton(container)?.click();
      await Promise.resolve();
    });

    await advance();
    expect(commandReads).toBe(1);

    await advance(1_499);
    expect(commandReads).toBe(1);

    await advance(1);
    expect(commandReads).toBe(2);

    await advance();
    expect(commandReads).toBe(2);

    await advance(1_499);
    expect(commandReads).toBe(2);

    await advance(1);
    expect(commandReads).toBe(3);
  });

  it("replays a submission-unknown journal with the same key after remount instead of creating a second retry intent", async () => {
    const postKeys: string[] = [];
    const postEntityVersions: number[] = [];
    const journalsObservedBeforePost: Array<
      Record<string, unknown> | null
    > = [];
    let postCount = 0;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path === `/api/v2/admin/creative/runs/${runId}`) {
        return runDetail(7);
      }
      if (
        path ===
          `/api/v2/admin/creative/runs/${runId}/commands/retry-failed` &&
        options?.method === "POST"
      ) {
        postCount += 1;
        postKeys.push(options.idempotencyKey ?? "");
        journalsObservedBeforePost.push(
          JSON.parse(
            window.localStorage.getItem(retryStorageKey) ?? "null",
          ) as Record<string, unknown> | null,
        );
        const body = options.body as
          | { readonly entityVersion?: number }
          | undefined;
        postEntityVersions.push(body?.entityVersion ?? -1);
        if (postCount === 1) {
          throw new TypeError("The response stream ended before headers");
        }
        return accepted("retry-command-replayed");
      }
      if (path === "/api/v2/admin/commands/retry-command-replayed") {
        return commandStatus("retry-command-replayed", "running");
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });

    await act(async () => {
      root.render(
        <CreativeRunWorkspace
          permissions={permissions}
          view={{ kind: "detail", id: runId }}
        />,
      );
    });
    await advance();

    await act(async () => {
      retryButton(container)?.click();
      await Promise.resolve();
    });

    expect(postCount).toBe(1);
    expect(journalsObservedBeforePost[0]).toMatchObject({
      commandId: null,
      verificationDeepLink: null,
      entityVersion: 7,
      idempotencyKey: postKeys[0],
      status: "submitting",
    });
    const unknownJournal = JSON.parse(
      window.localStorage.getItem(retryStorageKey) ?? "null",
    ) as Record<string, unknown> | null;
    expect(unknownJournal).toMatchObject({
      commandId: null,
      verificationDeepLink: null,
      entityVersion: 7,
      idempotencyKey: postKeys[0],
      status: "submission_unknown",
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        <CreativeRunWorkspace
          permissions={permissions}
          view={{ kind: "detail", id: runId }}
        />,
      );
    });
    await advance();

    expect(postCount).toBe(2);
    expect(postKeys[1]).toBe(postKeys[0]);
    expect(postEntityVersions).toEqual([7, 7]);
    expect(journalsObservedBeforePost[1]).toMatchObject({
      commandId: null,
      verificationDeepLink: null,
      entityVersion: 7,
      idempotencyKey: postKeys[0],
      status: "submitting",
    });
    expect(window.localStorage.getItem(retryStorageKey)).toContain(
      "retry-command-replayed",
    );
    expect(
      container.querySelector(
        'a[href="/admin/audit?commandId=retry-command-replayed"]',
      ),
    ).not.toBeNull();
    expect(retryButton(container)?.disabled).toBe(true);
  });

  it("retains a succeeded receipt and disables business retry until an explicit projection refresh succeeds", async () => {
    let runReads = 0;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path === `/api/v2/admin/creative/runs/${runId}`) {
        runReads += 1;
        if (runReads === 2) {
          throw new Error("projection replica unavailable");
        }
        return runDetail(runReads === 1 ? 7 : 8);
      }
      if (
        path ===
          `/api/v2/admin/creative/runs/${runId}/commands/retry-failed` &&
        options?.method === "POST"
      ) {
        return accepted("retry-command-projection-gap");
      }
      if (
        path ===
        "/api/v2/admin/commands/retry-command-projection-gap"
      ) {
        return commandStatus(
          "retry-command-projection-gap",
          "succeeded",
        );
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });

    await act(async () => {
      root.render(
        <CreativeRunWorkspace
          permissions={permissions}
          view={{ kind: "detail", id: runId }}
        />,
      );
    });
    await advance();
    await act(async () => {
      retryButton(container)?.click();
      await Promise.resolve();
    });
    await advance();

    expect(runReads).toBe(2);
    expect(container.textContent).toContain(
      "Retry command succeeded, but the latest projection could not be refreshed",
    );
    expect(retryButton(container)?.disabled).toBe(true);
    const retainedReceipt = JSON.parse(
      window.localStorage.getItem(retryStorageKey) ?? "null",
    ) as Record<string, unknown> | null;
    expect(retainedReceipt).toMatchObject({
      commandId: "retry-command-projection-gap",
      status: "succeeded",
    });
    expect(
      container.querySelector(
        'a[href="/admin/audit?commandId=retry-command-projection-gap"]',
      ),
    ).not.toBeNull();
    const refreshProjection = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Refresh projection"),
    );
    expect(refreshProjection).toBeDefined();
    expect(refreshProjection?.disabled).toBe(false);

    await act(async () => {
      refreshProjection?.click();
      await Promise.resolve();
    });

    expect(runReads).toBe(3);
    expect(container.textContent).toContain(
      "Mounted retry projection v8",
    );
    expect(window.localStorage.getItem(retryStorageKey)).toBeNull();
    expect(retryButton(container)?.disabled).toBe(false);
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Refresh projection"),
      ),
    ).toBe(false);
  });

  it("keeps the list as generation history and never exposes the removed generic creation flow", async () => {
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/v2/admin/creative/runs?")) {
        return {
          items: [],
          pageInfo: { endCursor: null, hasNextPage: false },
          asOf: "2026-07-17T12:00:00.000Z",
        };
      }
      throw new Error(`Unexpected Admin request: ${path} ${options?.method ?? "GET"}`);
    });

    await act(async () => {
      root.render(
        <CreativeRunWorkspace
          actorId="operator-a"
          permissions={permissions}
          view={{ kind: "list" }}
        />,
      );
    });
    await advance();

    expect(container.textContent).toContain("Generate assets, choose where to use them, and verify delivery.");
    expect(container.textContent).not.toContain("Create images");
    expect(container.querySelector('textarea[aria-label="Negative prompt"]')).toBeNull();
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path === "/api/v2/admin/creative/run-options" ||
      (path === "/api/v2/admin/creative/runs" && options?.method === "POST")
    )).toBe(false);
  });

});

const campaignRunId = "creative-run-campaign-mounted";
const campaignItemId = "creative-item-campaign";

// SPEC: 一个可评审、可投放的 campaign Run —— 评审表单与投放表单的行为都挂在它上面。
function campaignRun(
  overrides: {
    readonly review?: CreativeRunDetail["items"][number]["review"];
    readonly placement?: CreativeRunDetail["items"][number]["placement"];
  } = {},
): CreativeRunDetail {
  const base = runDetail(4);
  return {
    ...base,
    id: campaignRunId,
    title: "Summer campaign hero",
    purpose: "campaign",
    reviewContext: {
      ...base.reviewContext,
      recipe: { key: "campaign-hero", version: 2, label: "Campaign hero" },
    },
    executionOutcome: "succeeded",
    reviewState: "in_review",
    retryEligibility: { eligibleItemIds: [], eligibleCount: 0 },
    counts: { generated: 1, failed: 0, reviewed: 0, approved: 0, placed: 0, total: 1 },
    items: [{
      ...base.items[0]!,
      id: campaignItemId,
      status: "generated",
      executionState: "ready",
      retryability: "not_eligible",
      asset: {
        id: "creative-asset-campaign",
        url: "/campaign.webp",
        thumbnailUrl: null,
        width: 1024,
        height: 1024,
      },
      review: overrides.review ?? null,
      placement: overrides.placement ?? null,
    }],
  };
}

const approvedReview = {
  id: "creative-review-approved",
  supersedesDecisionId: null,
  decision: "approved",
  identityConsistency: "unscored",
  score: 88,
  quality: {
    artifactFree: true,
    singleSubject: true,
    intentMatch: true,
    noVisibleText: true,
  },
  reason: "Sharp subject, correct campaign framing",
  reviewerId: "anonymous",
  createdAt: "2026-07-17T12:00:00.000Z",
} as const;

const stagedPlacement = {
  id: "creative-placement-staged",
  slot: "campaign",
  status: "scheduled",
  verificationState: "verifying",
  targetType: "campaign",
  targetId: "summer-collection",
  verifiedAt: null,
  rollbackPlacementId: null,
} as const;

function fieldByLabel(container: HTMLElement, label: string) {
  const owner = [...container.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim().startsWith(label),
  );
  return owner?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  );
}

function changeField(
  field: HTMLInputElement | HTMLTextAreaElement | null | undefined,
  value: string,
) {
  if (!field) throw new Error("Field is not rendered");
  const prototype = field instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Creative Run review and placement authority", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Request.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    window.localStorage.clear();
    container.remove();
    vi.restoreAllMocks();
  });

  async function mountRun() {
    await act(async () => root.render(
      <CreativeRunWorkspace
        permissions={permissions}
        view={{ kind: "detail", id: campaignRunId }}
      />,
    ));
    await advance();
  }

  it("shows the frozen recipe alongside the other review evidence", async () => {
    const detail = campaignRun();
    adminV2Request.mockImplementation(async () => detail);
    await mountRun();

    expect(container.textContent).toContain("Recipe");
    expect(container.textContent).toContain("Campaign hero · v2");
    expect(container.textContent).toContain("Image route");
  });

  it("warns that the review decision was committed but the projection could not be refreshed", async () => {
    let projectionReads = 0;
    const detail = { ...campaignRun(), purpose: "model_eval" as const };
    adminV2Request.mockImplementation(async (path, options) => {
      if (options?.method === "POST" && path.includes("/decisions")) {
        return { decisionId: "creative-review-1", replayed: false };
      }
      projectionReads += 1;
      // INTENT: 第一次是挂载取数，必须成功；提交后的那次回读故意失败。
      if (projectionReads > 1) throw new Error("projection gateway unavailable");
      return detail;
    });
    await mountRun();

    changeField(fieldByLabel(container, "Identity match score"), "90");
    changeField(
      fieldByLabel(container, "Evidence and reason"),
      "Subject is sharp and on brief",
    );
    await act(async () => {
      buttonByText(container, "Approve")?.click();
    });
    await advance();

    // SPEC: 命令已提交但投影没跟上——必须说清楚，且不能把请求键作废。
    expect(container.textContent).toContain(
      "Review decision was committed, but the latest projection could not be refreshed",
    );
    await act(async () => {
      buttonByText(container, "Approve")?.click();
    });
    await advance();
    const decisions = adminV2Request.mock.calls.filter(
      ([path, options]) => options?.method === "POST" && path.includes("/decisions"),
    );
    expect(decisions).toHaveLength(2);
    // INVARIANT: 每一次评审写入都带着键上路；键从哪来、什么时候换归
    // idempotency-key-lifecycle 管，那里有纯状态机测试。
    for (const [, options] of decisions) {
      expect(typeof options?.idempotencyKey).toBe("string");
    }
  });

  it("stages a campaign candidate with normalized authored copy and its own reason", async () => {
    const detail = campaignRun();
    adminV2Request.mockImplementation(async (_path, options) => {
      if (options?.method === "POST") return { placementId: "creative-placement-1" };
      return detail;
    });
    await mountRun();

    changeField(fieldByLabel(container, "Campaign destination key"), "summer-collection");
    changeField(fieldByLabel(container, "Campaign eyebrow"), "  Featured  ");
    changeField(fieldByLabel(container, "Campaign title"), "  Summer dreamers  ");
    changeField(fieldByLabel(container, "Campaign CTA label"), "  Open collection  ");
    changeField(fieldByLabel(container, "Staging reason"), "Approved hero for the summer push");
    // SPEC: CTA 文案与去处要么都填、要么都不填。
    expect(buttonByText(container, "Stage campaign candidate")?.disabled).toBe(true);
    changeField(fieldByLabel(container, "Campaign CTA href"), "  /community?collection=summer  ");
    expect(buttonByText(container, "Stage campaign candidate")?.disabled).toBe(false);

    await act(async () => {
      buttonByText(container, "Stage campaign candidate")?.click();
    });
    await advance();

    const stage = adminV2Request.mock.calls.find(
      ([path, options]) => options?.method === "POST" && path.endsWith("/placements"),
    );
    expect(stage?.[1]?.body).toMatchObject({
      itemId: campaignItemId,
      eyebrow: "Featured",
      title: "Summer dreamers",
      ctaLabel: "Open collection",
      href: "/community?collection=summer",
      reason: "Approved hero for the summer push",
    });
  });

  it("collects the staged-withdrawal reason separately from the staging reason", async () => {
    const detail = campaignRun({
      review: approvedReview,
      placement: stagedPlacement,
    });
    adminV2Request.mockImplementation(async (_path, options) => {
      if (options?.method === "POST") return { withdrawn: true };
      return detail;
    });
    await mountRun();

    // SPEC: 已暂存后就没有 Staging reason 这个字段了，撤回必须自己给理由。
    expect(fieldByLabel(container, "Staging reason")).toBeUndefined();
    changeField(
      fieldByLabel(container, "Withdrawal reason"),
      "Campaign slot was reassigned before launch",
    );
    await act(async () => {
      buttonByText(container, "Withdraw staged placement")?.click();
    });
    await advance();

    const withdrawal = adminV2Request.mock.calls.find(
      ([path, options]) => options?.method === "POST" && path.endsWith("/withdrawal"),
    );
    expect(withdrawal?.[0]).toContain(`/placements/${stagedPlacement.id}/withdrawal`);
    expect(withdrawal?.[1]?.body).toMatchObject({
      reason: "Campaign slot was reassigned before launch",
    });
  });

  it("preserves historical decisions as read-only evidence", async () => {
    const detail = campaignRun({ review: approvedReview });
    adminV2Request.mockImplementation(async () => detail);
    await mountRun();
    expect(container.textContent).toContain("Historical decision");
    expect(container.textContent).toContain("Sharp subject, correct campaign framing");
    expect(buttonByText(container, "Withdraw approval")).toBeUndefined();
    expect(buttonByText(container, "Approve")).toBeUndefined();
    expect(buttonByText(container, "Reject")).toBeUndefined();
    expect(adminV2Request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("sends a generated Character asset directly back to its Character workspace", async () => {
    const detail = { ...campaignRun(), purpose: "character_hero" as const, target: { type: "character" as const, id: "test-character" } };
    adminV2Request.mockImplementation(async () => detail);
    await mountRun();
    expect(container.querySelector('a[href="/admin/characters/test-character?tab=assets"]')).not.toBeNull();
    expect(buttonByText(container, "Approve")).toBeUndefined();
    expect(container.textContent).not.toContain("Review required");
    expect(container.textContent).toContain("Asset ready");
  });

  /**
   * SPEC: 提交成功、回读投影失败时，运营必须读到「写进去了，但这一屏没跟上」。
   * INTENT: 四条写入路径（评审 / 暂存 / 激活 / 撤回）是同一段代码形状，各测一遍是因为
   *         把 reload 的失败吞成报错在任何一条上都会独立发生。
   *         幂等键不在这里断言——键的生成与复用归 idempotency-key-lifecycle 一家管，
   *         它自己有纯状态机测试；这里再抄一遍只会在改状态机时四处返红。
   */
  async function expectCommittedProjectionWarning(input: {
    readonly detail: CreativeRunDetail;
    readonly commandPath: string;
    readonly warning: string;
    readonly act: () => Promise<void>;
  }) {
    let projectionReads = 0;
    adminV2Request.mockImplementation(async (path, options) => {
      if (options?.method === "POST") return { accepted: true };
      projectionReads += 1;
      // INTENT: 挂载那次必须成功；提交后的回读故意失败。
      if (projectionReads > 1) throw new Error("projection gateway unavailable");
      return input.detail;
    });
    await mountRun();

    await input.act();
    expect(container.textContent).toContain(input.warning);
    await input.act();

    const commands = adminV2Request.mock.calls.filter(
      ([path, options]) =>
        options?.method === "POST" && path.includes(input.commandPath),
    );
    expect(commands).toHaveLength(2);
    for (const [, options] of commands) {
      expect(typeof options?.idempotencyKey).toBe("string");
    }
  }

  it("warns that staging was committed but the projection could not be refreshed", async () => {
    const detail = campaignRun({ review: approvedReview });
    await expectCommittedProjectionWarning({
      detail,
      commandPath: "/placements",
      warning: "Placement staging was committed, but the latest projection could not be refreshed",
      act: async () => {
        changeField(fieldByLabel(container, "Campaign destination key"), "summer-collection");
        changeField(fieldByLabel(container, "Campaign eyebrow"), "Featured");
        changeField(fieldByLabel(container, "Campaign title"), "Summer dreamers");
        changeField(fieldByLabel(container, "Staging reason"), "Approved hero for the summer push");
        await act(async () => {
          buttonByText(container, "Stage campaign candidate")?.click();
        });
        await advance();
      },
    });
  });

  it("warns that activation was committed but the projection could not be refreshed", async () => {
    const detail = campaignRun({
      review: approvedReview,
      placement: stagedPlacement,
    });
    await expectCommittedProjectionWarning({
      detail,
      commandPath: "/verification",
      warning: "Placement activation was committed, but the latest projection could not be refreshed",
      act: async () => {
        await act(async () => {
          buttonByText(container, "Verify & activate")?.click();
        });
        await advance();
      },
    });
  });

  it("warns that withdrawal was committed but the projection could not be refreshed", async () => {
    const detail = campaignRun({
      review: approvedReview,
      placement: stagedPlacement,
    });
    await expectCommittedProjectionWarning({
      detail,
      commandPath: "/withdrawal",
      warning: "Placement withdrawal was committed, but the latest projection could not be refreshed",
      act: async () => {
        changeField(
          fieldByLabel(container, "Withdrawal reason"),
          "Campaign slot was reassigned before launch",
        );
        await act(async () => {
          buttonByText(container, "Withdraw staged placement")?.click();
        });
        await advance();
      },
    });
  });
});
