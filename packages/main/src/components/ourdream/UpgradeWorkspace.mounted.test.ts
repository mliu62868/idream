// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicPlan } from "@/lib/public-api-contracts";
import {
  createPendingCheckoutIntent,
  readPendingCheckoutIntents,
  writePendingCheckoutIntents,
} from "@/lib/billing-checkout-intent";
import { invalidateViewerAuthority } from "./viewer-auth";
import { UpgradeWorkspace } from "./UpgradeWorkspace";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plan: PublicPlan = {
  id: "premium-monthly", slug: "premium", name: "Premium", billingPeriod: "monthly",
  priceCents: 1999, includedDreamcoins: 500, features: {},
};
const billing = { provider: "btcpay", demoMode: false, autoConfirmAvailable: false, billingModel: "prepaid_period", renewalCapability: "none" };
const ok = (data: unknown) => Response.json({ ok: true, data });
function invoice(owner: string, selectedPlan = plan, returnPath = "/generate") {
  return ok({
    checkout: { id: `checkout-${owner}`, planId: selectedPlan.id, provider: "btcpay", status: "created", returnPath, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" },
    invoice: { provider: "btcpay", invoiceId: `invoice-${owner}`, checkoutUrl: `https://payment.example.test/${owner}`, status: "created", additionalStatus: "none" },
    subscription: null, billingAccess: null, billing,
  });
}
let root: Root, container: HTMLDivElement, viewer: string;
beforeEach(() => {
  viewer = "owner-a";
  invalidateViewerAuthority(); window.sessionStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  window.history.replaceState(null, "", "/");
  invalidateViewerAuthority(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function read(path: string) {
  if (path === "/api/v1/me") return ok({ user: { id: viewer } });
  if (path === "/api/v1/plans") return ok({ items: [plan], billing });
  if (path === "/api/v1/profile") return ok({ user: { id: viewer, email: `${viewer}@example.test` }, balance: 5, subscription: null, billingAccess: null, entitlements: {} });
  throw new Error(`Unexpected read ${path}`);
}
async function until(condition: () => boolean) {
  for (let index = 0; index < 40; index += 1) {
    if (condition()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  expect(condition()).toBe(true);
}
function button(text: string) { return [...container.querySelectorAll("button")].find(element => element.textContent?.trim() === text); }
async function mount() { await act(async () => root.render(createElement(UpgradeWorkspace))); await until(() => { const ready = button("Buy access") || button("Continue payment") || button("Resume checkout"); return Boolean(ready && !ready.disabled); }); }
async function click(text: string) { const target = button(text); expect(target).toBeTruthy(); await act(async () => target!.click()); }

describe("prepaid access checkout stays with its confirmed account", () => {
  it("does not read private access data until the account has been confirmed", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me"
      ? new Promise<Response>(resolve => { finish = resolve; }) : read(String(input)));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(UpgradeWorkspace)));
    await until(() => fetcher.mock.calls.some(([path]) => String(path) === "/api/v1/me") && Boolean(button("Buy access")));
    expect(button("Buy access")!.disabled).toBe(true);
    expect(fetcher.mock.calls.some(([path]) => String(path) === "/api/v1/profile")).toBe(false);
    await act(async () => finish(ok({ user: { id: viewer } })));
    await until(() => Boolean(button("Buy access") && !button("Buy access")!.disabled));
    await until(() => fetcher.mock.calls.some(([path]) => String(path) === "/api/v1/profile"));
  });

  it("rejects a malformed account without requesting private access data", async () => {
    let finishPlans!: (response: Response) => void;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/plans"
      ? new Promise<Response>(resolve => { finishPlans = resolve; })
      : String(input) === "/api/v1/me" ? ok({ user: {} }) : read(String(input)));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(UpgradeWorkspace)));
    await until(() => Boolean(button("Retry account check")) && Boolean(finishPlans));
    expect(container.querySelector('[data-testid="upgrade-plans-status"]')?.textContent).toContain("Loading plans");
    expect(button("Buy access")).toBeUndefined();
    await act(async () => finishPlans(read("/api/v1/plans")));
    await until(() => Boolean(button("Retry account check")) && Boolean(button("Buy access")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The server sent a response this page could not read");
    expect(button("Buy access")?.disabled).toBe(true);
    expect(fetcher.mock.calls.some(([path]) => String(path) === "/api/v1/profile")).toBe(false);
    expect(fetcher.mock.calls.some(([path]) => String(path) === "/api/v1/billing/checkout")).toBe(false);
  });

  it("keeps the guest's task through signup without reading private access data or submitting payment", async () => {
    const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me"
      ? ok({ user: null }) : read(String(input)));
    vi.stubGlobal("fetch", fetcher);
    await mount(); await click("Buy access");
    expect(navigate).toHaveBeenCalledWith("/signup?next=%2Fupgrade%3Fplan%3Dpremium%26billing%3Dmonthly");
    expect(fetcher.mock.calls.some(([path]) => String(path) === "/api/v1/profile" || String(path) === "/api/v1/billing/checkout")).toBe(false);
  });

  it("replays a same-account unknown submission with its original key and saves its invoice", async () => {
    const requests: Array<{ key: string | null; scope: string | null; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/v1/billing/checkout") return read(String(input));
      const headers = new Headers(init?.headers);
      requests.push({ key: headers.get("idempotency-key"), scope: headers.get("x-idream-viewer-scope"), body: String(init?.body) });
      if (requests.length === 1) throw new TypeError("Controlled connection lost");
      return invoice(viewer);
    }));
    await mount();
    await click("Buy access");
    const saved = readPendingCheckoutIntents(window.sessionStorage, "owner-a");
    expect(saved).toHaveLength(1);
    expect(button("Resume checkout")).toBeTruthy();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await click("Resume checkout");
    await until(() => Boolean(container.querySelector('a[href="https://payment.example.test/owner-a"]')));
    expect(requests).toEqual([
      { key: saved[0]!.idempotencyKey, scope: "user:owner-a", body: JSON.stringify({ planId: plan.id, autoConfirm: false, returnPath: "/generate" }) },
      { key: saved[0]!.idempotencyKey, scope: "user:owner-a", body: JSON.stringify({ planId: plan.id, autoConfirm: false, returnPath: "/generate" }) },
    ]);
    expect(readPendingCheckoutIntents(window.sessionStorage, "owner-a")[0]?.checkoutUrl).toBe("https://payment.example.test/owner-a");
    expect(readPendingCheckoutIntents(window.sessionStorage, "owner-b")).toEqual([]);
  });

  it("removes the previous account's saved payment after focus confirms another account", async () => {
    const receipt = { ...createPendingCheckoutIntent({ planId: plan.id, autoConfirm: false, returnPath: "/generate" }, "owner-a-saved-key"), checkoutUrl: "https://payment.example.test/owner-a" };
    writePendingCheckoutIntents(window.sessionStorage, "owner-a", [receipt]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => read(String(input))));
    await mount();
    await until(() => Boolean(button("Continue payment")));
    expect(button("Continue payment")).toBeTruthy();
    viewer = "owner-b";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await until(() => !button("Continue payment"));
    expect(readPendingCheckoutIntents(window.sessionStorage, "owner-a")).toEqual([receipt]);
    expect(readPendingCheckoutIntents(window.sessionStorage, "owner-b")).toEqual([]);
  });

  it("refuses to create an invoice for a changed cookie before focus arrives", async () => {
    const accepted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/v1/billing/checkout") return read(String(input));
      // Match Main's expected-viewer constraint before any billing side effect.
      const expected = new Headers(init?.headers).get("x-idream-viewer-scope");
      if (expected !== null && expected !== `user:${viewer}`) return Response.json({ ok: false, error: { code: "conflict", message: "Your account changed. Review the current account before continuing." } }, { status: 409 });
      accepted.push(viewer);
      return invoice(viewer);
    }));
    await mount();
    viewer = "owner-b";
    await click("Buy access");
    expect(accepted).toEqual([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/account changed/i);
    expect(container.querySelector('a[href="https://payment.example.test/owner-b"]')).toBeNull();
  });

  it("does not show an old account's late invoice after focus detects another account", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/billing/checkout"
      ? new Promise<Response>(resolve => { finish = resolve; }) : read(String(input))));
    await mount();
    await click("Buy access");
    await until(() => Boolean(finish));
    viewer = "owner-b";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => finish(invoice("owner-a")));
    await until(() => !button("Creating checkout..."));
    expect(container.querySelector('a[href="https://payment.example.test/owner-a"]')).toBeNull();
    expect(readPendingCheckoutIntents(window.sessionStorage, "owner-b")).toEqual([]);
    expect(readPendingCheckoutIntents(window.sessionStorage, "owner-a")[0]?.checkoutUrl).toBeUndefined();
  });
});

