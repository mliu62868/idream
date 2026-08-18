// @vitest-environment happy-dom

import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiWrite } = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiWrite: vi.fn(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));

import { BillingWorkspace } from "./BillingWorkspace";

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
      "/admin/customer-ops/billing?billingSearch=refund-audit",
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

  /**
   * SPEC: 一笔退款把余额冲成负数时，运营在订阅那一行就要看到这件事。
   *
   * INTENT: 「已消费的 Dreamcoin 不返还」以前只是确认框里的一句话。真正证明它发生了的
   * 是冲销后的余额——后端不做下限截断，客户花掉的那部分直接把余额顶成负数。
   * 这个数一直在契约里，界面此前只印一个状态词。
   */
  it("shows the reversed grant and the negative balance it left behind", async () => {
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

  /** 页面上有两条分页条（订阅在前、账本在后）；账本那条永远是最后一条。 */
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
    window.history.replaceState(null, "", "/admin/customer-ops/billing");
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
  });

  // SPEC: 账本那两列是钱：delta 带正负号，余额带千分位。裸 String(x) 会把 -1500 和 2400 排成一样。
  it("signs the ledger delta and groups the balance", async () => {
    await mount();
    const text = container.textContent ?? "";
    expect(text).toContain("-1,500");
    expect(text).toContain("2,400");
  });
});
