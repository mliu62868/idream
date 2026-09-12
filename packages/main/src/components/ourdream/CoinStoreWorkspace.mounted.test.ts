// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePendingCoinCheckout, readPendingCoinCheckout } from "@/lib/coin-checkout-intent";
import { CoinStoreWorkspace } from "./CoinStoreWorkspace";

vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode }) => createElement("a", props, children) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const offer = { id: "offer-fixture", offerKey: "fixture", name: "Fixture coins", dreamcoins: 125,
  priceCents: 99, currency: "usd", eligibility: "all", terms: "Controlled fixture terms for the test purchase.",
  version: 1, status: "published", publishedAt: "2026-09-10T00:00:00Z", createdAt: "2026-09-10T00:00:00Z", fingerprint: "a".repeat(64), eligible: true };
const purchase = { id: "purchase-fixture", status: "created", provider: "mock",
  offer: { id: offer.id, offerKey: offer.offerKey, name: offer.name, dreamcoins: offer.dreamcoins,
    priceCents: offer.priceCents, currency: offer.currency, eligibility: offer.eligibility, terms: offer.terms,
    version: offer.version, fingerprint: offer.fingerprint },
  invoiceId: "invoice-fixture", checkoutUrl: "https://payment.example.test/invoice", returnPath: "/generate",
  createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z", needsReconciliation: false };
const ok = (data: unknown) => Response.json({ ok: true, data });
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let container: HTMLDivElement;
let root: Root;
let viewer: string;
function reads(url: string) {
  if (url === "/api/v1/me") return ok({ user: { id: viewer } });
  if (url === "/api/v1/billing/coin-offers") return ok({ viewerId: viewer, balance: 7,
    billing: { provider: "mock", demoMode: true }, offers: [offer] });
  if (url === "/api/v1/billing/coin-purchases") return ok({ items: [], nextCursor: null });
  throw new Error(`Unexpected request ${url}`);
}
beforeEach(() => {
  viewer = "owner-a"; vi.useFakeTimers(); window.sessionStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });
async function mount() { await act(async () => root.render(createElement(CoinStoreWorkspace))); await act(async () => vi.advanceTimersByTimeAsync(1)); }
function button(text: string) {
  const value = [...container.querySelectorAll("button")].find((element) => element.textContent === text);
  if (!value) throw new Error(`Missing button ${text}`);
  return value;
}
async function click(text: string) { await act(async () => button(text).click()); }

describe("coin checkout recovery and viewer ownership", () => {
  it("loads prices without creating an invoice and shows exact terms before explicit payment submission", async () => {
    const fetcher = vi.fn<Fetcher>(async (url) => reads(String(url))); vi.stubGlobal("fetch", fetcher);
    await mount();
    expect(container.textContent).toContain("7 dreamcoins");
    expect(container.textContent).toContain("No real cryptocurrency is collected");
    await click("Review purchase");
    expect(container.textContent).toContain(offer.terms);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(container.querySelector('a[href="/generate"]')).not.toBeNull();
  });

  it("persists an unknown submission and resumes the same payload and idempotency key after remount", async () => {
    let submissions = 0;
    const fetcher = vi.fn<Fetcher>(async (url, init) => {
      if (init?.method === "POST") {
        submissions += 1;
        expect(readPendingCoinCheckout(window.sessionStorage, "owner-a")).not.toBeNull();
        if (submissions === 1) throw new TypeError("Controlled connection lost");
        return ok({ purchase, balance: 7 });
      }
      return reads(String(url));
    }); vi.stubGlobal("fetch", fetcher);
    await mount(); await click("Review purchase"); await click("Continue to crypto checkout");
    expect(container.textContent).toContain("Check your previous checkout");
    expect(button("Review purchase").disabled).toBe(true);
    const saved = readPendingCoinCheckout(window.sessionStorage, "owner-a")!;
    await act(async () => root.unmount()); root = createRoot(container); await mount();
    expect(submissions).toBe(1);
    await click("Resume saved checkout");
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(2);
    expect(writes[1][1]).toMatchObject({ body: JSON.stringify(saved.body), headers: {
      "content-type": "application/json", "idempotency-key": saved.key, "x-idream-viewer-scope": "user:owner-a" } });
    expect(writes[0][1]?.body).toBe(writes[1][1]?.body);
    expect(readPendingCoinCheckout(window.sessionStorage, "owner-a")).toBeNull();
    expect(container.textContent).toContain("invoice is saved");
    expect(container.textContent).not.toContain("125 dreamcoins added");
  });

  it("refreshing a prior purchase cannot discard a different unknown checkout receipt", async () => {
    const saved = savePendingCoinCheckout(window.sessionStorage, "owner-a", { offerId: offer.id, offerFingerprint: offer.fingerprint, returnPath: "/generate" });
    const fetcher = vi.fn<Fetcher>(async (url, init) => {
      if (init?.method === "POST") return ok({ purchase: { ...purchase, status: "completed" }, balance: 132 });
      if (String(url) === "/api/v1/billing/coin-purchases") return ok({ items: [purchase], nextCursor: null });
      return reads(String(url));
    }); vi.stubGlobal("fetch", fetcher);
    await mount(); await click("Refresh payment status");
    expect(readPendingCoinCheckout(window.sessionStorage, "owner-a")).toEqual(saved);
    expect(container.textContent).toContain("Check your previous checkout");
    expect(container.textContent).toContain("125 dreamcoins added");
    expect(container.textContent).toContain("132 dreamcoins");
  });

  it("checks current viewer before payment and clears the old account presentation on a switch", async () => {
    const fetcher = vi.fn<Fetcher>(async (url) => reads(String(url))); vi.stubGlobal("fetch", fetcher);
    await mount(); await click("Review purchase"); viewer = "owner-b"; await click("Continue to crypto checkout");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(container.querySelector('[aria-label="Review coin purchase"]')).toBeNull();
    expect(readPendingCoinCheckout(window.sessionStorage, "owner-a")).toBeNull();
  });

  it("does not load or resume another viewer's unknown receipt", async () => {
    savePendingCoinCheckout(window.sessionStorage, "owner-b", { offerId: offer.id, offerFingerprint: offer.fingerprint, returnPath: "/generate" });
    vi.stubGlobal("fetch", vi.fn<Fetcher>(async (url) => reads(String(url))));
    await mount();
    expect(container.textContent).not.toContain("Check your previous checkout");
    expect(button("Review purchase").disabled).toBe(false);
    expect(readPendingCoinCheckout(window.sessionStorage, "owner-b")).not.toBeNull();
  });

  it.each([true, false])("drops a delayed checkout after an account switch (focus: %s) and preserves its owner's receipt", async (focus) => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<Fetcher>(async (url, init) => init?.method === "POST"
      ? new Promise<Response>((resolve) => { complete = resolve; })
      : reads(String(url)));
    vi.stubGlobal("fetch", fetcher);
    await mount(); await click("Review purchase"); await click("Continue to crypto checkout");
    const saved = readPendingCoinCheckout(window.sessionStorage, "owner-a");
    expect(saved).not.toBeNull();
    viewer = "owner-b";
    if (focus) {
      await act(async () => window.dispatchEvent(new Event("focus")));
      expect(container.textContent).not.toContain("Check your previous checkout");
      expect(container.querySelector('[aria-label="Review coin purchase"]')).toBeNull();
    }
    await act(async () => complete(ok({ purchase, balance: 999 })));
    expect(container.textContent).not.toContain("999 dreamcoins");
    expect(container.textContent).not.toContain(purchase.id);
    expect(container.querySelector(`a[href="${purchase.checkoutUrl}"]`)).toBeNull();
    expect(readPendingCoinCheckout(window.sessionStorage, "owner-a")).toEqual(saved);
    expect(readPendingCoinCheckout(window.sessionStorage, "owner-b")).toBeNull();
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the same receipt when its original payment provider is unavailable", async () => {
    const saved = savePendingCoinCheckout(window.sessionStorage, "owner-a", { offerId: offer.id, offerFingerprint: offer.fingerprint, returnPath: "/generate" });
    vi.stubGlobal("fetch", vi.fn<Fetcher>(async (url, init) => init?.method === "POST"
      ? Response.json({ ok: false, error: { code: "unavailable", message: "This checkout's original payment provider is unavailable." } }, { status: 503 })
      : reads(String(url))));
    await mount(); await click("Resume saved checkout");
    expect(readPendingCoinCheckout(window.sessionStorage, "owner-a")).toEqual(saved);
    expect(container.textContent).toContain("Check your previous checkout");
    expect(button("Review purchase").disabled).toBe(true);
  });

  it("clears a rejected admission only when the server confirms a new key is safe", async () => {
    const fetcher = vi.fn<Fetcher>(async (url, init) => init?.method === "POST"
      ? Response.json({ ok: false, error: { message: "The offer was retired", details: { idempotencyAction: "new_key" } } }, { status: 409 })
      : reads(String(url)));
    vi.stubGlobal("fetch", fetcher);
    await mount(); await click("Review purchase"); await click("Continue to crypto checkout");
    expect(container.textContent).toContain("The offer was retired");
    expect(container.textContent).not.toContain("Check your previous checkout");
    expect(readPendingCoinCheckout(window.sessionStorage, "owner-a")).toBeNull();
  });
});
