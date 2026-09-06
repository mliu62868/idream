// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: ComponentProps<"a">) =>
    createElement("a", { href: String(href), ...props }, children),
}));
vi.mock("next/image", () => ({
  default: ({ fill: _fill, unoptimized: _unoptimized, ...props }: ComponentProps<"img"> & {
    fill?: boolean; unoptimized?: boolean;
  }) => createElement("img", props),
}));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));

import { ProfileWorkspace } from "./ProfileWorkspace";
import { invalidateViewerAuthority } from "./viewer-auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mediaItem(id: string) {
  return { id, type: "image", prompt: `Scene ${id}`, url: `/user-content/${id}.png` };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("ProfileWorkspace media pagination", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: string[];
  let viewer: string;
  let olderPage: () => Promise<Response>;
  let searchPage: (query: string) => Promise<Response>;

  beforeEach(() => {
    window.history.replaceState(null, "", "/custom");
    requests = [];
    viewer = "viewer-a";
    olderPage = async () => Response.json({ ok: true, data: {
      items: [mediaItem("image-41")], nextCursor: null,
    } });
    searchPage = async () => Response.json({ ok: true, data: {
      items: [mediaItem("image-41")], nextCursor: null,
    } });
    invalidateViewerAuthority();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      let data: unknown = { items: [] };
      if (path === "/api/v1/me") data = { user: { id: viewer } };
      else if (path === "/api/v1/profile") data = {
        user: { id: viewer, displayName: viewer, email: `${viewer}@example.test` },
        balance: 100, subscription: null, billingAccess: null, entitlements: {},
      };
      else if (path === "/api/v1/profile/preferences") data = { preferences: {} };
      else if (path === "/api/v1/profile/chat-persona") data = { ownerScope: `user:${viewer}`, persona: null, version: 0 };
      else if (path === "/api/v1/media/collections") data = { collections: [] };
      else if (path.startsWith("/api/v1/library/media?") && new URL(path, "http://localhost").searchParams.has("q")) {
        return searchPage(new URL(path, "http://localhost").searchParams.get("q")!);
      }
      else if (path === "/api/v1/library/media?cursor=older-cursor") return olderPage();
      else if (path === "/api/v1/library/media") data = viewer === "viewer-a"
        ? { items: Array.from({ length: 40 }, (_, index) => mediaItem(`image-${index + 1}`)), nextCursor: "older-cursor" }
        : { items: [mediaItem("viewer-b-image")], nextCursor: null };
      else if (path.endsWith("/download")) data = { url: "/user-content/download.png" };
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
    invalidateViewerAuthority();
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

  async function mountMedia() {
    await act(async () => root.render(createElement(ProfileWorkspace, { routePath: "/custom" })));
    await settle();
    await click(button("media"));
  }

  async function setSearch(value: string) {
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search your library"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function searchFor(value: string) {
    await setSearch(value);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await settle();
  }

  it("clears sensitive account controls and drops a delayed recovery code after switching accounts", async () => {
    const deferred = deferredResponse();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/account/recovery-code") return deferred.promise;
      return originalFetch(input, init);
    }));
    await mountMedia();
    const password = container.querySelector<HTMLInputElement>('[aria-label="Current account password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "A-private-password");
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Generate new recovery code"));
    viewer = "viewer-b";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    deferred.resolve(Response.json({ ok: true, data: { recoveryCode: "A-secret-recovery-code" } }));
    await settle();
    expect(container.textContent).not.toContain("A-secret-recovery-code");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Current account password"]')?.value).toBe("");
  });

  it("shows and searches saved preset labels and opens the selected preset in Generate", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/library/presets") return Response.json({ ok: true, data: { items: [
        { id: "preset-rain", label: "Rainy cafe", controls: { prompt: "Rain at the cafe window" }, status: "active" },
        { id: "preset-sun", label: "Sunny garden", controls: {}, status: "active" },
      ] } });
      return originalFetch(input, init);
    }));
    await act(async () => root.render(createElement(ProfileWorkspace, { routePath: "/custom" })));
    await settle();
    await click(button("presets"));
    expect(container.querySelector('[data-media-id="preset-rain"]')?.textContent).toContain("Rainy cafe");
    expect(container.querySelector('[data-media-id="preset-rain"]')?.closest("a")?.getAttribute("href"))
      .toBe("/generate?presetId=preset-rain");
    await setSearch("rainy");
    expect(container.querySelector('[data-media-id="preset-rain"]')).not.toBeNull();
    expect(container.querySelector('[data-media-id="preset-sun"]')).toBeNull();
  });

  it("restores the exact recent conversation even when another session uses the same character", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/library/recent") return Response.json({ ok: true, data: { items: [
        { id: "session-old", type: "chat", title: "Earlier visit", character: { id: "mira", name: "Mira" } },
        { id: "session-new", type: "chat", title: "Latest visit", character: { id: "mira", name: "Mira" } },
      ] } });
      return originalFetch(input, init);
    }));
    await act(async () => root.render(createElement(ProfileWorkspace, { routePath: "/custom" })));
    await settle();
    for (const id of ["session-old", "session-new"]) {
      expect(container.querySelector(`[data-media-id="${id}"]`)?.closest("a")?.getAttribute("href"))
        .toBe(`/chat/${id}`);
    }
  });

  it("loads the requested library tab from the URL instead of showing Recent", async () => {
    window.history.replaceState(null, "", "/custom?tab=media");
    await act(async () => root.render(createElement(ProfileWorkspace, { routePath: "/custom" })));
    await settle();
    expect(button("media").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll("[data-media-id]")).toHaveLength(40);
    expect(requests).not.toContain("/api/v1/library/recent");
  });

  it("keeps tab URLs and history navigation aligned while rejecting the departed page response", async () => {
    const pendingPage = deferredResponse();
    olderPage = () => pendingPage.promise;
    await mountMedia();
    expect(new URL(window.location.href).searchParams.get("tab")).toBe("media");
    await click(button("Next page"));
    await click(button("presets"));
    expect(new URL(window.location.href).searchParams.get("tab")).toBe("presets");
    await act(async () => {
      window.history.replaceState(null, "", "/custom?tab=media");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();
    await act(async () => pendingPage.resolve(Response.json({ ok: true, data: {
      items: [mediaItem("departed-page")], nextCursor: null,
    } })));
    await settle();
    expect(button("media").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll("[data-media-id]")).toHaveLength(40);
    expect(container.querySelector('[data-media-id="departed-page"]')).toBeNull();
    expect(container.textContent).toContain("Page 1");
  });

  it("shows the 41st media after the first 40, permits download, and returns to page one", async () => {
    await mountMedia();
    expect(container.querySelectorAll("[data-media-id]")).toHaveLength(40);
    await click(button("Next page"));
    expect(requests).toContain("/api/v1/library/media?cursor=older-cursor");
    expect(container.querySelectorAll("[data-media-id]")).toHaveLength(1);
    expect(container.querySelector('[data-media-id="image-41"]')).not.toBeNull();
    expect(container.textContent).toContain("Page 2");
    await click(button("Download media"));
    expect(requests).toContain("/api/v1/media/image-41/download");
    expect(button("Next page").disabled).toBe(true);
    await click(button("Previous page"));
    expect(container.querySelectorAll("[data-media-id]")).toHaveLength(40);
    expect(container.textContent).toContain("Page 1");
  });

  it("offers Make private for an unlisted Character without changing its directory preference", async () => {
    const originalFetch = globalThis.fetch;
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/library/created") return Response.json({ ok: true, data: { items: [{
        id: "unlisted-character", name: "Avery", visibility: "unlisted", status: "approved",
        publicationState: "awaiting_publication", image: "/user-content/avery.png",
      }] } });
      if (String(input) === "/api/v1/characters/unlisted-character" && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      return originalFetch(input, init);
    }));
    await act(async () => root.render(createElement(ProfileWorkspace, { routePath: "/custom" })));
    await settle();
    await click(button("created"));
    expect(container.textContent).toContain("awaiting publication");
    await click(button("Make private"));
    expect(patches).toEqual([{ visibility: "private" }]);
  });

  it("retries the failed page without silently returning to the first 40 items", async () => {
    const successfulPage = olderPage;
    olderPage = async () => Response.json({ ok: false }, { status: 503 });
    await mountMedia();
    await click(button("Next page"));
    expect(container.textContent).toContain("Library data could not load.");
    olderPage = successfulPage;
    await click(button("Retry"));
    expect(container.querySelector('[data-media-id="image-41"]')).not.toBeNull();
    expect(container.textContent).toContain("Page 2");
    expect(requests.filter((path) => path.includes("cursor=older-cursor"))).toHaveLength(2);
  });

  it("finds media beyond the first 40 through the server and resets the cursor when searching or clearing", async () => {
    await mountMedia();
    await searchFor("image-41");
    expect(requests).toContain("/api/v1/library/media?q=image-41");
    expect(container.querySelector('[data-media-id="image-41"]')).not.toBeNull();
    await click(button("Clear search"));
    expect(container.querySelectorAll("[data-media-id]")).toHaveLength(40);
    await click(button("Next page"));
    await searchFor("image-41");
    expect(requests.at(-1)).toBe("/api/v1/library/media?q=image-41");
    expect(container.textContent).not.toContain("Page 2");
    expect(container.querySelectorAll("[data-media-id]")).toHaveLength(1);
  });

  it("does not apply a stale search or discard server matches based on absent client titles", async () => {
    const oldSearch = deferredResponse();
    searchPage = (query) => query === "old search" ? oldSearch.promise : Promise.resolve(
      Response.json({ ok: true, data: {
        items: [{ id: "voice-41", type: "voice", prompt: null, url: "/user-content/voice.mp3" }], nextCursor: null,
      } }),
    );
    await mountMedia();
    await searchFor("old search");
    await searchFor("voice clip");
    await act(async () => oldSearch.resolve(Response.json({ ok: true, data: {
      items: [mediaItem("stale-search-result")], nextCursor: "stale-search-cursor",
    } })));
    await settle();
    expect(container.querySelector('[data-media-id="voice-41"]')).not.toBeNull();
    expect(container.querySelector('[data-media-id="stale-search-result"]')).toBeNull();
    expect(container.querySelector('nav[aria-label="Library pages"]')).toBeNull();
  });

  it("discards a pending older page as soon as a new media search starts", async () => {
    const oldPage = deferredResponse();
    olderPage = () => oldPage.promise;
    await mountMedia();
    await click(button("Next page"));
    await setSearch("image-41");
    await act(async () => oldPage.resolve(Response.json({ ok: true, data: {
      items: [mediaItem("stale-page-result")], nextCursor: "stale-cursor",
    } })));
    expect(container.querySelector('[data-media-id="stale-page-result"]')).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await settle();
    expect(container.querySelector('[data-media-id="image-41"]')).not.toBeNull();
    expect(container.querySelector('[data-media-id="stale-page-result"]')).toBeNull();
  });

  it("returns to the preceding page after the last older item is deleted", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/media/image-41" && init?.method === "DELETE") {
        olderPage = async () => Response.json({ ok: true, data: { items: [], nextCursor: null } });
        return Response.json({ ok: true });
      }
      return originalFetch(input, init);
    }));
    await mountMedia();
    await click(button("Next page"));
    await click(button("Delete media"));
    await click(button("Confirm delete media"));
    expect(container.querySelectorAll("[data-media-id]")).toHaveLength(40);
    expect(container.querySelector('[data-media-id="image-41"]')).toBeNull();
    expect(container.textContent).toContain("Page 1");
    expect(container.textContent).not.toContain("No media yet");
  });

  it("discards an old page after changing library tabs and resets Media to page one", async () => {
    const pendingPage = deferredResponse();
    olderPage = () => pendingPage.promise;
    await mountMedia();
    await click(button("Next page"));
    await click(button("characters"));
    await click(button("media"));
    await act(async () => pendingPage.resolve(Response.json({ ok: true, data: {
      items: [mediaItem("stale-image")], nextCursor: "stale-cursor",
    } })));
    await settle();
    expect(container.querySelector('[data-media-id="stale-image"]')).toBeNull();
    expect(container.querySelectorAll("[data-media-id]")).toHaveLength(40);
    expect(container.textContent).toContain("Page 1");
    expect(button("Previous page").disabled).toBe(true);
  });

  it("never revives another viewer's pending search after the signed-in page is replaced", async () => {
    const pendingSearch = deferredResponse();
    searchPage = () => pendingSearch.promise;
    await mountMedia();
    await searchFor("private image");
    await act(async () => root.unmount());
    viewer = "viewer-b";
    invalidateViewerAuthority();
    root = createRoot(container);
    await mountMedia();
    await act(async () => pendingSearch.resolve(Response.json({ ok: true, data: {
      items: [mediaItem("viewer-a-private-image")], nextCursor: "viewer-a-cursor",
    } })));
    await settle();
    expect(container.querySelector('[data-media-id="viewer-b-image"]')).not.toBeNull();
    expect(container.querySelector('[data-media-id="viewer-a-private-image"]')).toBeNull();
    expect(container.querySelector('nav[aria-label="Library pages"]')).toBeNull();
  });
});
