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
  translate: (value: string) => value,
  displayValue: (value: string) => value.replaceAll("_", " "),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});

vi.mock("@/components/admin/i18n", () => ({
  useAdminI18n: () => ({
    t: translate,
    value: displayValue,
  }),
}));

vi.mock("@/features/collaboration/CollaborationPanel", () => ({
  CollaborationPanel: () => <div data-testid="collaboration-panel" />,
}));

import { CreativeRunWorkspace } from "./CreativeRunWorkspace";
import {
  beginDurableMutationIntent,
  readActiveDurableMutationIntent,
} from "@/lib/durable-mutation-intent";

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

function changeTextarea(
  textarea: HTMLTextAreaElement,
  value: string,
) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
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

  it("recovers a lost create response with the exact actor-scoped request and verifies without a second create", async () => {
    vi.useRealTimers();
    const settle = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const createKeys: string[] = [];
    const createBodies: unknown[] = [];
    let createPosts = 0;
    let projectionReads = 0;
    const options = {
      purposes: [{
        value: "campaign",
        label: "Campaign image",
        description: "A reviewed campaign candidate",
        defaultOrientation: "4:5",
        runtimePlacementSupported: true,
      }],
      profiles: [{
        profileKey: "campaign-profile-v1",
        profileVersion: 1,
        label: "Campaign profile",
        workflowKey: "campaign-workflow",
        workflowVersion: 1,
        allowedOrientations: ["4:5"],
        recommended: true,
      }],
      readiness: { ready: true, blocker: null },
      characterAssetStudioHref: "/admin/characters",
    };
    adminV2Request.mockImplementation(async (path, requestOptions) => {
      if (path === "/api/v2/admin/creative/run-options") {
        return options;
      }
      if (path.startsWith("/api/v2/admin/creative/runs?")) {
        return {
          items: [],
          pageInfo: { endCursor: null, hasNextPage: false },
          asOf: "2026-07-17T12:00:00.000Z",
        };
      }
      if (
        path === "/api/v2/admin/creative/runs" &&
        requestOptions?.method === "POST"
      ) {
        createPosts += 1;
        createKeys.push(requestOptions.idempotencyKey ?? "");
        createBodies.push(requestOptions.body);
        if (createPosts === 1) {
          throw new TypeError("Response ended after the server commit");
        }
        return {
          batch: { id: "created-run-recovered" },
          replayed: true,
        };
      }
      if (
        path ===
        "/api/v2/admin/creative/runs/created-run-recovered"
      ) {
        projectionReads += 1;
        throw new Error("projection replica unavailable");
      }
      throw new Error(`Unexpected Admin request: ${path}`);
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
    await settle();
    const brief = container.querySelector("textarea");
    expect(brief).not.toBeNull();
    act(() => {
      if (brief) changeTextarea(
        brief,
        "A precise campaign portrait with natural evening light.",
      );
    });
    expect(buttonByText(container, "Create and launch")?.disabled).toBe(
      false,
    );

    await act(async () => {
      buttonByText(container, "Create and launch")?.click();
      await Promise.resolve();
    });
    expect(createPosts).toBe(1);
    expect(createKeys[0]).toBeTruthy();
    expect(container.textContent).toContain(
      "Creation outcome is unknown",
    );
    expect(buttonByText(container, "Resume creation")).toBeDefined();

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        <CreativeRunWorkspace
          actorId="operator-a"
          permissions={permissions}
          view={{ kind: "list" }}
        />,
      );
    });
    await settle();
    expect(buttonByText(container, "Resume creation")).toBeDefined();
    expect(container.querySelector("textarea")?.disabled).toBe(true);

    await act(async () => {
      buttonByText(container, "Resume creation")?.click();
      await Promise.resolve();
    });
    expect(createPosts).toBe(2);
    expect(createKeys[1]).toBe(createKeys[0]);
    expect(createBodies[1]).toEqual(createBodies[0]);
    expect(projectionReads).toBe(1);
    expect(container.textContent).toContain(
      "Created Run receipt",
    );
    expect(
      buttonByText(container, "Verify created Run"),
    ).toBeDefined();

    await act(async () => {
      buttonByText(container, "Verify created Run")?.click();
      await Promise.resolve();
    });
    expect(projectionReads).toBe(2);
    expect(createPosts).toBe(2);
    expect(container.textContent).toContain(
      "Verification can be retried without another create request",
    );

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        <CreativeRunWorkspace
          actorId="operator-b"
          permissions={permissions}
          view={{ kind: "list" }}
        />,
      );
    });
    await settle();
    expect(buttonByText(container, "Resume creation")).toBeUndefined();
    expect(buttonByText(container, "Verify created Run")).toBeUndefined();
    expect(createPosts).toBe(2);
  });

  it("reconciles an unreplayable create receipt before unlocking a new generic image request", async () => {
    vi.useRealTimers();
    beginDurableMutationIntent({
      scope: "creative-run:create:operator-a",
      signature: "legacy-generic-create",
      now: 1,
      createIdempotencyKey: () => "legacy-generic-key",
      requestSnapshot: { legacyBrief: true },
    });
    adminV2Request.mockImplementation(async (path, options) => {
      if (path === "/api/v2/admin/creative/run-options") {
        return {
          purposes: [{
            value: "campaign",
            label: "Campaign image",
            description: "A reviewed campaign candidate",
            defaultOrientation: "4:5",
            runtimePlacementSupported: true,
          }],
          profiles: [{
            profileKey: "campaign-profile-v1",
            profileVersion: 1,
            label: "Campaign profile",
            workflowKey: "campaign-workflow",
            workflowVersion: 1,
            allowedOrientations: ["4:5"],
            recommended: true,
          }],
          readiness: { ready: true, blocker: null },
          characterAssetStudioHref: "/admin/characters",
        };
      }
      if (path.startsWith("/api/v2/admin/creative/runs?")) {
        return {
          items: [],
          pageInfo: { endCursor: null, hasNextPage: false },
          asOf: "2026-07-17T12:00:00.000Z",
        };
      }
      if (
        path === "/api/v2/admin/mutation-receipts/reconcile" &&
        options?.method === "POST"
      ) {
        return {
          state: "cancelled",
          commandType: "creative.run.create",
          commandId: "cancelled-generic-command",
          status: "cancelled",
          committedTargetId: null,
          verification: null,
        };
      }
      throw new Error(`Unexpected Admin request: ${path}`);
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      buttonByText(container, "Reconcile saved request"),
    ).toBeDefined();

    await act(async () => {
      buttonByText(container, "Reconcile saved request")?.click();
      await Promise.resolve();
    });

    expect(adminV2Request).toHaveBeenCalledWith(
      "/api/v2/admin/mutation-receipts/reconcile",
      expect.objectContaining({
        method: "POST",
        idempotencyKey: "legacy-generic-key",
        body: { commandType: "creative.run.create" },
      }),
    );
    expect(readActiveDurableMutationIntent({
      scope: "creative-run:create:operator-a",
    })).toBeNull();
    expect(container.textContent).toContain(
      "Its key was sealed on the server",
    );
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path === "/api/v2/admin/creative/runs" &&
      options?.method === "POST"
    )).toBe(false);
  });
});
