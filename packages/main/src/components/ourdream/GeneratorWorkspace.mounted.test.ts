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

  it("submits video with the quoted recipe instead of overriding its duration", async () => {
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
        quote: { ...quote, mode: "video", profileId: "video-model" },
      } });
      if (url === "/api/v1/generation/jobs" && init?.method === "POST") {
        submitted.push(JSON.parse(String(init.body)));
        return Response.json({ ok: false, error: { message: "Request captured" } }, { status: 503 });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Video"));
    await click(button("Generate · 5 coins"));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].mode).toBe("video");
    expect(submitted[0].controls).not.toHaveProperty("seconds");
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
