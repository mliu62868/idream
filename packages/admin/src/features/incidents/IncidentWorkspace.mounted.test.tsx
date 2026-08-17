// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request, AdminV2RequestError, setWorkspaceUrl } = vi.hoisted(() => ({
  adminV2Request: vi.fn(),
  AdminV2RequestError: class extends Error {},
  setWorkspaceUrl: vi.fn(),
}));

vi.mock("@/lib/admin-v2-api", () => ({
  adminV2Request,
  setWorkspaceUrl,
  AdminV2RequestError,
}));
vi.mock("@/features/collaboration/CollaborationPanel", () => ({
  CollaborationPanel: () => null,
}));
vi.mock("@/features/collaboration/SavedViewsControl", () => ({
  SavedViewsControl: () => null,
}));

import { IncidentWorkspace } from "./IncidentWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const impact = {
  affectedRequests: 4,
  affectedUsers: 3,
  failedCostMicros: 125_000,
  refundMicros: 0,
  refundDreamcoins: 40,
};
const incident = {
  id: "incident-1",
  signature: "signature-abcdef012345",
  signatureVersion: "v2",
  status: "mitigating",
  severity: "critical",
  ownerId: null,
  firstSeenAt: "2026-08-11T11:00:00.000Z",
  lastSeenAt: "2026-08-11T12:30:00.000Z",
  impact,
  lastKnownGoodAt: null,
  slaDueAt: null,
  suspectedCause: "Provider timeouts",
  causeConfidence: 0.75,
  recommendedActions: ["retry_eligible", "pause_route"],
  runbookUrl: null,
  rollbackTarget: null,
  recoveryVerification: { state: "pending", checkedAt: null, evidenceRefs: [], checks: null },
  version: 7,
  createdAt: "2026-08-11T11:00:00.000Z",
  updatedAt: "2026-08-11T12:31:00.000Z",
};
const plan = {
  id: "plan-1",
  incidentId: incident.id,
  action: "refund" as const,
  incidentVersion: incident.version,
  occurrenceSetHash: "hash-1",
  eligibleOccurrenceIds: ["occurrence-1", "occurrence-2"],
  skippedOccurrenceIds: [],
  impact,
  targetVersion: null,
  // 相对 list.asOf 未过期——过期判断锚在服务端时钟上，不受跑测试的挂钟影响。
  expiresAt: "2026-08-11T12:47:00.000Z",
  createdBy: "operator-1",
  createdAt: "2026-08-11T12:31:00.000Z",
};
const list = {
  items: [incident],
  pageInfo: { endCursor: null, hasNextPage: false },
  asOf: "2026-08-11T12:32:00.000Z",
  freshness: "fresh",
};
const detail = {
  incident,
  occurrences: [
    { id: "occurrence-1", incidentId: incident.id, requestId: "job-1", attemptId: "attempt-1", transportExecutionId: null, observedAt: "2026-08-11T12:00:00.000Z", assignmentHistory: [] },
    { id: "occurrence-2", incidentId: incident.id, requestId: "job-2", attemptId: "attempt-2", transportExecutionId: null, observedAt: "2026-08-11T12:10:00.000Z", assignmentHistory: [] },
  ],
  actionPlans: [plan],
  postmortem: null,
  activity: [],
};

describe("IncidentWorkspace mitigation safety", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/ops/incidents");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Request.mockReset();
    setWorkspaceUrl.mockReset();
    adminV2Request.mockImplementation(async (path: string) =>
      path.startsWith("/api/v2/admin/incidents?") ? list : detail,
    );
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(idempotencyKey);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows the frozen plan's own money impact and blocks execution behind a modal confirmation", async () => {
    await act(async () => {
      root.render(<IncidentWorkspace canManage initialIncidentId={incident.id} />);
    });
    await waitUntil(() => findButton("Execute frozen plan", container) !== null);

    // 冻结计划来自 detail.actionPlans，所以别的浏览器冻的那份在这里也看得见。
    expect(container.textContent).toContain("125,000 μ");
    expect(container.textContent).toContain("2 eligible");

    await click(findButton("Execute frozen plan", container));
    const dialog = await waitForDialog();
    // 后果是常驻红条，运营在敲确认串之前就读得到「没有回头路」。
    expect(dialog.textContent).toContain("This cannot be undone.");
    expect(dialog.textContent).toContain("This moves customer money across 2 occurrences");
    // 幂等键在打开对话框时就固定下来，失败后就地重试不会重复退款——这句话必须是真的。
    expect(dialog.textContent).toContain("reuses the same idempotency key");

    const submit = findButton("Execute frozen plan", dialog);
    expect(submit?.disabled).toBe(true);
    await enter(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Execution confirmation"]'),
      `${incident.id}:${plan.id}:refund`,
    );
    expect(submit?.disabled).toBe(false);
    // 契约不收 reason，所以确认框不该多问一个会被丢弃的原因。
    expect(dialog.querySelector('input[aria-label="Reason (≥3)"]')).toBeNull();

    await click(submit);
    await waitUntil(() =>
      adminV2Request.mock.calls.some(([path]) => String(path).includes("/execute")),
    );
    const executeCall = adminV2Request.mock.calls.find(([path]) => String(path).includes("/execute"));
    expect(executeCall?.[1]).toEqual({
      method: "POST",
      idempotencyKey,
      body: { entityVersion: incident.version, confirmation: `${incident.id}:${plan.id}:refund` },
    });
  });

  it("sends the idempotency key the preview authority requires", async () => {
    await act(async () => {
      root.render(<IncidentWorkspace canManage initialIncidentId={incident.id} />);
    });
    await waitUntil(() => findButton("Preview eligible scope", container) !== null);

    await click(findButton("Preview eligible scope", container));
    await waitUntil(() =>
      adminV2Request.mock.calls.some(([path]) => String(path).includes("/action-plans/preview")),
    );
    const previewCall = adminV2Request.mock.calls.find(([path]) =>
      String(path).includes("/action-plans/preview"),
    );
    expect(previewCall?.[1]).toMatchObject({ method: "POST", idempotencyKey });
  });
});

function findButton(label: string, root: ParentNode = document) {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.getAttribute("aria-label") === label ||
        button.textContent?.trim() === label,
    ) ?? null
  );
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function enter(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitForDialog() {
  await waitUntil(() => document.querySelector('[role="dialog"]') !== null);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Incident confirmation dialog did not mount");
  return dialog;
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for IncidentWorkspace state");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
