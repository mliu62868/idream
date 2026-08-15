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
      if (path.startsWith("/api/v1/admin/billing/subscriptions")) {
        return { dataScope, items: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path.startsWith("/api/v1/admin/billing/ledger")) {
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
});
