// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackQueue } from "./FeedbackQueue";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initialItem = { id: "feedback-1", title: "Keep scene selection", description: "Remember the scene when returning to Generate.", category: "improvement", status: "under_review", voteCount: 4, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };

describe("FeedbackQueue operator workflow", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${document.body.textContent}`);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
  function button(label: string) {
    const result = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
    expect(result, label).toBeDefined(); return result!;
  }
  async function open(canWrite = true) {
    await act(async () => root.render(<FeedbackQueue canWrite={canWrite} />));
    await act(async () => button("Product feedback").click());
    await waitFor(() => Boolean(document.querySelector('[aria-label="Feedback status for Keep scene selection"]')));
  }
  function list(item = initialItem) { return Response.json({ ok: true, data: { items: [item], pageInfo: { endCursor: null, hasNextPage: false } } }); }

  it("confirms a status change and retains the idempotency key after a lost response", async () => {
    let item = { ...initialItem };
    const writes: { body: Record<string, string>; key: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") return list(item);
      const body = JSON.parse(String(init.body));
      writes.push({ body, key: new Headers(init.headers).get("idempotency-key") });
      item = { ...item, status: body.status, updatedAt: "2026-09-02T00:00:00.000Z" };
      if (writes.length === 1) throw new TypeError("Connection lost after commit");
      return Response.json({ ok: true, data: { item, replayed: true } });
    }));
    await open();
    const select = document.querySelector<HTMLSelectElement>('[aria-label="Feedback status for Keep scene selection"]')!;
    await act(async () => { select.value = "planned"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Accepted for the next iteration");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save feedback status").click());
    await waitFor(() => writes.length === 1 && !button("Save feedback status").disabled);
    await act(async () => button("Save feedback status").click());
    await waitFor(() => !document.querySelector('[role="dialog"]'));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.key).toBeTruthy();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]!.body).toEqual({ status: "planned", expectedUpdatedAt: initialItem.updatedAt, reason: "Accepted for the next iteration" });
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Feedback status for Keep scene selection"]')?.value).toBe("planned");
  });

  it("keeps triage read-only without support write permission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => list()));
    await open(false);
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Feedback status for Keep scene selection"]')?.disabled).toBe(true);
  });

  it("refreshes the current filter and aborts obsolete requests when it closes", async () => {
    const paths: string[] = [];
    let lastSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      paths.push(String(input)); lastSignal = init?.signal; return list();
    }));
    await open();
    const filter = document.querySelector<HTMLSelectElement>('[aria-label="Feedback status filter"]')!;
    await act(async () => { filter.value = "planned"; filter.dispatchEvent(new Event("change", { bubbles: true })); });
    await waitFor(() => paths.at(-1)?.includes("status=planned") ?? false);
    const before = paths.length;
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    await waitFor(() => paths.length === before + 1);
    expect(paths.at(-1)).toContain("status=planned");
    await act(async () => button("Product feedback").click());
    expect(lastSignal?.aborted).toBe(true);
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    expect(paths).toHaveLength(before + 1);
  });
});
