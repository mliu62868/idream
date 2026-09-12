// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiGet, apiWrite } = vi.hoisted(() => ({ apiGet: vi.fn(), apiWrite: vi.fn() }));
vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));
vi.mock("@/components/admin/i18n", () => ({ useAdminI18n: () => ({ t: (value: string) => value, value: (value: string) => value }) }));
import { CoinOffersPanel } from "./CoinOffersPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const offer = { id: "coin-offer-fixture", offerKey: "fixture-coins", name: "Fixture coins", dreamcoins: 125,
  priceCents: 99, currency: "usd", eligibility: "all", terms: "Controlled fixture terms for this offer.",
  version: 2, status: "draft", publishedAt: null, createdAt: "2026-09-10T00:00:00Z", fingerprint: "a".repeat(64) };
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers(); apiGet.mockReset(); apiWrite.mockReset(); apiGet.mockResolvedValue({ items: [offer] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function mount(canWrite: boolean) {
  await act(async () => root.render(<CoinOffersPanel canWrite={canWrite} />));
  await act(async () => vi.advanceTimersByTimeAsync(1));
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

describe("coin offer operator actions", () => {
  it("provides a read-only catalog without mutation controls for readers", async () => {
    await mount(false);
    expect(container.textContent).toContain("Fixture coins");
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain("Publish coin offer");
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("requires explicit name/reason confirmation and resends an uncertain publish with its original key", async () => {
    apiWrite.mockRejectedValueOnce(new Error("Controlled lost response")).mockResolvedValueOnce({ offer: { ...offer, status: "published", publishedAt: "2026-09-10T01:00:00Z" } });
    await mount(true);
    await act(async () => button("Publish coin offer", container).click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(offer.terms);
    expect(button("Publish coin offer", dialog).disabled).toBe(true);
    await fill("Reason (≥3)", "Controlled publication review", dialog);
    await fill("Type the name to confirm", offer.name, dialog);
    await act(async () => button("Publish coin offer", dialog).click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => button("Publish coin offer", dialog).click());
    expect(apiWrite).toHaveBeenCalledTimes(2);
    expect(apiWrite.mock.calls[1]).toEqual(apiWrite.mock.calls[0]);
    expect(apiWrite.mock.calls[0]).toEqual([
      `/api/v2/admin/billing/coin-offers/${offer.id}/state`, "POST",
      { version: 2, action: "publish", confirmation: `${offer.id}:publish`, reason: "Controlled publication review" },
      { "idempotency-key": expect.any(String) },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("creates an unpublished draft with entered commercial terms and no default price", async () => {
    apiWrite.mockResolvedValue({ offer }); await mount(true);
    const form = container.querySelector("form")!;
    expect([...form.querySelectorAll('input[type="number"]')].every((element) => (element as HTMLInputElement).value === "")).toBe(true);
    for (const [label, value] of [
      ["Offer key", "fixture-coins"], ["Offer name", "Fixture coins"], ["Dreamcoin amount", "125"],
      ["Price in cents", "99"], ["Reason (≥3)", "Controlled draft test"], ["Customer purchase and refund terms", offer.terms],
    ]) await fill(label, value, form);
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(apiWrite).toHaveBeenCalledOnce();
    expect(apiWrite.mock.calls[0][0]).toBe("/api/v2/admin/billing/coin-offers");
    expect(apiWrite.mock.calls[0][2]).toEqual({ offerKey: "fixture-coins", name: "Fixture coins", dreamcoins: 125,
      priceCents: 99, currency: "usd", eligibility: "all", terms: offer.terms, reason: "Controlled draft test" });
    expect(apiWrite.mock.calls[0][2]).not.toHaveProperty("status");
  });
});
