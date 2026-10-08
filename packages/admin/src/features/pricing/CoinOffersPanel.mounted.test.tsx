// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { ToastProvider } from "@/components/admin/ui/Toast";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { CoinOffersPanel } from "./CoinOffersPanel";
import { PricingWorkspace } from "./PricingWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const template = { id: "coin-offer-fixture", offerKey: "fixture-coins", name: "Fixture coins", dreamcoins: 125,
  priceCents: 99, currency: "usd", eligibility: "all", terms: "Controlled fixture terms for this offer.",
  version: 2, status: "draft", publishedAt: null as string | null, createdAt: "2026-09-10T00:00:00Z", fingerprint: "a".repeat(64) };
type Write = { path: string; method: string; body: Record<string, unknown>; key: string | null };
let offer: typeof template;
let container: HTMLDivElement;
let root: Root;
let writes: Write[];
let listReads: number;
let writeResponse: (write: Write) => Promise<Response>;
function savedOffer(action = "publish") { return Response.json({ ok: true, data: { offer: { ...offer, status: action === "retire" ? "retired" : "published", publishedAt: "2026-09-10T01:00:00Z" } } }); }
beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/admin/growth/offers?view=pricing");
  offer = { ...template, id: `coin-offer-${crypto.randomUUID()}` };
  writes = []; listReads = 0;
  writeResponse = async (write) => savedOffer(String(write.body.action));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (init?.method && init.method !== "GET") {
      const write = { path, method: init.method, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("idempotency-key") };
      writes.push(write);
      return writeResponse(write);
    }
    if (path === "/api/v2/admin/billing/coin-offers") {
      listReads += 1;
      return Response.json({ ok: true, data: { items: [offer] } });
    }
    if (path.startsWith("/api/v2/admin/pricing/rules")) return Response.json({ ok: true, data: { items: [], pageInfo: { endCursor: null, hasNextPage: false } } });
    throw new Error(`Unexpected read ${path}`);
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function mount(canWrite: boolean, workspace = false) {
  await act(async () => root.render(<AdminI18nProvider locale="en"><ToastProvider>{workspace ? <PricingWorkspace canWrite={canWrite} /> : <CoinOffersPanel canWrite={canWrite} />}</ToastProvider></AdminI18nProvider>));
  await act(async () => vi.advanceTimersByTimeAsync(1));
  if (workspace) await act(async () => {
    container.querySelector<HTMLDetailsElement>("#coin-offers")!.open = true;
    await vi.advanceTimersByTimeAsync(1);
  });
}
async function fill(label: string, value: string, scope: ParentNode = document) {
  const labelElement = [...scope.querySelectorAll("label")].find((element) => element.textContent?.startsWith(label));
  const field = labelElement?.control ?? labelElement?.querySelector("input, textarea") ?? scope.querySelector(`[aria-label="${label}"]`);
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) throw new Error(`Missing ${label}`);
  const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
}
function button(label: string, scope: ParentNode = document) {
  const element = [...scope.querySelectorAll("button")].find((element) => element.textContent === label);
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
}
async function confirm(action: string, reason = "Controlled publication review") {
  await act(async () => button(action, container).click());
  const dialog = document.querySelector('[role="dialog"]')!;
  await fill("Reason (≥3)", reason, dialog);
  await fill("Type the name to confirm", offer.name, dialog);
  return dialog;
}

