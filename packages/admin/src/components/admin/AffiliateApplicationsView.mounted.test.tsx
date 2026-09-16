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
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
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
});