describe("upgrade page keeps the visitor's way back and makes plans comparable", () => {
  it("links back to the chat that sent them and prices a yearly plan per month", async () => {
    window.history.replaceState(null, "", "/upgrade?returnTo=%2Fchat%2Fsession-1");
    const yearly: PublicPlan = { ...plan, id: "premium-yearly", billingPeriod: "yearly", priceCents: 9990 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/plans"
      ? ok({ items: [plan, yearly], billing }) : read(String(input))));
    try {
      await mount();
      const back = container.querySelector<HTMLAnchorElement>('[data-testid="upgrade-return-link"]');
      expect(back?.getAttribute("href")).toBe("/chat/session-1");
      expect(back?.textContent).toBe("Back to your chat");
      expect(container.querySelector('[data-testid="upgrade-plan-monthly-equivalent"]')).toBeNull();
      await click("Yearly");
      const equivalents = [...container.querySelectorAll('[data-testid="upgrade-plan-monthly-equivalent"]')].map(node => node.textContent);
      expect(equivalents).toEqual(["$8.33 per month, paid once for the year"]);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("compares only published offers in the selected period without starting checkout", async () => {
    const yearly: PublicPlan = { ...plan, id: "premium-yearly", billingPeriod: "yearly", priceCents: 9990 };
    const deluxe: PublicPlan = { ...plan, id: "deluxe-monthly", slug: "deluxe", name: "Deluxe", priceCents: 5999 };
    const deluxeYearly: PublicPlan = { ...deluxe, id: "deluxe-yearly", billingPeriod: "yearly", priceCents: 29990 };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/plans"
      ? ok({ items: [deluxeYearly, deluxe, yearly, plan], billing }) : read(String(input)));
    vi.stubGlobal("fetch", fetcher);
    await mount();
    const headings = () => [...container.querySelectorAll("article h2")].map(node => node.textContent);
    expect(headings()).toEqual(["Premium monthly", "Deluxe monthly"]);
    expect(button("Monthly")?.getAttribute("aria-pressed")).toBe("true");
    await click("Yearly");
    expect(headings()).toEqual(["Premium yearly", "Deluxe yearly"]);
    expect(button("Yearly")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Monthly")?.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("Your existing chats and delivered media stay accessible after your access expires.");
    expect(fetcher.mock.calls.some(([path]) => String(path) === "/api/v1/billing/checkout")).toBe(false);
  });

  it("restores the requested yearly period and submits that exact offer with the original task", async () => {
    window.history.replaceState(null, "", "/upgrade?billing=yearly&returnTo=%2Fchat%2Fsession-1");
    const yearly: PublicPlan = { ...plan, id: "premium-yearly", billingPeriod: "yearly", priceCents: 9990 };
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/plans") return ok({ items: [plan, yearly], billing });
      if (String(input) === "/api/v1/billing/checkout") {
        requests.push(JSON.parse(String(init?.body)));
        return invoice(viewer, yearly, "/chat/session-1");
      }
      return read(String(input));
    }));
    await mount();
    expect(container.querySelector("article h2")?.textContent).toBe("Premium yearly");
    await click("Buy access");
    expect(requests).toEqual([{ planId: yearly.id, autoConfirm: false, returnPath: "/chat/session-1" }]);
  });

  it.each([
    { outcome: "unknown submission", loseFirstResponse: true, action: "Resume checkout" },
    { outcome: "created invoice", loseFirstResponse: false, action: "Continue payment" },
  ])("restores a yearly $outcome after remount and reuses the original purchase intent", async ({ loseFirstResponse, action }) => {
    window.history.replaceState(null, "", "/upgrade?returnTo=%2Fchat%2Fsession-1&source=chat#plans");
    const yearly: PublicPlan = { ...plan, id: "premium-yearly", billingPeriod: "yearly", priceCents: 9990 };
    const requests: Array<{ key: string | null; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/plans") return ok({ items: [plan, yearly], billing });
      if (String(input) === "/api/v1/billing/checkout") {
        requests.push({ key: new Headers(init?.headers).get("idempotency-key"), body: JSON.parse(String(init?.body)) });
        if (loseFirstResponse && requests.length === 1) throw new TypeError("Controlled connection lost");
        return invoice(viewer, yearly, "/chat/session-1");
      }
      return read(String(input));
    }));
    await mount();
    await click("Yearly");
    await click("Buy access");
    await until(() => Boolean(button(action)));
    const originalIntent = readPendingCheckoutIntents(window.sessionStorage, viewer)[0];
    expect(originalIntent?.planId).toBe(yearly.id);

    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    await until(() => Boolean(button(action)));
    expect(container.querySelector("article h2")?.textContent).toBe("Premium yearly");
    expect(button(action)).toBeTruthy();
    const params = new URLSearchParams(window.location.search);
    expect(params.get("billing")).toBe("yearly");
    expect(params.get("returnTo")).toBe("/chat/session-1");
    expect(params.get("source")).toBe("chat");
    expect(window.location.hash).toBe("#plans");
    await click(action);
    expect(requests).toEqual(Array.from({ length: 2 }, () => ({
      key: originalIntent?.idempotencyKey,
      body: { planId: yearly.id, autoConfirm: false, returnPath: "/chat/session-1" },
    })));
  });

  it("keeps a single available period reachable when the incoming period is unavailable", async () => {
    window.history.replaceState(null, "", "/upgrade?billing=monthly");
    const yearly: PublicPlan = { ...plan, id: "premium-yearly", billingPeriod: "yearly", priceCents: 9990 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/plans"
      ? ok({ items: [yearly], billing }) : read(String(input))));
    await mount();
    expect(container.querySelector("article h2")?.textContent).toBe("Premium yearly");
    expect(container.querySelector('[aria-label="Access period"]')).toBeNull();
    expect(container.textContent).toContain("Yearly access");
    expect(button("Buy access")?.disabled).toBe(false);
  });

  it("keeps current access visible across period switches and prevents repurchasing that offer", async () => {
    const yearly: PublicPlan = { ...plan, id: "premium-yearly", billingPeriod: "yearly", priceCents: 9990 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/plans") return ok({ items: [plan, yearly], billing });
      if (String(input) === "/api/v1/profile") return ok({
        user: { id: viewer, email: `${viewer}@example.test` }, balance: 5,
        subscription: { id: "subscription-a", userId: viewer, planId: yearly.id, status: "active", offerAuthority: "checkout_snapshot", plan: yearly },
        billingAccess: { provider: "btcpay", billingModel: "prepaid_period", renewalCapability: "none", benefitsEndAt: "2027-10-04T00:00:00.000Z", renewsAt: null },
        entitlements: {},
      });
      return read(String(input));
    }));
    await mount();
    await until(() => Boolean(container.querySelector('[data-testid="upgrade-current-access"]')));
    expect(container.querySelector('[data-testid="upgrade-current-access"]')?.textContent).toContain("Premium yearly");
    await click("Yearly");
    expect(button("Current plan")?.disabled).toBe(true);
    await click("Monthly");
    expect(container.querySelector('[data-testid="upgrade-current-access"]')?.textContent).toContain("Premium yearly");
    expect(button("Buy access")?.disabled).toBe(false);
  });

  it("shows a purchased yearly allowance separately from today's offer without allowing the same plan to be bought again", async () => {
    const yearly: PublicPlan = { ...plan, id: "premium-yearly", billingPeriod: "yearly", priceCents: 9990, features: { voiceEnabled: true, voiceMinutes: 30 } };
    const purchased: PublicPlan = { ...yearly, features: { voiceEnabled: true, voiceMinutes: 360 } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/plans") return ok({ items: [plan, yearly], billing });
      if (String(input) === "/api/v1/profile") return ok({
        user: { id: viewer, email: `${viewer}@example.test` }, balance: 5,
        subscription: { id: "subscription-a", userId: viewer, planId: purchased.id, status: "active", offerAuthority: "checkout_snapshot", plan: purchased },
        billingAccess: { provider: "btcpay", billingModel: "prepaid_period", renewalCapability: "none", benefitsEndAt: "2027-10-04T00:00:00.000Z", renewsAt: null },
        entitlements: { voice_enabled: true, voice_minutes: 360 },
      });
      return read(String(input));
    }));
    await mount();
    await until(() => Boolean(container.querySelector('[data-testid="upgrade-current-access"]')));
    const purchasedAccess = () => container.querySelector('[data-testid="upgrade-current-access"]')?.textContent;
    expect(purchasedAccess()).toContain("360 voice minutes");
    expect(purchasedAccess()).not.toContain("30 voice minutes");
    await click("Yearly");
    expect(container.querySelector("article")?.textContent).toContain("30 voice minutes");
    expect(container.querySelector("article")?.textContent).not.toContain("360 voice minutes");
    expect(container.querySelector("article")?.textContent).toContain("Your purchased benefits are listed above.");
    expect(button("Already active")?.disabled).toBe(true);
    expect(purchasedAccess()).toContain("360 voice minutes");
    await click("Monthly");
    expect(purchasedAccess()).toContain("360 voice minutes");
  });

  it("uses the activated purchase snapshot when resuming an older invoice from a changed catalog", async () => {
    const yearly: PublicPlan = { ...plan, id: "premium-yearly", billingPeriod: "yearly", priceCents: 9990, features: { voiceEnabled: true, voiceMinutes: 30 } };
    const purchased: PublicPlan = { ...yearly, features: { voiceEnabled: true, voiceMinutes: 360 } };
    const receipt = { ...createPendingCheckoutIntent({ planId: purchased.id, autoConfirm: false, returnPath: "/generate" }, "purchased-yearly-key"), checkoutUrl: "https://payment.example.test/old-yearly" };
    writePendingCheckoutIntents(window.sessionStorage, viewer, [receipt]);
    let profileLoaded = false;
    let activated = false;
    let submittedKey: string | null = null;
    const subscription = { id: "subscription-a", userId: viewer, planId: purchased.id, status: "active", offerAuthority: "checkout_snapshot", plan: purchased };
    const billingAccess = { provider: "btcpay", billingModel: "prepaid_period", renewalCapability: "none", benefitsEndAt: "2027-10-04T00:00:00.000Z", renewsAt: null };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/plans") return ok({ items: [yearly], billing });
      if (String(input) === "/api/v1/profile") {
        profileLoaded = true;
        if (activated) return ok({ user: { id: viewer, email: `${viewer}@example.test` }, balance: 5, subscription, billingAccess, entitlements: { voice_enabled: true, voice_minutes: 360 } });
      }
      if (String(input) === "/api/v1/billing/checkout") {
        submittedKey = new Headers(init?.headers).get("idempotency-key");
        activated = true;
        return ok({
          checkout: { id: "checkout-old-yearly", planId: purchased.id, provider: "btcpay", status: "completed", returnPath: "/generate", createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" },
          invoice: { provider: "btcpay", invoiceId: "invoice-old-yearly", checkoutUrl: receipt.checkoutUrl, status: "settled", additionalStatus: "none" },
          subscription,
          billingAccess,
          billing,
        });
      }
      return read(String(input));
    }));
    await mount();
    await until(() => profileLoaded && Boolean(button("Continue payment")));
    await click("Continue payment");
    await until(() => Boolean(container.querySelector('[data-testid="upgrade-current-access"]')));
    expect(submittedKey).toBe("purchased-yearly-key");
    expect(container.querySelector('[data-testid="upgrade-current-access"]')?.textContent).toContain("360 voice minutes");
    expect(container.querySelector("article")?.textContent).toContain("30 voice minutes");
    expect(button("Already active")?.disabled).toBe(true);
    expect(readPendingCheckoutIntents(window.sessionStorage, viewer)).toEqual([]);
  });

  it("shows the unavailable state without phantom periods or purchase controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/plans"
      ? ok({ items: [], billing }) : read(String(input))));
    await act(async () => root.render(createElement(UpgradeWorkspace)));
    await until(() => container.textContent?.includes("No plans available right now.") === true);
    expect(container.querySelectorAll("article")).toHaveLength(0);
    expect(button("Monthly")).toBeUndefined();
    expect(button("Yearly")).toBeUndefined();
    expect(button("Buy access")).toBeUndefined();
  });
});