describe("coin offer operator actions", () => {
  it("provides a read-only catalog without mutation controls for readers", async () => {
    await mount(false);
    expect(container.textContent).toContain("Fixture coins");
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain("Publish coin offer");
    expect(writes).toEqual([]);
  });

  it("refreshes the mounted catalog from the workspace event while preserving an entered offer draft", async () => {
    await mount(true, true);
    const form = container.querySelector<HTMLFormElement>('form[aria-label="Create coin offer draft"]')!;
    await fill("Offer name", "Unsubmitted weekend offer", form);
    await fill("Price in cents", "299", form);
    await fill("Customer purchase and refund terms", "Unsubmitted purchase terms must survive refresh.", form);
    expect(listReads).toBe(1);

    offer = { ...offer, name: "Fresh catalog offer", priceCents: 149, version: 3 };
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));

    expect(listReads).toBe(2);
    expect(container.textContent).toContain("Fresh catalog offer");
    expect(container.textContent).not.toContain("Fixture coins");
    expect(form).toBe(container.querySelector('form[aria-label="Create coin offer draft"]'));
    expect(form.querySelector<HTMLInputElement>('input[value="Unsubmitted weekend offer"]')?.value).toBe("Unsubmitted weekend offer");
    expect(form.querySelector<HTMLInputElement>('input[type="number"][value="299"]')?.value).toBe("299");
    expect(form.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Unsubmitted purchase terms must survive refresh.");
    expect(writes).toEqual([]);
  });

  it("requires explicit name/reason confirmation and resends an uncertain publish with its original key", async () => {
    writeResponse = async () => { if (writes.length === 1) throw new TypeError("Controlled lost response"); return savedOffer(); };
    await mount(true, true);
    await act(async () => button("Publish coin offer", container).click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(offer.terms);
    expect(button("Publish coin offer", dialog).disabled).toBe(true);
    await fill("Reason (≥3)", "Controlled publication review", dialog);
    await fill("Type the name to confirm", offer.name, dialog);
    await act(async () => button("Publish coin offer", dialog).click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(writes).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(writes).toHaveLength(1);
    await act(async () => button("Publish coin offer", dialog).click());
    expect(writes).toHaveLength(2);
    expect(writes[0]!.key).toBeTruthy();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toEqual({
      path: `/api/v2/admin/billing/coin-offers/${offer.id}/state`, method: "POST", key: expect.any(String),
      body: { version: 2, action: "publish", confirmation: `${offer.id}:publish`, reason: "Controlled publication review" },
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("offers an approval request when dual approval refuses the publish", async () => {
    writeResponse = async (write) => write.path.endsWith("/state")
      ? Response.json({ ok: false, error: { code: "forbidden", message: "Dual approval required: no approved request for this action" } }, { status: 403 })
      : Response.json({ ok: true, data: { request: { id: "approval-1" } } });
    await mount(true);
    const dialog = await confirm("Publish coin offer", "Launch weekend pack");
    await act(async () => button("Publish coin offer", dialog).click());
    expect(container.querySelector('[data-testid="coin-offer-publish-approval-required"]')).not.toBeNull();
    await act(async () => button("Request approval", container).click());
    expect(writes.at(-1)).toEqual(expect.objectContaining({ path: "/api/v2/admin/approvals", method: "POST", body: {
      permissionKey: "config.pricing.write", action: "config.coin_offer.publish", targetType: "coin_offer",
      targetId: offer.id, payload: {}, reason: "Launch weekend pack", confirmation: `${offer.id}:config.coin_offer.publish`,
    } }));
    expect(container.querySelector('[data-testid="coin-offer-publish-approval-required"]')).toBeNull();
  });

  it("creates an unpublished draft with entered commercial terms and no default price", async () => {
    writeResponse = async () => Response.json({ ok: true, data: { offer } });
    await mount(true);
    const form = container.querySelector("form")!;
    expect([...form.querySelectorAll('input[type="number"]')].every((element) => (element as HTMLInputElement).value === "")).toBe(true);
    for (const [label, value] of [
      ["Offer key", "fixture-coins"], ["Offer name", "Fixture coins"], ["Dreamcoin amount", "125"],
      ["Price in cents", "99"], ["Reason (≥3)", "Controlled draft test"], ["Customer purchase and refund terms", offer.terms],
    ]) await fill(label, value, form);
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/api/v2/admin/billing/coin-offers");
    expect(writes[0]!.body).toEqual({ offerKey: "fixture-coins", name: "Fixture coins", dreamcoins: 125,
      priceCents: 99, currency: "usd", eligibility: "all", terms: offer.terms, reason: "Controlled draft test" });
    expect(writes[0]!.body).not.toHaveProperty("status");
  });

  it.each(["publish", "retire"] as const)("discards a %s confirmation on permission revocation and requires a fresh one on regrant", async (action) => {
    if (action === "retire") offer = { ...offer, status: "published", publishedAt: "2026-09-10T01:00:00Z" };
    const title = action === "publish" ? "Publish coin offer" : "Retire coin offer";
    await mount(true, true);
    await confirm(title, "Revoked operator decision");
    await mount(false, true);
    const revoked = document.querySelector('[role="dialog"]');
    if (revoked) await act(async () => button(title, revoked).click());
    expect(writes).toEqual([]);
    expect(revoked).toBeNull();
    await mount(true, true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button(title, container).click());
    const fresh = document.querySelector('[role="dialog"]')!;
    expect(button(title, fresh).disabled).toBe(true);
    await fill("Reason (≥3)", "Fresh operator decision", fresh);
    await fill("Type the name to confirm", offer.name, fresh);
    await act(async () => button(title, fresh).click());
    expect(writes).toEqual([expect.objectContaining({ path: `/api/v2/admin/billing/coin-offers/${offer.id}/state`, body: {
      version: 2, action, confirmation: `${offer.id}:${action}`, reason: "Fresh operator decision",
    } })]);
  });

  it.each(["success", "approval"] as const)("does not let a pre-revocation %s receipt reload the catalog or close a fresh confirmation", async (outcome) => {
    let finishOld!: (response: Response) => void;
    writeResponse = () => new Promise((resolve) => { finishOld = resolve; });
    await mount(true, true);
    const old = await confirm("Publish coin offer");
    await act(async () => button("Publish coin offer", old).click());
    expect(writes).toHaveLength(1);
    await mount(false, true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await mount(true, true);
    const fresh = await confirm("Publish coin offer", "Fresh confirmation remains");
    const readsBefore = listReads;
    await act(async () => finishOld(outcome === "success" ? savedOffer()
      : Response.json({ ok: false, error: { code: "forbidden", message: "Dual approval required: no approved request for this action" } }, { status: 403 })));
    expect(document.querySelector('[role="dialog"]')).toBe(fresh);
    expect(listReads).toBe(readsBefore);
    expect(container.querySelector('[data-testid="coin-offer-publish-approval-required"]')).toBeNull();
    expect(writes).toHaveLength(1);
    expect(fresh.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!.value).toBe("Fresh confirmation remains");
  });
});
