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
  relationships: [],
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
      return listResponse;
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

  it("formats Dreamcoin balances with thousands separators", async () => {
    await mount();
    expect(container.textContent).toContain("12,345 DC");
  });

  // authority 给了 totalCount 就照实显示总数；没给就只说"本页几条"，绝不拿当页条数冒充总数。
  it("shows the authority's total when it has one and only the page size when it does not", async () => {
    await mount();
    expect(container.textContent).toContain("Showing 1 rows");
    expect(container.textContent).not.toContain("of 1");

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

  // 回归：搜索框此前只有 placeholder、状态下拉连 placeholder 都没有，读屏在两个控件上都是空的。
  it("names both filter controls for a screen reader", async () => {
    await mount();
    expect(container.querySelector('input[aria-label="Search customers"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Customer status"]')).not.toBeNull();
  });

  it("shows account standing, subscription end state, and operator history in the 360 panel", async () => {
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Customer results"] button')?.click());
    await waitUntil(() => container.querySelector("#customer-detail-title") !== null);
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

  function findButton(label: string) {
    return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(label));
  }
});
