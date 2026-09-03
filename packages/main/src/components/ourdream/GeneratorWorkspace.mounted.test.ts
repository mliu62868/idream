// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: ComponentProps<"a">) =>
    createElement("a", { href: String(href), ...props }, children),
}));
vi.mock("next/image", () => ({
  default: ({ fill: _fill, unoptimized: _unoptimized, priority: _priority, ...props }: ComponentProps<"img"> & {
    fill?: boolean; unoptimized?: boolean; priority?: boolean;
  }) => createElement("img", props),
}));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));

import { GeneratorWorkspace } from "./GeneratorWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mediaItem(id: string, type: "image" | "video" = "image") {
  return {
    id, type, url: `/user-content/${id}.${type === "image" ? "png" : "mp4"}`,
    thumbnailUrl: `/user-content/${id}.png`, prompt: "Test media", liked: false,
    width: 512, height: 512, imageEditModelIds: ["edit-model"],
  };
}

const config = {
  viewer: { authenticated: true, scope: "user:generator-viewer" },
  entitlements: { premium_controls: true },
  dreamcoins: { balance: 100 },
  pricing: { image: { baseCost: 5, maxCount: null }, video: { baseCost: null } },
  image: {
    availability: { state: "unavailable", reason: "no_active_model" },
    models: [], orientations: [],
    editModels: [{ id: "edit-model", label: "Image edit", maxCount: 1, costMultiplier: 1, entitlement: null, referenceMode: "source_only" }],
  },
  video: {
    enabled: false, availability: { state: "unavailable", reason: "feature_disabled" },
    models: [], requiredEntitlement: "video_generation",
  },
};

