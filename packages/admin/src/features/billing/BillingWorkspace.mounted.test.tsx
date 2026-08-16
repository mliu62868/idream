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
