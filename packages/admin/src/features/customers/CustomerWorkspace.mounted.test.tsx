// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn<(path: string) => Promise<unknown>>(),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});

import { CustomerWorkspace } from "./CustomerWorkspace";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const customer = {
  id: "user-1",
  email: "someone@example.com",
  displayName: "Test Customer",
  status: "suspended",
  createdAt: "2026-01-04T00:00:00.000Z",
  balanceDreamcoins: 12_345,
  activeCaseCount: 1,
  failedGenerationCount30d: 0,
  subscriptionStatus: "active",
  lastActiveAt: "2026-08-10T00:00:00.000Z",
};

const customer360 = {
  customer: { id: customer.id, email: customer.email, displayName: customer.displayName, status: customer.status, createdAt: customer.createdAt },
  overview: { balanceDreamcoins: 12_345, activeCaseCount: 1, failedGenerationCount30d: 0, lastActiveAt: customer.lastActiveAt },
  subscription: {
    id: "sub-1",
    status: "active",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    cancelAtPeriodEnd: true,
    plan: { id: "plan-1", name: "Premium", billingPeriod: "monthly" },
  },
  recentChats: [],
  generations: [],
  ledger: [{ id: "ledger-1", delta: -1_500, balanceAfter: 12_345, reason: "generation_spend", sourceId: null, createdAt: "2026-08-10T00:00:00.000Z" }],
  cases: [],
  activity: [{ id: "audit-1", action: "customer.note.added", targetType: "user", targetId: "user-1", createdAt: "2026-08-10T00:00:00.000Z" }],
  asOf: "2026-08-11T00:00:00.000Z",
};

