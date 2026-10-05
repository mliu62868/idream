// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerWorkspace } from "@/features/customers/CustomerWorkspace";
import { PricingWorkspace } from "@/features/pricing/PricingWorkspace";
import { AccessWorkspace } from "@/features/access/AccessWorkspace";
import { PromoWorkspace } from "@/features/promo/PromoWorkspace";
import { BillingWorkspace } from "@/features/billing/BillingWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }));

const timestamp = "2026-10-01T00:00:00.000Z";
const dataScope = { kind: "customer", includedDataClasses: ["customer"], excludedDataClasses: ["fixture", "internal"] };
const workspaces: { name: string; url: string; cursorKey: string; apiPath: string; pager: number; node: () => ReactNode }[] = [
  { name: "Customers", url: "/admin/customers", cursorKey: "cursor", apiPath: "/api/v2/admin/customers", pager: 0, node: () => <CustomerWorkspace /> },
  { name: "Pricing", url: "/admin/growth/offers?view=pricing", cursorKey: "pricingCursor", apiPath: "/api/v2/admin/pricing/rules", pager: 0, node: () => <PricingWorkspace canWrite={false} /> },
  { name: "Team Access", url: "/admin/system/access", cursorKey: "accessCursor", apiPath: "/api/v2/admin/users", pager: 0, node: () => <AccessWorkspace permissions={{ changeStatus: false, managePermissions: false }} /> },
  { name: "Redeem codes", url: "/admin/growth/offers?view=promo", cursorKey: "promoCursor", apiPath: "/api/v2/admin/promo/redeem-codes", pager: 0, node: () => <PromoWorkspace canWrite={false} /> },
  { name: "Referrals", url: "/admin/growth/offers?view=promo", cursorKey: "referralCursor", apiPath: "/api/v2/admin/promo/referrals", pager: 1, node: () => <PromoWorkspace canWrite={false} /> },
  { name: "Ledger", url: "/admin/customer-ops/billing?billingView=ledger", cursorKey: "ledgerCursor", apiPath: "/api/v2/admin/billing/ledger", pager: 0, node: () => <BillingWorkspace canAdjust={false} canReconcile={false} canRefund={false} /> },
  { name: "Subscriptions", url: "/admin/customer-ops/billing?billingView=subscriptions", cursorKey: "subscriptionCursor", apiPath: "/api/v2/admin/billing/subscriptions", pager: 0, node: () => <BillingWorkspace canAdjust={false} canReconcile={false} canRefund={false} /> },
];

