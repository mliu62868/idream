// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AffiliateApplicationsView } from "./AffiliateApplicationsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initialItem = { id: "affiliate-1", userId: "customer-1", status: "pending", termsVersion: "2026-09", channels: ["https://example.test/channel"], reviewNote: null, reviewedAt: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };

describe("affiliate review workflow", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { window.history.replaceState(null, "", "/admin/growth/affiliate"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${document.body.textContent}`);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
  function button(label: string, dialog = false) {
    const scope = dialog ? document.querySelector('[role="dialog"]')! : document;
    const result = [...scope.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
    expect(result, label).toBeDefined(); return result!;
  }
  async function open(canWrite = true) {
    await act(async () => root.render(<AffiliateApplicationsView canWrite={canWrite} />));
    await waitFor(() => Boolean(container.textContent?.includes("affiliate-1")));
  }
  function list(item = initialItem) { return Response.json({ ok: true, data: { items: [item], pageInfo: { endCursor: null, hasNextPage: false } } }); }
  async function type(input: HTMLInputElement, text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("requires ID and public review reason, then retries a lost response with the same command", async () => {
    let item = { ...initialItem };
    const writes: { body: Record<string, string>; key: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return list(item);
      const body = JSON.parse(String(init.body));
      writes.push({ body, key: new Headers(init.headers).get("idempotency-key") });
      item = { ...item, status: body.status, updatedAt: "2026-09-02T00:00:00.000Z" };
      if (writes.length === 1) throw new TypeError("Connection lost after commit");
      return Response.json({ ok: true, data: { item, replayed: true } });
    }));
    await open();
    expect(container.textContent).toContain(initialItem.termsVersion);
    expect(container.textContent).toContain(initialItem.channels[0]);
    await act(async () => button("Approve").click());
    expect(button("Approve", true).disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("visible to the applicant");
    const inputs = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')];
    expect(inputs).toHaveLength(2);
    await type(inputs[0]!, "Promotion channel verified");
    expect(button("Approve", true).disabled).toBe(true);
    await type(inputs[1]!, "affiliate-1");
    await act(async () => button("Approve", true).click());
    await waitFor(() => writes.length === 1 && !button("Approve", true).disabled);
    await act(async () => button("Approve", true).click());
    await waitFor(() => !document.querySelector('[role="dialog"]'));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.key).toBeTruthy();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]!.body).toEqual({ status: "approved", confirmation: "affiliate-1", expectedUpdatedAt: initialItem.updatedAt, reason: "Promotion channel verified" });
    expect(container.textContent).toContain("Approved");
  });

  it("keeps decisions disabled without growth write permission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => list()));
    await open(false);
    expect(button("Approve").disabled).toBe(true);
    expect(button("Reject").disabled).toBe(true);
    expect(container.textContent).toContain("growth.promo.write");
  });

  it("keeps the new query and confirmation when an earlier decision completes after navigation", async () => {
    const nextItem = { ...initialItem, id: "affiliate-2", userId: "customer-2" };
    let finish!: (value: Response) => void;
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>(resolve => { finish = resolve; });
      const path = String(input); reads.push(path);
      return list(path.includes("search=next") ? nextItem : initialItem);
    }));
    await open();
    await act(async () => button("Approve").click());
    const inputs = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')];
    await type(inputs[0]!, "Promotion channel verified");
    await type(inputs[1]!, initialItem.id);
    await act(async () => button("Approve", true).click());
    await act(async () => {
      window.history.pushState(null, "", "/admin/growth/affiliate?affiliateSearch=next");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => container.textContent?.includes(nextItem.id) === true);
    await act(async () => button("Approve").click());
    const nextDialog = document.querySelector('[role="dialog"]');
    await act(async () => finish(Response.json({ ok: true, data: { item: { ...initialItem, status: "approved" }, replayed: false } })));
    expect(reads).toHaveLength(2);
    expect(container.textContent).toContain(nextItem.id);
    expect(window.location.search).toBe("?affiliateSearch=next");
    expect(document.querySelector('[role="dialog"]')).toBe(nextDialog);
  });

  it("restores list filters and cursor from a shared URL and supports history restoration", async () => {
    window.history.replaceState(null, "", "/admin/growth/affiliate?affiliateStatus=approved&affiliateSearch=creator&affiliateCursor=shared-page");
    const fetcher = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => list()); vi.stubGlobal("fetch", fetcher);
    await open(false);
    expect(Object.fromEntries(new URL(String(fetcher.mock.calls[0]![0]), "http://localhost").searchParams)).toEqual({ status: "approved", limit: "25", search: "creator", cursor: "shared-page" });
    expect(container.textContent).not.toContain("Page 1");
    await act(async () => button("Back to first page").click());
    await waitFor(() => container.textContent?.includes("Page 1") === true);
    expect(new URLSearchParams(window.location.search).get("affiliateSearch")).toBe("creator");
    window.history.replaceState(null, "", "/admin/growth/affiliate?affiliateStatus=rejected&affiliateSearch=restored");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await waitFor(() => fetcher.mock.calls.some(([path]) => String(path).includes("search=restored")));
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Search application or user ID"]')?.value).toBe("restored");
  });

  it("lets a read-only operator open canonical attribution evidence without enabling decisions", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input); calls.push(path);
      if (path.includes("/attribution?")) return Response.json({ ok: true, data: { items: [], pageInfo: { endCursor: null, hasNextPage: false }, totalVisits: 0, totalSignups: 0, asOf: "2026-10-01T00:00:00.000Z", currentRule: { version: "affiliate-signup-v1", windowDays: 30 } } });
      return list();
    }));
    await open(false); await act(async () => button("View attribution").click()); await waitFor(() => Boolean(container.textContent?.includes("No visits in this date range")));
    expect(calls).toContain("/api/v2/admin/affiliate/applications/affiliate-1/attribution?limit=20"); expect(button("Approve").disabled).toBe(true); expect(button("Reject").disabled).toBe(true);
  });
});
