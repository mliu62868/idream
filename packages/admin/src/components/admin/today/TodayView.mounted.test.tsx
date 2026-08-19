// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({ adminV2Request: vi.fn() }));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});
vi.mock("@/components/admin/i18n", () => {
  const interpolate = (text: string, values?: Readonly<Record<string, string | number>>) =>
    Object.entries(values ?? {}).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), text);
  return {
    adminDateLocale: () => undefined,
    translateAdmin: (_locale: string, key: string, values?: Readonly<Record<string, string | number>>) => interpolate(key, values),
    useAdminI18n: () => ({ locale: "en" as const, t: interpolate, value: (key: string) => key }),
  };
});

import { ToastProvider } from "@/components/admin/ui/Toast";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { TodayView, type TodayData, type TodayLegacyData } from "./TodayView";

const legacy: TodayLegacyData = {
  metrics: {
    users: { active: 9, suspended: 1 },
    generation: { queued: 2, failed: 3, blocked: 1, successRate: 75 },
    moderation: { openReports: 5 },
    billing: { activeSubscriptions: 4 },
  },
  featureFlags: [],
};

const claimable = (sourceId: string) => ({
  sourceType: "admin_case" as const,
  sourceId,
  sourceStatus: "waiting" as const,
  title: `case ${sourceId}`,
  summary: `customer ${sourceId} is waiting`,
  severity: "critical" as const,
  priority: "urgent" as const,
  impactSnapshot: {},
  ownerId: null,
  slaDueAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  recommendedAction: "Review and advance the case",
  openedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
  deepLink: `/admin/cases/${sourceId}`,
  verificationState: "pending" as const,
  lastChangedAt: new Date(Date.now() - 86_400_000).toISOString(),
  environment: "test" as const,
  dataClass: "customer" as const,
  pinned: false,
  preferenceVersion: 0,
  claim: { entityVersion: 4 },
});

function data(items: ReturnType<typeof claimable>[]): TodayData {
  const empty = { totalCount: 0, items: [] };
  return {
    legacy,
    projection: {
      myShift: empty,
      nextBestActions: { totalCount: 18, items },
      unassigned: { totalCount: items.length, items },
      watching: empty,
      recentlyResolved: empty,
      asOf: new Date().toISOString(),
      freshness: "fresh",
      workMode: "support",
      rankingPolicyVersion: "today-ranking-v1",
    },
  };
}

let container: HTMLDivElement;
let root: Root;

function allWorkResponse(totalCount: number) {
  return { items: [], totalCount, pageInfo: { endCursor: null, hasNextPage: false }, asOf: new Date().toISOString(), freshness: "fresh", workMode: "support", rankingPolicyVersion: "today-ranking-v1" };
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function mount(items: ReturnType<typeof claimable>[]) {
  // Today 的写操作反馈走全局 toast —— 真实挂载点是 AdminConsoleClientOnly 的 ToastProvider。
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(TodayView, { data: data(items), workMode: "support" })));
  });
  await settle();
}

/** toast 通过 portal 渲染到 document.body，不在 container 里。 */
function toast() {
  return document.body.querySelector("[data-testid=\"admin-action-status\"]");
}

function buttons(scope: ParentNode = container) {
  return [...scope.querySelectorAll("button")];
}

function click(element: Element | undefined) {
  return act(async () => { (element as HTMLElement).click(); });
}

