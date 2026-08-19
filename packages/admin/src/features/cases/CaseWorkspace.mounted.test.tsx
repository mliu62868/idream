// @vitest-environment happy-dom

import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn<(path: string, init?: { method?: string; idempotencyKey?: string }) => Promise<unknown>>(),
}));

// React 覆盖了 value 的 setter，直接赋值不会触发 onChange —— 走原型上的原生 setter 才行。
function setReactValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});

import { CaseWorkspace } from "./CaseWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const adminCase = {
  id: "case-1",
  type: "support_request",
  target: { type: "user", id: "user-1" },
  caseKey: "support:user-1",
  status: "new",
  priority: "normal",
  severity: "medium",
  ownerId: null,
  slaDueAt: "2026-08-12T00:00:00.000Z",
  reportCount: 1,
  messageCount: 0,
  resolutionSummary: null,
  verification: null,
  relatedIncidentIds: [],
  relatedCaseIds: [],
  version: 1,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};

const resolvedCase = {
  ...adminCase,
  status: "resolved",
  ownerId: "operator-1",
  resolutionSummary: "Refund confirmed with the provider.",
  verification: { state: "passed", evidenceRefs: ["evidence-1"], verifiedAt: "2026-08-11T00:00:00.000Z", overrideReason: null },
  version: 4,
};

const resolvedDetail = {
  case: resolvedCase,
  evidence: [{
    id: "evidence-1",
    caseId: "case-1",
    source: { type: "message", id: "message-1" },
    evidenceType: "message",
    summary: "Customer reported a double charge.",
    occurredAt: "2026-08-11T00:00:00.000Z",
    access: "full",
  }],
  decisions: [{
    id: "decision-1",
    sourceType: "admin_case",
    sourceId: "case-1",
    releaseId: null,
    question: "Was the second charge a duplicate?",
    evidenceRefs: ["evidence-1"],
    evidenceLevel: "certified",
    decision: "actioned",
    confidence: null,
    ownerId: "operator-1",
    successCriteria: null,
    guardrails: null,
    reviewAt: null,
    outcome: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  }],
  activity: [{
    id: "audit-1",
    actorId: "operator-1",
    actorRole: "support",
    action: "case.decision.recorded",
    targetType: "admin_case",
    targetId: "case-1",
    reason: "Provider confirmed the duplicate charge.",
    before: null,
    after: null,
    requestId: null,
    ipHash: null,
    userAgent: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  }],
};

function listResponse(view: string) {
  return {
    items: [adminCase],
    pageInfo: { endCursor: null, hasNextPage: false },
    asOf: "2026-08-11T00:00:00.000Z",
    freshness: "live",
    query: {
      view,
      cursor: null,
      limit: 30,
      sort: "updated_desc",
    },
  };
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Cases workspace");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("CaseWorkspace browser URL interactions", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    adminV2Request.mockReset();
    adminV2Request.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/collaboration/case/case-1/activity?")) {
        return {
          items: [],
          actors: [],
          watching: false,
          watcherIds: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === "/api/v2/admin/cases/case-1") {
        return { case: adminCase, evidence: [], decisions: [], activity: [] };
      }
      const view = new URL(path, "http://admin.local").searchParams.get("view") ?? "mine";
      return listResponse(view);
    });
    window.history.replaceState(null, "", "/admin/cases?view=unassigned");
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("hydrates the URL view, changes queues, and opens a case without losing query state", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const browserWindow = window;
    vi.stubGlobal("window", undefined);
    const serverMarkup = renderToString(
      <CaseWorkspace canAssign={false} canDecide={false} />,
    );
    vi.unstubAllGlobals();
    expect(window).toBe(browserWindow);
    container.innerHTML = serverMarkup;

    await act(async () => {
      root = hydrateRoot(
        container,
        <CaseWorkspace canAssign={false} canDecide={false} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path.includes("/api/v2/admin/cases?")));
    expect(adminV2Request.mock.calls.find(([path]) => path.includes("/api/v2/admin/cases?"))?.[0]).toContain("view=unassigned");
    expect(findButton("unassigned")?.getAttribute("aria-pressed")).toBe("true");
    expect(window.location.search).toContain("view=unassigned");
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => findButton("overdue")?.click());
    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path.includes("view=overdue")));
    expect(findButton("overdue")?.getAttribute("aria-pressed")).toBe("true");
    expect(window.location.search).toContain("view=overdue");

    const caseRow = container.querySelector<HTMLButtonElement>('[aria-label="Case results"] > button');
    await act(async () => caseRow?.click());
    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path === "/api/v2/admin/cases/case-1"));
    expect(window.location.pathname).toBe("/admin/cases/case-1");
    expect(window.location.search).toContain("view=overdue");
    expect(container.querySelector("#case-detail-title")?.textContent).toBe("user-1");
  });

  function findButton(label: string) {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
  }
});

