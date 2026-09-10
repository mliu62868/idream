// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerationReceipts } from "./useGenerationReceipts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = "user:receipt-owner";
const requestKey = "retained-receipt-key";
const record = JSON.stringify({
  kind: "generation_retry", url: "/api/v1/generation/jobs/source-job/retry", requestKey,
  body: { quoteAuthority: { profileId: "image", profileVersion: 1,
    routeFingerprint: "a".repeat(64), pricingFingerprint: "b".repeat(64), outputCount: 1, costDreamcoins: 5 } },
});

function ReceiptView() {
  const [ownerScope, setOwnerScope] = useState<string | null>(owner);
  const [status, setStatus] = useState("");
  const book = useGenerationReceipts({ ownerScope });
  return createElement("div", null,
    createElement("output", { "data-testid": "receipts" }, book.receipts.map((receipt) => receipt.key).join(",")),
    createElement("output", { "data-testid": "status" }, status),
    createElement("button", { onClick: () => {
      book.suspend(true);
      setOwnerScope(null);
      // React may batch a fast, successful same-owner confirmation with the
      // suspension. A dependency effect never observes an ownerScope change.
      book.resume(owner);
      setOwnerScope(owner);
    } }, "Revalidate same account"),
    createElement("button", { onClick: () => book.resume(owner) }, "Confirm current account"),
    createElement("button", { onClick: async () => {
      try {
        const receipt = book.receipts[0];
        if (!receipt) { setStatus("Original request unavailable"); return; }
        const result = await book.recover(receipt);
        setStatus(result ? "Original request confirmed" : "Request still pending");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Request could not be checked");
      }
    } }, "Check original request"),
  );
}

describe("generation receipt suspension and confirmation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let stored: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    stored = new Map([[`idream:generation-receipt:v1:${encodeURIComponent(owner)}:${requestKey}`,
      JSON.stringify({ version: 1, ownerScope: owner, record, idempotencyKey: requestKey })]]);
    vi.stubGlobal("localStorage", {
      get length() { return stored.size; },
      key: (index: number) => [...stored.keys()][index] ?? null,
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: {
      job: { id: "accepted-job", mode: "image", status: "queued", costDreamcoins: 5, outputCount: 1,
        errorCode: null, createdAt: "2026-09-09T00:00:00.000Z" }, assets: [],
    } })));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => root.render(createElement(ReceiptView)));
    await act(async () => { vi.runOnlyPendingTimers(); });
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    if (!button) throw new Error(`Missing ${label} button`);
    await act(async () => button.click());
  }

  function delayNextResponse() {
    const fetcher = vi.mocked(fetch);
    const makeResponse = fetcher.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    return async () => resolve(await makeResponse("/api/v1/generation/jobs/source-job/retry"));
  }

  it("checks the original receipt after a batched same-owner suspension and confirmation", async () => {
    await mount();
    expect(container.querySelector('[data-testid="receipts"]')?.textContent).toBe(requestKey);
    await click("Revalidate same account");
    await act(async () => { vi.runOnlyPendingTimers(); });
    expect(stored.size).toBe(1);
    await click("Check original request");

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("Original request confirmed");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(requestKey);
    expect(new Headers(init?.headers).get("x-idream-viewer-scope")).toBe(owner);
    expect(JSON.parse(String(init?.body))).toEqual(JSON.parse(record).body);
    expect(stored.size).toBe(0);
  });

  it("keeps a late recovery ACK unconfirmed across synchronous suspension and same-owner confirmation", async () => {
    const finishResponse = delayNextResponse();
    await mount();
    await click("Check original request");
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Revalidate same account")!;
      button.click();
      await finishResponse();
    });

    expect(stored.size).toBe(1);
    expect(container.querySelector('[data-testid="receipts"]')?.textContent).toBe(requestKey);
    await click("Check original request");
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("Original request confirmed");
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of vi.mocked(fetch).mock.calls) {
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(requestKey);
      expect(JSON.parse(String(init?.body))).toEqual(JSON.parse(record).body);
    }
    expect(stored.size).toBe(0);
  });

  it("does not invalidate an active ACK when a normal poll confirms the unchanged owner", async () => {
    const finishResponse = delayNextResponse();
    await mount();
    await click("Check original request");
    await click("Confirm current account");
    await act(finishResponse);

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("Original request confirmed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stored.size).toBe(0);
  });
});
