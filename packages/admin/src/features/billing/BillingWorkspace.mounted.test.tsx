// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiWrite } = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiWrite: vi.fn(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));

import { BillingWorkspace } from "./BillingWorkspace";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dataScope = {
  kind: "customer" as const,
  includedDataClasses: ["customer"],
  excludedDataClasses: ["fixture", "internal"],
};

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for billing workspace");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("BillingWorkspace hydration", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    apiGet.mockReset();
    apiWrite.mockReset();
    apiGet.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/billing/subscriptions")) {
        return { dataScope, items: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path.startsWith("/api/v2/admin/billing/ledger")) {
        return { dataScope, items: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      return {
        dataScope,
        window: {
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-15T00:00:00.000Z",
        },
        activeSubscriptions: 0,
        checkoutExceptions: [],
        byReason: [],
        totals: { net: 0, entries: 0 },
      };
    });
    window.history.replaceState(
      null,
      "",
      "/admin/customer-ops/billing?billingSearch=refund-audit&billingView=ledger",
    );
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("restores bookmarked filters after a hydration-stable first render", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const browserWindow = window;
    vi.stubGlobal("window", undefined);
    const serverMarkup = renderToString(
      <BillingWorkspace canAdjust canReconcile canRefund />,
    );
    vi.unstubAllGlobals();
    expect(window).toBe(browserWindow);
    container.innerHTML = serverMarkup;

    await act(async () => {
      root = hydrateRoot(
        container,
        <BillingWorkspace canAdjust canReconcile canRefund />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitUntil(() =>
      apiGet.mock.calls.some(([path]) => path.includes("search=refund-audit")),
    );
    expect(
      container.querySelector<HTMLInputElement>(
        'input[placeholder="user, email, subscription, or source"]',
      )?.value,
    ).toBe("refund-audit");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("opens pending exceptions first and restores task views from URL history", async () => {
    window.history.replaceState(null, "", "/admin/customer-ops/billing");
    await act(async () => {
      root = createRoot(container);
      root.render(<BillingWorkspace canAdjust canReconcile canRefund />);
    });
    await waitUntil(() => container.textContent?.includes("Checkout reconciliation is clear") ?? false);
    expect(container.querySelector<HTMLDetailsElement>('[aria-labelledby="billing-adjustment-title"]')?.open).toBe(false);
    const ledgerTab = [...container.querySelectorAll("nav button")].find((button) => button.textContent === "Ledger") as HTMLButtonElement;
    await act(async () => ledgerTab.click());
    expect(new URLSearchParams(window.location.search).get("billingView")).toBe("ledger");
    expect(ledgerTab.getAttribute("aria-current")).toBe("page");
    expect(container.textContent).not.toContain("Checkout reconciliation is clear");
    await act(async () => {
      window.history.replaceState(null, "", "/admin/customer-ops/billing?billingView=subscriptions");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(container.querySelector('nav [aria-current="page"]')?.textContent).toBe("Subscriptions");
  });

  // SPEC: 空表必须说明非客户账号被排除，不然读作「没有流水」。
  it("discloses the excluded owner classes under the ledger and subscription tables", async () => {
    window.history.replaceState(null, "", "/admin/customer-ops/billing?billingView=ledger");
    await act(async () => {
      root = createRoot(container);
      root.render(<BillingWorkspace canAdjust canReconcile canRefund />);
    });
    await waitUntil(() => container.textContent?.includes("excluded: fixture + internal") ?? false);
    expect(container.textContent).toContain("customer owners: customer");
    await act(async () => {
      window.history.replaceState(null, "", "/admin/customer-ops/billing?billingView=subscriptions");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitUntil(() => container.textContent?.includes("excluded: fixture + internal") ?? false);
  });

  it("opens ledger adjustment for the selected customer and clears the previous amount", async () => {
    const fallback = apiGet.getMockImplementation()!;
    apiGet.mockImplementation(async (path) => {
      if (!path.startsWith("/api/v2/admin/billing/ledger")) return fallback(path);
      return { dataScope, items: ["a", "b"].map((id) => ({ id: `entry-${id}`, userId: `user-${id}`, userEmail: `${id}@example.test`, delta: 50, balanceAfter: 100, reason: "admin_adjust", createdAt: "2026-08-10T00:00:00.000Z" })), pageInfo: { endCursor: null, hasNextPage: false } };
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<BillingWorkspace canAdjust canReconcile canRefund />);
    });
    await waitUntil(() => container.textContent?.includes("entry-a") ?? false);
    const panel = container.querySelector<HTMLDetailsElement>('[aria-labelledby="billing-adjustment-title"]')!;
    panel.scrollIntoView = vi.fn();
    const actions = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Adjust Ledger");
    await act(async () => actions[0].click());
    const inputs = panel.querySelectorAll<HTMLInputElement>("input");
    expect(panel.open).toBe(true);
    expect(inputs[0].value).toBe("user-a");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs[1], "300");
      inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => actions[1].click());
    expect(inputs[0].value).toBe("user-b");
    expect(inputs[1].value).toBe("");
    expect(apiWrite).not.toHaveBeenCalled();
  });

  // SPEC: 双人复核开启后，调账被 403 拦下；被拦下的表单是运营提交审批申请的唯一入口。
  it("offers an approval request for exactly the adjustment dual approval refused", async () => {
    const { AdminV2RequestError } = await import("@/lib/admin-v2-api");
    apiWrite.mockImplementation(async (path: string) => {
      if (path === "/api/v2/admin/billing/adjustments") {
        throw new AdminV2RequestError("Dual approval required: no approved request for this action", 403, "forbidden");
      }
      return { request: { id: "approval-1" } };
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<BillingWorkspace canAdjust canReconcile canRefund />);
    });
    const panel = await (async () => {
      await waitUntil(() => Boolean(container.querySelector('[aria-labelledby="billing-adjustment-title"]')));
      return container.querySelector<HTMLDetailsElement>('[aria-labelledby="billing-adjustment-title"]')!;
    })();
    const setValue = async (input: HTMLInputElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const [userInput, deltaInput] = panel.querySelectorAll<HTMLInputElement>("input");
    await setValue(userInput, "user-a");
    await setValue(deltaInput, "1500");
    const adjust = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Adjust")!;
    await act(async () => adjust.click());
    await setValue(document.body.querySelector<HTMLInputElement>('input[aria-label="Reason"]')!, "goodwill credit");
    await setValue(document.body.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]')!, "user-a:1500");
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Confirm")!;
    await act(async () => confirm.click());
    await waitUntil(() => Boolean(container.querySelector('[data-testid="billing-adjustment-approval-required"]')));

    const request = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Request approval")!;
    await act(async () => request.click());
    expect(apiWrite).toHaveBeenLastCalledWith("/api/v2/admin/approvals", "POST", {
      permissionKey: "billing.ledger.adjust",
      action: "billing.ledger.adjust",
      targetType: "user",
      targetId: "user-a",
      payload: { delta: 1500 },
      reason: "goodwill credit",
      confirmation: "user-a:billing.ledger.adjust",
    });
    await waitUntil(() => !container.querySelector('[data-testid="billing-adjustment-approval-required"]'));
  });

  it("keeps external refund references scoped to their checkout", async () => {
    window.history.replaceState(null, "", "/admin/customer-ops/billing");
    const fallback = apiGet.getMockImplementation()!;
    apiGet.mockImplementation(async (path) => {
      if (!path.endsWith("/reconciliation")) return fallback(path);
      return {
        dataScope, window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" },
        activeSubscriptions: 0, byReason: [], totals: { net: 0, entries: 0 },
        checkoutExceptions: ["a", "b"].map((id) => ({ id: `checkout-${id}`, userId: `user-${id}`, userEmail: `${id}@example.test`, providerSessionId: `invoice-${id}`, status: "provider_unknown", failureCode: "provider_invoice_settled_after_abandonment", needsReconciliation: true, providerInvoiceStatus: "settled" })),
      };
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<BillingWorkspace canAdjust canReconcile canRefund />);
    });
    await waitUntil(() => container.querySelectorAll('input[placeholder="Refund transaction or provider case ID"]').length === 2);
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[placeholder="Refund transaction or provider case ID"]')];
    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.includes("Acknowledge refund"));
    expect(buttons().map((button) => button.disabled)).toEqual([true, true]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs[0], "refund-a");
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(inputs[1].value).toBe("");
    expect(buttons().map((button) => button.disabled)).toEqual([false, true]);
    await act(async () => buttons()[0].click());
    expect(document.body.textContent).toContain("invoice-a · refund-a");
    expect(apiWrite).not.toHaveBeenCalled();
  });

  /**
   * SPEC: 一笔退款把余额冲成负数时，运营在订阅那一行就要看到这件事。
   *
   * INTENT: 「已消费的 Dreamcoin 不返还」以前只是确认框里的一句话。真正证明它发生了的
   * 是冲销后的余额——后端不做下限截断，客户花掉的那部分直接把余额顶成负数。
   * 这个数一直在契约里，界面此前只印一个状态词。
   */
  it("shows the reversed grant and the negative balance it left behind", async () => {
    window.history.replaceState(null, "", "/admin/customer-ops/billing?billingView=subscriptions");
    apiGet.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/billing/subscriptions")) {
        return {
          dataScope,
          items: [
            {
              id: "sub-1",
              userId: "user-1",
              userEmail: "refund-audit@example.test",
              plan: "premium",
              billingPeriod: "monthly",
              includedDreamcoins: 1_500,
              provider: "btcpay",
              status: "refund_pending",
              currentPeriodEnd: "2026-09-01T00:00:00.000Z",
              cancelAtPeriodEnd: false,
              providerSubscriptionId: null,
              checkoutId: "checkout-1",
              amountCents: 1_999,
              currency: "usd",
              canRefund: false,
              createdAt: "2026-08-01T00:00:00.000Z",
              refund: {
                subscriptionId: "sub-1",
                checkoutId: "checkout-1",
                reference: "idream-refund:checkout-1:command-1",
                state: "awaiting_payment",
                amountCents: 1_999,
                currency: "usd",
                reversedDreamcoins: 1_500,
                balanceAfter: -400,
                claimUrl: null,
                providerRefundId: null,
                payouts: [
                  { payoutId: "payout-1", state: "awaiting_payment", paymentProofId: null },
                ],
                requestedAt: "2026-08-15T00:00:00.000Z",
                completedAt: null,
                restoredAt: null,
                restoredBalanceAfter: null,
              },
            },
          ],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path.startsWith("/api/v2/admin/billing/ledger")) {
        return { dataScope, items: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      return {
        dataScope,
        window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" },
        activeSubscriptions: 0,
        checkoutExceptions: [],
        byReason: [],
        totals: { net: 0, entries: 0 },
      };
    });

    await act(async () => {
      root = hydrateRoot(container, <BillingWorkspace canAdjust canReconcile canRefund />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitUntil(() => container.textContent?.includes("Awaiting payout") ?? false);

    const text = container.textContent ?? "";
    expect(text).toContain("$19.99");
    expect(text).toContain("1,500 Dreamcoin grant reversed");
    expect(text).toContain("-400");
    expect(text).toContain("the customer had already spent part of the grant");
    // 退款进行中的行不许再出现「发起全额退款」的入口。
    expect(text).not.toContain("Full refund");
  });
});

/**
 * SPEC: 账本分页条 —— 第一页「上一页」置灰，翻过去之后能原路回来，全程不编造总数。
 *
 * INTENT: 这里以前只有一个「下一页」。运营翻到第 4 页就回不去了，只能清筛选重来。
 * 契约没给 totalCount，所以页脚只报当页行数；把当页条数冒充成「共 N 条」是上一轮抓到的 bug。
 */
describe("BillingWorkspace ledger pagination", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  /** 每页一行，行的 id 就是这一页请求时用的 cursor —— 断言时一眼看出停在哪一页。 */
  function ledgerPage(cursor: string) {
    const pages: Record<string, { id: string; endCursor: string | null }> = {
      "": { id: "ledger-page-1", endCursor: "cursor-2" },
      "cursor-2": { id: "ledger-page-2", endCursor: "cursor-3" },
      "cursor-3": { id: "ledger-page-3", endCursor: null },
    };
    const page = pages[cursor] ?? pages[""]!;
    return {
      dataScope,
      items: [
        {
          id: page.id,
          userId: "user-1",
          userEmail: "ledger@example.test",
          delta: -1_500,
          balanceAfter: 2_400,
          reason: "generation_spend",
          sourceId: "job-1",
          createdAt: "2026-08-15T00:00:00.000Z",
        },
      ],
      pageInfo: { endCursor: page.endCursor, hasNextPage: page.endCursor !== null },
    };
  }

  /** 当前任务视图只有自己的分页条。 */
  function pagerButton(label: string) {
    return [...container.querySelectorAll("button")]
      .filter((button) => button.textContent?.trim() === label)
      .at(-1);
  }

  beforeEach(() => {
    apiGet.mockReset();
    apiWrite.mockReset();
    apiGet.mockImplementation(async (path) => {
      if (path.startsWith("/api/v2/admin/billing/ledger")) {
        return ledgerPage(new URL(path, "http://admin.test").searchParams.get("cursor") ?? "");
      }
      if (path.startsWith("/api/v2/admin/billing/subscriptions")) {
        return { dataScope, items: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      return {
        dataScope,
        window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" },
        activeSubscriptions: 0,
        checkoutExceptions: [],
        byReason: [],
        totals: { net: 0, entries: 0 },
      };
    });
    window.history.replaceState(null, "", "/admin/customer-ops/billing?billingView=ledger");
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
      root = hydrateRoot(container, <BillingWorkspace canAdjust canReconcile canRefund />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitUntil(() => container.textContent?.includes("ledger-page-1") ?? false);
  }

  // INVARIANT: 第一页没有上一页，但按钮要在场且置灰——藏起来运营就不知道它存在。
  it("greys out Previous page on the first page instead of hiding it", async () => {
    await mount();
    expect(pagerButton("Previous page")?.disabled).toBe(true);
    expect(pagerButton("Next page")?.disabled).toBe(false);
    expect(container.textContent).toContain("Page 1");
  });

  // INVARIANT: 契约没给 totalCount，就只报当页行数，绝不把它写成「共 N 条」。
  // TRAP: 断言必须限定在分页条内。对整页文本做子串匹配时，页头的「as of 1:47 AM」里那个
  //       "of 1" 会让这条用例在 1 点、10 点、11 点、12 点整段时间里假红。
  it("reports the row count it actually has rather than inventing a total", async () => {
    await mount();
    const pagers = [...container.querySelectorAll('[data-testid="admin-pagination"]')];
    expect(pagers.length).toBeGreaterThan(0);
    const text = pagers.map((pager) => pager.textContent ?? "").join(" ");
    expect(text).toContain("Showing 1 rows");
    expect(text).not.toContain("of 1");
    expect(text).not.toContain("Page 1 of");
  });

  it("walks forward on the authority cursor and back again to the same page", async () => {
    await mount();
    expect(apiGet.mock.calls.every(([path]) => path.startsWith("/api/v2/admin/billing/ledger"))).toBe(true);

    await act(async () => pagerButton("Next page")?.click());
    await waitUntil(() => container.textContent?.includes("ledger-page-2") ?? false);
    expect(apiGet.mock.calls.some(([path]) =>
      path.startsWith("/api/v2/admin/billing/ledger") && path.includes("cursor=cursor-2"),
    )).toBe(true);
    expect(pagerButton("Previous page")?.disabled).toBe(false);
    expect(container.textContent).toContain("Page 2");

    await act(async () => pagerButton("Previous page")?.click());
    await waitUntil(() => container.textContent?.includes("ledger-page-1") ?? false);
    expect(pagerButton("Previous page")?.disabled).toBe(true);
    expect(container.textContent).toContain("Page 1");
    expect(apiGet.mock.calls.every(([path]) => path.startsWith("/api/v2/admin/billing/ledger"))).toBe(true);
  });

  // SPEC: 账本那两列是钱：delta 带正负号，余额带千分位。裸 String(x) 会把 -1500 和 2400 排成一样。
  it("signs the ledger delta and groups the balance", async () => {
    await mount();
    const text = container.textContent ?? "";
    expect(text).toContain("-1,500");
    expect(text).toContain("2,400");
  });
});

describe("billing query authority", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  const ledger = { id: "ledger-a", userId: "user-a", userEmail: "a@example.test", delta: 10, balanceAfter: 100, reason: "admin_adjust", createdAt: "2026-08-01T00:00:00.000Z" };
  const subscription = {
    id: "subscription-a", userId: "user-a", userEmail: "a@example.test", plan: "premium", billingPeriod: "monthly",
    includedDreamcoins: 1500, provider: "btcpay", status: "active", currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    cancelAtPeriodEnd: false, providerSubscriptionId: null, checkoutId: "checkout-a", amountCents: 1999, currency: "usd",
    refund: null, canRefund: true, createdAt: "2026-08-01T00:00:00.000Z",
  };
  const pendingRefund = {
    subscriptionId: "subscription-a", checkoutId: "checkout-a", reference: "idream-refund:checkout-a:command-a",
    state: "provider_unknown", amountCents: 1999, currency: "usd", reversedDreamcoins: 1500,
    balanceAfter: -200, claimUrl: null, providerRefundId: null, payouts: [],
    requestedAt: "2026-08-01T00:00:00.000Z", completedAt: null, restoredAt: null, restoredBalanceAfter: null,
  };
  const reconciliation = {
    dataScope, window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" },
    activeSubscriptions: 0, byReason: [], totals: { net: 0, entries: 0 },
    checkoutExceptions: [{
      id: "checkout-a", userId: "user-a", userEmail: "a@example.test", providerSessionId: "invoice-a",
      status: "provider_unknown", failureCode: "provider_invoice_settled_after_abandonment",
      needsReconciliation: true, providerInvoiceStatus: "settled",
    }],
  };
  beforeEach(() => {
    apiGet.mockReset();
    apiWrite.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function mount(view: string) {
    window.history.replaceState(null, "", `/admin/customer-ops/billing?billingView=${view}`);
    await act(async () => {
      root = createRoot(container);
      root.render(<BillingWorkspace canAdjust canReconcile canRefund />);
    });
    await waitUntil(() => container.textContent?.includes("a@example.test") ?? false);
  }
  async function navigate(query: string) {
    await act(async () => {
      window.history.pushState(null, "", `/admin/customer-ops/billing?${query}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  }
  const setValue = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  async function openAdjustment(userId: string) {
    const panel = container.querySelector('[aria-labelledby="billing-adjustment-title"]')!;
    const [user, delta] = panel.querySelectorAll<HTMLInputElement>("input");
    await act(async () => { setValue(user, userId); setValue(delta, "10"); });
    await act(async () => [...panel.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Adjust")!.click());
  }
  async function submitAdjustment(userId: string) {
    await openAdjustment(userId);
    await act(async () => {
      setValue(document.querySelector<HTMLInputElement>('input[aria-label="Reason"]')!, "reviewed credit");
      setValue(document.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]')!, `${userId}:10`);
    });
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === "Confirm")!.click());
  }
  it.each([
    ["ledger", "billingSearch=other"], ["ledger", "ledgerCursor=next"],
    ["subscriptions", "billingSearch=other"], ["subscriptions", "subscriptionCursor=next"],
  ])("hides old %s rows and actions during %s and after its failure", async (view, query) => {
    let reject!: (error: Error) => void;
    const pending = new Promise<unknown>((_, fail) => { reject = fail; });
    apiGet.mockImplementation(async path => path.includes("search=other") || path.includes("cursor=next") ? pending : {
      dataScope, items: [view === "ledger" ? ledger : subscription], pageInfo: { endCursor: null, hasNextPage: false },
    });
    await mount(view);
    if (view === "subscriptions") expect(container.textContent).toContain("Full refund");
    await navigate(`billingView=${view}&${query}`);
    expect(container.textContent).not.toContain("a@example.test");
    expect(container.textContent).not.toContain("Full refund");
    expect([...container.querySelectorAll("button")].some(node => node.textContent === "Adjust Ledger")).toBe(false);
    await waitUntil(() => apiGet.mock.calls.some(([path]) => path.includes("search=other") || path.includes("cursor=next")));
    await act(async () => reject(new Error("new billing scope failed")));
    expect(container.textContent).toContain("new billing scope failed");
    expect(container.textContent).not.toContain("a@example.test");
    expect(container.textContent).not.toContain("Full refund");
  });

  it("hides cached subscriptions when returning from a different query in another tab", async () => {
    const pending = new Promise<unknown>(() => {});
    apiGet.mockImplementation(async path => {
      if (path.includes("search=other")) return pending;
      return { dataScope, items: [subscription], pageInfo: { endCursor: null, hasNextPage: false } };
    });
    await mount("subscriptions");
    await navigate("billingView=ledger&billingSearch=other");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(node => node.textContent === "Subscriptions")!.click());
    expect(container.textContent).not.toContain("a@example.test");
    expect(container.textContent).not.toContain("Full refund");
  });

  it.each(["ledger", "subscriptions"])("retains same-query %s last-good data after refresh failure", async view => {
    let fail = false;
    apiGet.mockImplementation(async () => {
      if (fail) throw new Error("same billing scope failed");
      return { dataScope, items: [view === "ledger" ? ledger : subscription], pageInfo: { endCursor: null, hasNextPage: false } };
    });
    await mount(view);
    fail = true;
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(container.textContent).toContain("same billing scope failed");
    expect(container.textContent).toContain("a@example.test");
  });

  it("refreshes all billing authorities for the current filters through the shared workspace event", async () => {
    apiGet.mockImplementation(async path => {
      if (path.endsWith("/reconciliation")) return reconciliation;
      const row = path.includes("/subscriptions") ? subscription : ledger;
      return { dataScope, items: [{ ...row, userEmail: path.includes("search=current") ? "current@example.test" : "a@example.test" }], pageInfo: { endCursor: null, hasNextPage: false } };
    });
    await mount("ledger");
    await navigate("billingView=ledger&billingSearch=current");
    await waitUntil(() => container.textContent?.includes("current@example.test") ?? false);
    apiGet.mockClear();
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    expect(apiGet.mock.calls.map(([path]) => {
      const url = new URL(path, window.location.origin);
      return { path: url.pathname, search: url.searchParams.get("search"), limit: url.searchParams.get("limit") };
    })).toEqual(expect.arrayContaining([
      { path: "/api/v2/admin/billing/ledger", search: "current", limit: "25" },
      { path: "/api/v2/admin/billing/subscriptions", search: "current", limit: "25" },
      { path: "/api/v2/admin/billing/reconciliation", search: null, limit: null },
    ]));
    expect(apiGet).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("current@example.test");
    expect(window.location.search).toBe("?billingView=ledger&billingSearch=current");
  });

  it.each(["refund", "reconcile"] as const)("reuses the same %s key when a real success envelope has an invalid response contract", async operation => {
    const actualApi = await vi.importActual<typeof import("@/components/admin/api")>("@/components/admin/api");
    apiWrite.mockImplementation(actualApi.apiWrite);
    apiGet.mockResolvedValue({ dataScope, items: [{ ...subscription,
      ...(operation === "reconcile" ? { status: "refund_pending", canRefund: false, refund: pendingRefund } : {}),
    }], pageInfo: { endCursor: null, hasNextPage: false } });
    const attempts: Array<{ path: string; key: string | null; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      attempts.push({ path: String(input), key: new Headers(init?.headers).get("idempotency-key"), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, data: { refund: { state: "completed" } } });
    }));
    await mount("subscriptions");
    const action = operation === "refund" ? "Full refund" : "Reconcile";
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === action)!.click());
    const confirmation = `subscription-a:${operation === "refund" ? "refund" : "refund_reconcile"}`;
    await act(async () => {
      const inputs = document.querySelectorAll<HTMLInputElement>('[role="dialog"] input');
      setValue(inputs[0], "Verify the exact provider refund");
      setValue(inputs[1], confirmation);
    });
    const submitLabel = operation === "refund" ? "Issue full refund" : "Reconcile provider state";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent?.trim() === submitLabel)!.click());
      await waitUntil(() => attempts.length === attempt && document.querySelector('[role="dialog"] [role="alert"]') !== null);
    }
    expect(attempts[0].key).toBeTruthy();
    expect(attempts[1].key).toBe(attempts[0].key);
    expect(attempts.map(attempt => attempt.path)).toEqual(Array(2).fill(`/api/v2/admin/billing/subscriptions/subscription-a/refund${operation === "reconcile" ? "/reconcile" : ""}`));
    expect(attempts.map(attempt => attempt.body)).toEqual(Array(2).fill({ reason: "Verify the exact provider refund", confirmation }));
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("admin_v2_response_contract_violation");
    expect(container.textContent).not.toContain("Subscription subscription-a refund is");
  });

  it.each([false, true])("prevents a late adjustment from replacing a later visit or confirmation (return to A: %s)", async returnToA => {
    let finish!: (value: unknown) => void;
    apiWrite.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    apiGet.mockImplementation(async path => ({ dataScope, items: [{ ...ledger, userEmail: path.includes("search=b") ? "b@example.test" : "a@example.test" }], pageInfo: { endCursor: null, hasNextPage: false } }));
    await mount("ledger");
    await submitAdjustment("user-a");
    expect(apiWrite).toHaveBeenCalledTimes(1);
    await navigate("billingView=ledger&billingSearch=b");
    await waitUntil(() => container.textContent?.includes("b@example.test") ?? false);
    if (returnToA) {
      await navigate("billingView=ledger");
      await waitUntil(() => container.textContent?.includes("a@example.test") ?? false);
    }
    await openAdjustment("user-b");
    const gets = apiGet.mock.calls.length;
    await act(async () => finish({}));
    expect(window.location.search).toBe(returnToA ? "?billingView=ledger" : "?billingView=ledger&billingSearch=b");
    expect(container.textContent).toContain(returnToA ? "a@example.test" : "b@example.test");
    expect(apiGet).toHaveBeenCalledTimes(gets);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Adjust ledger for user-b");
  });

  it("preserves the subscription cursor trail across the authority resource", async () => {
    apiGet.mockImplementation(async path => {
      const next = new URL(path, window.location.origin).searchParams.has("cursor");
      return { dataScope, items: [{ ...subscription, userEmail: next ? "second@example.test" : "a@example.test" }],
        pageInfo: { endCursor: next ? null : "subscription-next", hasNextPage: !next } };
    });
    await mount("subscriptions");
    const pager = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === label)!;
    expect(pager("Previous page").disabled).toBe(true);
    await act(async () => pager("Next page").click());
    await waitUntil(() => container.textContent?.includes("second@example.test") ?? false);
    expect(window.location.search).toContain("subscriptionCursor=subscription-next");
    expect(apiGet.mock.calls.at(-1)?.[0]).toContain("cursor=subscription-next");
    await act(async () => pager("Previous page").click());
    await waitUntil(() => container.textContent?.includes("a@example.test") ?? false);
    expect(apiGet.mock.calls.at(-1)?.[0]).not.toContain("cursor=");
    expect(pager("Previous page").disabled).toBe(true);
  });

  it("clears failed reconciliation data and does not revive it while retrying", async () => {
    apiGet.mockResolvedValue(reconciliation);
    await mount("pending");
    apiGet.mockRejectedValueOnce(new Error("Reconciliation unavailable"));
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(container.textContent).toContain("Reconciliation unavailable");
    expect(container.textContent).not.toContain("a@example.test");
    let completeRetry!: (value: unknown) => void;
    apiGet.mockImplementationOnce(() => new Promise(resolve => { completeRetry = resolve; }));
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(container.textContent).not.toContain("a@example.test");
    expect(container.querySelector('[aria-label="Loading billing records…"]')).not.toBeNull();
    await act(async () => completeRetry({ ...reconciliation, checkoutExceptions: [] }));
    expect(container.textContent).toContain("Checkout reconciliation is clear");
  });

  it.each(["adjust", "refund", "reconcile"] as const)("retires a %s confirmation when its write permission is revoked without hiding read authority", async permission => {
    const view = permission === "adjust" ? "ledger" : permission === "refund" ? "subscriptions" : "pending";
    apiGet.mockResolvedValue(permission === "reconcile" ? reconciliation : {
      dataScope, items: [permission === "adjust" ? ledger : subscription], pageInfo: { endCursor: null, hasNextPage: false },
    });
    await mount(view);
    if (permission === "adjust") await openAdjustment("user-a");
    else if (permission === "refund") {
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Full refund")!.click());
    } else {
      await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="Refund transaction or provider case ID"]')!, "external-refund-reference"));
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Acknowledge refund")!.click());
    }
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => root!.render(<BillingWorkspace canAdjust={permission !== "adjust"} canReconcile={permission !== "reconcile"} canRefund={permission !== "refund"} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("a@example.test");
    await act(async () => root!.render(<BillingWorkspace canAdjust canReconcile canRefund />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("does not refresh or clear a newer adjustment after write permission is revoked", async () => {
    let completeWrite!: (value: unknown) => void;
    apiWrite.mockImplementation(() => new Promise(resolve => { completeWrite = resolve; }));
    apiGet.mockResolvedValue({ dataScope, items: [ledger], pageInfo: { endCursor: null, hasNextPage: false } });
    await mount("ledger");
    await submitAdjustment("user-a");
    await act(async () => root!.render(<BillingWorkspace canAdjust={false} canReconcile canRefund />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root!.render(<BillingWorkspace canAdjust canReconcile canRefund />));
    await openAdjustment("user-b");
    const readCount = apiGet.mock.calls.length;
    await act(async () => completeWrite({}));
    expect(apiGet).toHaveBeenCalledTimes(readCount);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Adjust ledger for user-b");
    expect(container.textContent).toContain("a@example.test");
  });

  it("retires an old confirmation after an unrelated permission changes and permits a fresh adjustment", async () => {
    apiGet.mockResolvedValue({ dataScope, items: [ledger], pageInfo: { endCursor: null, hasNextPage: false } });
    await mount("ledger");
    await openAdjustment("user-a");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => root!.render(<BillingWorkspace canAdjust canReconcile canRefund={false} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("a@example.test");
    apiWrite.mockResolvedValue({});
    await submitAdjustment("user-b");
    expect(apiWrite).toHaveBeenCalledTimes(1);
    expect(apiWrite).toHaveBeenCalledWith("/api/v2/admin/billing/adjustments", "POST", {
      userId: "user-b", delta: 10, reason: "reviewed credit", confirmation: "user-b:10",
    });
  });

  it("does not replace a post-adjustment readback with an older refresh", async () => {
    const response = (email: string) => ({ dataScope, items: [{ ...ledger, userEmail: email }], pageInfo: { endCursor: null, hasNextPage: false } });
    apiGet.mockResolvedValue(response("a@example.test"));
    await mount("ledger");
    let completeOld!: (value: unknown) => void;
    apiGet.mockImplementationOnce(() => new Promise(resolve => { completeOld = resolve; }));
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    apiGet.mockResolvedValue(response("committed@example.test"));
    apiWrite.mockResolvedValue({});
    await submitAdjustment("user-a");
    await waitUntil(() => container.textContent?.includes("committed@example.test") ?? false);
    await act(async () => completeOld(response("obsolete@example.test")));
    expect(container.textContent).toContain("committed@example.test");
    expect(container.textContent).not.toContain("obsolete@example.test");
    expect(apiWrite).toHaveBeenCalledTimes(1);
  });
});
