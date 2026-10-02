// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AffiliateAttributionHistory } from "./AffiliateAttributionHistory";
import { AdminI18nProvider } from "./i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const item = { id: "visit-observed", convertedUserId: "customer-observed", landingPath: "/", createdAt: "2026-10-01T00:00:00.000Z", convertedAt: "2026-10-01T01:00:00.000Z", expiresAt: "2026-10-31T00:00:00.000Z", attributionVersion: "affiliate-signup-v1", attributionWindowDays: 30, termsVersion: "terms-observed", state: "valid", reason: "active_customer_signup" };
function response(id = item.id, next = false) { return Response.json({ ok: true, data: { items: [{ ...item, id }], pageInfo: { endCursor: next ? "cursor-observed" : null, hasNextPage: next }, totalVisits: 4, totalSignups: 2, asOf: "2026-10-01T02:00:00.000Z", currentRule: { version: "affiliate-signup-v1", windowDays: 30 } } }); }
function deferredResponse() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(complete => { resolve = complete; }); return { promise, resolve }; }

describe("AffiliateAttributionHistory authoritative read", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function settle() { for (let i = 0; i < 4; i++) await act(async () => new Promise(resolve => setTimeout(resolve, 0))); }
  async function mount(id = "application-observed") { await act(async () => root.render(<AffiliateAttributionHistory key={id} applicationId={id} onClose={() => {}} />)); await settle(); }
  function button(label: string) { const result = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label); expect(result, label).toBeDefined(); return result!; }
  async function click(label: string) { await act(async () => button(label).click()); await settle(); }
  async function type(input: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }

  it("shows the real account, frozen rule and dates, with read-only cursor navigation", async () => {
    const calls: { path: string; method: string | undefined }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input); calls.push({ path, method: init?.method }); return response(new URL(path, "http://localhost").searchParams.has("cursor") ? "visit-next" : item.id, !new URL(path, "http://localhost").searchParams.has("cursor")); }));
    await mount();
    expect(container.textContent).toContain("customer-observed"); expect(container.textContent).toContain("terms-observed"); expect(container.textContent).toContain("affiliate-signup-v1"); expect(container.textContent).toContain("4 deduplicated visits · 2 observed signups");
    expect(container.textContent).toContain("These states do not authorize commission or payment.");
    await click("Next page"); expect(container.textContent).toContain("visit-next"); expect(container.textContent).toContain("Page 2");
    expect(new URL(calls.at(-1)!.path, "http://localhost").searchParams.get("cursor")).toBe("cursor-observed");
    const dates = container.querySelectorAll<HTMLInputElement>('input[type="date"]'); await type(dates[0]!, "2026-10-01"); await type(dates[1]!, "2026-10-01"); await click("Apply dates");
    expect(Object.fromEntries(new URL(calls.at(-1)!.path, "http://localhost").searchParams)).toEqual({ limit: "20", from: "2026-10-01", to: "2026-10-01" }); expect(container.textContent).toContain("Page 1"); expect(calls.every(call => call.method === "GET")).toBe(true);
  });

  it("keeps a permission failure distinct from empty evidence and allows a real read retry", async () => {
    let allowed = false;
    vi.stubGlobal("fetch", vi.fn(async () => allowed ? response() : Response.json({ ok: false, error: { code: "permission_denied", message: "growth.promo.read is required", requestId: "failed-attribution-read" } }, { status: 403 })));
    await mount(); expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(container.textContent).not.toContain("No visits in this date range"); expect(container.textContent).toContain("failed-attribution-read");
    allowed = true; await click("Retry"); expect(container.querySelector('[role="alert"]')).toBeNull(); expect(container.textContent).toContain("visit-observed");
  });

  it("ignores a late page after changing the UTC date scope", async () => {
    const old = deferredResponse(), read: { signal: AbortSignal | null } = { signal: null };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const params = new URL(String(input), "http://localhost").searchParams; if (params.has("cursor")) { read.signal = init?.signal ?? null; return old.promise; } return response(params.has("from") ? "visit-filtered" : item.id, !params.has("from")); }));
    await mount(); await click("Next page");
    const dates = container.querySelectorAll<HTMLInputElement>('input[type="date"]'); await type(dates[0]!, "2026-10-01"); await click("Apply dates");
    expect(read.signal?.aborted).toBe(true); expect(container.textContent).toContain("visit-filtered");
    await act(async () => old.resolve(response("visit-stale"))); await settle(); expect(container.textContent).not.toContain("visit-stale"); expect(container.textContent).toContain("visit-filtered");
  });

  it("does not restore a closed application's response into the newly selected application", async () => {
    const old = deferredResponse(), read: { signal: AbortSignal | null } = { signal: null };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { if (String(input).includes("application-old/")) { read.signal = init?.signal ?? null; return old.promise; } return response("visit-new-application"); }));
    await mount("application-old"); await mount("application-new"); expect(read.signal?.aborted).toBe(true);
    await act(async () => old.resolve(response("visit-old-application"))); await settle();
    expect(container.textContent).toContain("application-new"); expect(container.textContent).toContain("visit-new-application"); expect(container.textContent).not.toContain("visit-old-application");
  });

  it("explains an inverted date range without discarding the last actual evidence", async () => {
    const fetcher = vi.fn(async () => response()); vi.stubGlobal("fetch", fetcher); await mount();
    const dates = container.querySelectorAll<HTMLInputElement>('input[type="date"]'); await type(dates[0]!, "2026-10-02"); await type(dates[1]!, "2026-10-01"); await click("Apply dates");
    expect(fetcher).toHaveBeenCalledTimes(1); expect(container.querySelector('[role="alert"]')?.textContent).toBe("Start date must not follow end date"); expect(container.textContent).toContain("visit-observed");
  });

  it("renders current attribution states and recovery instructions in the Chinese operator locale", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await act(async () => root.render(<AdminI18nProvider locale="zh"><AffiliateAttributionHistory applicationId="application-observed" onClose={() => {}} /></AdminI18nProvider>)); await settle();
    expect(container.textContent).toContain("推广归因证据"); expect(container.textContent).toContain("有效注册归因"); expect(container.textContent).toContain("客户账户目前有效"); expect(container.textContent).toContain("注册账户"); expect(container.textContent).not.toContain("Valid signup attribution");
  });
});