const listResponse = {
  items: [customer],
  pageInfo: { endCursor: "cursor-2", hasNextPage: true },
  query: { search: "", status: "", limit: 30, cursor: null },
  asOf: "2026-08-11T00:00:00.000Z",
  freshness: "fresh",
};

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the Customers workspace");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("CustomerWorkspace 360", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    adminV2Request.mockReset();
    adminV2Request.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/customers/")) return customer360;
      return customerListFor(path);
    });
    window.history.replaceState(null, "", "/admin/customers");
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function mount() {
    await act(async () => {
      root = createRoot(container);
      root.render(<CustomerWorkspace />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitUntil(() => container.textContent?.includes("Test Customer") === true);
  }

  it("reloads the applied customer list and open 360 once through shell refresh without submitting a search draft", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<CustomerWorkspace initialCustomerId={customer.id} />);
    });
    await waitUntil(() => container.textContent?.includes("Premium") === true);
    const applied = adminV2Request.mock.calls.find(([path]) => path.startsWith("/api/v2/admin/customers?"))![0];
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search customers"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Unfinished customer search");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const before = adminV2Request.mock.calls.length;
    const href = window.location.href;
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(adminV2Request.mock.calls.slice(before).map(([path]) => path)).toEqual([applied, `/api/v2/admin/customers/${customer.id}`]);
    expect(input.value).toBe("Unfinished customer search");
    expect(window.location.href).toBe(href);
    expect(container.textContent).toContain("Premium");
  });

  it("formats Dreamcoin balances with thousands separators", async () => {
    await mount();
    expect(container.textContent).toContain("12,345 DC");
  });

  // authority 给了 totalCount 就照实显示总数；没给就只说"本页几条"，绝不拿当页条数冒充总数。
  it("shows the authority's total when it has one and only the page size when it does not", async () => {
    await mount();
    // TRAP: 断言限定在分页条内。对整页文本匹配 "of 1" 会被任何「as of 1:47 AM」式的
    //       时间戳打红（1 点、10 点、11 点、12 点整段中招）；这一页现在恰好没渲染时刻，
    //       属于侥幸，不是安全。
    const pagers = [...container.querySelectorAll('[data-testid="admin-pagination"]')];
    expect(pagers.length).toBeGreaterThan(0);
    const pagerText = pagers.map((pager) => pager.textContent ?? "").join(" ");
    expect(pagerText).toContain("Showing 1 rows");
    expect(pagerText).not.toContain("of 1");

    adminV2Request.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/customers/")) return customer360;
      return { ...listResponse, pageInfo: { endCursor: "cursor-2", hasNextPage: true, totalCount: 87 } };
    });
    await act(async () => findButton("Refresh")?.click());
    await waitUntil(() => container.textContent?.includes("of 87") === true);
    expect(container.textContent).toContain("Showing 1–1 of 87");
  });

  // 回归：以前只有「下一页」。翻到第 2 页就回不去，第一页也没有任何"你在第几页"的读数。
  it("keeps Previous disabled on the first page and walks back through the pages it visited", async () => {
    await mount();
    const previous = () => findButton("Previous page");
    expect(previous()?.disabled).toBe(true);
    expect(container.textContent).toContain("Page 1");

    await act(async () => findButton("Next page")?.click());
    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path.includes("cursor=cursor-2")));
    await waitUntil(() => container.textContent?.includes("Page 2") === true);
    expect(previous()?.disabled).toBe(false);

    await act(async () => previous()?.click());
    await waitUntil(() => container.textContent?.includes("Page 1") === true);
    // 回第一页发的是不带游标的那次请求，而不是给单向 operation 塞一个它不认识的 before。
    const lastCall = adminV2Request.mock.calls.at(-1)?.[0] ?? "";
    expect(lastCall).toContain("/api/v2/admin/customers?");
    expect(lastCall).not.toContain("cursor=");
    expect(lastCall).not.toContain("before=");
    expect(previous()?.disabled).toBe(true);
  });

  it.each(["search", "status"])("keeps the returned page position while %s is an unapplied draft", async (field) => {
    await mount();
    await act(async () => findButton("Next page")?.click());
    await waitUntil(() => container.textContent?.includes("Page 2") === true);
    const requestsBeforeDraft = adminV2Request.mock.calls.length;

    await act(async () => {
      if (field === "search") {
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Search customers"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "new customer");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        const select = container.querySelector<HTMLSelectElement>('select[aria-label="Customer status"]')!;
        select.value = "active";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(new URLSearchParams(window.location.search).get(field)).toBe(field === "search" ? "new customer" : "active");
    expect(adminV2Request.mock.calls.length).toBe(requestsBeforeDraft);
    expect(container.textContent).toContain("Page 2");
    expect(findButton("Previous page")?.disabled).toBe(false);

    await act(async () => container.querySelector<HTMLFormElement>("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await waitUntil(() => adminV2Request.mock.calls.length > requestsBeforeDraft);
    expect(container.textContent).toContain("Page 1");
    expect(findButton("Previous page")?.disabled).toBe(true);
    const applied = new URL(adminV2Request.mock.calls.at(-1)![0], "http://admin.test").searchParams;
    expect(applied.get(field)).toBe(field === "search" ? "new customer" : "active");
    expect(applied.has("cursor")).toBe(false);
  });

  it("retains the returned page while the next page is pending or fails, then retries the same page", async () => {
    let failPage: ((error: Error) => void) | undefined;
    let pageThreeRequests = 0;
    adminV2Request.mockImplementation(async (path) => {
      const params = new URL(path, "http://admin.test").searchParams;
      if (params.get("cursor") === "cursor-3" && ++pageThreeRequests === 1) {
        return new Promise((_resolve, reject) => { failPage = reject; });
      }
      return customerListFor(path);
    });
    await mount();
    await act(async () => findButton("Next page")?.click());
    await waitUntil(() => container.textContent?.includes("Page 2") === true);
    await act(async () => findButton("Next page")?.click());
    await waitUntil(() => failPage !== undefined);
    expect(container.textContent).toContain("Page 2");
    expect(container.textContent).not.toContain("Page 3");
    await act(async () => failPage!(new Error("Page three unavailable")));
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);
    expect(container.textContent).toContain("Page 2");
    expect(findButton("Previous page")?.disabled).toBe(false);
    await act(async () => findButton("Retry")?.click());
    await waitUntil(() => container.textContent?.includes("Page 3") === true);
    expect(pageThreeRequests).toBe(2);
    await act(async () => findButton("Previous page")?.click());
    await waitUntil(() => container.textContent?.includes("Page 2") === true);
    expect(new URL(adminV2Request.mock.calls.at(-1)![0], "http://admin.test").searchParams.get("cursor")).toBe("cursor-2");
  });

  it("uses the authority's normalized query for the empty-state explanation", async () => {
    window.history.replaceState(null, "", "/admin/customers?search=%20%20");
    adminV2Request.mockImplementation(async (path) => ({ ...customerListFor(path), items: [] }));
    await act(async () => {
      root = createRoot(container);
      root.render(<CustomerWorkspace />);
    });
    await waitUntil(() => container.textContent?.includes("No customer accounts yet") === true);
    expect(container.textContent).not.toContain("No customers match these filters");
  });

  it("keeps pagination in the returned scope after applying a different filter fails", async () => {
    window.history.replaceState(null, "", "/admin/customers?search=original");
    adminV2Request.mockImplementation(async (path) => {
      if (new URL(path, "http://admin.test").searchParams.get("search") === "unavailable") throw new Error("Filter query unavailable");
      return customerListFor(path);
    });
    await mount();
    await act(async () => findButton("Next page")?.click());
    await waitUntil(() => container.textContent?.includes("Page 2") === true);
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Search customers"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "unavailable");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLFormElement>("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);
    expect(container.textContent).toContain("Page 2");
    await act(async () => findButton("Next page")?.click());
    const pageRequest = new URL(adminV2Request.mock.calls.at(-1)![0], "http://admin.test").searchParams;
    expect(pageRequest.get("cursor")).toBe("cursor-3");
    expect(pageRequest.get("search")).toBe("original");
    await waitUntil(() => container.textContent?.includes("Page 3") === true);
  });

  // 回归：搜索框此前只有 placeholder、状态下拉连 placeholder 都没有，读屏在两个控件上都是空的。
  it("names both filter controls for a screen reader", async () => {
    await mount();
    expect(container.querySelector('input[aria-label="Search customers"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Customer status"]')).not.toBeNull();
  });

  // INTENT: account and subscription can both be `active`; two identical unlabeled badges are ambiguous.
  it("labels the subscription status separately from account standing", async () => {
    await mount();
    const row = container.querySelector<HTMLElement>('[aria-label="Customer results"] button');
    expect(row?.textContent).toContain("Subscriptionactive");
  });

  it("shows account standing, subscription end state, and operator history in the 360 panel", async () => {
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Customer results"] button')?.click());
    await waitUntil(() => container.querySelector("#customer-detail-title") !== null);
    const inspector = container.querySelector<HTMLElement>('[aria-labelledby="customer-detail-title"]');
    const results = container.querySelector<HTMLElement>('[aria-label="Customer results"]');
    expect(inspector?.className).toContain("lg:sticky");
    expect(inspector?.parentElement?.className).toContain("lg:grid-cols");
    expect(inspector?.nextElementSibling).toBe(results);
    expect(results?.className).toContain("lg:order-first");
    const panel = container.textContent ?? "";
    // 封禁状态在详情头（此前只有列表里有）
    expect(panel).toContain("suspended");
    expect(panel).toContain("Customer since");
    // 订阅到期与「已排定取消」——此前两个字段都被丢弃
    expect(panel).toContain("Access ends");
    expect(panel).toContain("Cancellation is already scheduled");
    // activity 一直在响应里，此前整段没渲染
    expect(panel).toContain("Operator history (1)");
    expect(panel).toContain("customer.note.added");
  });

  it("labels active prepaid access by its end date without claiming renewal", async () => {
    adminV2Request.mockImplementation(async (path) => path.startsWith("/api/v2/admin/customers/")
      ? { ...customer360, subscription: { ...customer360.subscription, cancelAtPeriodEnd: false } }
      : listResponse);
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Customer results"] button')?.click());
    await waitUntil(() => container.querySelector("#customer-detail-title") !== null);
    const panel = container.querySelector<HTMLElement>('[aria-labelledby="customer-detail-title"]')?.textContent ?? "";
    expect(panel).toContain("Access ends");
    expect(panel).not.toContain("Renews");
    expect(panel).not.toContain("Cancellation is already scheduled");
  });

  // INVARIANT: 已结束的状态和已过去的日期都不能写成续费或仍可访问。
  it.each([
    { status: "expired", currentPeriodEnd: "2026-07-01T00:00:00.000Z" },
    { status: "active", currentPeriodEnd: "2026-07-01T00:00:00.000Z" },
    { status: "expired", currentPeriodEnd: "2026-09-01T00:00:00.000Z" },
  ])("labels ended access ($status, $currentPeriodEnd) without claiming renewal", async (period) => {
    adminV2Request.mockImplementation(async (path) => path.startsWith("/api/v2/admin/customers/")
      ? { ...customer360, subscription: { ...customer360.subscription, ...period, cancelAtPeriodEnd: false } }
      : listResponse);
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Customer results"] button')?.click());
    await waitUntil(() => container.querySelector("#customer-detail-title") !== null);
    const panel = container.querySelector<HTMLElement>('[aria-labelledby="customer-detail-title"]')?.textContent ?? "";
    expect(panel).toContain("Period ended");
    expect(panel).not.toContain("Renews");
    expect(panel).not.toContain("Access ends");
  });

  it("retries the failed customer detail without reloading the successful list", async () => {
    let detailAttempts = 0;
    adminV2Request.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/customers/")) {
        if (++detailAttempts === 1) throw new Error("detail unavailable");
        return customer360;
      }
      return listResponse;
    });
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Customer results"] button')?.click());
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);
    const listCalls = adminV2Request.mock.calls.filter(([path]) => path.startsWith("/api/v2/admin/customers?")).length;
    await act(async () => findButton("Retry")?.click());
    await waitUntil(() => container.querySelector("#customer-detail-title") !== null);
    expect(detailAttempts).toBe(2);
    expect(adminV2Request.mock.calls.filter(([path]) => path.startsWith("/api/v2/admin/customers?")).length).toBe(listCalls);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("can close a failed detail and restore another customer with browser history", async () => {
    adminV2Request.mockImplementation(async (path) => {
      if (path.endsWith("/user-1")) throw new Error("detail unavailable");
      if (path.endsWith("/user-2")) return { ...customer360, customer: { ...customer360.customer, id: "user-2", displayName: "Second Customer" } };
      return listResponse;
    });
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Customer results"] button')?.click());
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);
    await act(async () => findButton("Close customer detail")?.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(window.location.pathname).toBe("/admin/customers");
    await act(async () => {
      window.history.replaceState(null, "", "/admin/customers/user-2");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitUntil(() => container.querySelector("#customer-detail-title")?.textContent === "Second Customer");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("links customer summaries to supported billing, chat and audit filters", async () => {
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Customer results"] button')?.click());
    await waitUntil(() => container.querySelector("#customer-detail-title") !== null);
    const hrefs = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/admin/customer-ops/billing?billingView=ledger&billingSearch=user-1");
    expect(hrefs).toContain("/admin/customer-ops/billing?billingView=subscriptions&billingSearch=user-1");
    expect(hrefs).toContain("/admin/ops/chat?chatUserId=user-1&chatSessionStatus=all");
    expect(hrefs).toContain("/admin/system/audit?auditSearch=user-1");
    expect(hrefs).toContain("/admin/system/audit?auditSearch=audit-1");
    const quick = (label: string) => [...container.querySelectorAll("a")].find((link) => link.textContent === label)?.getAttribute("href");
    expect(quick("Adjust balance")).toBe("/admin/customer-ops/billing?billingView=ledger&billingSearch=user-1");
    expect(quick("Account status")).toMatch(/^\/admin\/system\/access\?accessSearch=/);
  });

  function findButton(label: string) {
    return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(label));
  }
});

function customerListFor(path: string) {
  const params = new URL(path, "http://admin.test").searchParams;
  const cursor = params.get("cursor");
  return {
    ...listResponse,
    query: { ...listResponse.query, search: (params.get("search") ?? "").trim(), status: params.get("status") ?? "", cursor },
    pageInfo: { ...listResponse.pageInfo, endCursor: cursor === "cursor-2" ? "cursor-3" : "cursor-2" },
  };
}
