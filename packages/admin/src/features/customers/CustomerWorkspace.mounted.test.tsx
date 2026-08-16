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
      return {
        items: [customer],
        pageInfo: { endCursor: "cursor-2", hasNextPage: true },
        query: { search: "", status: "", limit: 30, cursor: null },
        asOf: "2026-08-11T00:00:00.000Z",
        freshness: "fresh",
      };
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

  // 双向分页要等 authority 侧补 startCursor / hasPreviousPage / totalCount。在那之前
  // 这行只许声明"本页几条"——绝不能让运营把它读成总数。
  it("reports the page size without claiming it is a total", async () => {
    await mount();
    expect(container.querySelector('[aria-label="Customer pages"]')?.textContent).toContain("1 on this page");
    await act(async () => findButton("Next page")?.click());
    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path.includes("cursor=cursor-2")));
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
