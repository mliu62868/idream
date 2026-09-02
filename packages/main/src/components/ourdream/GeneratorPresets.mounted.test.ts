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

describe("GeneratorWorkspace owned preset editing", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: string[];
  let scope: string;
  let premium: boolean;
  let owned: Array<{ id: string; type: string; label: string; category: string | null; controls: Record<string, string>; visibility: string }>;
  const catalog = [
    { id: "cafe", type: "background", label: "Cafe", category: "Indoor", scope: "built_in" },
    { id: "roof", type: "background", label: "Rooftop", category: "Outdoor", scope: "community" },
  ];

  beforeEach(() => {
    window.history.replaceState(null, "", "/generate");
    window.localStorage.clear();
    requests = [];
    scope = config.viewer.scope;
    premium = true;
    owned = [
      { id: "own-scene", type: "background", label: "Rainy window", category: "Indoor", controls: { background: "Rain on a cafe window" }, visibility: "private" },
      { id: "own-setup", type: "mode", label: "Cafe setup", category: "Indoor", controls: { backgroundPresetId: "cafe" }, visibility: "private" },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      let data: unknown = { items: [] };
      if (path === "/api/v1/generation/config") data = { ...config, viewer: { authenticated: true, scope }, entitlements: { premium_controls: premium }, presets: catalog };
      else if (path === "/api/v1/generation/presets?scope=user") data = { items: owned };
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

  async function input(label: string, value: string) {
    const node = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    expect(node, label).not.toBeNull();
    await act(async () => {
      const prototype = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function select(label: string, value: string) {
    const node = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent?.includes(label))?.querySelector("select")!;
    expect(node, label).not.toBeNull();
    await act(async () => { node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); });
  }

  it("filters the public and owned catalog without discarding an active selection", async () => {
    await mount();
    await select("Background", "own-scene");
    await select("Preset source", "community");
    await select("Preset category", "Outdoor");
    const selector = container.querySelector<HTMLSelectElement>('[data-testid="preset-select-background"]')!;
    expect(selector.value).toBe("own-scene");
    expect([...selector.options].map((option) => option.value)).toEqual(["", "roof", "own-scene"]);
    expect(container.querySelectorAll('[data-testid="my-preset-item"]')).toHaveLength(0);
    await select("Preset source", "user");
    await select("Preset category", "Indoor");
    expect(container.querySelectorAll('[data-testid="my-preset-item"]')).toHaveLength(2);
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "window");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-testid="my-preset-item"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="my-preset-item"]')?.textContent).toContain("Rainy window");
  });

  it("creates a private reusable fragment and applies its id without starting generation", async () => {
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        writes.push({ path: String(url), body });
        const preset = { id: "new-pose", ...body };
        owned.push(preset);
        return Response.json({ ok: true, data: { preset } });
      }
      return baseFetch(url, init);
    }));
    await mount();
    await select("Save as", "pose");
    await input("Preset name", "  Window seat  ");
    await input("Saved preset category", "  Quiet scenes  ");
    await input("Preset description", "Seated sideways, looking out the window");
    await click(button("Save"));
    expect(writes).toEqual([{ path: "/api/v1/generation/presets", body: {
      type: "pose", label: "Window seat", category: "Quiet scenes", visibility: "private",
      controls: { pose: "Seated sideways, looking out the window" },
    } }]);
    const row = [...container.querySelectorAll('[data-testid="my-preset-item"]')].find((node) => node.textContent?.includes("Window seat"))!;
    await click([...row.querySelectorAll("button")].find((node) => node.textContent === "Apply")!);
    expect(container.querySelector<HTMLSelectElement>('[data-testid="preset-select-pose"]')?.value).toBe("new-pose");
    expect(writes).toHaveLength(1);
  });

  it("preserves an edit across same-viewer reconnect and saves only once to the original preset", async () => {
    const pending = deferredResponse();
    const reconnect = deferredResponse();
    let configReads = 0;
    const writes: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "/api/v1/generation/config" && ++configReads === 2) return reconnect.promise;
      if (init?.method === "PATCH" || init?.method === "POST") {
        writes.push({ url: String(url), method: init.method, body: JSON.parse(String(init.body)) });
        return pending.promise;
      }
      return baseFetch(url, init);
    }));
    await mount();
    await click(button("Edit preset Rainy window"));
    await input("Preset name", "Evening window");
    await input("Preset description", "Amber lamps reflected in rainy glass");
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(container.querySelector('[data-testid="my-presets"]')).toBeNull();
    reconnect.resolve(Response.json({ ok: true, data: { ...config, presets: catalog } }));
    await settle();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Preset name"]')?.value).toBe("Evening window");
    await click(button("Save changes"));
    await click(button("Saving…"));
    expect(writes).toEqual([{ url: "/api/v1/generation/presets/own-scene", method: "PATCH", body: {
      label: "Evening window", category: "Indoor", visibility: "private", controls: { background: "Amber lamps reflected in rainy glass" },
    } }]);
    pending.resolve(Response.json({ ok: true, data: { preset: { ...owned[0], ...writes[0]!.body } } }));
    await settle();
    expect(container.textContent).toContain('Updated preset "Evening window".');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Preset name"]')?.value).toBe("");
  });

  it("keeps the edited content after a failure and retries the same owned preset", async () => {
    let calls = 0;
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        calls += 1;
        expect(String(url)).toBe("/api/v1/generation/presets/own-scene");
        return calls === 1 ? Response.json({ ok: false, error: { message: "Preset update unavailable" } }, { status: 503 })
          : Response.json({ ok: true, data: { preset: owned[0] } });
      }
      return baseFetch(url, init);
    }));
    await mount();
    await click(button("Edit preset Rainy window"));
    await input("Preset description", "New rainy description");
    await click(button("Save changes"));
    expect(container.textContent).toContain("Preset update unavailable");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Preset description"]')?.value).toBe("New rainy description");
    await click(button("Save changes"));
    expect(calls).toBe(2);
    expect(container.textContent).toContain('Updated preset "Rainy window".');
  });

  it("clears another viewer's edit and ignores a delayed save result after account change", async () => {
    const pending = deferredResponse();
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === "PATCH" ? pending.promise : baseFetch(url, init)));
    await mount();
    await click(button("Edit preset Rainy window"));
    await input("Preset name", "Private old viewer label");
    await click(button("Save changes"));
    scope = "user:next-preset-viewer";
    owned = [];
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    pending.resolve(Response.json({ ok: true, data: { preset: { id: "own-scene" } } }));
    await settle();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Preset name"]')?.value).toBe("");
    expect(container.textContent).not.toContain("Private old viewer label");
    expect(container.textContent).not.toContain("Save changes");
    expect(button("Save").disabled).toBe(true);
  });

  it("replaces a stale prompt when applying a setup that has no prompt", async () => {
    await mount();
    await input("Prompt", "Old scene must not leak into this setup");
    const row = [...container.querySelectorAll('[data-testid="my-preset-item"]')].find((node) => node.textContent?.includes("Cafe setup"))!;
    await click([...row.querySelectorAll("button")].find((node) => node.textContent === "Apply")!);
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe("");
    expect(container.querySelector<HTMLSelectElement>('[data-testid="preset-select-background"]')?.value).toBe("cafe");
  });

  it("does not erase an existing saved prompt when its control becomes unavailable", async () => {
    premium = false;
    owned[1]!.controls.prompt = "Preserve this saved prompt";
    let saved: Record<string, unknown> | null = null;
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        saved = JSON.parse(String(init.body));
        return Response.json({ ok: true, data: { preset: owned[1] } });
      }
      return baseFetch(url, init);
    }));
    await mount();
    await click(button("Edit preset Cafe setup"));
    await input("Preset name", "Renamed saved setup");
    await click(button("Save changes"));
    expect(saved).toMatchObject({ label: "Renamed saved setup", controls: { backgroundPresetId: "cafe", prompt: "Preserve this saved prompt" } });
  });
});
