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
function invoice(owner: string) {
  return ok({
    checkout: { id: `checkout-${owner}`, planId: plan.id, provider: "btcpay", status: "created", returnPath: "/generate", createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" },
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
async function mount() { await act(async () => root.render(createElement(UpgradeWorkspace))); await until(() => { const ready = button("Buy access") || button("Continue payment"); return Boolean(ready && !ready.disabled); }); }
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