const quote = {
  mode: "image", profileId: "edit-model", profileVersion: 1,
  routeFingerprint: "a".repeat(64),
  pricing: { ruleId: "image-price", ruleKey: "image", version: 1, effectiveFrom: null, fingerprint: "b".repeat(64) },
  orientations: ["4:5"], defaultOrientation: "4:5", maxCount: 1,
  costs: [{ outputCount: 1, costDreamcoins: 5 }], balance: 100, identityLocked: false,
};

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("GeneratorWorkspace media journeys", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: string[];

  beforeEach(() => {
    // Keep browser storage isolated from Node's optional file-backed storage.
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() { return stored.size; },
      key: (index: number) => [...stored.keys()][index] ?? null,
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, String(value)); },
      removeItem: (key: string) => { stored.delete(key); },
      clear: () => stored.clear(),
    });
    window.history.replaceState(null, "", "/generate");
    requests = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      let data: unknown = { items: [] };
      if (path === "/api/v1/generation/config") data = config;
      else if (path.endsWith("/variation/quote")) data = { quote };
      else if (path.startsWith("/api/v1/media?")) {
        const url = new URL(path, "http://localhost");
        data = url.searchParams.get("type") === "video"
          ? { items: [mediaItem("video-1", "video")], nextCursor: null }
          : url.searchParams.has("liked")
            ? { items: [], nextCursor: null }
            : url.searchParams.has("cursor")
              ? { items: [mediaItem("older-image")], nextCursor: null }
              : { items: Array.from({ length: 8 }, (_, index) => mediaItem(`image-${index + 1}`)), nextCursor: "older-cursor" };
      }
      return Response.json({ ok: true, data });
    }));
    Element.prototype.scrollIntoView ??= () => {};
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function settle() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
  }

  function button(label: string) {
    const result = [...container.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
    );
    expect(result, label).toBeDefined();
    return result!;
  }

  async function click(target: Element) {
    await act(async () => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
  }

  async function mount() {
    await act(async () => root.render(createElement(GeneratorWorkspace)));
    await settle();
    expect(container.textContent).toContain("100 coins");
  }

  it("keeps actionable jobs visible and lets completed history expand without displacing the Gallery", async () => {
    const originalFetch = globalThis.fetch;
    const completed = Array.from({ length: 6 }, (_, index) => ({
      id: `completed-${index}`, mode: "image", status: "completed", costDreamcoins: 5,
      outputCount: 1, errorCode: null, createdAt: new Date().toISOString(),
    }));
    const items = [...completed, ...["queued", "failed"].map((status) => ({ ...completed[0], id: status, status }))];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("/api/v1/generation/jobs?")
        ? Response.json({ ok: true, data: { items } })
        : originalFetch(input, init)));
    await mount();
    const cards = () => [...container.querySelectorAll("[data-generation-job-id]")].map((node) => node.getAttribute("data-generation-job-id"));
    expect(cards()).toEqual(["completed-0", "completed-1", "completed-2", "queued", "failed"]);
    await click(button("Show 3 older completed jobs"));
    expect(cards()).toEqual(items.map((job) => job.id));
    expect(button("Hide older completed jobs").getAttribute("aria-expanded")).toBe("true");
    await click(button("Hide older completed jobs"));
    expect(cards()).toContain("queued");
    expect(cards()).toContain("failed");
    expect(cards()).not.toContain("completed-5");
    expect(container.querySelector('[aria-label="Gallery filters"]')).not.toBeNull();
  });

  it("keeps a superseded Chat failure visible without offering a paid retry", async () => {
    const originalFetch = globalThis.fetch;
    const retryWrites: string[] = [];
    const message = "This Chat image is no longer available to retry. Check the chat for its current result.";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/generation/jobs?")) return Response.json({ ok: true, data: { items: [
        { id: "old-chat-image", mode: "image", status: "failed", errorCode: "backend_error", costDreamcoins: 8, outputCount: 1, createdAt: "2026-09-03T02:53:10.437Z" },
        { id: "replacement-chat-image", mode: "image", status: "completed", errorCode: null, costDreamcoins: 8, outputCount: 1, createdAt: "2026-09-03T02:54:36.379Z" },
      ] } });
      if (path === "/api/v1/generation/jobs/old-chat-image/retry/quote") return Response.json({ ok: false, error: { code: "conflict", message } }, { status: 409 });
      if (path === "/api/v1/generation/jobs/old-chat-image/retry") retryWrites.push(path);
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Jobs"));
    const card = container.querySelector('[data-generation-job-id="old-chat-image"]')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain(message);
    expect(card.textContent).not.toContain("Retry · 8 coins");
    const retryButton = button("Retry price unavailable");
    expect(retryButton.disabled).toBe(true);
    await click(retryButton);
    await click(button("Retry price check"));
    expect(button("Retry price unavailable").disabled).toBe(true);
    expect(retryWrites).toEqual([]);
    expect(container.querySelector('[data-generation-job-id="replacement-chat-image"]')).not.toBeNull();
  });

  it("binds Jobs reads to the confirmed viewer even before a cookie change has raised a focus event", async () => {
    const originalFetch = globalThis.fetch;
    const scopes: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/v1/generation/jobs?")) {
        const scope = new Headers(init?.headers).get("x-idream-viewer-scope");
        scopes.push(scope);
        // Config just confirmed A; the actual request is now authenticated as B.
        return scope === "user:generator-viewer"
          ? Response.json({ ok: false, error: { message: "Your account changed. Reload this page." } }, { status: 409 })
          : Response.json({ ok: true, data: { items: [{ id: "other-account-job", mode: "image", status: "completed", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString() }] } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Jobs"));
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every(scope => scope === "user:generator-viewer")).toBe(true);
    expect(container.querySelector('[data-generation-job-id="other-account-job"]')).toBeNull();
    expect(container.textContent).toContain("Your account changed");
  });

  it.each(["variation", "enhance"] as const)("restores an independent %s request after unmount, without its source or quote, and hides it from another viewer", async (kind) => {
    const originalFetch = globalThis.fetch;
    const writes: Array<{ key: string | null; body: string }> = [];
    let viewer: string | null = "user:generator-viewer";
    const job = { id: "restored-original", mode: "image", status: "completed", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString() };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, viewer: { authenticated: viewer !== null, scope: viewer ?? "anonymous" }, dreamcoins: { balance: writes.length ? 0 : 100 },
        image: { ...config.image, enhance: { available: writes.length === 0, scale: 2 } },
      } });
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: {
        items: writes.length ? [] : [{ ...mediaItem("source"), enhanceEligible: true }], nextCursor: null,
      } });
      if (path.endsWith("/quote")) return writes.length
        ? Response.json({ ok: false, error: { message: "Original route no longer quotes" } }, { status: 409 })
        : Response.json({ ok: true, data: { quote, ...(kind === "enhance" ? {
          enhancement: { sourceMediaId: "source", scale: 2, sourceWidth: 512, sourceHeight: 512, width: 1024, height: 1024 },
        } : {}) } });
      if (path === `/api/v1/media/source/${kind}` && init?.method === "POST") {
        writes.push({ key: new Headers(init.headers).get("idempotency-key"), body: String(init.body) });
        if (writes.length === 1) throw new TypeError("lost after accepting original");
        if (writes.length === 2) return Response.json({ ok: false, error: { message: "Sign in again" } }, { status: 401 });
        return Response.json({ ok: true, data: { job, assets: [] } }, { status: 202 });
      }
      if (path === "/api/v1/generation/jobs/restored-original") return Response.json({ ok: true, data: { job, assets: [] } });
      return originalFetch(input, init);
    }));
    await mount();
    await click(button(kind === "enhance" ? "Enhance image 2×" : "Create variation"));
    if (kind === "enhance") await click(button("Enhance 2× · 5 coins"));
    expect(writes).toHaveLength(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(GeneratorWorkspace)));
    await settle();
    expect(container.querySelector('[data-media-id="source"]')).toBeNull();
    expect(container.querySelector('[data-testid="generation-pending-requests"]')).not.toBeNull();
    expect(writes).toHaveLength(1);
    await click(button("Check original request"));
    expect(writes).toHaveLength(2);
    expect(container.textContent).toContain("pending request is kept");
    expect(container.querySelector('[data-testid="generation-pending-requests"]')).not.toBeNull();
    viewer = null;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(container.querySelector('[data-testid="generation-pending-requests"]')).toBeNull();
    expect(writes).toHaveLength(2);
    viewer = "user:another-viewer";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(container.querySelector('[data-testid="generation-pending-requests"]')).toBeNull();
    expect(writes).toHaveLength(2);
    viewer = "user:generator-viewer";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    await click(button("Check original request"));
    expect(writes).toHaveLength(3);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[2]).toEqual(writes[0]);
    expect(container.querySelector('[data-testid="generation-pending-requests"]')).toBeNull();
    expect(container.querySelector('[data-generation-job-id="restored-original"]')).not.toBeNull();
  });

  it("confirms a different Gallery variation in the edit form while keeping the earlier unknown request", async () => {
    const originalFetch = globalThis.fetch;
    const writes: Array<{ path: string; key: string | null; body: Record<string, unknown> }> = [];
    const job = { id: "new-edit", mode: "image", status: "completed", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString() };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/variation") && init?.method === "POST") {
        writes.push({ path, key: new Headers(init.headers).get("idempotency-key"), body: JSON.parse(String(init.body)) });
        if (writes.length === 1) throw new TypeError("first response lost");
        return Response.json({ ok: true, data: { job, assets: [] } }, { status: 202 });
      }
      if (path === "/api/v1/generation/jobs/new-edit") return Response.json({ ok: true, data: { job, assets: [] } });
      return originalFetch(input, init);
    }));
    await mount();
    await click(container.querySelector('[data-media-id="image-1"] button[aria-label="Create variation"]')!);
    expect(writes).toHaveLength(1);
    await click(container.querySelector('[data-media-id="image-2"] button[aria-label="Create variation"]')!);
    expect(writes).toHaveLength(1);
    expect(container.textContent).toContain("confirm this new edit at its current price");
    const prompt = container.querySelector<HTMLTextAreaElement>('[aria-label="Edit instructions"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "A red raincoat");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    await click(button("Generate new · 5 coins"));
    expect(writes).toHaveLength(2);
    expect(writes[1].path).toBe("/api/v1/media/image-2/variation");
    expect(writes[1].body.prompt).toBe("A red raincoat");
    expect(writes[1].key).not.toBe(writes[0].key);
    expect(container.querySelectorAll('[data-pending-request-key]')).toHaveLength(1);
    expect(container.querySelector('[data-pending-request-key]')?.getAttribute("data-pending-request-key")).toBe(writes[0].key);
  });

  it("quotes enhancement before confirmation and sends the exact price only after confirming", async () => {
    const originalFetch = globalThis.fetch;
    const writes: Array<{ body: unknown; key: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, image: { ...config.image, enhance: { available: true, scale: 2 } },
      } });
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: {
        items: [{ ...mediaItem("source-image"), enhanceEligible: true }], nextCursor: null,
      } });
      if (path.endsWith("/enhance/quote")) return Response.json({ ok: true, data: {
        quote, enhancement: { sourceMediaId: "source-image", scale: 2, sourceWidth: 512, sourceHeight: 640, width: 1024, height: 1280 },
      } });
      if (path.endsWith("/enhance")) {
        writes.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("idempotency-key") });
        if (writes.length === 1) return Response.json({ ok: false }, { status: 503 });
        return Response.json({ ok: true, data: { job: {
          id: "enhance-job", mode: "image", status: "queued", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString(),
        }, assets: [] } }, { status: 202 });
      }
      if (path === "/api/v1/generation/jobs/enhance-job") return Response.json({ ok: true, data: { job: {
        id: "enhance-job", mode: "image", status: "queued", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString(),
      }, assets: [] } });
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Enhance image 2×"));
    expect(container.querySelector('[aria-label="Enhance image"]')?.textContent).toContain("512 × 640 → 1024 × 1280");
    expect(writes).toHaveLength(0);
    await click(button("Enhance 2× · 5 coins"));
    expect(container.textContent).toContain("Retry to check the same request");
    await click(button("Check enhancement request"));
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[0].key).toBeTruthy();
    expect(writes[0].body).toEqual({ scale: 2, quoteAuthority: {
      profileId: quote.profileId, profileVersion: 1, routeFingerprint: quote.routeFingerprint,
      pricingFingerprint: quote.pricing.fingerprint, outputCount: 1, costDreamcoins: 5,
    } });
    expect(container.querySelector('[aria-label="Enhance image"]')).toBeNull();
    expect(container.querySelector('[data-generation-job-id="enhance-job"]')).not.toBeNull();
  });

  it("does not reopen a cancelled enhancement when its price arrives late", async () => {
    const originalFetch = globalThis.fetch;
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, image: { ...config.image, enhance: { available: true, scale: 2 } },
      } });
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: {
        items: [{ ...mediaItem("source-image"), enhanceEligible: true }], nextCursor: null,
      } });
      if (path.endsWith("/enhance/quote")) return pending.promise;
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Enhance image 2×"));
    expect(container.textContent).toContain("Checking enhancement price");
    await click(button("Cancel enhancement"));
    pending.resolve(Response.json({ ok: true, data: {
      quote, enhancement: { sourceMediaId: "source-image", scale: 2, sourceWidth: 512, sourceHeight: 512, width: 1024, height: 1024 },
    } }));
    await settle();
    expect(container.querySelector('[aria-label="Enhance image"]')).toBeNull();
    expect(requests.some((path) => path.endsWith("/enhance"))).toBe(false);
  });

  it("does not offer enhancement when the backend is unavailable", async () => {
    await mount();
    expect(container.querySelector('button[aria-label="Enhance image 2×"]')).toBeNull();
  });

  it("checks an accepted but unconfirmed enhancement after reopening with no balance", async () => {
    const originalFetch = globalThis.fetch;
    const keys: Array<string | null> = [];
    let quoteCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: { ...config, image: { ...config.image, enhance: { available: true, scale: 2 } } } });
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [{ ...mediaItem("source-image"), enhanceEligible: true }], nextCursor: null } });
      if (path.endsWith("/enhance/quote")) return Response.json({ ok: true, data: {
        quote: { ...quote, balance: quoteCount++ === 0 ? 5 : 0 }, enhancement: { sourceMediaId: "source-image", scale: 2, sourceWidth: 512, sourceHeight: 512, width: 1024, height: 1024 },
      } });
      const job = { id: "accepted-enhance", mode: "image", status: "queued", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString() };
      if (path.endsWith("/enhance")) {
        keys.push(new Headers(init?.headers).get("idempotency-key"));
        if (keys.length === 1) throw new TypeError("response lost after reservation");
        return Response.json({ ok: true, data: { job, assets: [] } }, { status: 202 });
      }
      if (path === "/api/v1/generation/jobs/accepted-enhance") return Response.json({ ok: true, data: { job, assets: [] } });
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Enhance image 2×"));
    await click(button("Enhance 2× · 5 coins"));
    await click(button("Cancel enhancement"));
    await click(button("Enhance image 2×"));
    const check = button("Check enhancement request");
    expect((check as HTMLButtonElement).disabled).toBe(false);
    await click(check);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(container.querySelector('[data-generation-job-id="accepted-enhance"]')).not.toBeNull();
  });

  it("keeps late Enhance quotes and writes isolated from another source and viewer", async () => {
    const originalFetch = globalThis.fetch;
    const oldQuote = deferredResponse();
    const oldWrite = deferredResponse();
    let viewerChanged = false;
    const writes: string[] = [];
    const polls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, viewer: viewerChanged ? { authenticated: true, scope: "user:new-enhance-viewer" } : config.viewer,
        image: { ...config.image, enhance: { available: true, scale: 2 } },
      } });
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: (viewerChanged ? ["new-source"] : ["source-a", "source-b"]).map((id) => ({ ...mediaItem(id), enhanceEligible: true })), nextCursor: null } });
      if (path === "/api/v1/media/source-a/enhance/quote") return oldQuote.promise;
      if (path.endsWith("/enhance/quote")) return Response.json({ ok: true, data: { quote, enhancement: { sourceMediaId: "source-b", scale: 2, sourceWidth: 512, sourceHeight: 512, width: 1024, height: 1024 } } });
      if (path.endsWith("/enhance")) { writes.push(path); return oldWrite.promise; }
      if (path.includes("old-enhance-job")) polls.push(path);
      return originalFetch(input, init);
    }));
    await mount();
    await click(container.querySelector('[data-media-id="source-a"] button[aria-label="Enhance image 2×"]')!);
    await click(container.querySelector('[data-media-id="source-b"] button[aria-label="Enhance image 2×"]')!);
    oldQuote.resolve(Response.json({ ok: true, data: { quote, enhancement: { sourceMediaId: "source-a", scale: 2, sourceWidth: 512, sourceHeight: 512, width: 1024, height: 1024 } } }));
    await settle();
    expect(container.querySelector('[alt="Image to enhance"]')?.getAttribute("src")).toContain("source-b");
    await click(button("Enhance 2× · 5 coins"));
    await click(button("Starting enhancement…"));
    expect(writes).toEqual(["/api/v1/media/source-b/enhance"]);
    viewerChanged = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    oldWrite.resolve(Response.json({ ok: true, data: { job: { id: "old-enhance-job", mode: "image", status: "queued", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString() }, assets: [] } }, { status: 202 }));
    await settle();
    expect(container.querySelector('[aria-label="Enhance image"]')).toBeNull();
    expect(container.querySelector('[data-generation-job-id="old-enhance-job"]')).toBeNull();
    expect(polls).toEqual([]);
    expect(container.querySelector('[data-media-id="new-source"]')).not.toBeNull();
  });

  it("reconfirms changed pricing and refreshes Gallery with both original and completed copy", async () => {
    const originalFetch = globalThis.fetch;
    let quoteCount = 0;
    let completed = false;
    const writes: Array<{ key: string | null; cost: number }> = [];
    const job = { id: "completed-enhance", mode: "image", status: "queued", costDreamcoins: 7, outputCount: 1, errorCode: null, createdAt: new Date().toISOString() };
    const enhanced = { ...mediaItem("enhanced-copy"), width: 1024, height: 1024, enhancement: { sourceMediaId: "source-image", scale: 2 } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: { ...config, image: { ...config.image, enhance: { available: true, scale: 2 } } } });
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [{ ...mediaItem("source-image"), enhanceEligible: true }, ...(completed ? [enhanced] : [])], nextCursor: null } });
      if (path.endsWith("/enhance/quote")) return Response.json({ ok: true, data: { quote: { ...quote, costs: [{ outputCount: 1, costDreamcoins: quoteCount++ === 0 ? 5 : 7 }] }, enhancement: { sourceMediaId: "source-image", scale: 2, sourceWidth: 512, sourceHeight: 512, width: 1024, height: 1024 } } });
      if (path.endsWith("/enhance")) {
        writes.push({ key: new Headers(init?.headers).get("idempotency-key"), cost: JSON.parse(String(init?.body)).quoteAuthority.costDreamcoins });
        return writes.length === 1 ? Response.json({ ok: false, error: { message: "Price changed" } }, { status: 409 }) : Response.json({ ok: true, data: { job, assets: [] } }, { status: 202 });
      }
      if (path === "/api/v1/generation/jobs/completed-enhance") {
        completed = true;
        return Response.json({ ok: true, data: { job: { ...job, status: "completed" }, assets: [enhanced] } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Enhance image 2×"));
    await click(button("Enhance 2× · 5 coins"));
    expect(container.textContent).toContain("Check the price again before confirming");
    await click(button("Check enhancement price"));
    await click(button("Enhance 2× · 7 coins"));
    expect(writes.map((write) => write.cost)).toEqual([5, 7]);
    expect(writes[0].key).not.toBe(writes[1].key);
    await settle();
    expect(container.querySelector('[data-testid="gallery-media-card"][data-media-id="source-image"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="gallery-media-card"][data-media-id="enhanced-copy"]')).not.toBeNull();
  });

  it("names Gallery images and reveals their actions for keyboard focus", async () => {
    await mount();
    const card = container.querySelector('[data-testid="gallery-media-card"]')!;
    expect(card.querySelector("img")?.getAttribute("alt")).toBe("Image creation");
    const actions = Array.from(card.querySelectorAll('div[class*="md:opacity-0"]'));
    expect(actions).toHaveLength(2);
    for (const row of actions) expect(row.classList.contains("md:group-focus-within:opacity-100")).toBe(true);
  });

  it("uses public image context without exposing internal generation prompts in accessible names", async () => {
    const originalFetch = globalThis.fetch;
    const internalPrompt = "High quality in-character portrait. Locked identity: INTERNAL-VISUAL-AUTHORITY.";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [
        { ...mediaItem("generic"), prompt: internalPrompt },
        { ...mediaItem("enhanced"), prompt: internalPrompt,
          enhancement: { sourceMediaId: "original", scale: 2 },
          provenance: { sourceType: "chat", label: "Chat", sourceCharacterName: "Leo" } },
      ], nextCursor: null } });
      return originalFetch(input, init);
    }));
    await mount();
    const names = Array.from(container.querySelectorAll('[data-testid="gallery-media-image"]'))
      .map((image) => image.getAttribute("alt"));
    expect(names).toEqual(["Image creation", "Enhanced image · Leo"]);
    expect(names.join(" ")).not.toContain(internalPrompt);
    expect(container.innerHTML).not.toContain("INTERNAL-VISUAL-AUTHORITY");
  });

  it("saves only the user's explicit styling description as a Look", async () => {
    const originalFetch = globalThis.fetch;
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [{
        ...mediaItem("look-source"), characterId: "leo", canEditIdentity: true,
        prompt: "High quality in-character portrait. Locked identity: INTERNAL-VISUAL-AUTHORITY.",
      }], nextCursor: null } });
      if (path === "/api/v1/media/look-source/save-as-look") {
        writes.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, data: { look: { id: "saved-look" } } }, { status: 201 });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Save as Look"));
    const description = container.querySelector<HTMLTextAreaElement>('[aria-label="Look styling description"]')!;
    expect(description.value).toBe("");
    expect(container.innerHTML).not.toContain("INTERNAL-VISUAL-AUTHORITY");
    const name = container.querySelector<HTMLInputElement>('[aria-label="Look name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Rainy day");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save Look"));
    expect(writes).toEqual([]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(description, "Cream raincoat and amber umbrella");
      description.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save Look"));
    expect(writes).toEqual([{ label: "Rainy day", appearanceDelta: { description: "Cream raincoat and amber umbrella" } }]);
  });

  it.each((["generation", "variation", "retry"] as const).flatMap((kind) =>
    (["balance", "route", "viewer", "late", "json", "config"] as const).map((scenario) => [kind, scenario] as const),
  ))("checks unconfirmed %s after focus: %s", async (kind, scenario) => {
    const originalFetch = globalThis.fetch;
    const keys: string[] = [];
    let changedViewer = false;
    let configReads = 0;
    const late = deferredResponse();
    const failedJob = { id: "failed-job", mode: "image", status: "failed", errorCode: "provider_failed",
      costDreamcoins: 5, outputCount: 1, createdAt: new Date().toISOString() };
    const endpoint = kind === "generation" ? "/api/v1/generation/jobs"
      : kind === "retry" ? "/api/v1/generation/jobs/failed-job/retry" : "/api/v1/media/only-image/variation";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const balance = keys.length ? 0 : 100;
      if (path === "/api/v1/generation/config") {
        configReads += 1;
        if (scenario === "config" && configReads === 2) return Response.json({ ok: false }, { status: 503 });
        return Response.json({ ok: true, data: {
        ...config, viewer: changedViewer ? { authenticated: true, scope: "user:next-viewer" } : config.viewer,
        dreamcoins: { balance }, pricing: { ...config.pricing, image: { baseCost: 5, maxCount: 1 } },
        image: { ...config.image, availability: { state: "available" }, orientations: ["4:5"],
          recipes: ["character", "freeplay"].map((useCase) => ({ id: `image-${useCase}`, rowId: `image-${useCase}-v1`, label: "Image", mode: "image", useCase, version: 1 })),
          models: [{ id: "edit-model", label: "Image", maxCount: 1, costMultiplier: 1, entitlement: null }] },
      } });
      }
      if (keys.length && scenario === "route" && (path === "/api/v1/generation/quote" || path.endsWith("/quote"))) {
        return Response.json({ ok: false, error: { message: "The previous route is unavailable" } }, { status: 409 });
      }
      if (path === "/api/v1/generation/quote" || path.endsWith("/variation/quote")) {
        return Response.json({ ok: true, data: { quote: { ...quote, balance } } });
      }
      if (path.endsWith("/retry/quote")) return Response.json({ ok: true, data: { quote: {
        mode: "image", profileId: quote.profileId, profileVersion: quote.profileVersion,
        routeFingerprint: quote.routeFingerprint, pricing: quote.pricing,
        generationJobId: failedJob.id, outputCount: 1, costDreamcoins: 5, balance,
      } } });
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [mediaItem("only-image")], nextCursor: null } });
      if (path === endpoint && init?.method === "POST") {
        keys.push(new Headers(init.headers).get("idempotency-key") ?? "");
        if (keys.length === 1) {
          if (scenario === "late") return late.promise;
          if (scenario === "json") {
            const response = Response.json({ ok: true }, { status: 202 });
            vi.spyOn(response, "json").mockImplementation(() => late.promise.then((body) => body.json()));
            return response;
          }
          throw new TypeError("Lost response after accepted charge");
        }
        return Response.json({ ok: true, data: { job: { ...failedJob, id: "accepted-job", status: "completed", errorCode: null }, assets: [] } }, { status: 202 });
      }
      if (path === "/api/v1/generation/jobs/accepted-job") return Response.json({ ok: true, data: {
        job: { ...failedJob, id: "accepted-job", status: "completed", errorCode: null }, assets: [],
      } });
      if (path.startsWith("/api/v1/generation/jobs")) return Response.json({ ok: true, data: { items: kind === "retry" ? [failedJob] : [] } });
      return originalFetch(input, init);
    }));
    await mount();
    await click(button(kind === "generation" ? "Generate · 5 coins" : kind === "retry" ? "Retry · 5 coins" : "Create variation"));
    expect(keys).toHaveLength(1);
    changedViewer = scenario === "viewer";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    if (scenario === "config") {
      expect(container.textContent).toContain("Generation controls could not load");
      await act(async () => window.dispatchEvent(new Event("focus")));
      await settle();
    }
    if (scenario === "late" || scenario === "json") {
      late.resolve(Response.json({ ok: true, data: { job: { ...failedJob, id: "accepted-job", status: "completed", errorCode: null }, assets: [] } }, { status: 202 }));
      await settle();
      expect(container.querySelector('[data-generation-job-id="accepted-job"]')).toBeNull();
    }
    expect(container.textContent).toContain("0 coins");
    if (scenario === "viewer") {
      expect(container.textContent).not.toContain("Check generation request");
      expect(container.textContent).not.toContain("Check retry request");
      const fresh = button(kind === "generation" ? "Generate · 5 coins" : kind === "retry" ? "Retry · 5 coins" : "Create variation");
      if (kind === "variation") await click(fresh);
      else expect(fresh.disabled).toBe(true);
      expect(keys).toHaveLength(1);
      return;
    }
    const check = button(kind === "generation" ? "Check generation request" : kind === "retry" ? "Check retry request" : "Create variation");
    expect(check.disabled).toBe(false);
    await click(check);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(container.querySelector('[data-generation-job-id="accepted-job"]')).not.toBeNull();
  });

  it.each(["generation", "image-edit", "gallery-variation"] as const)("keeps the original count, model, orientation and quote when the current %s route changes", async (kind) => {
    const originalFetch = globalThis.fetch;
    const writes: Array<{ key: string | null; body: Record<string, unknown> }> = [];
    const endpoint = kind === "generation" ? "/api/v1/generation/jobs" : "/api/v1/media/image-1/variation";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const changed = writes.length > 0;
      const maxCount = changed ? 1 : 2;
      const orientation = changed ? "16:9" : "4:5";
      const model = { id: changed ? "replacement-edit-model" : "edit-model", label: "Image", maxCount, costMultiplier: 1, entitlement: null };
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, pricing: { ...config.pricing, image: { baseCost: 5, maxCount } },
        image: { ...config.image, availability: { state: "available" }, orientations: [orientation],
          recipes: ["character", "freeplay"].map((useCase) => ({ id: `image-${useCase}`, rowId: `image-${useCase}-v1`, label: "Image", mode: "image", useCase, version: 1 })),
          models: [model], editModels: [{ ...model, referenceMode: "source_only" }] },
      } });
      if (path === "/api/v1/generation/quote" || path.endsWith("/variation/quote")) return Response.json({ ok: true, data: { quote: {
        ...quote, profileVersion: changed ? 2 : 1, routeFingerprint: (changed ? "d" : "a").repeat(64),
        orientations: [orientation], defaultOrientation: orientation, maxCount,
        costs: changed ? [{ outputCount: 1, costDreamcoins: 8 }] : [{ outputCount: 1, costDreamcoins: 5 }, { outputCount: 2, costDreamcoins: 10 }],
      } } });
      if (path === endpoint && init?.method === "POST") {
        writes.push({ key: new Headers(init.headers).get("idempotency-key"), body: JSON.parse(String(init.body)) });
        if (writes.length === 1) throw new TypeError("Response lost");
        return Response.json({ ok: true, data: { job: { id: "original-job", mode: "image", status: "completed", costDreamcoins: kind === "gallery-variation" ? 5 : 10, outputCount: kind === "gallery-variation" ? 1 : 2, errorCode: null, createdAt: new Date().toISOString() }, assets: [] } }, { status: 202 });
      }
      return originalFetch(input, init);
    }));
    await mount();
    if (kind === "image-edit") {
      const card = container.querySelector('[data-testid="gallery-media-card"][data-media-id="image-1"]')!;
      await click(card.querySelector('button[aria-label="Edit image"]')!);
      const prompt = container.querySelector<HTMLTextAreaElement>('[aria-label="Edit instructions"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Add a cream raincoat");
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const model = container.querySelector<HTMLSelectElement>('#generator-model')!;
    await act(async () => {
      model.value = "edit-model";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    if (kind !== "gallery-variation") {
      const count = container.querySelector<HTMLInputElement>('#generator-output-count')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(count, "2");
        count.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await click(button(kind === "gallery-variation" ? "Create variation" : kind === "generation" ? "Generate · 10 coins" : "Create edit · 10 coins"));
    expect(writes).toHaveLength(1);
    expect(kind === "generation" ? (writes[0].body.controls as { model: string }).model : writes[0].body.model).toBe("edit-model");
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    if (kind !== "gallery-variation") {
      expect(container.querySelector<HTMLInputElement>('#generator-output-count')?.value).toBe("2");
      if (kind === "generation") expect(container.querySelector<HTMLSelectElement>('#generator-orientation')?.value).toBe("4:5");
      expect(container.querySelector<HTMLSelectElement>('#generator-model')?.value).toBe("edit-model");
    }
    const check = button(kind === "gallery-variation" ? "Create variation" : "Check generation request");
    expect(check.disabled).toBe(false);
    await click(check);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
  });

  it.each(["headers", "json"] as const)("checks a late accepted enhancement %s after focus even when its old route no longer quotes", async (stage) => {
    const originalFetch = globalThis.fetch;
    const late = deferredResponse();
    const writes: Array<{ key: string | null; body: unknown }> = [];
    const job = { id: "late-enhance", mode: "image", status: "completed", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString() };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: { ...config, image: { ...config.image, enhance: { available: true, scale: 2 } } } });
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [{ ...mediaItem("source"), enhanceEligible: true }], nextCursor: null } });
      if (path.endsWith("/enhance/quote")) return writes.length
        ? Response.json({ ok: false, error: { message: "Previous enhancement route unavailable" } }, { status: 409 })
        : Response.json({ ok: true, data: { quote, enhancement: { sourceMediaId: "source", scale: 2, sourceWidth: 512, sourceHeight: 512, width: 1024, height: 1024 } } });
      if (path.endsWith("/enhance")) {
        writes.push({ key: new Headers(init?.headers).get("idempotency-key"), body: JSON.parse(String(init?.body)) });
        if (writes.length === 1) {
          if (stage === "headers") return late.promise;
          const response = Response.json({ ok: true }, { status: 202 });
          vi.spyOn(response, "json").mockImplementation(() => late.promise.then((body) => body.json()));
          return response;
        }
        return Response.json({ ok: true, data: { job, assets: [] } }, { status: 202 });
      }
      if (path === "/api/v1/generation/jobs/late-enhance") return Response.json({ ok: true, data: { job, assets: [] } });
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Enhance image 2×"));
    await click(button("Enhance 2× · 5 coins"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    late.resolve(Response.json({ ok: true, data: { job, assets: [] } }, { status: 202 }));
    await settle();
    expect(container.querySelector('[data-generation-job-id="late-enhance"]')).toBeNull();
    await click(button("Enhance image 2×"));
    await click(button("Check enhancement request"));
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(container.querySelector('[data-generation-job-id="late-enhance"]')).not.toBeNull();
  });

  it("opens a linked saved preset using its own controls without submitting a generation", async () => {
    window.history.replaceState(null, "", "/generate?presetId=rain-preset");
    const originalFetch = globalThis.fetch;
    const generationWrites: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/jobs" && init?.method === "POST") generationWrites.push(String(init.body));
      if (path === "/api/v1/generation/presets?scope=user") return Response.json({ ok: true, data: { items: [{
        id: "rain-preset", type: "user", category: null, label: "Rainy cafe", visibility: "private",
        controls: { prompt: "Rain on the cafe window", backgroundPresetId: "cafe-background" },
      }] } });
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config,
        presets: [{ id: "cafe-background", type: "background", category: null, label: "Cafe" }],
      } });
      return originalFetch(input, init);
    }));
    await mount();
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe("Rain on the cafe window");
    expect(container.querySelector<HTMLSelectElement>('[data-testid="preset-select-background"]')?.value).toBe("cafe-background");
    expect(container.textContent).toContain('Applied preset "Rainy cafe".');
    expect(generationWrites).toEqual([]);
  });

  it("does not apply a linked preset that is absent from this viewer's saved presets", async () => {
    window.history.replaceState(null, "", "/generate?presetId=another-users-preset");
    await mount();
    expect(container.textContent).toContain("This saved preset is unavailable. Choose one of your presets below.");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe("");
    expect(container.textContent).not.toContain("Applied preset");
  });

  it.each([
    { durationSeconds: 121 / 24, width: 768, height: 1152, audio: "generated", orientation: "2:3" },
    { durationSeconds: 124 / 24, width: 512, height: 512, audio: "generated", orientation: "1:1" },
  ])("shows the quoted $width×$height video envelope before submitting without a duration override", async ({ orientation, ...video }) => {
    const originalFetch = globalThis.fetch;
    const submitted: Array<{ mode: string; controls: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config,
        entitlements: { premium_controls: true, video_generation: true },
        video: { enabled: true, availability: { state: "available" },
          recipes: [{ id: "video-recipe", rowId: "video-recipe-v1", label: "Animate character", mode: "video", useCase: "character", version: 1 }],
          requiredEntitlement: "video_generation", models: [
            { id: "video-model", label: "Video", maxCount: 1, costMultiplier: 1, entitlement: null },
          ] },
      } });
      if (url.startsWith("/api/v1/characters?")) return Response.json({ ok: true, data: {
        items: [{ id: "character", title: "Mira", age: "28", description: "Photographer",
          likes: "0", chats: "0", creator: "iDream", image: "/user-content/portrait.png" }], nextCursor: null,
      } });
      if (url === "/api/v1/generation/quote") return Response.json({ ok: true, data: {
        quote: { ...quote, mode: "video", profileId: "video-model", orientations: [orientation], defaultOrientation: orientation, video },
      } });
      if (url === "/api/v1/generation/jobs" && init?.method === "POST") {
        submitted.push(JSON.parse(String(init.body)));
        return Response.json({ ok: false, error: { message: "Request captured" } }, { status: 503 });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Video"));
    expect(container.querySelector('[data-testid="generator-video-specifications"]')?.textContent).toBe(`About 5 seconds · ${video.width}×${video.height} · Generated audio`);
    await click(button("Generate · 5 coins"));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].mode).toBe("video");
    expect(submitted[0].controls).not.toHaveProperty("seconds");
    expect(submitted[0].controls.orientation).toBe(orientation);
    // An unresolved request checks its original authority, not today's quote.
    expect(container.querySelector('[data-testid="generator-video-specifications"]')).toBeNull();
  });

  it.each([
    { mode: "video", modelId: "h3-model", modelLabel: "H3 Video", autoLabel: "Auto (animate source)" },
    { mode: "image", modelId: "premium-image", modelLabel: "Premium image", autoLabel: "Auto (identity-aware)" },
  ] as const)("keeps Auto distinct from an explicit $mode model and requotes the automatic route", async ({ mode, modelId, modelLabel, autoLabel }) => {
    const originalFetch = globalThis.fetch;
    const quoteBodies: Array<{ mode: string; controls: { model?: string } }> = [];
    const model = { id: modelId, label: modelLabel, maxCount: 1, costMultiplier: 1, entitlement: null };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, entitlements: { premium_controls: true, video_generation: true },
        pricing: { ...config.pricing, image: { baseCost: 5, maxCount: 1 } },
        image: { ...config.image, availability: { state: "available" }, orientations: ["4:5"], models: [model],
          recipes: ["character", "freeplay"].map((useCase) => ({ id: `image-${useCase}`, rowId: `image-${useCase}-v1`, label: "Image", mode: "image", useCase, version: 1 })) },
        video: { ...config.video, enabled: true, availability: { state: "available" }, models: [model],
          recipes: [{ id: "video-recipe", rowId: "video-recipe-v1", label: "Animate character", mode: "video", useCase: "character", version: 1 }] },
      } });
      if (path.startsWith("/api/v1/characters?")) return Response.json({ ok: true, data: {
        items: [{ id: "character", title: "Mira", age: "28", description: "Photographer",
          likes: "0", chats: "0", creator: "iDream", image: "/user-content/portrait.png" }], nextCursor: null,
      } });
      if (path === "/api/v1/generation/quote") {
        const body = JSON.parse(String(init?.body));
        quoteBodies.push(body);
        return Response.json({ ok: true, data: { quote: {
          ...quote, mode: body.mode, profileId: body.controls.model ?? "automatic-route",
        } } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(mode === "video" ? button("Video") : container.querySelector("#generator-freeplay")!);
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Model"]')!;
    await act(async () => {
      select.value = modelId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(select.value).toBe(modelId);
    expect(select.options[select.selectedIndex].textContent).toBe(modelLabel);
    expect(quoteBodies.at(-1)).toMatchObject({ mode, controls: { model: modelId } });
    expect(select.querySelector('option[value=""]')?.textContent).toBe(autoLabel);

    const quotesBeforeAuto = quoteBodies.length;
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(select.value).toBe("");
    expect(select.options[select.selectedIndex].textContent).toBe(autoLabel);
    expect(quoteBodies.length).toBeGreaterThan(quotesBeforeAuto);
    expect(quoteBodies.at(-1)).toMatchObject({ mode });
    expect(quoteBodies.at(-1)?.controls).not.toHaveProperty("model");
  });

  it("shows an unconfirmed job with support access instead of queue or retry promises", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/v1/generation/jobs")) return Response.json({ ok: true, data: { items: [{
        id: "unknown-video", mode: "video", status: "queued", errorCode: "provider_outcome_unknown",
        outputCount: 1, costDreamcoins: 100, createdAt: new Date().toISOString(),
      }] } });
      return originalFetch(input, init);
    }));
    await mount();
    const card = container.querySelector('[data-generation-job-id="unknown-video"]');
    expect(card?.textContent).toContain("Result needs review");
    expect(card?.textContent).not.toMatch(/queued|rendering slot|coins are back|Retry/i);
    expect(card?.querySelector('a[href="/helpdesk"]')?.textContent).toContain("Contact support");
  });

  it("keeps delivered videos accessible while video generation is disabled and after reconnect", async () => {
    await mount();
    await click(button("Videos"));
    expect(container.querySelector('[data-media-id="video-1"]')).not.toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(container.querySelector('[data-media-id="video-1"]')).not.toBeNull();
    expect(container.querySelector('[data-media-id="image-1"]')).toBeNull();
  });

  it("edits an older page image and preserves that source when Gallery filters change", async () => {
    await mount();
    await click(button("Next page"));
    expect(requests).toContain("/api/v1/media?type=image&cursor=older-cursor");
    expect(container.querySelector('[data-testid="gallery-media-card"][data-media-id="image-1"]')).toBeNull();
    const olderCard = container.querySelector('[data-testid="gallery-media-card"][data-media-id="older-image"]')!;
    await click(olderCard.querySelector('button[aria-label="Edit image"]')!);
    expect(container.querySelector('[data-testid="image-edit-source-card"][data-media-id="older-image"]')?.getAttribute("aria-pressed")).toBe("true");
    await click(button("Liked"));
    expect(container.querySelector('[data-testid="image-edit-source-card"][data-media-id="older-image"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).not.toContain("Select a source image");
    expect(requests).toContain("/api/v1/media/older-image/variation/quote");
  });

  it("offers every loaded source, including the seventh image, without a text-to-image model", async () => {
    await mount();
    await click(button("Image Edit"));
    const seventh = container.querySelector('[data-testid="image-edit-source-card"][data-media-id="image-7"]');
    expect(seventh).not.toBeNull();
    await click(seventh!);
    expect(requests).toContain("/api/v1/media/image-7/variation/quote");
    expect(container.textContent).toContain("Create edit · 5 coins");
  });

  it("keeps the selected edit source when deleting it fails", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/media/image-1" && init?.method === "DELETE") {
        return Response.json({ ok: false }, { status: 500 });
      }
      return originalFetch(input, init);
    }));
    await mount();
    const card = container.querySelector('[data-testid="gallery-media-card"][data-media-id="image-1"]')!;
    await click(card.querySelector('button[aria-label="Edit image"]')!);
    await click(card.querySelector('button[aria-label="Delete"]')!);
    await click(card.querySelector('button[aria-label="Confirm delete media"]')!);
    expect(container.textContent).toContain("Delete failed.");
    expect(container.querySelector('[data-testid="image-edit-source-card"][data-media-id="image-1"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("clears a selected source after a successful bulk deletion", async () => {
    const originalFetch = globalThis.fetch;
    let deleted = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/media/bulk") {
        deleted = true;
        return Response.json({ ok: true, data: { deleted: 1 } });
      }
      if (deleted && String(input).startsWith("/api/v1/media?")) {
        return Response.json({ ok: true, data: { items: [mediaItem("image-2")], nextCursor: null } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    const card = container.querySelector('[data-testid="gallery-media-card"][data-media-id="image-1"]')!;
    await click(card.querySelector('button[aria-label="Edit image"]')!);
    await click(button("Manage"));
    await click(card.querySelector('button[aria-label="Select media"]')!);
    await click(button("Delete selected"));
    await click(button("Confirm delete selected"));
    expect(container.textContent).toContain("Deleted 1 item.");
    expect(container.querySelector('[data-testid="image-edit-source-card"][data-media-id="image-1"]')).toBeNull();
    expect(container.textContent).toContain("Select a source image");
  });

  it.each(["same viewer", "different viewer", "failed"] as const)(
    "restores an older edit source only after %s revalidation confirms its owner",
    async (result) => {
      await mount();
      await click(button("Next page"));
      const olderCard = container.querySelector('[data-testid="gallery-media-card"][data-media-id="older-image"]')!;
      await click(olderCard.querySelector('button[aria-label="Edit image"]')!);

      const originalFetch = globalThis.fetch;
      const revalidation = deferredResponse();
      let awaitingConfig = true;
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        awaitingConfig && String(input) === "/api/v1/generation/config"
          ? revalidation.promise
          : originalFetch(input, init),
      ));
      await act(async () => window.dispatchEvent(new Event("focus")));
      await settle();
      expect(container.querySelector('[data-testid="image-edit-source-card"][data-media-id="older-image"]')).toBeNull();

      awaitingConfig = false;
      revalidation.resolve(result === "failed"
        ? Response.json({ ok: false }, { status: 503 })
        : Response.json({ ok: true, data: result === "same viewer" ? config : {
          ...config, viewer: { authenticated: true, scope: "user:another-viewer" },
        } }));
      await settle();
      if (result === "same viewer") {
        expect(container.querySelector('[data-testid="image-edit-source-card"][data-media-id="older-image"]')?.getAttribute("aria-pressed")).toBe("true");
      } else {
        expect(container.querySelector('[data-testid="image-edit-source-card"][data-media-id="older-image"]')).toBeNull();
        // Recovery or switching back must not resurrect a draft discarded on failure/account change.
        await act(async () => window.dispatchEvent(new Event("focus")));
        await settle();
        expect(container.querySelector('[data-testid="image-edit-source-card"][data-media-id="older-image"]')).toBeNull();
      }
    },
  );

  it.each(["queued", "rejected"] as const)(
    "discards a late %s generation write after the viewer changes",
    async (result) => {
      await mount();
      const originalFetch = globalThis.fetch;
      const write = deferredResponse();
      let viewerChanged = false;
      const calls: string[] = [];
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        calls.push(path);
        if (path === "/api/v1/media/image-1/variation") return write.promise;
        if (path === "/api/v1/generation/config" && viewerChanged) {
          return Promise.resolve(Response.json({ ok: true, data: {
            ...config, viewer: { authenticated: true, scope: "user:another-viewer" },
          } }));
        }
        return originalFetch(input, init);
      }));
      const card = container.querySelector('[data-testid="gallery-media-card"][data-media-id="image-1"]')!;
      await click(card.querySelector('button[aria-label="Create variation"]')!);
      expect(calls).toContain("/api/v1/media/image-1/variation");
      viewerChanged = true;
      await act(async () => window.dispatchEvent(new Event("focus")));
      await settle();
      const callsBeforeOldResult = calls.length;
      write.resolve(result === "queued"
        ? Response.json({ ok: true, data: { job: {
          id: "previous-viewer-job", mode: "image", status: "queued", costDreamcoins: 5,
          outputCount: 1, errorCode: null, createdAt: "2026-09-02T00:00:00.000Z",
        }, assets: [] } })
        : Response.json({ ok: false, error: { message: "Previous viewer balance changed" } }, { status: 402 }));
      await settle();
      expect(container.querySelector('[data-generation-job-id="previous-viewer-job"]')).toBeNull();
      expect(container.textContent).not.toContain("Previous viewer balance changed");
      expect(calls.slice(callsBeforeOldResult)).toEqual([]);
    },
  );

  it("does not submit a variation under a new viewer after its old price read finishes", async () => {
    await mount();
    const originalFetch = globalThis.fetch;
    const pricing = deferredResponse();
    let viewerChanged = false;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(path);
      if (path === "/api/v1/media/image-1/variation/quote") return pricing.promise;
      if (path === "/api/v1/generation/config" && viewerChanged) {
        return Promise.resolve(Response.json({ ok: true, data: {
          ...config, viewer: { authenticated: true, scope: "user:another-viewer" },
        } }));
      }
      return originalFetch(input, init);
    }));
    const card = container.querySelector('[data-testid="gallery-media-card"][data-media-id="image-1"]')!;
    await click(card.querySelector('button[aria-label="Create variation"]')!);
    viewerChanged = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    pricing.resolve(Response.json({ ok: true, data: { quote } }));
    await settle();
    expect(calls).not.toContain("/api/v1/media/image-1/variation");
  });
});
