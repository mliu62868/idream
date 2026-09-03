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

describe("GeneratorWorkspace Gallery filters and video playback", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: string[];

  beforeEach(() => {
    window.history.replaceState(null, "", "/generate");
    window.localStorage.clear();
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


  async function filterGallery(search: string, visibility = "") {
    const form = container.querySelector<HTMLFormElement>('form[aria-label="Gallery filters"]')!;
    const input = form.querySelector<HTMLInputElement>('input[type="search"]')!;
    const select = form.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, search);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      select.value = visibility;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
  }

  it("queries older media on the server and preserves filters through pages, tabs and reconnect", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?") && new URL(path, "http://localhost").searchParams.has("q")) {
        requests.push(path);
        const url = new URL(path, "http://localhost");
        return Response.json({ ok: true, data: { items: [mediaItem(url.searchParams.has("cursor") ? "filtered-second" : "filtered-first")], nextCursor: url.searchParams.has("cursor") ? null : "filtered-page" } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Next page"));
    await filterGallery("  rooftop 雨  ", "private");
    expect(requests).toContain("/api/v1/media?type=image&q=rooftop%20%E9%9B%A8&visibility=private");
    expect(container.querySelector('[data-media-id="older-image"]')).toBeNull();
    expect(container.querySelector('[data-media-id="filtered-first"]')).not.toBeNull();
    expect(container.textContent).toContain("Page 1");
    await click(button("Next page"));
    expect(requests).toContain("/api/v1/media?type=image&q=rooftop%20%E9%9B%A8&visibility=private&cursor=filtered-page");
    expect(container.querySelector('[data-media-id="filtered-second"]')).not.toBeNull();
    await click(button("Liked"));
    expect(requests).toContain("/api/v1/media?liked=1&types=image,video&q=rooftop%20%E9%9B%A8&visibility=private");
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(requests.at(-1)).not.toContain("cursor=filtered-page");
    expect(container.querySelector<HTMLInputElement>('form[aria-label="Gallery filters"] input')?.value).toBe("  rooftop 雨  ");
    expect(requests.filter((path) => path === "/api/v1/media?liked=1&types=image,video&q=rooftop%20%E9%9B%A8&visibility=private").length).toBeGreaterThanOrEqual(2);
  });

  it("drops late filter results and clears selection when the filter changes", async () => {
    const old = deferredResponse();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/media?type=image&q=old") return old.promise;
      if (path === "/api/v1/media?type=image&q=new") return Response.json({ ok: true, data: { items: [mediaItem("new-result")], nextCursor: null } });
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Manage"));
    await click(button("Select all"));
    expect(container.textContent).toContain("8 selected");
    await filterGallery("old");
    expect(container.querySelector('[data-media-id="image-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="gallery-bulk-toolbar"]')).toBeNull();
    await filterGallery("new");
    old.resolve(Response.json({ ok: true, data: { items: [mediaItem("late-old-result")], nextCursor: "wrong-page" } }));
    await settle();
    expect(container.querySelector('[data-media-id="new-result"]')).not.toBeNull();
    expect(container.querySelector('[data-media-id="late-old-result"]')).toBeNull();
    expect(container.querySelector('nav[aria-label="Gallery pages"]')).toBeNull();
  });

  it("keeps a failed query retryable and distinguishes no matches from an empty Gallery", async () => {
    let fail = true;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/media?type=image&q=missing&visibility=unlisted") {
        return fail ? Response.json({ ok: false, error: { message: "Filtered Gallery unavailable" } }, { status: 503 })
          : Response.json({ ok: true, data: { items: [], nextCursor: null } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await filterGallery("missing", "unlisted");
    const alert = [...container.querySelectorAll('[role="alert"]')].find((node) => node.textContent?.includes("Filtered Gallery unavailable"))!;
    expect(alert).toBeDefined();
    expect(container.textContent).not.toContain("No media match these filters.");
    fail = false;
    await click(alert.querySelector("button")!);
    expect(container.textContent).toContain("No media match these filters.");
    await click(button("Clear filters"));
    expect(container.querySelector('[data-media-id="image-1"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('form[aria-label="Gallery filters"] input')?.value).toBe("");
  });

  it("clears another viewer's filter and ignores a private delayed page after account change", async () => {
    let scope = config.viewer.scope;
    const old = deferredResponse();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: { ...config, viewer: { authenticated: true, scope } } });
      if (path === "/api/v1/media?type=image&q=private-phrase") return old.promise;
      return originalFetch(input, init);
    }));
    await mount();
    await filterGallery("private-phrase");
    scope = "user:another-viewer";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    old.resolve(Response.json({ ok: true, data: { items: [mediaItem("previous-private-result")], nextCursor: null } }));
    await settle();
    expect(container.querySelector<HTMLInputElement>('form[aria-label="Gallery filters"] input')?.value).toBe("");
    expect(container.querySelector('[data-media-id="previous-private-result"]')).toBeNull();
  });

  it("plays the video content with its separate poster and keeps native controls unobstructed", async () => {
    await mount();
    await click(button("Videos"));
    const card = container.querySelector('[data-media-id="video-1"]')!;
    const video = card.querySelector("video")!;
    expect(video.querySelector("source")?.getAttribute("src")).toBe("/user-content/video-1.mp4");
    expect(video.getAttribute("poster")).toBe("/user-content/video-1.png");
    expect(video.classList.contains("object-contain")).toBe(true);
    expect(card.querySelector('button[aria-label="Download"]')?.parentElement?.classList.contains("top-2")).toBe(true);
    await act(async () => video.querySelector("source")!.dispatchEvent(new Event("error")));
    await settle();
    expect(card.querySelector('[data-testid="gallery-media-preview-fallback"]')?.textContent).toContain("Preview unavailable");
    expect(card.querySelector('button[aria-label="Download"]')).not.toBeNull();
    expect(card.querySelector('button[aria-label="Delete"]')).not.toBeNull();
    await click(button("Retry preview"));
    expect(card.querySelector("video source")?.getAttribute("src")).toBe("/user-content/video-1.mp4");
  });

  it("does not use the canonical video URL or a built-in placeholder as its poster", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/media?type=video") {
        const video = mediaItem("canonical-video", "video");
        return Response.json({ ok: true, data: { items: [{ ...video, thumbnailUrl: video.url },
          { ...mediaItem("placeholder-video", "video"), thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp" }], nextCursor: null } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Videos"));
    expect(container.querySelector("video")?.getAttribute("poster")).toBeNull();
    expect(container.querySelector("video source")?.getAttribute("src")).toBe("/user-content/canonical-video.mp4");
    const placeholderVideo = container.querySelector('[data-media-id="placeholder-video"] video');
    expect(placeholderVideo).not.toBeNull();
    expect(placeholderVideo?.getAttribute("poster")).toBeNull();
    expect(placeholderVideo?.querySelector("source")?.getAttribute("src")).toBe("/user-content/placeholder-video.mp4");
  });
});
