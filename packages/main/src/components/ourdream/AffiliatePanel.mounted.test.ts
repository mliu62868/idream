// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AffiliateAttributionHistory } from "@idream/shared/contracts";
import { AffiliatePanel } from "./AffiliatePanel";

vi.mock("next/link", () => ({ default: ({ children, href, ...props }: ComponentProps<"a">) => createElement("a", { href: String(href), ...props }, children) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fetcher = ComponentProps<typeof AffiliatePanel>["fetcher"];
const history: AffiliateAttributionHistory = {
  items: [{ id: "visit-observed", landingPath: "/", createdAt: "2026-10-01T00:00:00.000Z", convertedAt: "2026-10-01T01:00:00.000Z", expiresAt: "2026-10-31T00:00:00.000Z", attributionVersion: "affiliate-signup-v1", attributionWindowDays: 30, termsVersion: "terms-observed", state: "valid", reason: "active_customer_signup" }],
  pageInfo: { endCursor: null, hasNextPage: false }, totalVisits: 3, totalSignups: 2, asOf: "2026-10-01T02:00:00.000Z", currentRule: { version: "affiliate-signup-v1", windowDays: 30 },
};
function dashboard(status = "not_applied", attribution = history) {
  return { status, clicks: attribution.totalVisits, conversions: attribution.totalSignups, linkPath: status === "approved" ? "/?aff=approved-code" : null, attributionWindowDays: 30,
    application: status === "not_applied" ? null : { reviewNote: null, termsVersion: "terms-accepted" }, attribution,
    materials: status === "approved" ? [{ characterId: "character-public", name: "Public Iris", assetId: "asset-public", imagePath: "/api/v1/media/asset-public/content", downloadPath: "/api/v1/media/asset-public/content?download=1", linkPath: "/?aff=approved-code" }] : [],
    terms: { state: "published", version: "terms-current", title: "Affiliate terms", path: "/affiliate-terms" },
  };
}
const envelope = (data: unknown) => Response.json({ ok: true, data });
function deferredResponse() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(complete => { resolve = complete; }); return { promise, resolve }; }

describe("AffiliatePanel application and observed attribution", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function settle() { for (let i = 0; i < 4; i++) await act(async () => new Promise(resolve => setTimeout(resolve, 0))); }
  async function mount(fetcher: Fetcher) { await act(async () => root.render(createElement(AffiliatePanel, { fetcher }))); await settle(); }
  function button(label: string) { const result = [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === label); expect(result, label).toBeDefined(); return result!; }
  async function click(label: string) { await act(async () => button(label).click()); await settle(); }
  async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => { const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  async function accept() { await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); }

  it("explains a 142-character channel before posting and retains the draft and acceptance", async () => {
    const fetcher = vi.fn<Fetcher>(async () => envelope(dashboard())); await mount(fetcher);
    const textarea = container.querySelector("textarea")!, value = "x".repeat(142);
    expect(container.textContent).toContain("Add 1–12 channels. Each channel can have up to 120 characters.");
    await type(textarea, value); await accept(); await click("Apply");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Channel 1 must have 1–120 characters. Shorten it and try again.");
    expect(textarea.value).toBe(value); expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  });

  it("rejects 13 channels without truncating them and submits all 12 after correction", async () => {
    const writes: unknown[] = [];
    const fetcher = vi.fn<Fetcher>(async (_input, init) => { if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return envelope({ status: "pending" }); } return envelope(dashboard(writes.length ? "pending" : "not_applied")); });
    await mount(fetcher); const textarea = container.querySelector("textarea")!, channels = Array.from({ length: 13 }, (_, i) => `https://example.invalid/channel-${i + 1}`);
    await type(textarea, channels.join("\n")); await accept(); await click("Apply");
    expect(writes).toHaveLength(0); expect(textarea.value).toBe(channels.join("\n"));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Add between 1 and 12 promotion channels");
    await type(textarea, channels.slice(0, 12).join("\n")); await click("Apply");
    expect(writes).toEqual([{ termsVersion: "terms-current", channels: channels.slice(0, 12) }]);
    expect(container.textContent).toContain("Your application is under review.");
  });

  it("offers approved media through canonical download paths and separates current states from observed signups", async () => {
    const data = dashboard("approved", { ...history, items: [history.items[0]!, { ...history.items[0]!, id: "visit-legacy", state: "pending", reason: "legacy_unverified", attributionVersion: null, termsVersion: null }, { ...history.items[0]!, id: "visit-revoked", state: "revoked", reason: "account_inactive" }] });
    const copy = vi.fn(async () => {}); vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    await mount(vi.fn<Fetcher>(async () => envelope(data)));
    expect(container.querySelector<HTMLInputElement>('[aria-label="Affiliate link"]')?.value).toBe(new URL("/?aff=approved-code", window.location.origin).href);
    expect(container.querySelector('a[download]')?.getAttribute("href")).toBe("/api/v1/media/asset-public/content?download=1");
    expect(container.textContent).toContain("3 deduplicated visits · 2 observed signups");
    expect(container.textContent).toContain("Valid signup attribution"); expect(container.textContent).toContain("Pending verification"); expect(container.textContent).toContain("Revoked signup attribution");
    expect(container.textContent).toContain("This historical signup has no complete account and rule evidence."); expect(container.textContent).toContain("The original signup remains recorded.");
    expect(container.textContent).toContain("do not qualify a commission"); expect(container.textContent).not.toContain("earnings");
    await click("Copy promotion link"); expect(copy).toHaveBeenCalledWith(new URL("/?aff=approved-code", window.location.origin).href);
  });

  it("uses the returned cursor and UTC date filter, rejecting an inverted range locally", async () => {
    const paths: string[] = [];
    const fetcher = vi.fn<Fetcher>(async input => { const path = String(input); paths.push(path); const next = new URL(path, "http://localhost").searchParams.has("cursor"); return envelope(dashboard("approved", { ...history, items: [{ ...history.items[0]!, id: next ? "visit-next" : "visit-first" }], pageInfo: { endCursor: next ? null : "observed-cursor", hasNextPage: !next } })); });
    await mount(fetcher); await click("Next visits");
    expect(new URL(paths.at(-1)!, "http://localhost").searchParams.get("cursor")).toBe("observed-cursor"); expect(container.textContent).toContain("visit-next"); expect(container.textContent).toContain("Page 2");
    const from = container.querySelector<HTMLInputElement>('[aria-label="Affiliate visits from"]')!, to = container.querySelector<HTMLInputElement>('[aria-label="Affiliate visits through"]')!;
    await type(from, "2026-10-02"); await type(to, "2026-10-01"); const before = paths.length; await click("Apply dates");
    expect(paths).toHaveLength(before); expect(container.textContent).toContain("start must not follow the end"); expect(container.textContent).toContain("visit-next");
    await type(from, "2026-10-01"); await click("Apply dates"); const params = new URL(paths.at(-1)!, "http://localhost").searchParams;
    expect(Object.fromEntries(params)).toEqual({ limit: "20", from: "2026-10-01", to: "2026-10-01" }); expect(container.textContent).toContain("Page 1");
  });

  it("ignores a superseded read even when its transport completes after abort", async () => {
    const old = deferredResponse(), read: { signal: AbortSignal | null } = { signal: null };
    await mount(vi.fn<Fetcher>(async (_input, init) => { read.signal = init?.signal ?? null; return old.promise; }));
    await mount(vi.fn<Fetcher>(async () => envelope(dashboard("approved"))));
    expect(read.signal?.aborted).toBe(true); expect(container.textContent).toContain("Public Iris");
    await act(async () => old.resolve(envelope(dashboard("not_applied")))); await settle();
    expect(container.textContent).toContain("Public Iris"); expect(container.querySelector("textarea")).toBeNull();
  });
});