describe("CaseWorkspace decision loop", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    adminV2Request.mockReset();
    adminV2Request.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/collaboration/case/case-1/activity?")) {
        return { items: [], actors: [], watching: false, watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path === "/api/v2/admin/cases/case-1") return resolvedDetail;
      if (path.startsWith("/api/v2/admin/saved-views")) return { items: [] };
      return { ...listResponse("mine"), items: [resolvedCase] };
    });
    window.history.replaceState(null, "", "/admin/cases/case-1");
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    document.querySelectorAll('[role="dialog"]').forEach((node) => node.parentElement?.remove());
    vi.restoreAllMocks();
  });

  async function mount(permissions: { canAssign: boolean; canDecide: boolean }) {
    await act(async () => {
      root = hydrateRoot(container, <CaseWorkspace canAssign={permissions.canAssign} canDecide={permissions.canDecide} initialCaseId="case-1" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitUntil(() => container.querySelector("#case-detail-title") !== null);
  }

  it("renders the recorded decisions and audit trail that ship with the detail payload", async () => {
    await mount({ canAssign: true, canDecide: true });
    const panel = container.textContent ?? "";
    expect(panel).toContain("Recorded decisions");
    expect(panel).toContain("Was the second charge a duplicate?");
    expect(panel).toContain("Audit trail");
    expect(panel).toContain("case.decision.recorded");
    expect(panel).toContain("Provider confirmed the duplicate charge.");
  });

  // 回归：reason 输入框此前只在 canAssign 的「分配」表单里，而关闭按钮要求 reason≥3——
  // 只有 case.decide 的运营永远关不掉工单，界面上也没有任何解释。
  it("lets a decide-only operator reach the close confirmation without the assignment form", async () => {
    await mount({ canAssign: false, canDecide: true });
    expect(container.textContent).not.toContain("Save assignment");
    const close = [...container.querySelectorAll("button")].find((button) => button.textContent === "Close case");
    expect(close?.disabled).toBe(false);
    await act(async () => close?.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Close case");
    expect(dialog?.querySelector('input[aria-label="Type confirmation"]')).not.toBeNull();
    expect(dialog?.querySelector('input[aria-label="Reason (≥3)"]')).not.toBeNull();
    // 后果不再混在 summary 里当说明文字——它是敲确认串之前必须读到的那一条。
    expect(dialog?.textContent).toContain("This cannot be undone.");
    expect(dialog?.textContent).toContain("Closing is the end of this customer problem.");
  });

  // wait 是可逆的（有人恢复它就回来），不能跟 close 用同一句「不可撤销」吓运营。
  it("marks a reversible lifecycle command as reversible", async () => {
    await mount({ canAssign: true, canDecide: true });
    const reopen = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reopen / create recurrence");
    await act(async () => reopen?.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("This can be undone later.");
    expect(dialog?.textContent).not.toContain("This cannot be undone.");
  });

  // 回归：wait / reopen 端点要求 Idempotency-Key，此前客户端一个都没发，后端一律 400
  // 「Idempotency-Key header is required」——这两个按钮从上线起就没成功过一次。
  it("sends an idempotency key with every lifecycle command", async () => {
    await mount({ canAssign: true, canDecide: true });
    const wait = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reopen / create recurrence");
    await act(async () => wait?.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const reason = dialog.querySelector<HTMLInputElement>('input[aria-label="Reason (≥3)"]')!;
    const confirmation = dialog.querySelector<HTMLInputElement>('input[aria-label="Type confirmation"]')!;
    setReactValue(reason, "reopening for the regression test");
    setReactValue(confirmation, "case-1:reopen");
    await act(async () => {
      [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Reopen"))?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const command = adminV2Request.mock.calls.find(([path]) => path.endsWith("/commands/reopen"));
    expect(command?.[1]).toMatchObject({ method: "POST", idempotencyKey: expect.any(String) });
  });

  it("explains why closing is unavailable instead of showing a bare disabled button", async () => {
    adminV2Request.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/collaboration/case/case-1/activity?")) {
        return { items: [], actors: [], watching: false, watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path === "/api/v2/admin/cases/case-1") return { ...resolvedDetail, case: adminCase };
      if (path.startsWith("/api/v2/admin/saved-views")) return { items: [] };
      return listResponse("mine");
    });
    await mount({ canAssign: false, canDecide: true });
    expect(container.textContent).toContain("Close needs a recorded decision first");
  });
});
