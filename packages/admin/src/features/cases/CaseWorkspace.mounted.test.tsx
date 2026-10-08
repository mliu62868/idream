// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn<(path: string, init?: { method?: string; idempotencyKey?: string }) => Promise<unknown>>(),
}));

// React 覆盖了 value 的 setter，直接赋值不会触发 onChange —— 走原型上的原生 setter 才行。
function setReactValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});

import { CaseWorkspace } from "./CaseWorkspace";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { ToastProvider } from "@/components/admin/ui/Toast";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

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
    decision: "incident_escalated",
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns to the actual preceding cursor after paging past an unapplied filter draft", async () => {
    adminV2Request.mockImplementation(async (path) => {
      if (!path.startsWith("/api/v2/admin/cases?")) return { items: [] };
      const params = new URL(path, "http://admin.local").searchParams;
      const cursor = params.get("cursor");
      const number = cursor === "after-page-2" ? 3 : cursor === "after-page-1" ? 2 : 1;
      return {
        ...listResponse("unassigned"),
        items: [{ ...adminCase, id: `case-page-${number}`, target: { type: "user", id: `user-page-${number}` } }],
        pageInfo: { endCursor: number === 1 ? "after-page-1" : number === 2 ? "after-page-2" : null, hasNextPage: number < 3 },
      };
    });
    root = createRoot(container);
    await act(async () => root!.render(<CaseWorkspace canAssign={false} canDecide={false} />));
    await waitUntil(() => container.textContent?.includes("user-page-1") === true);
    await act(async () => findButton("Next page")!.click());
    await waitUntil(() => container.textContent?.includes("user-page-2") === true);
    await act(async () => setReactValue(container.querySelector<HTMLInputElement>('[placeholder="Search all cases"]')!, "unapplied search"));
    await act(async () => findButton("Next page")!.click());
    await waitUntil(() => container.textContent?.includes("user-page-3") === true);
    const thirdRead = adminV2Request.mock.calls.filter(([path]) => path.startsWith("/api/v2/admin/cases?")).at(-1)![0];
    expect(new URL(thirdRead, "http://admin.local").searchParams.get("search")).toBeNull();
    await act(async () => findButton("Previous page")!.click());
    const previousRead = adminV2Request.mock.calls.filter(([path]) => path.startsWith("/api/v2/admin/cases?")).at(-1)![0];
    expect(new URL(previousRead, "http://admin.local").searchParams.get("cursor")).toBe("after-page-1");
    expect(container.textContent).toContain("user-page-2");
    expect(container.querySelector('[data-testid="admin-pagination"]')?.textContent).toContain("Page 2");
  });

  it.each(["mount", "history"] as const)("keeps restored Case cursor positions unknown through next and previous after %s", async (entry) => {
    adminV2Request.mockImplementation(async (path) => {
      if (!path.startsWith("/api/v2/admin/cases?")) return { items: [] };
      const params = new URL(path, "http://admin.local").searchParams;
      const cursor = params.get("cursor");
      return {
        ...listResponse("unassigned"),
        items: [{ ...adminCase, target: { type: "user", id: cursor === "restored-next" ? "next-case-user" : cursor ? "restored-case-user" : "first-case-user" } }],
        pageInfo: { endCursor: cursor === "restored-next" ? null : "restored-next", hasNextPage: cursor !== "restored-next" },
      };
    });
    const restoredUrl = "/admin/cases?view=unassigned&search=linked&cursor=restored-page";
    window.history.replaceState(null, "", entry === "mount" ? restoredUrl : "/admin/cases?view=unassigned&search=linked");
    root = createRoot(container);
    await act(async () => root!.render(<CaseWorkspace canAssign={false} canDecide={false} />));
    await waitUntil(() => container.textContent?.includes(entry === "mount" ? "restored-case-user" : "first-case-user") === true);
    if (entry === "history") {
      await act(async () => findButton("Next page")!.click());
      await waitUntil(() => container.textContent?.includes("next-case-user") === true);
      expect(container.querySelector('[data-testid="admin-pagination"]')?.textContent).toContain("Page 2");
      await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
      expect(container.querySelector('[data-testid="admin-pagination"]')?.textContent).toContain("Page 2");
      await act(async () => {
        window.history.replaceState(null, "", restoredUrl);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await waitUntil(() => container.textContent?.includes("restored-case-user") === true);
    }
    const pagination = () => container.querySelector('[data-testid="admin-pagination"]')!;
    expect(pagination().textContent).toContain("Page position unknown");
    expect(pagination().textContent).not.toContain("Page 1");
    expect(findButton("Back to first page")?.disabled).toBe(false);
    await act(async () => findButton("Next page")!.click());
    await waitUntil(() => container.textContent?.includes("next-case-user") === true);
    expect(pagination().textContent).toContain("Page position unknown");
    await act(async () => findButton("Previous page")!.click());
    await waitUntil(() => container.textContent?.includes("restored-case-user") === true);
    expect(pagination().textContent).toContain("Page position unknown");
    await act(async () => findButton("Back to first page")!.click());
    await waitUntil(() => container.textContent?.includes("first-case-user") === true);
    const firstRead = adminV2Request.mock.calls.filter(([path]) => path.startsWith("/api/v2/admin/cases?")).at(-1)![0];
    const firstParams = new URL(firstRead, "http://admin.local").searchParams;
    expect(firstParams.has("cursor")).toBe(false);
    expect(firstParams.get("search")).toBe("linked");
    expect(pagination().textContent).toContain("Page 1");
    expect(findButton("Previous page")?.disabled).toBe(true);
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

  // SPEC: 视图为空要说清空的是哪个范围，并把运营送到下一个真有活的范围。
  // INVARIANT: 「我的」空着时通用的"队列已清空"是假的——工作可能只是还没人认领。
  it("sends an operator from an empty mine queue to the unassigned queue", async () => {
    adminV2Request.mockImplementation(async (path) => {
      if (path.includes("/api/v2/admin/cases?")) {
        const view = new URL(path, "http://admin.local").searchParams.get("view") ?? "mine";
        return view === "mine" ? { ...listResponse("mine"), items: [] } : listResponse(view);
      }
      return listResponse("mine");
    });
    window.history.replaceState(null, "", "/admin/cases?view=mine");
    container.innerHTML = renderToString(<CaseWorkspace canAssign={false} canDecide={false} />);

    await act(async () => {
      root = hydrateRoot(container, <CaseWorkspace canAssign={false} canDecide={false} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitUntil(() => container.textContent?.includes("This queue view is empty") ?? false);
    expect(container.textContent).not.toContain("The queue is clear");

    const openUnassigned = findButton("Open unassigned");
    expect(openUnassigned).toBeTruthy();
    await act(async () => openUnassigned?.click());
    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path.includes("view=unassigned")));
    expect(findButton("unassigned")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).not.toContain("This queue view is empty");
  });

  // SPEC: Today / search / audit links may open a Case that is outside the operator's current queue.
  // INVARIANT: the detail remains visible even when the default `mine` list is empty.
  it("keeps a deep-linked case visible when the current queue is empty", async () => {
    adminV2Request.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/collaboration/case/case-1/activity?")) {
        return { items: [], actors: [], watching: false, watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path === "/api/v2/admin/cases/case-1") {
        return { case: adminCase, evidence: [], decisions: [], activity: [] };
      }
      return { ...listResponse("mine"), items: [] };
    });
    window.history.replaceState(null, "", "/admin/cases/case-1");
    container.innerHTML = renderToString(
      <CaseWorkspace canAssign={false} canDecide={false} initialCaseId="case-1" />,
    );

    await act(async () => {
      root = hydrateRoot(
        container,
        <CaseWorkspace canAssign={false} canDecide={false} initialCaseId="case-1" />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path === "/api/v2/admin/cases/case-1"));
    await waitUntil(() => container.querySelector("#case-detail-title") !== null);
    const inspector = container.querySelector<HTMLElement>('[aria-labelledby="case-detail-title"]');
    const results = container.querySelector<HTMLElement>('[aria-label="Case results"]');
    expect(inspector?.textContent).toContain("user-1");
    expect(inspector?.className).toContain("lg:sticky");
    expect(inspector?.parentElement?.parentElement?.className).toContain("lg:grid-cols");
    expect(inspector?.parentElement?.nextElementSibling).toBe(results);
    expect(results?.className).toContain("lg:order-first");

    const tabletToggle = [...container.querySelectorAll("button")].find(
      (button) => button.className.includes("lg:hidden") && button.textContent === "Case results",
    );
    expect(tabletToggle?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => tabletToggle?.click());
    expect(tabletToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(inspector?.parentElement?.className).toContain("md:hidden lg:block");
  });

  it("translates disclosed filters and distinguishes drafts from applied conditions", async () => {
    const workspace = <AdminI18nProvider locale="zh"><CaseWorkspace canAssign={false} canDecide={false} /></AdminI18nProvider>;
    container.innerHTML = renderToString(workspace);
    await act(async () => { root = hydrateRoot(container, workspace); });
    await waitUntil(() => Boolean(findButton("应用") && !findButton("应用")!.disabled));

    expect(container.querySelector('select[aria-label="类型"]')).toBeNull();
    await act(async () => findButton("筛选")!.click());
    const html = container.innerHTML;
    for (const translated of ["内容举报", "账务争议", "未分配", "最近已解决", "最近更新在前"]) {
      expect(html).toContain(translated);
    }
    for (const leaked of ["content report", "recently resolved", "updated_desc<"]) {
      expect(html).not.toContain(leaked);
    }

    const type = container.querySelector<HTMLSelectElement>('select[aria-label="类型"]')!;
    const requestsBeforeDraft = adminV2Request.mock.calls.length;
    await act(async () => { type.value = "appeal"; type.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(adminV2Request.mock.calls).toHaveLength(requestsBeforeDraft);
    expect(container.querySelector('button[aria-label="清除筛选：类型"]')).toBeNull();

    await act(async () => findButton("应用")!.click());
    await waitUntil(() => container.querySelector('button[aria-label="清除筛选：类型"]') !== null);
    expect(adminV2Request.mock.calls.some(([path]) => path.includes("type=appeal") && path.includes("view=unassigned"))).toBe(true);
    const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded="true"][aria-controls]')!;
    await act(async () => disclosure.click());
    expect(container.querySelector('select[aria-label="类型"]')).toBeNull();
    const clear = container.querySelector<HTMLButtonElement>('button[aria-label="清除筛选：类型"]')!;
    await act(async () => clear.click());
    await waitUntil(() => container.querySelector('button[aria-label="清除筛选：类型"]') === null);
    const lastListRequest = adminV2Request.mock.calls.filter(([path]) => path.startsWith("/api/v2/admin/cases?" )).at(-1)![0];
    expect(lastListRequest).toContain("view=unassigned");
    expect(lastListRequest).not.toContain("type=appeal");
  });

  it("marks a failed queue read as a stale snapshot and retries the current view", async () => {
    let failing = false;
    let listReads = 0;
    adminV2Request.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/saved-views")) return { items: [] };
      const view = new URL(path, "http://admin.local").searchParams.get("view") ?? "mine";
      listReads += 1;
      if (failing) throw new TypeError("Queue connection lost");
      return { ...listResponse(view), pageInfo: { endCursor: "next-page", hasNextPage: true } };
    });
    const workspace = <CaseWorkspace canAssign={false} canDecide={false} />;
    container.innerHTML = renderToString(workspace);
    await act(async () => { root = hydrateRoot(container, workspace); });
    await waitUntil(() => container.querySelector('[aria-label="Case results"] > button') !== null);
    failing = true;
    await act(async () => findButton("overdue")!.click());
    await waitUntil(() => listReads === 2 && !findButton("Apply")!.disabled);
    const results = container.querySelector('[aria-label="Case results"]')!;
    const error = results.querySelector('[role="alert"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain("Showing the last successful snapshot from");
    expect(error?.querySelector("time")?.dateTime).toBe("2026-08-11T00:00:00.000Z");
    expect(findButton("Next page")!.disabled).toBe(true);
    failing = false;
    await act(async () => [...error!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry")!.click());
    await waitUntil(() => listReads === 3 && results.querySelector('[role="alert"]') === null);
    expect(adminV2Request.mock.calls.at(-1)?.[0]).toContain("view=overdue");
    expect(findButton("Next page")!.disabled).toBe(false);
    expect(window.location.search).toContain("view=overdue");
  });

  it("keeps a failed case detail actionable through an inline retry", async () => {
    let failing = true;
    let detailReads = 0;
    adminV2Request.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/saved-views")) return { items: [] };
      if (path.startsWith("/api/v2/admin/collaboration/")) return { items: [], actors: [], watching: false, watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false } };
      if (path === "/api/v2/admin/cases/case-1") {
        detailReads += 1;
        if (failing) throw new TypeError("Detail connection lost");
        return { case: adminCase, evidence: [], decisions: [], activity: [] };
      }
      return listResponse("overdue");
    });
    window.history.replaceState(null, "", "/admin/cases/case-1?view=overdue");
    const workspace = <CaseWorkspace canAssign={false} canDecide={false} initialCaseId="case-1" />;
    container.innerHTML = renderToString(workspace);
    await act(async () => { root = hydrateRoot(container, workspace); });
    await waitUntil(() => detailReads === 1 && !container.textContent?.includes("Loading case detail"));
    const error = container.querySelector('[role="alert"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain("Retry to load the latest data.");
    failing = false;
    await act(async () => [...error!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry")!.click());
    await waitUntil(() => container.querySelector("#case-detail-title") !== null);
    expect(detailReads).toBe(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(window.location.pathname + window.location.search).toBe("/admin/cases/case-1?view=overdue");
  });

  it("dates a retained detail snapshot by its successful read, not the record's last edit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const firstRead = "2026-10-02T07:00:00.000Z";
    const nextRead = "2026-10-02T07:04:00.000Z";
    vi.setSystemTime(firstRead);
    const originalRequest = adminV2Request.getMockImplementation()!;
    let failing = false;
    adminV2Request.mockImplementation(async (path, init) => {
      if (path === "/api/v2/admin/cases/case-1" && failing) throw new TypeError("Detail connection lost");
      return originalRequest(path, init);
    });
    window.history.replaceState(null, "", "/admin/cases/case-1");
    const workspace = <CaseWorkspace canAssign={false} canDecide={false} initialCaseId="case-1" />;
    container.innerHTML = renderToString(workspace);
    await act(async () => { root = hydrateRoot(container, workspace); });
    await waitUntil(() => container.querySelector("#case-detail-title") !== null);

    failing = true;
    vi.setSystemTime("2026-10-02T07:02:00.000Z");
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);
    const snapshotTime = () => container.querySelector<HTMLTimeElement>('[role="alert"] time')?.dateTime;
    expect(snapshotTime()).toBe(firstRead);

    vi.setSystemTime("2026-10-02T07:03:00.000Z");
    await act(async () => findButton("Retry")!.click());
    expect(snapshotTime()).toBe(firstRead);

    failing = false;
    vi.setSystemTime(nextRead);
    await act(async () => findButton("Retry")!.click());
    await waitUntil(() => container.querySelector('[role="alert"]') === null);
    failing = true;
    vi.setSystemTime("2026-10-02T07:05:00.000Z");
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);
    expect(snapshotTime()).toBe(nextRead);
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

  async function mount(permissions: { canAssign: boolean; canDecide: boolean; actorId?: string }, locale: "en" | "zh" = "en") {
    const workspace = <AdminI18nProvider locale={locale}><ToastProvider><CaseWorkspace actorId={permissions.actorId} canAssign={permissions.canAssign} canDecide={permissions.canDecide} initialCaseId="case-1" /></ToastProvider></AdminI18nProvider>;
    container.innerHTML = renderToString(workspace);
    await act(async () => {
      root = hydrateRoot(container, workspace);
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

  it("selects readable evidence and sends the selected authority IDs", async () => {
    const read = adminV2Request.getMockImplementation()!;
    adminV2Request.mockImplementation(async (path, options) => path === "/api/v2/admin/cases/case-1"
      ? { ...resolvedDetail, case: { ...resolvedCase, status: "in_progress" } }
      : read(path, options));
    await mount({ canAssign: false, canDecide: true });
    expect(container.textContent).not.toContain("Evidence IDs (comma separated)");
    const evidence = container.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!;
    expect(evidence.checked).toBe(true);
    expect(evidence.closest("label")?.textContent).toContain("Customer reported a double charge.");
    const verify = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Verify from authority")!;
    await act(async () => evidence.click());
    expect(verify().disabled).toBe(true);
    await act(async () => evidence.click());
    await act(async () => verify().click());
    expect(adminV2Request).toHaveBeenCalledWith("/api/v2/admin/cases/case-1/verification", expect.objectContaining({ body: { entityVersion: 4, state: "passed", evidenceRefs: ["evidence-1"] } }));
    expect(container.querySelector("#case-evidence-title")?.closest("section")?.querySelector("details")?.open).toBe(false);
  });

  it.each([
    ["closed", "incident_escalated"],
    ["resolved", "incident_escalated"],
    ["closed", "account_guidance_provided"],
    ["resolved", "account_guidance_provided"],
  ])("blocks passed/overridden verification of a %s Case after filling the %s note", async (status, action) => {
    const read = adminV2Request.getMockImplementation()!;
    adminV2Request.mockImplementation(async (path, options) => path === "/api/v2/admin/cases/case-1"
      ? { ...resolvedDetail, case: { ...resolvedCase, status }, decisions: [{ ...resolvedDetail.decisions[0], decision: action }] }
      : read(path, options));
    await mount({ canAssign: false, canDecide: true });
    const note = [...container.querySelectorAll("label")].find(label => label.textContent?.startsWith("Override reason") || label.textContent?.startsWith("Attestation note"))!.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => setReactValue(note, "Controlled operator attestation after closure"));
    const manual = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => ["Attest outcome", "Override verification"].includes(button.textContent ?? ""))!;
    const authority = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Verify from authority");
    expect(manual.disabled).toBe(true);
    if (action === "incident_escalated") expect(authority?.disabled).toBe(true);
    await act(async () => { manual.click(); authority?.click(); });
    expect(adminV2Request.mock.calls.some(([path]) => path.endsWith("/verification"))).toBe(false);
    expect(note.disabled).toBe(true);
  });

  it("keeps in-progress attestation available with the operator note and selected evidence", async () => {
    const read = adminV2Request.getMockImplementation()!;
    adminV2Request.mockImplementation(async (path, options) => path === "/api/v2/admin/cases/case-1"
      ? { ...resolvedDetail, case: { ...resolvedCase, status: "in_progress" }, decisions: [{ ...resolvedDetail.decisions[0], decision: "account_guidance_provided" }] }
      : read(path, options));
    await mount({ canAssign: false, canDecide: true });
    const note = [...container.querySelectorAll("label")].find(label => label.textContent?.startsWith("Attestation note"))!.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(note.disabled).toBe(false);
    await act(async () => setReactValue(note, "Personally checked the controlled account guidance"));
    const attest = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Attest outcome")!;
    expect(attest.disabled).toBe(false);
    await act(async () => attest.click());
    expect(adminV2Request).toHaveBeenCalledWith("/api/v2/admin/cases/case-1/verification", expect.objectContaining({
      body: { entityVersion: 4, state: "overridden", evidenceRefs: ["evidence-1"], overrideReason: "Personally checked the controlled account guidance" },
    }));
  });

  it("offers attestation instead of a doomed authority check for actions without a verifier", async () => {
    const read = adminV2Request.getMockImplementation()!;
    adminV2Request.mockImplementation(async (path, options) => path === "/api/v2/admin/cases/case-1"
      ? { ...resolvedDetail, decisions: [{ ...resolvedDetail.decisions[0], decision: "account_guidance_provided" }] }
      : read(path, options));
    await mount({ canAssign: false, canDecide: true });
    const buttons = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).not.toContain("Verify from authority");
    expect(buttons).toContain("Attest outcome");
    // The default Support action (diagnostic_reviewed) has no verifier, so no outcome reference is asked for.
    expect(container.textContent).not.toContain("Outcome reference");
  });

  it("sends a stable assignment key when retrying a lost response", async () => {
    const read = adminV2Request.getMockImplementation()!;
    let assignmentWrites = 0;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.endsWith("/assignment")) {
        assignmentWrites += 1;
        if (assignmentWrites === 1) throw new TypeError("Assignment response lost");
        return { caseId: "case-1", version: 5 };
      }
      if (path === "/api/v2/admin/cases/case-1") return { ...resolvedDetail, case: { ...resolvedCase, status: "in_progress" } };
      return read(path, options);
    });
    await mount({ canAssign: true, canDecide: false });
    const reason = [...container.querySelectorAll("label")]
      .find((label) => label.textContent === "Audit reason")!
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => setReactValue(reason, "Assign follow-up owner"));
    const save = () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Save assignment")!;
    await act(async () => save().click());
    await waitUntil(() => assignmentWrites === 1 && !save().disabled);
    await act(async () => save().click());
    await waitUntil(() => assignmentWrites === 2 && !save().disabled);
    const requests = adminV2Request.mock.calls.filter(([path]) => path.endsWith("/assignment"));
    expect(requests[0]?.[1]).toMatchObject({ method: "POST", idempotencyKey: expect.any(String) });
    expect(requests[1]?.[1]).toEqual(requests[0]?.[1]);
  });

  it("assigns the case to the signed-in operator in one click and links a ticket to its customer reply", async () => {
    const read = adminV2Request.getMockImplementation()!;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.endsWith("/assignment")) return { caseId: "case-1", version: 5 };
      if (path === "/api/v2/admin/cases/case-1") return { ...resolvedDetail, case: { ...resolvedCase, status: "in_progress", ownerId: null, caseKey: "ticket:SUP-TEST123" } };
      return read(path, options);
    });
    await mount({ canAssign: true, canDecide: false, actorId: "operator-7" });
    const reply = [...container.querySelectorAll("a")].find((link) => link.textContent === "Reply to customer");
    expect(reply?.getAttribute("href")).toBe("/admin/support?ticket=SUP-TEST123");
    const assign = [...container.querySelectorAll("button")].find((button) => button.textContent === "Assign to me")!;
    await act(async () => assign.click());
    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path.endsWith("/assignment")));
    const [, options] = adminV2Request.mock.calls.find(([path]) => path.endsWith("/assignment"))!;
    expect(options).toMatchObject({ method: "POST", body: expect.objectContaining({ ownerId: "operator-7" }) });
  });

  it("distinguishes a saved assignment from a failed refresh and recovers without another write", async () => {
    const read = adminV2Request.getMockImplementation()!;
    let saved = false;
    let failing = true;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.endsWith("/assignment")) { saved = true; return { caseId: "case-1", version: 5 }; }
      if (path === "/api/v2/admin/cases/case-1") {
        if (saved && failing) throw new TypeError("Detail refresh connection lost");
        return { ...resolvedDetail, case: { ...resolvedCase, status: "in_progress", ownerId: saved ? "operator-7" : null, version: saved ? 5 : 4 } };
      }
      return read(path, options);
    });
    await mount({ canAssign: true, canDecide: false, actorId: "operator-7" });
    const assign = [...container.querySelectorAll("button")].find((button) => button.textContent === "Assign to me")!;
    await act(async () => assign.click());
    await waitUntil(() => [...document.querySelectorAll('[data-testid="admin-action-status"]')].some((node) => node.textContent?.includes("Case assigned to you")));
    const result = [...document.querySelectorAll('[data-testid="admin-action-status"]')].find((node) => node.textContent?.includes("Case assigned to you"))!;
    expect(result.getAttribute("data-tone")).toBe("info");
    expect(result.textContent).toContain("The latest data could not be loaded.");
    expect(document.querySelector('[data-testid="admin-action-status"][data-tone="success"]')).toBeNull();
    const error = container.querySelector('[role="alert"]');
    expect(error).not.toBeNull();
    expect(assign.disabled).toBe(true);
    failing = false;
    await act(async () => [...error!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry")!.click());
    await waitUntil(() => container.querySelector('[role="alert"]') === null);
    expect(container.querySelector("#case-summary-title")?.parentElement?.textContent).toContain("You");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Assign to me")).toBe(false);
    expect(adminV2Request.mock.calls.filter(([path]) => path.endsWith("/assignment"))).toHaveLength(1);
  });

  it.each([false, true])("keeps Support navigation when a Case assignment finishes late (unmounted: %s)", async (unmountBeforeCompletion) => {
    const read = adminV2Request.getMockImplementation()!;
    let resolveAssignment!: (result: unknown) => void;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.endsWith("/assignment")) return new Promise((resolve) => { resolveAssignment = resolve; });
      if (path === "/api/v2/admin/cases/case-1") return { ...resolvedDetail, case: { ...resolvedCase, status: "in_progress", ownerId: null, caseKey: "ticket:SUP-TEST123" } };
      return read(path, options);
    });
    await mount({ canAssign: true, canDecide: false, actorId: "operator-7" });
    const assign = [...container.querySelectorAll("button")].find((button) => button.textContent === "Assign to me")!;
    const reply = [...container.querySelectorAll("a")].find((link) => link.textContent === "Reply to customer")!;
    await act(async () => assign.click());
    await waitUntil(() => Boolean(resolveAssignment));
    window.history.pushState(null, "", reply.getAttribute("href"));
    if (unmountBeforeCompletion) {
      await act(async () => root?.unmount());
      root = null;
    }
    const readsBeforeCompletion = adminV2Request.mock.calls.length;
    await act(async () => resolveAssignment({ caseId: "case-1", version: 5 }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(window.location.pathname + window.location.search).toBe("/admin/support?ticket=SUP-TEST123");
    expect(adminV2Request.mock.calls).toHaveLength(readsBeforeCompletion);
  });

  it("does not rewrite browser history while Reply navigation is still pending", async () => {
    const read = adminV2Request.getMockImplementation()!;
    let resolveAssignment!: (result: unknown) => void;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.endsWith("/assignment")) return new Promise((resolve) => { resolveAssignment = resolve; });
      if (path === "/api/v2/admin/cases/case-1") return { ...resolvedDetail, case: { ...resolvedCase, status: "in_progress", ownerId: null, caseKey: "ticket:SUP-TEST123" } };
      return read(path, options);
    });
    await mount({ canAssign: true, canDecide: false, actorId: "operator-7" });
    const assign = [...container.querySelectorAll("button")].find((button) => button.textContent === "Assign to me")!;
    await act(async () => assign.click());
    await waitUntil(() => Boolean(resolveAssignment));
    const reply = [...container.querySelectorAll("a")].find((link) => link.textContent === "Reply to customer")!;
    // Next keeps the old pathname until the destination RSC payload commits.
    reply.addEventListener("click", (event) => event.preventDefault());
    await act(async () => reply.click());
    const replace = vi.spyOn(window.history, "replaceState");
    const push = vi.spyOn(window.history, "pushState");
    const readsBeforeCompletion = adminV2Request.mock.calls.length;
    await act(async () => resolveAssignment({ caseId: "case-1", version: 5 }));
    await waitUntil(() => !assign.disabled);
    expect(adminV2Request.mock.calls.length).toBeGreaterThan(readsBeforeCompletion);
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("names another operator's ownership by display name rather than user ID", async () => {
    const read = adminV2Request.getMockImplementation()!;
    adminV2Request.mockImplementation(async (path, options) => path === "/api/v2/admin/cases/case-1"
      ? { ...resolvedDetail, case: { ...resolvedCase, status: "in_progress", ownerId: "cmowner000000000000000001", ownerName: "Dana Support" } }
      : read(path, options));
    await mount({ canAssign: false, canDecide: false, actorId: "operator-7" });
    await waitUntil(() => container.querySelector("#case-summary-title") !== null);
    const summary = container.querySelector("#case-summary-title")!.parentElement!;
    expect(summary.textContent).toContain("Dana Support");
    expect(summary.textContent).not.toContain("cmowner000000000000000001");
  });

  it.each(["resolved", "closed"])("requires reopening a %s case before assigning it", async (status) => {
    const read = adminV2Request.getMockImplementation()!;
    adminV2Request.mockImplementation(async (path, options) => path === "/api/v2/admin/cases/case-1"
      ? { ...resolvedDetail, case: { ...resolvedCase, status } }
      : read(path, options));
    await mount({ canAssign: true, canDecide: true });
    const reason = [...container.querySelectorAll("label")].find((label) => label.textContent === "Audit reason")!.querySelector<HTMLInputElement>("input")!;
    await act(async () => setReactValue(reason, "Assign follow-up owner"));
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save assignment")!;
    expect(save.disabled).toBe(true);
    expect(container.textContent).toContain("Reopen this case before changing its assignment.");
    const reopen = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reopen / create recurrence")!;
    expect(reopen.disabled).toBe(false);
    await act(async () => save.click());
    expect(adminV2Request.mock.calls.some(([path]) => path.endsWith("/assignment"))).toBe(false);
  });

  it.each([
    ["support_request", "closed"],
    ["billing_dispute", "closed"],
    ["content_report", "closed"],
    ["appeal", "closed"],
    ["content_report", "resolved"],
    ["appeal", "resolved"],
  ])("requires reopening a %s / %s before recording another action on desktop or mobile", async (type, status) => {
    const read = adminV2Request.getMockImplementation()!;
    adminV2Request.mockImplementation(async (path, options) => path === "/api/v2/admin/cases/case-1"
      ? { ...resolvedDetail, case: { ...resolvedCase, type, status } }
      : read(path, options));
    await mount({ canAssign: true, canDecide: true });
    const outcome = [...container.querySelectorAll("label")].find(label => label.textContent === "Outcome reference")?.querySelector<HTMLInputElement>("input");
    if (outcome) await act(async () => setReactValue(outcome, "ledger:controlled-evidence"));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-case-mobile-step="decision"]')!.click());
    const label = ["support_request", "billing_dispute"].includes(type) ? "Record action" : "Record decision";
    const recordButtons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent === label);
    expect(recordButtons).toHaveLength(2);
    expect(recordButtons.every(button => button.disabled)).toBe(true);
    await act(async () => recordButtons.forEach(button => button.click()));
    expect(adminV2Request.mock.calls.some(([path]) => path.endsWith("/actions") || path.endsWith("/decisions"))).toBe(false);
    expect(container.querySelector("#case-decision-title")?.closest("section")?.textContent).toContain("Reopen this case");
    expect(container.querySelector<HTMLTextAreaElement>('textarea')).not.toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Reopen / create recurrence")?.disabled).toBe(false);
    // Closed cases still permit private collaboration, independent of decisions.
    expect(container.textContent).toContain("Comment");
  });

  it.each(["support_request", "billing_dispute"])("preserves the authority's resolved %s action path", async type => {
    const read = adminV2Request.getMockImplementation()!;
    adminV2Request.mockImplementation(async (path, options) => path === "/api/v2/admin/cases/case-1"
      ? { ...resolvedDetail, case: { ...resolvedCase, type, status: "resolved" } }
      : read(path, options));
    await mount({ canAssign: false, canDecide: true });
    const outcome = [...container.querySelectorAll("label")].find(label => label.textContent === "Outcome reference")?.querySelector<HTMLInputElement>("input");
    if (outcome) await act(async () => setReactValue(outcome, "ledger:controlled-evidence"));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-case-mobile-step="decision"]')!.click());
    const records = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent === "Record action");
    expect(records).toHaveLength(2);
    expect(records.every(button => !button.disabled)).toBe(true);
    await act(async () => records[0]!.click());
    expect(adminV2Request.mock.calls.some(([path]) => path === "/api/v2/admin/cases/case-1/actions")).toBe(true);
  });

  it("refreshes the selected Case and current queue from the shell without resetting a pending write", async () => {
    const read = adminV2Request.getMockImplementation()!;
    let releaseAssignment!: () => void;
    let version = 4;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.endsWith("/assignment")) return new Promise<void>((resolve) => { releaseAssignment = resolve; });
      if (path === "/api/v2/admin/cases/case-1") return { ...resolvedDetail, case: { ...resolvedCase, status: "in_progress", version, resolutionSummary: `Verified state ${version}` } };
      return read(path, options);
    });
    await mount({ canAssign: true, canDecide: false });
    const reason = [...container.querySelectorAll("label")].find((label) => label.textContent === "Audit reason")!.querySelector<HTMLInputElement>("input")!;
    await act(async () => setReactValue(reason, "Assign follow-up owner"));
    const save = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Save assignment")!;
    await act(async () => save().click());
    await waitUntil(() => Boolean(releaseAssignment));
    expect(save().disabled).toBe(true);
    adminV2Request.mockClear();
    version = 5;
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    await waitUntil(() => container.textContent?.includes("Verified state 5") ?? false);
    expect(adminV2Request.mock.calls.some(([path]) => path.startsWith("/api/v2/admin/cases?"))).toBe(true);
    expect(adminV2Request.mock.calls.some(([path]) => path === "/api/v2/admin/cases/case-1")).toBe(true);
    expect(window.location.pathname).toBe("/admin/cases/case-1");
    expect(save().disabled).toBe(true);
    expect(reason.value).toBe("Assign follow-up owner");
    await act(async () => releaseAssignment());
    await waitUntil(() => !save().disabled);
  });

  it("exposes mobile Summary, Evidence, and Decision steps with a bottom action bar", async () => {
    await mount({ canAssign: true, canDecide: true });
    const summary = container.querySelector<HTMLElement>('[data-case-step="summary"]');
    const evidence = container.querySelector<HTMLElement>('[data-case-step="evidence"]');
    const decision = container.querySelector<HTMLElement>('[data-case-step="decision"]');
    const evidenceTab = container.querySelector<HTMLButtonElement>('[data-case-mobile-step="evidence"]');
    const decisionTab = container.querySelector<HTMLButtonElement>('[data-case-mobile-step="decision"]');

    expect(summary?.className).not.toContain("max-md:hidden");
    expect(evidence?.className).toContain("max-md:hidden");
    expect(container.querySelector('[data-case-mobile-actions]')?.className).toContain("md:hidden");
    await act(async () => evidenceTab?.click());
    expect(summary?.className).toContain("max-md:hidden");
    expect(evidence?.className).not.toContain("max-md:hidden");
    await act(async () => decisionTab?.click());
    expect(decision?.className).not.toContain("max-md:hidden");
    expect(container.querySelector('[data-case-mobile-actions]')?.textContent).toContain("Record action");
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

  it.each([
    { locale: "en", status: "in_progress", state: "pending", action: "diagnostic_reviewed", expected: "Attest the recorded outcome manually before closing this case." },
    { locale: "zh", status: "in_progress", state: "pending", action: "diagnostic_reviewed", expected: "关闭前，请先对已记录的处理结果进行人工自证。" },
    { locale: "en", status: "in_progress", state: "pending", action: "incident_escalated", expected: "Close needs downstream verification to pass or be explicitly overridden first." },
    { locale: "zh", status: "in_progress", state: "pending", action: "incident_escalated", expected: "关闭前需要下游验证通过，或被显式覆盖。" },
    { locale: "en", status: "closed", state: "overridden", action: "diagnostic_reviewed", expected: "This case is already closed. Reopen it to continue work." },
    { locale: "zh", status: "closed", state: "overridden", action: "diagnostic_reviewed", expected: "该工单已关闭。如需继续处理，请重新打开。" },
  ] as const)("explains the actual close blocker for $action/$status in $locale", async ({ locale, status, state, action, expected }) => {
    const read = adminV2Request.getMockImplementation()!;
    adminV2Request.mockImplementation(async (path, options) => path === "/api/v2/admin/cases/case-1"
      ? {
          ...resolvedDetail,
          case: {
            ...resolvedCase,
            status,
            verification: { ...resolvedCase.verification, state },
          },
          decisions: [{ ...resolvedDetail.decisions[0]!, decision: action }],
        }
      : read(path, options));
    await mount({ canAssign: false, canDecide: true }, locale);
    const closeLabel = locale === "zh" ? "关闭工单" : "Close case";
    const close = [...container.querySelectorAll("button")].find((button) => button.textContent === closeLabel);
    expect(close?.disabled).toBe(true);
    expect(close?.parentElement?.parentElement?.textContent).toContain(expected);
    expect(container.textContent).not.toContain(locale === "zh" ? "需要先记录决策" : "needs a recorded decision first");
    expect(adminV2Request.mock.calls.filter(([, options]) => options?.method === "POST")).toEqual([]);
  });

  it("explains why closing is unavailable instead of showing a bare disabled button", async () => {
    adminV2Request.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/collaboration/case/case-1/activity?")) {
        return { items: [], actors: [], watching: false, watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path === "/api/v2/admin/cases/case-1") return { ...resolvedDetail, case: adminCase, decisions: [] };
      if (path.startsWith("/api/v2/admin/saved-views")) return { items: [] };
      return listResponse("mine");
    });
    await mount({ canAssign: false, canDecide: true });
    expect(container.textContent).toContain("Close needs a recorded decision first");
  });
});