beforeEach(() => {
  // 地址栏与 history.state 都是每个用例的输入，上一条用例翻过的页不能漏进来。
  window.history.replaceState(null, "", "/admin/today");
  adminV2Request.mockReset();
  adminV2Request.mockImplementation((path: string) => {
    if (path.startsWith("/api/v2/admin/today/all-work")) return Promise.resolve(allWorkResponse(8));
    return Promise.resolve({});
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe("Today operator actions", () => {
  it("replaces the visible overdue floor with the authoritative count", async () => {
    await mount([claimable("case-1")]);

    const kpis = container.querySelector("[data-testid=\"today-kpis\"]");
    expect(kpis?.textContent).toContain("8");
    expect(kpis?.textContent).not.toContain("≥");
    expect(adminV2Request).toHaveBeenCalledWith(
      expect.stringContaining("sla=overdue"),
      expect.anything(),
    );
  });

  it("claims a whole selection through one action and one report", async () => {
    await mount([claimable("case-1"), claimable("case-2")]);
    const checkboxes = [...container.querySelectorAll("input[type=\"checkbox\"]")];

    await click(checkboxes[0]);
    await click(checkboxes[1]);

    const bulk = container.querySelector("[data-testid=\"today-bulk-actions\"]");
    expect(bulk?.textContent).toContain("2 selected");

    await click(buttons(bulk!).find((button) => button.textContent?.includes("Claim")));
    await settle();

    const claims = adminV2Request.mock.calls.filter(([path]) => path === "/api/v2/admin/today/claim");
    expect(claims).toHaveLength(2);
    expect(claims[0][1]).toMatchObject({ method: "POST", body: { sourceId: "case-1", entityVersion: 4 } });
    expect(toast()?.textContent).toContain("Claimed 2 items");
  });

  it("says what the authority said and keeps the raw failure as evidence, not as a reason", async () => {
    await mount([claimable("case-1")]);
    const writeText = vi.fn();
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText } });
    adminV2Request.mockImplementation((path: string) => {
      if (path.startsWith("/api/v2/admin/today/all-work")) return Promise.resolve(allWorkResponse(8));
      return Promise.reject(new AdminV2RequestError("case version changed", 409, "conflict", undefined, "req-9"));
    });

    await click(buttons().find((button) => button.textContent?.includes("Claim")));
    await settle();

    const feedback = toast();
    expect(feedback?.getAttribute("role")).toBe("alert");
    expect(feedback?.textContent).toContain("Someone changed this record before your action landed.");
    expect(feedback?.textContent).toContain("Refresh to load the current version, then decide again.");
    // 原始技术串是证据，不是运营要读的原因 —— 它只在「复制给工程」里，不在首屏文案里。
    expect(feedback?.textContent).not.toContain("case version changed");

    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Copy for engineering")));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("case version changed"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("requestId: req-9"));
  });

  it("does not promise the write was rolled back when the authority never answered", async () => {
    await mount([claimable("case-1")]);
    adminV2Request.mockImplementation((path: string) => {
      if (path.startsWith("/api/v2/admin/today/all-work")) return Promise.resolve(allWorkResponse(8));
      return Promise.reject(new AdminV2RequestError("upstream timeout", 502));
    });

    await click(buttons().find((button) => button.textContent?.includes("Claim")));
    await settle();

    const feedback = toast();
    expect(feedback?.textContent).toContain("The authority did not answer.");
    expect(feedback?.textContent).toContain("whether the write landed is unknown");
    expect(feedback?.textContent).not.toContain("nothing was written");
  });

  it("counts the page it is actually on instead of guessing from an unplaceable cursor", async () => {
    window.history.pushState(null, "", "/admin/today?todayTab=all&cursor=opaque-4");
    adminV2Request.mockImplementation((path: string) => {
      if (path.startsWith("/api/v2/admin/today/all-work")) return Promise.resolve(allWorkResponse(8));
      return Promise.resolve({});
    });
    await mount([]);

    // 游标是别人分享过来的：history.state 里没有走过的路，就不假装知道这是第几页。
    const requested = adminV2Request.mock.calls.map(([path]) => String(path));
    expect(requested.some((path) => path.includes("cursor=opaque-4"))).toBe(false);
    const pager = container.querySelector("[data-testid=\"today-all-work\"]");
    expect(pager?.textContent).toContain("Page 1");
    const previous = buttons(pager!).find((button) => button.textContent?.includes("Previous page"));
    expect(previous?.disabled).toBe(true);
  });
});
