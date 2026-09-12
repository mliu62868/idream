// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerationRequest } from "./useGenerationRequest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ReceiptView({ ownerScope }: { ownerScope: string | null }) {
  const [pending, setPending] = useState(false);
  const controller = useGenerationRequest({
    receiptOwnerScope: ownerScope,
    quoteRequest: null,
    retryQuoteScopeKey: "",
    onQuoteResolved: () => {},
    view: { configAuthority: ownerScope ? "ready" : "suspended", mode: "image", count: 1, modeAvailable: false, hasTarget: false },
  });
  return createElement("div", null,
    createElement("output", { "data-testid": "receipts" }, controller.receipts.map((receipt) => receipt.key).join(",")),
    createElement("button", { onClick: () => setPending(controller.isRetryUnconfirmed("source-job")) }, "Check local key"),
    createElement("output", { "data-testid": "pending" }, String(pending)),
  );
}

function QuoteView({ prompt, ownerScope = "user:a" }: { prompt: string; ownerScope?: string | null }) {
  const controller = useGenerationRequest({
    receiptOwnerScope: ownerScope,
    quoteRequest: ownerScope ? { viewerScope: ownerScope, mode: "image", consistencyMode: "balanced",
      target: "generation", characterId: "character", freeplay: false, generationContextToken: "context", prompt } : null,
    retryQuoteScopeKey: "", onQuoteResolved: () => {},
    view: { configAuthority: ownerScope ? "ready" : "suspended", mode: "image", count: 1, modeAvailable: true, hasTarget: true },
  });
  return createElement("button", { disabled: !controller.view.canSubmit }, "Generate");
}

describe("useGenerationRequest receipt owner projection", () => {
  let root: Root;
  let container: HTMLDivElement;
  let stored: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    stored = new Map();
    vi.stubGlobal("localStorage", {
      get length() { return stored.size; },
      key: (index: number) => [...stored.keys()][index] ?? null,
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    });
    vi.stubGlobal("fetch", vi.fn());
    for (const ownerScope of ["user:a", "user:b"]) {
      const key = `pending-${ownerScope}`;
      const record = JSON.stringify({ kind: "generation_retry", url: "/api/v1/generation/jobs/source-job/retry", requestKey: key,
        body: { quoteAuthority: { profileId: "image", profileVersion: 1, routeFingerprint: "a".repeat(64), pricingFingerprint: "b".repeat(64), outputCount: 1, costDreamcoins: 5 } } });
      stored.set(`idream:generation-receipt:v1:${encodeURIComponent(ownerScope)}:${encodeURIComponent(key)}`,
        JSON.stringify({ version: 1, ownerScope, record, idempotencyKey: key }));
    }
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

  const renderedKeys = () => container.querySelector('[data-testid="receipts"]')?.textContent;
  async function render(ownerScope: string | null) {
    await act(async () => root.render(createElement(ReceiptView, { ownerScope })));
  }
  async function publish() {
    await act(async () => { vi.runOnlyPendingTimers(); });
  }

  it("hides prior-owner state before storage hydration and keeps each owner's original key on return", async () => {
    await render("user:a");
    expect(renderedKeys()).toBe("");
    await publish();
    expect(renderedKeys()).toBe("pending-user:a");
    await render(null);
    expect(renderedKeys()).toBe("");
    await render("user:b");
    expect(renderedKeys()).toBe("");
    await publish();
    expect(renderedKeys()).toBe("pending-user:b");
    await render("user:a");
    expect(renderedKeys()).toBe("");
    await publish();
    expect(renderedKeys()).toBe("pending-user:a");
    expect(stored.size).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restores the original semantic key before publishing the deferred receipt list", async () => {
    await render("user:a");
    expect(renderedKeys()).toBe("");
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("true");
    await publish();
    expect(renderedKeys()).toBe("pending-user:a");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalidates a source-bound price immediately and prices only the final description after typing pauses", async () => {
    stored.clear();
    const quotes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      quotes.push(JSON.parse(String(init?.body)).prompt);
      return Response.json({ ok: true, data: { quote: {
        mode: "image", profileId: "image", profileVersion: 1, routeFingerprint: "a".repeat(64),
        pricing: { ruleId: "price", ruleKey: "image", version: 1, effectiveFrom: null, fingerprint: "b".repeat(64) },
        orientations: ["4:5"], defaultOrientation: "4:5", maxCount: 1,
        costs: [{ outputCount: 1, costDreamcoins: 5 }], balance: 100,
      } } });
    }));
    const show = async (prompt: string, ownerScope: string | null = "user:a") => {
      await act(async () => root.render(createElement(QuoteView, { prompt, ownerScope })));
    };
    await show("Greenhouse");
    expect(quotes).toEqual(["Greenhouse"]);
    expect(container.querySelector("button")?.disabled).toBe(false);
    for (const prompt of ["Greenhouse at", "Greenhouse at sunset", "Greenhouse at sunset, blue cup"]) {
      await show(prompt);
      expect(container.querySelector("button")?.disabled).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    expect(quotes).toEqual(["Greenhouse"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(quotes).toEqual(["Greenhouse", "Greenhouse at sunset, blue cup"]);
    expect(container.querySelector("button")?.disabled).toBe(false);
    await show("Private description");
    await show("Private description", null);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(quotes).toHaveLength(2);
    expect(container.querySelector("button")?.disabled).toBe(true);
  });
});