describe("Cursor workspaces never invent page positions after reload or shared links", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      const cursor = url.searchParams.get("cursor") ?? "";
      const marker = `page-${cursor || "first"}`;
      const pageInfo = { endCursor: cursor === "cursor-three" ? null : cursor ? "cursor-three" : "cursor-two", hasNextPage: cursor !== "cursor-three" };
      let data: unknown;
      if (url.pathname === "/api/v2/admin/customers") data = {
        items: [{ id: marker, email: `${marker}@example.test`, displayName: marker, status: "active", createdAt: timestamp, balanceDreamcoins: 10, activeCaseCount: 0, failedGenerationCount30d: 0, subscriptionStatus: null, lastActiveAt: null }],
        pageInfo: { ...pageInfo, totalCount: 90 }, query: { search: "", status: "", limit: 30, cursor: cursor || null }, asOf: timestamp, freshness: "fresh",
      };
      else if (url.pathname === "/api/v2/admin/users") data = { items: [{ id: marker, email: `${marker}@example.test`, displayName: marker, role: "user", status: "active", dataClass: "customer", createdAt: timestamp, plan: null, dreamcoins: 10 }], pageInfo };
      else if (url.pathname === "/api/v2/admin/pricing/rules") data = { items: [{ id: marker, label: marker, ruleKey: "pricing-example", mode: "image", baseCost: 5, multiplier: 1, status: "draft", version: 1 }], pageInfo };
      else if (url.pathname === "/api/v2/admin/promo/redeem-codes") data = { items: [{ id: marker, status: "active", reward: { dreamcoins: 10 }, maxRedemptions: 10, redemptions: 0 }], pageInfo };
      else if (url.pathname === "/api/v2/admin/promo/referrals") data = { items: [{ id: marker, inviterId: "inviter", inviteeId: "invitee", status: "pending", rewardStatus: "pending" }], pageInfo };
      else if (url.pathname === "/api/v2/admin/billing/ledger") data = { dataScope, items: [{ id: marker, userId: "customer", userEmail: `${marker}@example.test`, delta: -5, balanceAfter: 10, reason: "generation_spend", sourceId: null, createdAt: timestamp }], pageInfo };
      else if (url.pathname === "/api/v2/admin/billing/subscriptions") data = { dataScope, items: [{ id: marker, userId: "customer", userEmail: `${marker}@example.test`, plan: "Premium", billingPeriod: "monthly", includedDreamcoins: 100, provider: "crypto", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false, providerSubscriptionId: null, checkoutId: null, amountCents: null, currency: null, refund: null, canRefund: false, createdAt: timestamp }], pageInfo };
      else if (url.pathname === "/api/v2/admin/billing/reconciliation") data = { dataScope, window: { from: timestamp, to: timestamp }, activeSubscriptions: 0, checkoutExceptions: [], byReason: [], totals: { net: 0, entries: 0 } };
      else if (url.pathname === "/api/v2/admin/billing/coin-offers") data = { items: [] };
      else throw new Error(`Unexpected cursor-workspace request ${url.pathname}`);
      return Response.json({ ok: true, data });
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it.each(workspaces.flatMap(workspace => [
    { ...workspace, entry: "reload" },
    { ...workspace, entry: "shared link" },
  ]))("$name keeps $entry positions unknown through next/back until returning to the first page", async workspace => {
    const initial = new URL(workspace.url, window.location.origin);
    if (workspace.entry === "shared link") initial.searchParams.set(workspace.cursorKey, "cursor-two");
    window.history.replaceState(null, "", initial.href);
    const pager = () => container.querySelectorAll<HTMLElement>('[data-testid="admin-pagination"]')[workspace.pager]!;
    const button = (label: string) => [...pager().querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label)!;
    const lastRequestedCursor = () => [...vi.mocked(fetch).mock.calls].reverse()
      .map(([input]) => new URL(String(input), window.location.origin))
      .find(url => url.pathname === workspace.apiPath)?.searchParams.get("cursor") ?? null;
    const mount = async (marker: string) => {
      await act(async () => root.render(workspace.node()));
      await waitFor(() => container.textContent?.includes(marker) === true && Boolean(pager()) && !pager().querySelector(".animate-spin"));
    };
    if (workspace.entry === "reload") {
      await mount("page-first");
      expect(pager().textContent).toContain("Page 1");
      await act(async () => button("Next page").click());
      await waitFor(() => container.textContent?.includes("page-cursor-two") === true && !pager().querySelector(".animate-spin"));
      expect(pager().textContent).toContain("Page 2");
      await act(async () => root.unmount());
      root = createRoot(container);
    }
    await mount("page-cursor-two");
    expect(new URLSearchParams(window.location.search).get(workspace.cursorKey)).toBe("cursor-two");
    expect(lastRequestedCursor()).toBe("cursor-two");
    expect(pager().textContent).toContain("Page position unknown");
    expect(pager().textContent).toContain("Showing 1 rows");
    expect(pager().textContent).not.toMatch(/Page \d|Showing \d+–\d+/);
    expect(button("Back to first page").disabled).toBe(false);
    await act(async () => button("Next page").click());
    await waitFor(() => container.textContent?.includes("page-cursor-three") === true && !pager().querySelector(".animate-spin"));
    expect(lastRequestedCursor()).toBe("cursor-three");
    expect(pager().textContent).toContain("Page position unknown");
    expect(pager().textContent).not.toMatch(/Page \d/);
    await act(async () => button("Previous page").click());
    await waitFor(() => !pager().querySelector(".animate-spin") && new URLSearchParams(window.location.search).get(workspace.cursorKey) === "cursor-two");
    expect(lastRequestedCursor()).toBe("cursor-two");
    expect(pager().textContent).toContain("Page position unknown");
    await act(async () => button("Back to first page").click());
    await waitFor(() => !pager().querySelector(".animate-spin") && !new URLSearchParams(window.location.search).has(workspace.cursorKey));
    expect(lastRequestedCursor()).toBeNull();
    expect(pager().textContent).toContain("Page 1");
    expect(button("Previous page").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  throw new Error("Cursor workspace did not settle");
}
