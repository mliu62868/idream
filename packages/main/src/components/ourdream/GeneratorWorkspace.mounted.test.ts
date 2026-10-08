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
import { readCurrentGenerationJob, saveCurrentGenerationJob } from "@/lib/generation-current-job";
import { requestGenerationJobWithExactAuthority, requestGenerationRetryWithExactAuthority } from "@/lib/generation-write-client";

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

const videoCapabilities = { options: { seconds: [3, 5], orientations: ["2:3", "1:1"], qualities: ["preview", "standard"] }, audio: ["generated", "silent", "narration"] };
const videoQuote = { fingerprint: "c".repeat(64), costDreamcoins: 5, balance: 100, audio: "generated", narrationExtendsLastFrame: false, narrationExtraCostDreamcoins: 0,
  costs: [{ ordinal: 0, costDreamcoins: 5 }], scenes: [{ ordinal: 0, video: { durationSeconds: 121 / 24, width: 768, height: 1152, audio: "generated" } }] };

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const chatHandoff = {
  token: "owned-turn-context", characterId: "character", characterName: "Mira",
  source: { kind: "chat", sessionId: "chat-session", turnId: "chat-turn", attempt: 1 },
  identityMode: "character", returnHref: "/chat/chat-session", sourceLabel: "your chat",
  prompt: "Mira holds a blue cup in the greenhouse.", scene: null, sourceMedia: null,
  pins: { characterContentVersionId: "content-v1", characterReleaseId: "release-v1",
    releaseSnapshotHash: "a".repeat(64), visualProfileId: "visual-v1", visualProfileVersion: 1,
    referenceSetRevisionId: "references-v1" },
};

function installNextHistory() {
  const originalReplace = window.history.replaceState.bind(window.history);
  let canonicalHref = window.location.href;
  const internalState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ["generate"], renderedSearch: window.location.search } };
  originalReplace(internalState, "", canonicalHref);
  // Next 16's history boundary treats __NA/_N writes as framework commits.
  // Plain happy-dom history cannot expose a stale canonical route being restored.
  vi.spyOn(window.history, "replaceState").mockImplementation((data, unused, url) => {
    if (!data?.__NA && !data?._N && url) canonicalHref = new URL(String(url), window.location.href).href;
    originalReplace({ ...data, ...internalState }, unused, url);
  });
  return { commit: () => window.history.replaceState(internalState, "", canonicalHref) };
}

describe("GeneratorWorkspace media journeys", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: string[];

  beforeEach(() => {
    window.sessionStorage.clear();
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
    vi.useRealTimers();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
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

  it.each(["image", "video"] as const)("brings the opened %s feedback editor into view and keyboard focus without submitting", async type => {
    const originalFetch = globalThis.fetch;
    const mutations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST" && (path.endsWith("/feedback") || path === "/api/v1/generation/jobs")) mutations.push(path);
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [{ ...mediaItem("visible-editor-result", type), intentFeedbackAvailable: true }], nextCursor: null } });
      return originalFetch(input, init);
    }));
    await mount();
    if (type === "video") await click(button("Videos"));
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const opener = button("Report intent mismatch");
    opener.focus();
    expect(document.activeElement, "the keyboard starts on the selected Gallery result's report action").toBe(opener);
    await click(opener);
    const editor = container.querySelector<HTMLElement>('[aria-label="Intent feedback editor"]');
    expect(editor, "click creates the requested editor").not.toBeNull();
    expect.soft(editor!.contains(document.activeElement), "opening a form outside the current view moves keyboard focus into that form").toBe(true);
    expect.soft(scroll.mock.contexts.some(target => target instanceof Element && (target === editor || target.contains(editor))), "opening feedback exposes the editor using its existing workspace scroll boundary").toBe(true);
    expect(mutations, "opening feedback must not save a report or submit paid generation").toEqual([]);
    expect(container.textContent).toContain("100 coins");
  });

  it("does not reveal a feedback editor after its deferred opening was closed", async () => {
    const originalFetch = globalThis.fetch;
    const mutations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST" && (path.endsWith("/feedback") || path === "/api/v1/generation/jobs")) mutations.push(path);
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [{ ...mediaItem("closed-editor-result"), intentFeedbackAvailable: true }], nextCursor: null } });
      return originalFetch(input, init);
    }));
    await mount();
    vi.useFakeTimers();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    await act(async () => { button("Report intent mismatch").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(vi.getTimerCount(), "hold the deferred opening until the editor is closed").toBeGreaterThan(0);
    expect(container.querySelector('[aria-label="Intent feedback editor"]')).not.toBeNull();
    await act(async () => { button("Close feedback").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector('[aria-label="Intent feedback editor"]')).toBeNull();
    const nextAction = button("Videos");
    nextAction.focus();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(scroll, "a stale opening must not jump away from the user's next action").not.toHaveBeenCalled();
    expect(document.activeElement).toBe(nextAction);
    expect(mutations).toEqual([]);
  });

  it.each(["image", "video"] as const)("records %s intent separately from identity and paid generation", async (type) => {
    const originalFetch = globalThis.fetch;
    const writes: Array<{ body: Record<string, unknown>; scope: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [{ ...mediaItem("intent-result", type), intentFeedbackAvailable: true }], nextCursor: null } });
      if (path === "/api/v1/media/intent-result/feedback") {
        const body = JSON.parse(String(init?.body));
        writes.push({ body, scope: new Headers(init?.headers).get("x-idream-viewer-scope") });
        return Response.json({ ok: true, data: { mediaAssetId: "intent-result", ownerScope: "user:generator-viewer", target: { kind: "generation_job", generationJobId: "intent-job" }, feedback: {
          id: "intent-receipt", dimension: "intent", value: "mismatch", direction: "Keep the camera still and use a terracotta pot.", revision: 1, sourceSurface: "gallery", actorId: "generator-viewer", mediaAssetId: "intent-result", target: { kind: "generation_job", generationJobId: "intent-job" }, createdAt: "2026-10-04T12:00:00.000Z",
        } } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    if (type === "video") await click(button("Videos"));
    const card = container.querySelector('[data-testid="gallery-media-card"]')!;
    expect(card.querySelector('button[aria-label="Report intent mismatch"]'), "report instruction mismatch without misrating identity").not.toBeNull();
    await click(card.querySelector('button[aria-label="Report intent mismatch"]')!);
    expect(writes).toHaveLength(0);
    const direction = container.querySelector('textarea[aria-label="Correction direction"]') as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(direction, "Keep the camera still and use a terracotta pot."); direction.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(button("Save intent feedback"));
    expect(writes).toEqual([{ body: { feedbackType: "intent_mismatch", sourceSurface: "gallery", direction: "Keep the camera still and use a terracotta pot." }, scope: "user:generator-viewer" }]);
    expect(container.textContent).toContain("Keep the camera still and use a terracotta pot.");
    expect(requests.some(path => path === "/api/v1/generation/jobs")).toBe(false);
    expect(container.textContent).toContain("100 coins");
  });

  it.each(["503", "null", "false"] as const)("checks the original asset after %s feedback ACK and retries its exact intent only on explicit request", async kind => {
    const original = globalThis.fetch, writes: Record<string, unknown>[] = [], reads: string[] = [];
    const direction = "Use the requested terracotta pot.";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) { const type = new URL(path, "http://localhost").searchParams.get("type") === "video" ? "video" : "image"; return Response.json({ ok: true, data: { items: [{ ...mediaItem(type === "image" ? "original-intent" : "other-video", type), intentFeedbackAvailable: true }], nextCursor: null } }); }
      if (path === "/api/v1/media/original-intent/feedback") {
        expect(new Headers(init?.headers).get("x-idream-viewer-scope")).toBe("user:generator-viewer");
        const target = { kind: "generation_job", generationJobId: "original-job" };
        if (init?.method === "GET") { reads.push(path); return Response.json({ ok: true, data: { mediaAssetId: "original-intent", ownerScope: "user:generator-viewer", target, feedback: null } }); }
        writes.push(JSON.parse(String(init?.body)));
        if (writes.length === 1) return kind === "503" ? Response.json({ ok: false }, { status: 503 }) : Response.json(kind === "null" ? null : { ok: false });
        return Response.json({ ok: true, data: { mediaAssetId: "original-intent", ownerScope: "user:generator-viewer", target, feedback: { id: "feedback-original", dimension: "intent", value: "mismatch", direction, revision: 1, sourceSurface: "gallery", actorId: "generator-viewer", mediaAssetId: "original-intent", target, createdAt: "2026-10-04T12:00:00.000Z" } } });
      }
      return original(input, init);
    }));
    await mount(); await click(button("Report intent mismatch"));
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Correction direction"]')!;
    const type = async (text: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await type(direction); await click(button("Save intent feedback"));
    expect(writes).toHaveLength(1); expect(button("Close feedback").disabled).toBe(true);
    await type("My later draft must not replace the original report."); await click(button("Videos"));
    await click(button("Check recorded feedback")); expect(reads).toEqual(["/api/v1/media/original-intent/feedback"]); expect(writes).toHaveLength(1);
    await click(button("Retry original feedback")); expect(writes).toEqual([{ feedbackType: "intent_mismatch", sourceSurface: "gallery", direction }, { feedbackType: "intent_mismatch", sourceSurface: "gallery", direction }]);
    expect(field.value).toBe("My later draft must not replace the original report."); expect(container.textContent).toContain(`Recorded: ${direction}`);
    expect(button("Close feedback").disabled).toBe(false); expect(container.textContent).toContain("100 coins");
  });

  it("hides and resumes unmatched feedback without losing the original report or edited draft", async () => {
    const original = globalThis.fetch;
    const writes: Array<{ body: Record<string, unknown>; scope: string | null }> = [];
    const reads: string[] = [];
    const direction = "Keep the original balcony and use a terracotta pot.";
    const editedDraft = "My later draft asks for a blue cup and must stay separate.";
    const target = { kind: "generation_job", generationJobId: "hidden-intent-job" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: ["hidden-intent", "other-intent"].map(id => ({ ...mediaItem(id), intentFeedbackAvailable: true })), nextCursor: null } });
      if (path === "/api/v1/media/hidden-intent/feedback") {
        const scope = new Headers(init?.headers).get("x-idream-viewer-scope");
        expect(scope).toBe("user:generator-viewer");
        if (init?.method === "GET") {
          reads.push(path);
          return Response.json({ ok: true, data: { mediaAssetId: "hidden-intent", ownerScope: scope, target, feedback: null } });
        }
        writes.push({ body: JSON.parse(String(init?.body)), scope });
        if (writes.length === 1) return Response.json({ ok: false }, { status: 503 });
        return Response.json({ ok: true, data: { mediaAssetId: "hidden-intent", ownerScope: scope, target, feedback: { id: "hidden-intent-feedback", dimension: "intent", value: "mismatch", direction, revision: 1, sourceSurface: "gallery", actorId: "generator-viewer", mediaAssetId: "hidden-intent", target, createdAt: "2026-10-05T13:44:00.000Z" } } });
      }
      return original(input, init);
    }));
    await mount();
    await click(container.querySelector('[data-media-id="hidden-intent"] button[aria-label="Report intent mismatch"]')!);
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Correction direction"]')!;
    const type = async (text: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await type(direction);
    await click(button("Save intent feedback"));
    expect(button("Close feedback").disabled).toBe(true);
    expect(container.textContent).not.toContain("Hide feedback editor");
    await click(button("Check recorded feedback"));
    expect(container.textContent).toContain("This result has no matching recorded feedback.");
    await type(editedDraft);
    const rating = container.querySelector<HTMLSelectElement>('[aria-label="Intent rating"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(rating, "match"); rating.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(button("Hide feedback editor"));
    expect(container.querySelector('[aria-label="Intent feedback editor"]')).toBeNull();
    expect(document.activeElement).toBe(button("Resume original feedback"));
    expect(writes).toHaveLength(1);
    expect(reads).toEqual(["/api/v1/media/hidden-intent/feedback"]);
    await click(container.querySelector('[data-media-id="other-intent"] button[aria-label="Report intent match"]')!);
    expect(container.textContent).toContain("Check the original feedback before starting another report.");
    expect(container.querySelector('[aria-label="Intent feedback editor"]')).toBeNull();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    await click(button("Resume original feedback"));
    const editor = container.querySelector<HTMLElement>('[aria-label="Intent feedback editor"]')!;
    const restoredField = editor.querySelector<HTMLTextAreaElement>('[aria-label="Correction direction"]')!;
    const restoredRating = editor.querySelector<HTMLSelectElement>('[aria-label="Intent rating"]')!;
    expect(restoredField.value).toBe(editedDraft);
    expect(restoredRating.value).toBe("match");
    expect(document.activeElement).toBe(restoredRating);
    expect(scroll.mock.contexts.some(node => node instanceof Element && node.contains(editor))).toBe(true);
    expect(editor.textContent).toContain(`Original report: mismatch · ${direction}`);
    expect(writes).toHaveLength(1);
    expect(reads).toHaveLength(1);
    await click(button("Check recorded feedback"));
    expect(reads).toEqual(["/api/v1/media/hidden-intent/feedback", "/api/v1/media/hidden-intent/feedback"]);
    expect(writes).toHaveLength(1);
    await click(button("Retry original feedback"));
    const report = { body: { feedbackType: "intent_mismatch", sourceSurface: "gallery", direction }, scope: "user:generator-viewer" };
    expect(writes).toEqual([report, report]);
    expect(restoredField.value).toBe(editedDraft);
    expect(button("Close feedback").disabled).toBe(false);
    await click(button("Close feedback"));
    expect(container.querySelector('[aria-label="Intent feedback editor"]')).toBeNull();
    expect(container.textContent).not.toContain("Resume original feedback");
  });

  it("does not restore a hidden unconfirmed report after the viewer changes", async () => {
    const original = globalThis.fetch;
    const writes: Array<{ body: Record<string, unknown>; scope: string | null }> = [];
    const reads: string[] = [];
    let viewerChanged = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config" && viewerChanged) return Response.json({ ok: true, data: { ...config, viewer: { authenticated: true, scope: "user:new-feedback-viewer" } } });
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [{ ...mediaItem(viewerChanged ? "new-viewer-result" : "old-hidden-result"), intentFeedbackAvailable: true }], nextCursor: null } });
      if (path === "/api/v1/media/old-hidden-result/feedback") {
        const scope = new Headers(init?.headers).get("x-idream-viewer-scope");
        expect(scope).toBe("user:generator-viewer");
        if (init?.method === "GET") {
          reads.push(path);
          return Response.json({ ok: true, data: { mediaAssetId: "old-hidden-result", ownerScope: scope, target: { kind: "generation_job", generationJobId: "old-hidden-job" }, feedback: null } });
        }
        writes.push({ body: JSON.parse(String(init?.body)), scope });
        return Response.json({ ok: false }, { status: 503 });
      }
      return original(input, init);
    }));
    await mount();
    await click(button("Report intent mismatch"));
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Correction direction"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Old viewer's private correction direction."); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(button("Save intent feedback"));
    await click(button("Check recorded feedback"));
    await click(button("Hide feedback editor"));
    expect(button("Resume original feedback")).toBeDefined();
    viewerChanged = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(container.querySelector('[aria-label="Unconfirmed intent feedback"]')).toBeNull();
    expect(container.querySelector('[aria-label="Intent feedback editor"]')).toBeNull();
    expect(container.textContent).not.toContain("Resume original feedback");
    expect(container.textContent).not.toContain("Old viewer's private correction direction.");
    expect(container.querySelector('[data-media-id="old-hidden-result"]')).toBeNull();
    expect(container.querySelector('[data-media-id="new-viewer-result"]')).not.toBeNull();
    await click(button("Report intent match"));
    expect(container.querySelector('[aria-label="Intent feedback editor"]')).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Correction direction"]')?.value).toBe("");
    expect(button("Close feedback").disabled).toBe(false);
    expect(writes).toEqual([{ body: { feedbackType: "intent_mismatch", sourceSurface: "gallery", direction: "Old viewer's private correction direction." }, scope: "user:generator-viewer" }]);
    expect(reads).toEqual(["/api/v1/media/old-hidden-result/feedback"]);
    expect(requests).not.toContain("/api/v1/generation/jobs");
  });

  it("discards the previous actor's late intent receipt without projecting it into the new gallery", async () => {
    const original = globalThis.fetch, write = deferredResponse(); let changed = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config" && changed) return Promise.resolve(Response.json({ ok: true, data: { ...config, viewer: { authenticated: true, scope: "user:new-owner" } } }));
      if (path.startsWith("/api/v1/media?")) return Promise.resolve(Response.json({ ok: true, data: { items: [{ ...mediaItem(changed ? "new-owner-media" : "old-owner-media"), intentFeedbackAvailable: true }], nextCursor: null } }));
      if (path === "/api/v1/media/old-owner-media/feedback") { expect(new Headers(init?.headers).get("x-idream-viewer-scope")).toBe("user:generator-viewer"); return write.promise; }
      return original(input, init);
    }));
    await mount(); await click(button("Report intent match")); await click(button("Save intent feedback"));
    changed = true; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    const target = { kind: "generation_job", generationJobId: "old-job" };
    write.resolve(Response.json({ ok: true, data: { mediaAssetId: "old-owner-media", ownerScope: "user:generator-viewer", target, feedback: { id: "old-feedback", dimension: "intent", value: "match", direction: null, revision: 1, sourceSurface: "gallery", actorId: "generator-viewer", mediaAssetId: "old-owner-media", target, createdAt: "2026-10-04T12:00:00.000Z" } } })); await settle();
    expect(container.querySelector('[aria-label="Intent feedback editor"]')).toBeNull(); expect(container.textContent).not.toContain("Feedback recorded.");
    expect(container.querySelector('[data-media-id="old-owner-media"]')).toBeNull(); expect(container.querySelector('[data-media-id="new-owner-media"]')).not.toBeNull();
  });

  it.each(["actor", "asset", "target"] as const)("refuses an unknown feedback readback with a foreign %s inside an otherwise owned envelope", async kind => {
    const original = globalThis.fetch; let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [{ ...mediaItem("readback-asset"), intentFeedbackAvailable: true }], nextCursor: null } });
      if (path === "/api/v1/media/readback-asset/feedback") {
        if (init?.method === "POST") { posts += 1; return Response.json({ ok: false }, { status: 503 }); }
        const target = { kind: "generation_job", generationJobId: "readback-job" };
        return Response.json({ ok: true, data: { mediaAssetId: "readback-asset", ownerScope: "user:generator-viewer", target, feedback: { id: "foreign-feedback", dimension: "intent", value: "mismatch", direction: "Foreign private instruction", revision: 2, sourceSurface: "gallery", actorId: kind === "actor" ? "other-owner" : "generator-viewer", mediaAssetId: kind === "asset" ? "other-asset" : "readback-asset", target: kind === "target" ? { ...target, generationJobId: "other-job" } : target, createdAt: "2026-10-04T12:00:00.000Z" } } });
      }
      return original(input, init);
    }));
    await mount(); await click(button("Report intent match")); await click(button("Save intent feedback")); await click(button("Check recorded feedback"));
    expect(posts).toBe(1); expect(container.textContent).not.toContain("Foreign private instruction");
    expect([...container.querySelectorAll("button")].some(item => item.textContent === "Retry original feedback")).toBe(false);
    expect(button("Close feedback").disabled).toBe(true); expect(container.textContent).toContain("Feedback may already be recorded");
  });

  it("prepares an image correction as visible edit instructions and a new quote without submitting generation", async () => {
    const original = globalThis.fetch, generationWrites: unknown[] = [], correctionQuotes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [{ ...mediaItem("correct-image"), intentFeedbackAvailable: true }], nextCursor: null } });
      if (path === "/api/v1/media/correct-image/variation/quote") { correctionQuotes.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, data: { quote } }); }
      if (path === "/api/v1/generation/jobs" && init?.method === "POST") generationWrites.push(init.body);
      return original(input, init);
    }));
    await mount(); await click(button("Report intent mismatch"));
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Correction direction"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Use a terracotta pot and keep the face."); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(button("Prepare correction draft"));
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Edit instructions"]')?.value).toBe("Use a terracotta pot and keep the face.");
    expect(container.querySelector('[data-testid="image-edit-source-card"][data-media-id="correct-image"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(generationWrites).toHaveLength(0); expect(correctionQuotes).not.toHaveLength(0);
    expect(correctionQuotes[correctionQuotes.length - 1]).toMatchObject({ consistencyMode: "balanced" });
  });

  it.each([false, true])("restores an owned Chat context (source image: %s), requotes edits and never generates on arrival", async (withImage) => {
    window.history.replaceState(null, "", "/generate?characterId=character&chatSessionId=chat-session&chatTurnId=chat-turn&chatAttempt=1" + (withImage ? "&chatMediaAssetId=chat-image" : ""));
    const originalFetch = globalThis.fetch;
    const quotes: Record<string, unknown>[] = [];
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/generation/context?")) return Response.json({ ok: true, data: { context: {
        ...chatHandoff, sourceMedia: withImage ? { id: "chat-image", url: "/user-content/chat-image.png", thumbnailUrl: "/user-content/chat-image.png" } : null,
      } } });
      if (path === "/api/v1/generation/quote") {
        quotes.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, data: { quote } });
      }
      if (path === "/api/v1/generation/jobs" && init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true, data: { job: { id: "handoff-job", mode: "image", status: "queued", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString() }, assets: [] } }, { status: 202 });
      }
      return originalFetch(input, init);
    }));
    await mount();
    expect(writes).toHaveLength(0);
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((body) => body.generationContextToken === chatHandoff.token && body.characterId === "character" && body.freeplay === false)).toBe(true);
    expect(container.querySelector('[data-testid="generator-context"]')?.textContent).toContain("Mira");
    expect(Boolean(container.querySelector('img[alt="Original source image"]'))).toBe(withImage);
    const prompt = container.querySelector<HTMLTextAreaElement>('#generator-prompt')!;
    expect(prompt.value).toBe(chatHandoff.prompt);
    expect(container.querySelector('#generator-character')).toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Keep the same greenhouse. Change the cup to yellow.");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await settle();
    expect(quotes.at(-1)?.prompt).toBe("Keep the same greenhouse. Change the cup to yellow.");
    await click(button("Generate this moment · 5 coins"));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ generationContextToken: chatHandoff.token, characterId: "character", freeplay: false, prompt: "Keep the same greenhouse. Change the cup to yellow." });
    expect(writes[0]).not.toHaveProperty("visualProfileId");
    await click(button("Start a new generation"));
    expect(window.location.search).not.toContain("chatTurnId");
    expect(container.querySelector('[data-testid="generator-context"]')).toBeNull();
    expect(prompt.value).toBe("");
  });

  it("keeps a new generation detached from Chat after a router commit and reload without losing owned recovery", async () => {
    window.history.replaceState(null, "", "/generate?characterId=character&chatSessionId=chat-session&chatTurnId=chat-turn&chatAttempt=3");
    const nextHistory = installNextHistory();
    const owner = config.viewer.scope;
    saveCurrentGenerationJob(window.sessionStorage, owner, "owned-running-job");
    await expect(requestGenerationRetryWithExactAuthority({
      jobId: "earlier-failed-job", createIdempotencyKey: () => "retained-retry-key",
      persistence: { ownerScope: owner },
      quoteAuthority: { profileId: "edit-model", profileVersion: 1, routeFingerprint: "a".repeat(64), pricingFingerprint: "b".repeat(64), outputCount: 1, costDreamcoins: 5 },
    }, async () => { throw new TypeError("Lost response"); })).rejects.toThrow();
    const originalFetch = globalThis.fetch;
    const quotes: Array<{ body: Record<string, unknown>; scope: string | null }> = [];
    const contextRequests: string[] = [];
    const writes: string[] = [];
    const job = { id: "owned-running-job", mode: "image", status: "running", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString() };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, entitlements: { premium_controls: true, video_generation: true },
        video: { enabled: true, availability: { state: "available" }, requiredEntitlement: "video_generation",
          recipes: [{ id: "video-recipe", rowId: "video-recipe-v1", label: "Animate character", mode: "video", useCase: "character", version: 1 }],
          models: [{ id: "video-model", label: "Video", maxCount: 1, costMultiplier: 1, entitlement: null }] },
      } });
      if (path.startsWith("/api/v1/characters?")) return Response.json({ ok: true, data: { items: [{
        id: "character", title: "Mira", age: "28", description: "Photographer", likes: "0", chats: "0", creator: "iDream", image: "/user-content/portrait.png",
      }], nextCursor: null } });
      if (path.startsWith("/api/v1/generation/context?")) {
        contextRequests.push(path);
        return Response.json({ ok: true, data: { context: { ...chatHandoff, source: { ...chatHandoff.source, attempt: 3 } } } });
      }
      if (path === "/api/v1/generation/quote") {
        const body = JSON.parse(String(init?.body));
        quotes.push({ body, scope: new Headers(init?.headers).get("x-idream-viewer-scope") });
        return Response.json({ ok: true, data: { quote: body.mode === "video"
          ? { ...quote, mode: "video", profileId: "video-model", video: { durationSeconds: 5, width: 512, height: 512, audio: "none" } } : quote } });
      }
      if (path === "/api/v1/generation/video-sequences/capabilities") return Response.json({ ok: true, data: { capabilities: videoCapabilities } });
      if (path === "/api/v1/generation/video-sequences") return Response.json({ ok: true, data: { sequences: [] } });
      if (path === "/api/v1/generation/video-sequences/quote") {
        quotes.push({ body: JSON.parse(String(init?.body)), scope: new Headers(init?.headers).get("x-idream-viewer-scope") });
        return Response.json({ ok: true, data: { quote: videoQuote } });
      }
      if (path.startsWith("/api/v1/generation/jobs?")) return Response.json({ ok: true, data: { items: [job] } });
      if (path === "/api/v1/generation/jobs/owned-running-job") return Response.json({ ok: true, data: { job, assets: [] } });
      if (init?.method === "POST") writes.push(path);
      return originalFetch(input, init);
    }));
    await mount();
    expect(quotes.at(-1)?.body.generationContextToken).toBe(chatHandoff.token);
    expect(contextRequests).toHaveLength(1);
    expect(container.querySelector('[data-pending-request-key="retained-retry-key"]')).not.toBeNull();
    await click(button("Start a new generation"));
    expect(container.querySelector('[data-testid="generator-context"]')).toBeNull();
    await click(button("Video"));
    await act(async () => nextHistory.commit());
    await settle();
    expect(window.location.pathname + window.location.search).toBe("/generate?characterId=character");
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Scene 1 prompt"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "A calm wave"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(button("Review video price"));
    expect(quotes.at(-1)).toMatchObject({ body: { characterId: "character", scenes: [{ prompt: "A calm wave", seconds: 5 }] }, scope: owner });
    expect(quotes.at(-1)?.body).not.toHaveProperty("generationContextToken");
    expect(window.history.state.__NA).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(container.querySelector('[data-testid="generator-context"]')).toBeNull();
    expect(contextRequests).toHaveLength(1);
    expect(readCurrentGenerationJob(window.sessionStorage, owner)).toBe("owned-running-job");
    expect(container.querySelector('[data-generation-job-id="owned-running-job"]')).not.toBeNull();
    expect(container.querySelector('[data-pending-request-key="retained-retry-key"]')).not.toBeNull();
    expect(writes).toEqual([]);
  });

  it("keeps an exited Feed Remix out of the canonical route and reload", async () => {
    window.history.replaceState(null, "", "/generate?characterId=character&remixFeedItemId=feed-post#workspace");
    const nextHistory = installNextHistory();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/v1/characters?")) return Response.json({ ok: true, data: { items: [{
        id: "character", title: "Mira", age: "28", description: "Photographer", likes: "0", chats: "0", creator: "iDream", image: "/user-content/portrait.png",
      }], nextCursor: null } });
      return originalFetch(input, init);
    }));
    await mount();
    expect(container.textContent).toContain("Remix ready from Feed");
    await click(container.querySelector<HTMLInputElement>("#generator-freeplay")!);
    await act(async () => nextHistory.commit());
    await settle();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/generate#workspace");
    expect(container.textContent).not.toContain("Remix ready from Feed");
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(container.textContent).not.toContain("Remix ready from Feed");
  });

  it.each(["&chatAttempt=0", "&chatAttempt=1"]) ("never falls back to a new generation when a Chat source cannot be resolved (%s)", async (attempt) => {
    window.history.replaceState(null, "", `/generate?chatSessionId=chat-session&chatTurnId=chat-turn${attempt}`);
    const originalFetch = globalThis.fetch;
    const quoteWrites: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/generation/context?")) return Response.json({ ok: false }, { status: 404 });
      if (path === "/api/v1/generation/quote" || path === "/api/v1/generation/jobs") quoteWrites.push(path);
      return originalFetch(input, init);
    }));
    await mount();
    expect(container.querySelector('[data-testid="generator-context"] [role="alert"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(quoteWrites).toEqual([]);
  });

  it("quotes and submits Comic source-only edits without choosing a different Character or Gallery image", async () => {
    window.history.replaceState({}, "", "/generate?comicId=public-comic&comicVersion=4&comicPageId=page-original");
    const context = { token: "comic-page-token", source: { kind: "comic", comicId: "public-comic", comicVersion: 4, pageId: "page-original" },
      identityMode: "source_only", characterId: null, characterName: null, pins: null, scene: null,
      prompt: "Keep the room. Change the lamp to red.", sourceMedia: { id: "other-authors-image", url: "/api/v1/comics/public-comic/pages/page-original/content", thumbnailUrl: "/api/v1/comics/public-comic/pages/page-original/content" },
      returnHref: "/comics/public-comic", sourceLabel: "A night journey" };
    const originalFetch = globalThis.fetch;
    const quotes: Record<string, unknown>[] = [], writes: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/generation/context?")) return Response.json({ ok: true, data: { context } });
      if (path === "/api/v1/generation/quote") { quotes.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, data: { quote } }); }
      if (path === "/api/v1/generation/jobs" && init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true, data: { job: { id: "comic-remix-job", mode: "image", status: "queued", costDreamcoins: 5, outputCount: 1, errorCode: null, createdAt: new Date().toISOString() }, assets: [] } }, { status: 202 });
      }
      return originalFetch(input, init);
    }));
    await mount();
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every(body => body.generationContextToken === context.token && body.freeplay === true && body.characterId === undefined)).toBe(true);
    expect(container.querySelector('[data-testid="generator-context"]')?.textContent).toContain("A night journey");
    expect(container.querySelector('#generator-character')).toBeNull();
    expect(container.querySelector('img[alt="Original source image"]')?.getAttribute("src")).toBe(context.sourceMedia.url);
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ freeplay: true, generationContextToken: context.token, prompt: context.prompt });
    expect(writes[0]).not.toHaveProperty("characterId");
  });

  it("discards an old viewer's delayed handoff and hides its private prompt on account change", async () => {
    window.history.replaceState(null, "", "/generate?chatSessionId=chat-session&chatTurnId=chat-turn&chatAttempt=1");
    const originalFetch = globalThis.fetch;
    const delayed = deferredResponse();
    let newViewer = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: { ...config, viewer: newViewer ? { authenticated: true, scope: "user:second-viewer" } : config.viewer } });
      if (path.startsWith("/api/v1/generation/context?")) return newViewer ? Response.json({ ok: false }, { status: 404 }) : delayed.promise;
      return originalFetch(input, init);
    }));
    await mount();
    newViewer = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    delayed.resolve(Response.json({ ok: true, data: { context: chatHandoff } }));
    await settle();
    expect(container.textContent).not.toContain(chatHandoff.characterName);
    expect(container.querySelector<HTMLTextAreaElement>('#generator-prompt')?.value).toBe("");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });

  it("keeps the restored video active when an unrelated candidate completes, then delivers that video", async () => {
    saveCurrentGenerationJob(window.sessionStorage, config.viewer.scope, "my-video");
    const originalFetch = globalThis.fetch;
    let videoCompleted = false;
    const job = (id: string, status: string) => ({ id, status, mode: id === "my-video" ? "video" : "image",
      errorCode: null, costDreamcoins: 5, outputCount: 1, createdAt: new Date().toISOString() });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/generation/jobs?")) return Response.json({ ok: true, data: {
        items: [job("other-candidate", "queued"), job("my-video", "running")],
      } });
      if (path === "/api/v1/generation/jobs/other-candidate") return Response.json({ ok: true, data: {
        job: job("other-candidate", "completed"), assets: [mediaItem("other-candidate-result")],
      } });
      if (path === "/api/v1/generation/jobs/my-video") return Response.json({ ok: true, data: {
        job: job("my-video", videoCompleted ? "completed" : "running"),
        assets: videoCompleted ? [mediaItem("my-video-result", "video")] : [],
      } });
      return originalFetch(input, init);
    }));
    vi.useFakeTimers();
    await act(async () => root.render(createElement(GeneratorWorkspace)));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    await act(async () => button("Videos").click());
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(container.querySelector('[data-media-id="video-1"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.querySelector('[data-media-id="video-1"]')).not.toBeNull();
    expect(container.querySelector('[data-media-id="image-1"]')).toBeNull();
    expect(container.querySelector('[data-generation-job-id="other-candidate"]')?.textContent).toContain("Completed");
    expect(container.textContent).not.toContain("Generation complete.");
    expect(container.querySelector('video source[src="/user-content/my-video-result.mp4"]')).toBeNull();
    videoCompleted = true;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.textContent).toContain("Generation complete.");
    expect(container.querySelector('video source[src="/user-content/my-video-result.mp4"]')).not.toBeNull();
    expect(container.querySelector('img[src="/user-content/other-candidate-result.png"]')).toBeNull();
  });

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

  it("does not project a prior viewer's accepted identity feedback into the new viewer", async () => {
    const originalFetch = globalThis.fetch;
    const pending = deferredResponse();
    let actor = "first";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ok: true, data: {...config, viewer: {authenticated: true, scope: `user:${actor}`}}});
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [{...mediaItem(`source-${actor}`), characterId: `character-${actor}`, canEditIdentity: true}], nextCursor: null}});
      if (path === "/api/v1/media/source-first/feedback") return pending.promise;
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Looks like character"));
    actor = "second";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(container.querySelector('[data-media-id="source-second"]')).not.toBeNull();
    pending.resolve(Response.json({ok: true, data: {saved: true}}, {status: 201}));
    await settle();
    expect(container.textContent).not.toContain("Recorded: looks like the character.");
  });

  it("does not project a prior viewer's accepted identity image update into the new viewer", async () => {
    const originalFetch = globalThis.fetch;
    const pending = deferredResponse();
    let actor = "first";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ok: true, data: {...config, viewer: {authenticated: true, scope: `user:${actor}`}}});
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [{...mediaItem(`source-${actor}`), characterId: `character-${actor}`, canEditIdentity: true}], nextCursor: null}});
      if (path === "/api/v1/media/source-first/use-as-character-image") return pending.promise;
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Use as character image"));
    actor = "second";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(container.querySelector('[data-media-id="source-second"]')).not.toBeNull();
    pending.resolve(Response.json({ok: true, data: {saved: true}}, {status: 201}));
    await settle();
    expect(container.textContent).not.toContain("Character image updated.");
  });

  it("keeps the selected Videos gallery when an image identity update finishes late", async () => {
    const originalFetch = globalThis.fetch;
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) {
        const type = new URL(path, "http://localhost").searchParams.get("type");
        return Response.json({ok: true, data: {items: [type === "video" ? mediaItem("current-video", "video") : {...mediaItem("owned-image"), characterId: "character", canEditIdentity: true}], nextCursor: null}});
      }
      if (path === "/api/v1/media/owned-image/add-to-identity") return pending.promise;
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Add to identity"));
    await click(button("Videos"));
    expect(container.querySelector('[data-media-id="current-video"]')).not.toBeNull();
    pending.resolve(Response.json({ok: true, data: {saved: true}}, {status: 201}));
    await settle();
    expect(container.querySelector('[data-media-id="current-video"]')).not.toBeNull();
    expect(container.querySelector('[data-media-id="owned-image"]')).toBeNull();
  });

  it.each([
    ["Looks like character", "feedback", {feedbackType: "identity_match", sourceSurface: "gallery"}, "Recorded: looks like the character."],
    ["Use as character image", "use-as-character-image", {characterId: "owned-character"}, "Character image updated."],
    ["Add to identity", "add-to-identity", {characterId: "owned-character"}, "Added to identity references."],
  ] as const)("keeps %s bound to its original owner and source", async (label, action, body, status) => {
    const originalFetch = globalThis.fetch;
    const writes: Array<{body: unknown; scope: string | null; signal: AbortSignal | null | undefined}> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [{...mediaItem("owned-source"), characterId: "owned-character", canEditIdentity: true}], nextCursor: null}});
      if (path === `/api/v1/media/owned-source/${action}`) {
        writes.push({body: JSON.parse(String(init?.body)), scope: new Headers(init?.headers).get("x-idream-viewer-scope"), signal: init?.signal});
        return Response.json({ok: true, data: {saved: true}}, {status: 201});
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button(label));
    expect(writes).toEqual([{body, scope: config.viewer.scope, signal: undefined}]);
    expect(container.textContent).toContain(status);
  });

  it("discards an old identity feedback body after a new viewer is confirmed", async () => {
    const originalFetch = globalThis.fetch;
    let resolveBody!: (value: unknown) => void;
    const body = new Promise<unknown>(resolve => { resolveBody = resolve; });
    let actor = "first";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ok: true, data: {...config, viewer: {authenticated: true, scope: `user:${actor}`}}});
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [{...mediaItem(`source-${actor}`), characterId: `character-${actor}`, canEditIdentity: true}], nextCursor: null}});
      if (path === "/api/v1/media/source-first/feedback") {
        const response = Response.json({});
        vi.spyOn(response, "json").mockImplementation(() => body);
        return response;
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Looks like character"));
    actor = "second";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(container.querySelector('[data-media-id="source-second"]')).not.toBeNull();
    resolveBody({ok: true, data: {saved: true}});
    await settle();
    expect(container.textContent).not.toContain("Recorded: looks like the character.");
  });

  async function fillLook(name: string, description: string) {
    const nameField = container.querySelector<HTMLInputElement>('[aria-label="Look name"]')!;
    const descriptionField = container.querySelector<HTMLTextAreaElement>('[aria-label="Look styling description"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameField, name);
      nameField.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(descriptionField, description);
      descriptionField.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  }

  it("preserves a newer Look draft when the older saved Look response arrives", async () => {
    const originalFetch = globalThis.fetch;
    const pending = deferredResponse();
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [
        {...mediaItem("source-one"), characterId: "leo", canEditIdentity: true},
        {...mediaItem("source-two"), characterId: "leo", canEditIdentity: true},
      ], nextCursor: null}});
      if (path === "/api/v1/media/source-one/save-as-look") { writes.push(JSON.parse(String(init?.body))); return pending.promise; }
      return originalFetch(input, init);
    }));
    await mount();
    const cards = container.querySelectorAll('[data-media-id]');
    const saveButtons = [...container.querySelectorAll('button')].filter(item => item.textContent?.trim() === "Save as Look" || item.getAttribute("aria-label") === "Save as Look");
    expect(saveButtons).toHaveLength(2);
    expect(cards.length).toBeGreaterThanOrEqual(2);
    await click(saveButtons[0]!);
    await fillLook("First accepted Look", "Cream raincoat");
    await click(button("Save Look"));
    expect(writes).toEqual([{label: "First accepted Look", appearanceDelta: {description: "Cream raincoat"}}]);
    await click(saveButtons[1]!);
    await fillLook("Second unsaved Look", "Amber scarf");
    pending.resolve(Response.json({ok: true, data: {look: {id: "saved-first"}}}, {status: 201}));
    await settle();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("Second unsaved Look");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Look styling description"]')?.value).toBe("Amber scarf");
  });

  it("does not clear a new viewer's Look draft with a previous viewer's late receipt", async () => {
    const originalFetch = globalThis.fetch;
    const pending = deferredResponse();
    let actor = "first";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ok: true, data: {...config, viewer: {authenticated: true, scope: `user:${actor}`}}});
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [{...mediaItem(`source-${actor}`), characterId: `character-${actor}`, canEditIdentity: true}], nextCursor: null}});
      if (path === "/api/v1/media/source-first/save-as-look") return pending.promise;
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Save as Look"));
    await fillLook("First accepted Look", "Cream raincoat");
    await click(button("Save Look"));
    actor = "second";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(container.querySelector('[data-media-id="source-second"]')).not.toBeNull();
    await click(button("Save as Look"));
    await fillLook("New viewer private draft", "Amber scarf");
    pending.resolve(Response.json({ok: true, data: {look: {id: "saved-first"}}}, {status: 201}));
    await settle();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("New viewer private draft");
    expect(container.textContent).not.toContain("Look saved. You can reuse it for this character.");
  });


  it("drops a prior owner's Look response body that finishes after the new editor is ready", async () => {
    const originalFetch = globalThis.fetch;
    let resolveBody!: (value: unknown) => void;
    const body = new Promise<unknown>(resolve => { resolveBody = resolve; });
    let actor = "first";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ok: true, data: {...config, viewer: {authenticated: true, scope: `user:${actor}`}}});
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [{...mediaItem(`source-${actor}`), characterId: `character-${actor}`, canEditIdentity: true}], nextCursor: null}});
      if (path === "/api/v1/media/source-first/save-as-look") {
        const response = Response.json({});
        vi.spyOn(response, "json").mockImplementation(() => body);
        return response;
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Save as Look"));
    await fillLook("First accepted Look", "Cream raincoat");
    await click(button("Save Look"));
    actor = "second";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    await click(button("Save as Look"));
    await fillLook("Second private draft", "Amber scarf");
    resolveBody({ok: true, data: {look: {id: "saved-first"}}});
    await settle();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("Second private draft");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Look styling description"]')?.value).toBe("Amber scarf");
    expect(container.textContent).not.toContain("Look saved. You can reuse it for this character.");
  });

  it("submits a Look once with the current owner scope and keeps its accepted draft fixed", async () => {
    const originalFetch = globalThis.fetch;
    const pending = deferredResponse();
    const writes: Array<{body: unknown; scope: string | null}> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [{...mediaItem("look-source"), characterId: "leo", canEditIdentity: true}], nextCursor: null}});
      if (path === "/api/v1/media/look-source/save-as-look") {
        writes.push({body: JSON.parse(String(init?.body)), scope: new Headers(init?.headers).get("x-idream-viewer-scope")});
        return pending.promise;
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Save as Look"));
    await fillLook("Rainy day", "Cream raincoat");
    const save = button("Save Look");
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", {bubbles: true}));
      save.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    });
    await settle();
    expect(writes).toEqual([{body: {label: "Rainy day", appearanceDelta: {description: "Cream raincoat"}}, scope: config.viewer.scope}]);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.disabled).toBe(true);
    pending.resolve(Response.json({ok: true, data: {look: {id: "saved-look"}}}, {status: 201}));
    await settle();
    expect(container.textContent).toContain("Look saved. You can reuse it for this character.");
    expect(container.querySelector('[aria-label="Look name"]')).toBeNull();
  });

  it.each(["rejected", "unknown"] as const)("keeps the owned Look draft after a %s save result", async result => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [{...mediaItem("look-source"), characterId: "leo", canEditIdentity: true}], nextCursor: null}});
      if (path === "/api/v1/media/look-source/save-as-look") {
        if (result === "unknown") throw new TypeError("Response lost");
        return Response.json({ok: false, error: {message: "The source is unavailable"}}, {status: 409});
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Save as Look"));
    await fillLook("Rainy day", "Cream raincoat");
    await click(button("Save Look"));
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("Rainy day");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.disabled).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Look styling description"]')?.value).toBe("Cream raincoat");
    expect(container.textContent).toContain(result === "unknown" ? "Look save could not be confirmed. Check your saved Looks before retrying." : "The source is unavailable");
    expect(container.textContent).not.toContain("Look saved. You can reuse it for this character.");
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
    if (kind === "generation") {
      const seed = container.querySelector<HTMLInputElement>('#generator-seed');
      expect(seed, "A supported seed must be selectable before submission").not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(seed, "sunlit-garden-42");
        seed!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await click(button(kind === "gallery-variation" ? "Create variation" : kind === "generation" ? "Generate · 10 coins" : "Create edit · 10 coins"));
    expect(writes).toHaveLength(1);
    if (kind === "generation") expect(writes[0].body.seed).toBe("sunlit-garden-42");
    expect(kind === "generation" ? (writes[0].body.controls as { model: string }).model : writes[0].body.model).toBe("edit-model");
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    if (kind !== "gallery-variation") {
      expect(container.querySelector<HTMLInputElement>('#generator-output-count')?.value).toBe("2");
      if (kind === "generation") expect(container.querySelector<HTMLSelectElement>('#generator-orientation')?.value).toBe("4:5");
      if (kind === "generation") expect(container.querySelector<HTMLInputElement>('#generator-seed')?.value).toBe("sunlit-garden-42");
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

  it.each([true, false])("opens a linked saved preset using its own controls without submitting a generation (premium: %s)", async (premium) => {
    window.history.replaceState(null, "", "/generate?presetId=rain-preset");
    const originalFetch = globalThis.fetch;
    const generationWrites: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/jobs" && init?.method === "POST") generationWrites.push(String(init.body));
      if (path.startsWith("/api/v1/characters?")) return Response.json({ ok: true, data: { items: [{ id: "character", title: "Mira", image: "/user-content/portrait.png" }] } });
      if (path === "/api/v1/generation/presets?scope=user") return Response.json({ ok: true, data: { items: [{
        id: "rain-preset", type: "user", category: null, label: "Rainy cafe", visibility: "private",
        controls: { prompt: "Rain on the cafe window", backgroundPresetId: "cafe-background" },
      }] } });
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, entitlements: { premium_controls: premium },
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

  it.each(["A sunny balcony", ""])("saves an edited character moment preset for a free account (prompt: %s)", async (newPrompt) => {
    window.history.replaceState(null, "", "/generate?presetId=moment-preset");
    const originalFetch = globalThis.fetch;
    const writes: Record<string, unknown>[] = [];
    const preset = { id: "moment-preset", type: "mode", category: null, label: "Garden", visibility: "private",
      controls: { prompt: "Original rainy garden", backgroundPresetId: "garden-background" } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/characters?")) return Response.json({ ok: true, data: { items: [{ id: "character", title: "Mira", image: "/user-content/portrait.png" }] } });
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, entitlements: { premium_controls: false },
        presets: [{ id: "garden-background", type: "background", category: null, label: "Garden" }],
      } });
      if (path === "/api/v1/generation/presets?scope=user") return Response.json({ ok: true, data: { items: [preset] } });
      if (path === "/api/v1/generation/presets/moment-preset" && init?.method === "PATCH") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true, data: { preset } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Edit preset Garden"));
    const prompt = container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')!;
    expect(prompt.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, newPrompt);
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save changes"));
    expect(writes).toHaveLength(1);
    expect(writes[0].controls).toEqual({ backgroundPresetId: "garden-background", ...(newPrompt ? { prompt: newPrompt } : {}) });
  });

  it("saves a new character moment preset for a free account", async () => {
    const originalFetch = globalThis.fetch;
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/v1/characters?")) return Response.json({ ok: true, data: { items: [{ id: "character", title: "Mira", image: "/user-content/portrait.png" }] } });
      if (String(input) === "/api/v1/generation/config") return Response.json({ ok: true, data: { ...config, entitlements: { premium_controls: false } } });
      if (String(input) === "/api/v1/generation/presets" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)); writes.push(body);
        return Response.json({ ok: true, data: { preset: { id: "new-moment", ...body } } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(container.querySelector('[data-testid="generator-advanced-toggle"]')!);
    await act(async () => {
      const prompt = container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "A quiet balcony at dawn");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      const name = container.querySelector<HTMLInputElement>('[aria-label="Preset name"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Balcony");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save"));
    expect(writes).toEqual([expect.objectContaining({ label: "Balcony", controls: { prompt: "A quiet balcony at dawn" } })]);
  });

  it("keeps freeplay prompt controls locked and preserves a saved prompt when renaming", async () => {
    window.history.replaceState(null, "", "/generate?presetId=locked-preset");
    const originalFetch = globalThis.fetch;
    const writes: Record<string, unknown>[] = [];
    const preset = { id: "locked-preset", type: "mode", category: null, label: "Locked garden", visibility: "private", controls: { prompt: "Saved while Premium" } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: { ...config, entitlements: { premium_controls: false } } });
      if (path === "/api/v1/generation/presets?scope=user") return Response.json({ ok: true, data: { items: [preset] } });
      if (path === "/api/v1/generation/presets/locked-preset" && init?.method === "PATCH") {
        writes.push(JSON.parse(String(init.body))); return Response.json({ ok: true, data: { preset } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Edit preset Locked garden"));
    const prompt = container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')!;
    expect(prompt.disabled).toBe(true);
    expect(prompt.value).toBe("");
    await click(button("Save changes"));
    expect(writes).toHaveLength(1);
    expect(writes[0].controls).toEqual({ prompt: "Saved while Premium" });
  });

  it("does not apply a linked preset that is absent from this viewer's saved presets", async () => {
    window.history.replaceState(null, "", "/generate?presetId=another-users-preset");
    await mount();
    expect(container.textContent).toContain("This saved preset is unavailable. Choose one of your presets below.");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe("");
    expect(container.textContent).not.toContain("Applied preset");
  });

  it.each([false, true])("restores the pending video's original character and pinned image instead of the catalog default (first jobs read delayed: %s)", async delayedJobs => {
    const originalFetch = globalThis.fetch;
    const firstJobs = deferredResponse();
    let jobsReleased = false;
    const jobs = { items: [{ id: "original-scene", mode: "video", status: "running", errorCode: null,
      outputCount: 1, costDreamcoins: 100, createdAt: "2026-10-02T00:00:00.000Z" }] };
    const request = { characterId: "original-character", consistencyMode: "balanced", orientation: "2:3", quality: "preview", audio: "generated", scenes: [{ prompt: "A calm wave", seconds: 3 }] };
    localStorage.setItem("idream:video-sequence:user:generator-viewer", JSON.stringify({ key: "original-request-key", id: "original-sequence", request }));
    const sequence = { id: "original-sequence", status: "generating", errorCode: null, request,
      scenes: [{ ordinal: 0, narrationState: "pending", job: { id: "original-scene", status: "running", controls: { sourceImageAssetId: "pinned-original-image" }, cost: { charged: 100, refunded: 0, finalCharge: 100 } }, assets: [] }],
      cost: { charged: 100, refunded: 0, finalCharge: 100 }, asset: null, createdAt: "2026-10-02T00:00:00.000Z", completedAt: null };
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") writes.push(path);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, entitlements: { premium_controls: true, video_generation: true },
        video: { enabled: true, availability: { state: "available" }, requiredEntitlement: "video_generation",
          recipes: [{ id: "video-recipe", rowId: "video-recipe-v1", label: "Animate character", mode: "video", useCase: "character", version: 1 }],
          models: [{ id: "video-model", label: "Video", maxCount: 1, costMultiplier: 1, entitlement: null }] },
      } });
      if (path.startsWith("/api/v1/characters?")) return Response.json({ ok: true, data: { items: [
        { id: "default-character", title: "Default character", image: "/user-content/default.png" },
        { id: "original-character", title: "Original character", image: "/user-content/new-catalog-portrait.png" },
      ].map(character => ({ ...character, age: "28", description: "Photographer", likes: "0", chats: "0", creator: "iDream" })), nextCursor: null } });
      if (path.endsWith("/video-sequences/capabilities")) return Response.json({ ok: true, data: { capabilities: videoCapabilities } });
      if (path.endsWith("/video-sequences")) return Response.json({ ok: true, data: { sequences: [sequence] } });
      if (path.endsWith("/original-sequence")) return Response.json({ ok: true, data: { sequence } });
      if (delayedJobs && path.startsWith("/api/v1/generation/jobs?")) {
        return jobsReleased ? Response.json({ ok: true, data: jobs }) : firstJobs.promise;
      }
      return originalFetch(input, init);
    }));
    await mount();
    if (delayedJobs) {
      expect(container.querySelector('[aria-label="Video sequence"]'), "config/reset's empty state is not a loaded jobs snapshot").toBeNull();
      await act(async () => { jobsReleased = true; firstJobs.resolve(Response.json({ ok: true, data: jobs })); });
      await settle();
      expect(container.querySelector('[data-generation-job-id="original-scene"]'), "the first real jobs response has reached the workspace").not.toBeNull();
      expect(container.querySelector('[aria-label="Video sequence"]'), "a reload restores the active sequence without a manual Video click").not.toBeNull();
    } else await click(button("Video"));
    expect(container.querySelector<HTMLSelectElement>("#generator-character")?.value).toBe("original-character");
    expect(container.querySelector<HTMLSelectElement>("#generator-character")?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#generator-freeplay")?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="generator-video-source"] img')?.getAttribute("src")).toBe("/api/v1/media/pinned-original-image/content");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Scene 1 prompt"]')?.value).toBe("A calm wave");
    if (delayedJobs) {
      await click(button("Image"));
      await click(button("Refresh jobs"));
      expect(container.querySelector('[aria-label="Video sequence"]'), "a later jobs refresh must respect the user's tab choice").toBeNull();
    }
    expect(writes).toHaveLength(0);
  });

  it.each([
    { durationSeconds: 121 / 24, width: 768, height: 1152, audio: "generated", orientation: "2:3" },
    { durationSeconds: 73 / 24, width: 512, height: 512, audio: "generated", orientation: "1:1" },
  ])("shows the exact $width×$height sequence quote before one accepted submission", async ({ orientation, ...video }) => {
    const originalFetch = globalThis.fetch;
    const submitted: Array<{ orientation: string; scenes: Array<{ seconds: number }> }> = [];
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
      if (url === "/api/v1/generation/video-sequences/capabilities") return Response.json({ ok: true, data: { capabilities: videoCapabilities } });
      if (url === "/api/v1/generation/video-sequences/quote") return Response.json({ ok: true, data: { quote: { ...videoQuote, scenes: [{ ordinal: 0, video }] } } });
      if (url === "/api/v1/generation/video-sequences" && init?.method === "POST") {
        submitted.push(JSON.parse(String(init.body)));
        return Response.json({ ok: false, error: { message: "Request captured" } }, { status: 503 });
      }
      if (url === "/api/v1/generation/video-sequences") return Response.json({ ok: true, data: { sequences: [] } });
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Video"));
    const prompt = container.querySelector<HTMLTextAreaElement>('[aria-label="Scene 1 prompt"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "A calm wave"); prompt.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { const ratio = container.querySelector<HTMLSelectElement>('[aria-label="Video aspect ratio"]')!, resolution = container.querySelector<HTMLSelectElement>('[aria-label="Video resolution"]')!, duration = container.querySelector<HTMLSelectElement>('[aria-label="Scene 1 duration"]')!;
      ratio.value = orientation; ratio.dispatchEvent(new Event("change", { bubbles: true }));
      resolution.value = video.width === 512 ? "preview" : "standard"; resolution.dispatchEvent(new Event("change", { bubbles: true }));
      duration.value = video.width === 512 ? "3" : "5"; duration.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(submitted).toHaveLength(0); await click(button("Review video price"));
    expect(container.querySelector('[aria-label="Video price"]')?.textContent).toContain(`${video.durationSeconds.toFixed(2)}s · ${video.width}×${video.height} · 5 coins`);
    await click(button("Accept 5 coins & create video"));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].scenes[0]?.seconds).toBe(video.width === 512 ? 3 : 5);
    expect(submitted[0].orientation).toBe(orientation);
    // An unresolved request checks its original authority, not today's quote.
    expect(button("Check original request").disabled).toBe(false);
  });

  it.each([
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
    await click(container.querySelector("#generator-freeplay")!);
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Model"]')!;
    await act(async () => {
      select.value = modelId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(select.value).toBe(modelId);
    expect(select.options[select.selectedIndex].textContent).toBe("Standard");
    expect(container.textContent).not.toContain(modelLabel);
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

  it("offers only the current Character quote's compatible models and requotes an explicit choice", async () => {
    const originalFetch = globalThis.fetch;
    const quoteBodies: Array<{ controls: { model?: string } }> = [];
    const genericModel = { id: "text-only", label: "Text only", maxCount: 1, costMultiplier: 1, entitlement: null };
    const identityModel = { ...genericModel, id: "identity-model", label: "Identity compatible" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, pricing: { ...config.pricing, image: { baseCost: 5, maxCount: 1 } },
        image: { ...config.image, availability: { state: "available" }, models: [genericModel], orientations: ["4:5"],
          recipes: ["character", "freeplay"].map((useCase) => ({ id: `image-${useCase}`, rowId: `image-${useCase}-v1`, label: "Image", mode: "image", useCase, version: 1 })) },
      } });
      if (path.startsWith("/api/v1/characters?")) return Response.json({ ok: true, data: { items: [{
        id: "character", title: "Mira", age: "28", description: "Photographer", likes: "0", chats: "0", creator: "iDream", image: "/user-content/portrait.png",
      }], nextCursor: null } });
      if (path === "/api/v1/generation/quote") {
        const body = JSON.parse(String(init?.body));
        quoteBodies.push(body);
        return Response.json({ ok: true, data: { quote: { ...quote, identityLocked: true, models: [identityModel] } } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Advanced settingsShow"));
    const model = container.querySelector<HTMLSelectElement>('#generator-model')!;
    expect([...model.options].map((option) => option.value)).toEqual(["", "identity-model"]);
    await act(async () => {
      model.value = "identity-model";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(quoteBodies.at(-1)?.controls.model).toBe("identity-model");
  });

  it("tells an unconfirmed job's owner about the automatic refund instead of queue, retry or support promises", async () => {
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
    expect(card?.textContent).toContain("Result not confirmed yet");
    expect(card?.textContent).not.toMatch(/queued|rendering slot|coins are back|Retry/i);
    // The stale-unknown sweeper settles it without anyone; support has nothing to do.
    expect(card?.textContent).toContain("100 coins are refunded automatically within about 30 minutes");
    expect(card?.querySelector('a[href="/helpdesk"]')).toBeNull();
  });

  it.each([
    { jobStatus: "running", expected: "video", delayedJobs: false, priority: "none" },
    { jobStatus: "completed", expected: "image", delayedJobs: false, priority: "none" },
    { jobStatus: "running", expected: "image", delayedJobs: true, priority: "handoff" },
    { jobStatus: "running", expected: "image", delayedJobs: true, priority: "unconfirmed-image" },
  ])("opens on the $expected tab when the latest video job is $jobStatus ($priority; delayed jobs: $delayedJobs)", async ({ jobStatus, expected, delayedJobs, priority }) => {
    if (priority === "handoff") window.history.replaceState(null, "", "/generate?characterId=character&chatSessionId=chat-session&chatTurnId=chat-turn&chatAttempt=1");
    if (priority === "unconfirmed-image") {
      window.history.replaceState(null, "", "/generate?characterId=character");
      await expect(requestGenerationJobWithExactAuthority({
        body: { mode: "image", characterId: "character", freeplay: false, consistencyMode: "balanced", outputCount: 1, controls: { orientation: "4:5" },
          quoteAuthority: { profileId: "image-model", profileVersion: 1, routeFingerprint: "a".repeat(64), pricingFingerprint: "b".repeat(64), outputCount: 1, costDreamcoins: 5 } },
        idempotencyKeys: new Map(), createIdempotencyKey: () => "retained-image-key", persistence: { ownerScope: config.viewer.scope },
      }, async () => { throw new TypeError("Lost response"); })).rejects.toThrow("Lost response");
    }
    const originalFetch = globalThis.fetch;
    const firstJobs = deferredResponse();
    let jobsReleased = false;
    const jobs = { items: [{ id: "video-job", mode: "video", status: jobStatus, errorCode: null,
      outputCount: 1, costDreamcoins: 100, createdAt: new Date().toISOString() }] };
    const paidWrites: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST" && ["/api/v1/generation/jobs", "/api/v1/generation/video-sequences"].includes(path)) paidWrites.push(path);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, entitlements: { premium_controls: true, video_generation: true },
        pricing: { ...config.pricing, image: { baseCost: 5, maxCount: 1 } },
        image: { ...config.image, availability: { state: "available" }, orientations: ["4:5"],
          models: [{ id: "image-model", label: "Image", maxCount: 1, costMultiplier: 1, entitlement: null }],
          recipes: ["character", "freeplay"].map(useCase => ({ id: `image-${useCase}`, rowId: `image-${useCase}-v1`, label: "Image", mode: "image", useCase, version: 1 })) },
        video: { enabled: true, availability: { state: "available" }, requiredEntitlement: "video_generation",
          recipes: [{ id: "video-recipe", rowId: "video-recipe-v1", label: "Animate character", mode: "video", useCase: "character", version: 1 }],
          models: [{ id: "video-model", label: "Video", maxCount: 1, costMultiplier: 1, entitlement: null }] },
      } });
      if (path.startsWith("/api/v1/characters?")) return Response.json({ ok: true, data: { items: [{
        id: "character", title: "Mira", age: "28", description: "Photographer", likes: "0", chats: "0", creator: "iDream", image: "/user-content/portrait.png",
      }], nextCursor: null } });
      if (path.startsWith("/api/v1/generation/context?")) return Response.json({ ok: true, data: { context: chatHandoff } });
      if (path.startsWith("/api/v1/generation/jobs?")) return delayedJobs && !jobsReleased ? firstJobs.promise : Response.json({ ok: true, data: jobs });
      if (path.endsWith("/video-sequences/capabilities")) return Response.json({ ok: true, data: { capabilities: videoCapabilities } });
      if (path.endsWith("/video-sequences")) return Response.json({ ok: true, data: { sequences: [] } });
      return originalFetch(input, init);
    }));
    await mount();
    if (priority === "handoff") expect(container.querySelector('[data-testid="generator-context"]')).not.toBeNull();
    if (priority === "unconfirmed-image") {
      expect(container.querySelector('[data-pending-request-key="retained-image-key"]')).not.toBeNull();
      expect(container.textContent).toContain("Check the existing request with its original settings and price.");
    }
    if (delayedJobs) {
      await act(async () => { jobsReleased = true; firstJobs.resolve(Response.json({ ok: true, data: jobs })); });
      await settle();
      expect(container.querySelector('[data-generation-job-id="video-job"]')).not.toBeNull();
    }
    expect(container.querySelector('[aria-label="Video sequence"]') !== null).toBe(expected === "video");
    expect(paidWrites).toEqual([]);
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
    // A disabled button names what is missing instead of going silently grey.
    const submitButton = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submitButton.disabled).toBe(true);
    expect(submitButton.textContent).toBe("Describe the change to continue");
    const prompt = container.querySelector<HTMLTextAreaElement>("#generator-prompt")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Make the jacket red.");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(submitButton.disabled).toBe(false);
    expect(submitButton.textContent).toBe("Create edit · 5 coins");
  });

  it("names edit models by what they keep, never by their admin profile name", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/generation/config") return Response.json({ ok: true, data: { ...config, image: { ...config.image, editModels: [
        { id: "edit-model", label: "Chat Image Edit (Qwen-Edit)", maxCount: 1, costMultiplier: 1, entitlement: null, referenceMode: "source_only" },
        { id: "identity-edit", label: "Character Image Variation (Qwen-Edit)", maxCount: 1, costMultiplier: 1, entitlement: null, referenceMode: "identity_source" },
      ] } } });
      if (String(input).startsWith("/api/v1/media?")) {
        const response = await originalFetch(input, init);
        const payload = await response.json();
        return Response.json({ ...payload, data: { ...payload.data, items: payload.data.items.map((item: ReturnType<typeof mediaItem>) => ({ ...item, imageEditModelIds: ["edit-model", "identity-edit"] })) } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Image Edit"));
    await click(container.querySelector('[data-testid="image-edit-source-card"][data-media-id="image-1"]')!);
    const options = [...container.querySelectorAll<HTMLOptionElement>('[aria-label="Model"] option')].map((option) => option.textContent);
    expect(options).toEqual(["Auto (identity-aware)", "Edit · this image only", "Edit · keep the character"]);
    expect(container.textContent).not.toContain("Qwen");
  });

  it("says Checking while the quote is out and only warns once the quote proves no lock", async () => {
    const originalFetch = globalThis.fetch;
    const pendingQuote = deferredResponse();
    const model = { id: "image-model", label: "Default image · REDQW21", maxCount: 1, costMultiplier: 1, entitlement: null };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/generation/config") return Response.json({ ok: true, data: {
        ...config, pricing: { ...config.pricing, image: { baseCost: 5, maxCount: 1 } },
        image: { ...config.image, availability: { state: "available" }, orientations: ["4:5"], models: [model],
          recipes: ["character", "freeplay"].map((useCase) => ({ id: `image-${useCase}`, rowId: `image-${useCase}-v1`, label: "Image", mode: "image", useCase, version: 1 })) },
      } });
      if (path.startsWith("/api/v1/characters?")) return Response.json({ ok: true, data: {
        items: [{ id: "character", title: "Mira", age: "28", description: "Photographer",
          likes: "0", chats: "0", creator: "iDream", image: "/user-content/portrait.png" }], nextCursor: null,
      } });
      if (path === "/api/v1/generation/quote") return pendingQuote.promise;
      return originalFetch(input, init);
    }));
    await mount();
    expect(container.textContent).toContain("Checking…");
    expect(container.textContent).not.toContain("look isn't locked");
    pendingQuote.resolve(Response.json({ ok: true, data: { quote: { ...quote, profileId: "image-model", identityLocked: false } } }));
    await settle();
    expect(container.textContent).toContain("This character's look isn't locked yet");
    expect(container.textContent).not.toMatch(/anchor|legacy|identity-locked route/);
  });

  it("stops polling a job the server no longer lets this viewer read", async () => {
    saveCurrentGenerationJob(window.sessionStorage, config.viewer.scope, "gone-job");
    const originalFetch = globalThis.fetch;
    const detailReads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/generation/jobs?")) return Response.json({ ok: true, data: {
        items: [{ id: "gone-job", status: "running", mode: "image", errorCode: null, costDreamcoins: 5, outputCount: 1, createdAt: new Date().toISOString() }],
      } });
      if (path === "/api/v1/generation/jobs/gone-job") {
        detailReads.push(path);
        return Response.json({ ok: false, error: { code: "not_found", message: "Generation job not found" } }, { status: 404 });
      }
      return originalFetch(input, init);
    }));
    vi.useFakeTimers();
    await act(async () => root.render(createElement(GeneratorWorkspace)));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(container.textContent).toContain("This generation is no longer available.");
    expect(container.querySelector('[data-generation-job-id="gone-job"]')).toBeNull();
    expect(detailReads.length).toBeLessThanOrEqual(2);
    expect(window.sessionStorage.getItem("idream:generation:current-job")).toBeNull();
  });

  it("shows the server's reason when a download is refused", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/media/image-1/download") {
        return Response.json({ ok: false, error: { code: "forbidden", message: "Downloads are not available on your plan." } }, { status: 403 });
      }
      return originalFetch(input, init);
    }));
    vi.stubGlobal("open", vi.fn(() => null));
    await mount();
    const card = container.querySelector('[data-testid="gallery-media-card"][data-media-id="image-1"]')!;
    await click(card.querySelector('button[aria-label="Download"]')!);
    expect(container.textContent).toContain("Downloads are not available on your plan.");
  });

  it("locks the Image Edit negative prompt for accounts without Premium controls", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/generation/config") {
        return Response.json({ ok: true, data: { ...config, entitlements: { premium_controls: false } } });
      }
      return originalFetch(input, init);
    }));
    await mount();
    await click(button("Image Edit"));
    const negativePrompt = container.querySelector<HTMLInputElement>("#generator-negative-prompt");
    expect(negativePrompt?.disabled).toBe(true);
    expect(negativePrompt?.placeholder).toBe("Premium control");
    expect(container.textContent).toContain("Negative prompts are a Premium control.");
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
  function installSavedLooksFixture(initialStatus = "active") {
    const originalFetch = globalThis.fetch;
    const character = {id: "look-character", title: "Look character", age: "28", description: "Adult audit character", likes: "0", chats: "0", creator: "Audit creator", image: "/images/ourdream/card-sophie.webp", canEditIdentity: true};
    const fixture = { activeVisualProfileId: "visual-new", items: [{id: "saved-look", characterId: character.id, visualProfileId: "visual-old", label: "Rainy day", status: initialStatus,
      appearanceDelta: {description: "Cream raincoat", outfit: "Trench coat", accessories: ["Amber umbrella"]}, referenceAssetId: "owned-look-source", rebasedFromLookId: null as string | null}] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/characters?limit=60") return Response.json({ok: true, data: {items: [character]}});
      if (path === "/api/v1/characters/look-character/looks" && (!init?.method || init.method === "GET")) return Response.json({ok: true, data: fixture});
      return originalFetch(input, init);
    }));
    return fixture;
  }

  it.each(["new", "saved"] as const)("reveals the %s Look editor and focuses its name without saving or generating", async kind => {
    installSavedLooksFixture();
    const originalFetch = globalThis.fetch;
    const mutations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method && init.method !== "GET") mutations.push(path);
      if (path.startsWith("/api/v1/media?")) return Response.json({ ok: true, data: { items: [{
        ...mediaItem("look-editor-source"), characterId: "look-character", canEditIdentity: true,
      }], nextCursor: null } });
      return originalFetch(input, init);
    }));
    await mount();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const opener = button(kind === "new" ? "Save as Look" : "Manage Look: Rainy day");
    opener.focus();
    expect(document.activeElement).toBe(opener);
    await click(opener);
    const name = container.querySelector<HTMLInputElement>('[aria-label="Look name"]');
    expect(name, "the selected action opens its real Look editor").not.toBeNull();
    expect(name!.value).toBe(kind === "new" ? "" : "Rainy day");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Look styling description"]')!.value).toBe(kind === "new" ? "" : "Cream raincoat");
    expect.soft(document.activeElement, "opening a Look form transfers keyboard focus into its name field").toBe(name);
    expect.soft(scroll.mock.contexts, "reveal the actual Look editor, including when opened from below it").toContain(name!.parentElement);
    expect(mutations, "opening a Look must not save, archive, rebase, quote, or generate").toEqual([]);
    expect(container.textContent).toContain("100 coins");

    await click(button("Cancel"));
    expect(container.querySelector('[aria-label="Look name"]')).toBeNull();
    vi.useFakeTimers();
    scroll.mockClear();
    await act(async () => { opener.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(vi.getTimerCount(), "hold the deferred reveal while the user closes the editor").toBeGreaterThan(0);
    expect(container.querySelector('[aria-label="Look name"]')).not.toBeNull();
    await act(async () => { button("Cancel").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector('[aria-label="Look name"]')).toBeNull();
    const nextAction = button("Videos");
    nextAction.focus();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(scroll, "a closed Look's deferred reveal must not move the viewport").not.toHaveBeenCalled();
    expect(document.activeElement, "a closed Look must not steal focus from the user's next action").toBe(nextAction);
    expect(mutations).toEqual([]);
  });

  it("keeps a saved Look requiring identity confirmation visible without offering it for generation", async () => {
    installSavedLooksFixture("needs_rebase");
    await mount();
    expect(container.textContent).toContain("Rainy day");
    expect(container.textContent).toContain("Needs identity confirmation");
    expect(container.textContent).not.toContain("No saved Looks for this character yet");
    const selector = container.querySelector<HTMLSelectElement>('[aria-label="Character Look"]');
    expect(selector?.querySelector('option[value="saved-look"]')).toBeNull();
    expect(button("Manage Look: Rainy day")).toBeDefined();
  });

  it("edits a Look's name and description without dropping other styling or reference authority or activating a stale identity", async () => {
    const fixture = installSavedLooksFixture("needs_rebase");
    const base = globalThis.fetch; const writes: Array<{body: unknown; headers: Headers}> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/characters/look-character/looks/saved-look" && init?.method === "PATCH") {
        writes.push({body: JSON.parse(String(init.body)), headers: new Headers(init.headers)});
        fixture.items[0] = {...fixture.items[0]!, label: "Rainy evening", appearanceDelta: {...fixture.items[0]!.appearanceDelta, description: "Navy raincoat and amber umbrella"}};
        return Response.json({ok: true, data: {look: fixture.items[0]}});
      }
      return base(input, init);
    }));
    await mount(); await click(button("Manage Look: Rainy day"));
    await fillLook("Rainy evening", "Navy raincoat and amber umbrella");
    await click(button("Save Look changes"));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({label: "Rainy evening", appearanceDelta: {description: "Navy raincoat and amber umbrella", outfit: "Trench coat", accessories: ["Amber umbrella"]}});
    expect(writes[0]!.headers.get("x-idream-viewer-scope")).toBe("user:generator-viewer");
    expect(container.textContent).toContain("Needs identity confirmation");
    expect(container.querySelector('option[value="saved-look"]')).toBeNull();
  });

  it("requires an explicit separate confirmation before rebasing and selects the returned new Look instead of its historical ID", async () => {
    const fixture = installSavedLooksFixture("needs_rebase");
    const base = globalThis.fetch; const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/characters/look-character/looks/saved-look" && init?.method === "PATCH") {
        writes.push(JSON.parse(String(init.body)));
        const fresh = {...fixture.items[0]!, id: "rebased-look", status: "active", visualProfileId: "visual-new", rebasedFromLookId: "saved-look"};
        fixture.items = [fresh]; return Response.json({ok: true, data: {look: fresh}});
      }
      return base(input, init);
    }));
    await mount(); await click(button("Manage Look: Rainy day"));
    await click(button("Use with current identity"));
    expect(writes).toEqual([]);
    expect(container.textContent).toContain("Your character's appearance has changed");
    await click(button("Confirm identity change"));
    expect(writes).toEqual([{status: "active", expectedVisualProfileId: "visual-new"}]);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Character Look"]')?.value).toBe("rebased-look");
    expect(container.querySelector('option[value="saved-look"]')).toBeNull();
  });

  it("archives a Look only after confirmation and removes reuse without deleting the source image or generating", async () => {
    const fixture = installSavedLooksFixture();
    const base = globalThis.fetch; const writes: Array<{path: string; init?: RequestInit}> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        writes.push({path: String(input), init}); fixture.items = []; return new Response(null, {status: 204});
      }
      return base(input, init);
    }));
    await mount(); await click(button("Manage Look: Rainy day")); await click(button("Archive Look"));
    expect(writes).toEqual([]); expect(container.textContent).toContain("Your source image and past generations stay available");
    await click(button("Cancel Look action")); expect(writes).toEqual([]);
    await click(button("Archive Look")); await click(button("Confirm archive Look"));
    expect(writes.map(w => w.path)).toEqual(["/api/v1/characters/look-character/looks/saved-look"]);
    expect(new Headers(writes[0]!.init?.headers).get("x-idream-viewer-scope")).toBe("user:generator-viewer");
    expect(writes[0]!.init?.signal).toBeUndefined();
    expect(container.querySelector('option[value="saved-look"]')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([path, init]) => String(path) === "/api/v1/generation/jobs" && init?.method === "POST")).toBe(false);
  });

  it("keeps selected character Looks after a different character's saved Look receipt", async () => {
    const originalFetch = globalThis.fetch;
    const pending = deferredResponse();
    const attrs = {age: "28", description: "Adult audit character", likes: "0", chats: "0", creator: "Audit creator"};
    const chars = [{...attrs, id: "character-a", title: "Character A", image: "/a.png", canEditIdentity: true}, {...attrs, id: "character-b", title: "Character B", image: "/b.png", canEditIdentity: true}];
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/characters?limit=60") return Response.json({ok: true, data: {items: chars}});
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [{...mediaItem("source-a"), characterId: "character-a", canEditIdentity: true}], nextCursor: null}});
      if (path === "/api/v1/media/source-a/save-as-look") return pending.promise;
      if (path.endsWith("/looks")) {
        reads.push(path);
        const c = path.includes("character-b") ? "b" : "a";
        return Response.json({ok: true, data: {items: [{id: `look-${c}`, characterId: `character-${c}`, label: `Saved Look ${c.toUpperCase()}`, status: "active", appearanceDelta: {description: `${c} scarf`}}]}});
      }
      return originalFetch(input, init);
    }));
    await mount();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Character"]')?.value).toBe("character-a");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Character Look"]')?.textContent).toContain("Saved Look A");
    await click(button("Save as Look"));
    await fillLook("Accepted A Look", "Cream raincoat");
    await click(button("Save Look"));
    await act(async () => {
      const field = container.querySelector<HTMLSelectElement>('[aria-label="Character"]')!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(field, "character-b");
      field.dispatchEvent(new Event("change", {bubbles: true}));
    });
    await settle();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Character Look"]')?.textContent).toContain("Saved Look B");
    pending.resolve(Response.json({ok: true, data: {look: {id: "new-a"}}}, {status: 201}));
    await settle();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Character"]')?.value).toBe("character-b");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Character Look"]')?.textContent).toContain("Saved Look B");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Character Look"]')?.textContent).not.toContain("Saved Look A");
  });
  it("renames a structured Look without inventing a description or resending its reference and can explicitly rebase the unchanged styling", async () => {
    const fixture = installSavedLooksFixture("needs_rebase");
    delete (fixture.items[0]!.appearanceDelta as Partial<typeof fixture.items[0]["appearanceDelta"]>).description;
    const originalDelta = structuredClone(fixture.items[0]!.appearanceDelta);
    const base = globalThis.fetch; const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/characters/look-character/looks/saved-look" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)); writes.push(body);
        fixture.items[0] = {...fixture.items[0]!, label: body.label ?? fixture.items[0]!.label,
          ...(body.status === "active" ? {id: "structured-rebased", status: "active", visualProfileId: "visual-new", rebasedFromLookId: "saved-look"} : {})};
        return Response.json({ok: true, data: {look: fixture.items[0]}});
      }
      return base(input, init);
    }));
    await mount(); await click(button("Manage Look: Rainy day"));
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Look styling description"]')?.value).toBe("");
    await fillLook("Structured raincoat", ""); await click(button("Save Look changes"));
    expect(writes).toEqual([{label: "Structured raincoat"}]);
    expect(fixture.items[0]!.appearanceDelta).toEqual(originalDelta); expect(fixture.items[0]!.referenceAssetId).toBe("owned-look-source");
    await click(button("Manage Look: Structured raincoat")); await click(button("Use with current identity")); await click(button("Confirm identity change"));
    expect(writes[1]).toEqual({status: "active", expectedVisualProfileId: "visual-new"});
    expect(fixture.items[0]!.appearanceDelta).toEqual(originalDelta); expect(fixture.items[0]!.referenceAssetId).toBe("owned-look-source");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Character Look"]')?.value).toBe("structured-rebased");
  });

  it("keeps the draft after an uncertain update and rereads saved Looks before permitting another explicit write", async () => {
    const fixture = installSavedLooksFixture(); const base = globalThis.fetch; let writes = 0, reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/characters/look-character/looks/saved-look" && init?.method === "PATCH") {writes += 1; return Response.json({ok: false}, {status: 503});}
      if (String(input) === "/api/v1/characters/look-character/looks") reads += 1;
      return base(input, init);
    }));
    await mount(); await click(button("Manage Look: Rainy day")); await fillLook("My retained draft", "Navy raincoat");
    await click(button("Save Look changes"));
    expect(writes).toBe(1); expect(container.textContent).toContain("could not be confirmed");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("My retained draft");
    expect(button("Save Look changes").disabled).toBe(true);
    const before = reads; await click(button("Check saved Looks"));
    expect(reads).toBeGreaterThan(before); expect(writes).toBe(1); expect(button("Save Look changes").disabled).toBe(false);
    expect(fixture.items[0]!.id).toBe("saved-look");
  });

  it("requires a new explicit confirmation after the active identity changes rather than replaying a stale confirmation", async () => {
    const fixture = installSavedLooksFixture("needs_rebase"); const base = globalThis.fetch; const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/characters/look-character/looks/saved-look" && init?.method === "PATCH") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ok: false, error: {message: "The character identity changed. Review it and confirm the Look again."}}, {status: 409});
      }
      return base(input, init);
    }));
    await mount(); await click(button("Manage Look: Rainy day")); await fillLook("Retained name", "Retained styling");
    await click(button("Use with current identity")); fixture.activeVisualProfileId = "visual-newer";
    await click(button("Confirm identity change"));
    expect(writes).toEqual([{status: "active", expectedVisualProfileId: "visual-new"}]);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("Retained name");
    expect(container.textContent).toContain("Review it and confirm the Look again");
    expect([...container.querySelectorAll("button")].some(b => b.textContent === "Confirm identity change")).toBe(false);
    await click(button("Use with current identity")); await click(button("Confirm identity change"));
    expect(writes[1]).toEqual({status: "active", expectedVisualProfileId: "visual-newer"});
  });

  it("does not clear a later saved-Look editor with an older accepted update body", async () => {
    const fixture = installSavedLooksFixture(); fixture.items.push({...fixture.items[0]!, id: "second-look", label: "Second Look"});
    const base = globalThis.fetch, pending = deferredResponse(); let written = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/looks/saved-look") && init?.method === "PATCH") {written += 1; return pending.promise;}
      return base(input, init);
    }));
    await mount(); await click(button("Manage Look: Rainy day")); await fillLook("First write", "First styling");
    await act(async () => {button("Save Look changes").click(); button("Save Look changes").click();}); await settle();
    expect(written).toBe(1);
    await click(button("Manage Look: Second Look")); await fillLook("Later unsaved draft", "Amber scarf");
    pending.resolve(Response.json({ok: true, data: {look: fixture.items[0]}})); await settle();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("Later unsaved draft");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Look styling description"]')?.value).toBe("Amber scarf");
    expect(container.textContent).not.toContain("Look changes saved");
  });

  it.each([
    {status: 200, payload: null},
    {status: 200, payload: {ok: false}},
    {status: 503, payload: {ok: false}},
  ])("requires rereading Looks before resubmitting an uncertain save ($status, $payload)", async ({status, payload}) => {
    installSavedLooksFixture(); const base = globalThis.fetch; let writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [{...mediaItem("look-source"), characterId: "look-character", canEditIdentity: true}], nextCursor: null}});
      if (path === "/api/v1/media/look-source/save-as-look") {writes += 1; return Response.json(payload, {status});}
      return base(input, init);
    }));
    await mount(); await click(button("Save as Look")); await fillLook("Retained source Look", "Amber raincoat"); await click(button("Save Look"));
    expect(writes).toBe(1); expect(button("Save Look").disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("Retained source Look");
    expect(container.textContent).toContain("could not be confirmed");
    await click(button("Check saved Looks")); expect(writes).toBe(1); expect(button("Save Look").disabled).toBe(false);
  });

  it.each([null, {ok: false}])("does not claim an archive succeeded from a malformed HTTP200 receipt (%s)", async payload => {
    installSavedLooksFixture(); const base = globalThis.fetch; let writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/looks/saved-look") && init?.method === "DELETE") {writes += 1; return Response.json(payload);}
      return base(input, init);
    }));
    await mount(); await click(button("Manage Look: Rainy day")); await click(button("Archive Look")); await click(button("Confirm archive Look"));
    expect(writes).toBe(1); expect(container.textContent).not.toContain("Look archived.");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("Rainy day");
    expect(button("Check saved Looks")).toBeDefined(); expect(button("Save Look changes").disabled).toBe(true);
  });

  it.each(["edit", "archive"] as const)("retains a draft and unknown-result recovery when %s succeeds but the saved Looks reread fails", async action => {
    const fixture = installSavedLooksFixture(); const base = globalThis.fetch; let writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/looks/saved-look") && (init?.method === "DELETE" || init?.method === "PATCH")) {
        writes += 1;
        return action === "archive" ? new Response(null, {status: 204}) : Response.json({ok: true, data: {look: fixture.items[0]}});
      }
      if (path === "/api/v1/characters/look-character/looks" && writes > 0) return Response.json({ok: false}, {status: 503});
      return base(input, init);
    }));
    await mount(); await click(button("Manage Look: Rainy day")); await fillLook("Keep this draft", "Amber raincoat");
    if (action === "archive") {await click(button("Archive Look")); await click(button("Confirm archive Look"));}
    else await click(button("Save Look changes"));
    expect(writes).toBe(1); expect(container.textContent).not.toContain(action === "archive" ? "Look archived." : "Look changes saved.");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("Keep this draft");
    expect(button("Check saved Looks")).toBeDefined(); expect(button("Save Look changes").disabled).toBe(true);
    await click(button("Check saved Looks")); expect(writes).toBe(1); expect(button("Save Look changes").disabled).toBe(true);
  });

  it("checks the source character before unlocking an uncertain Look save from another character's gallery image", async () => {
    const base = globalThis.fetch; const reads: string[] = []; let writes = 0, sourceReadable = false;
    const attrs = {age: "28", description: "Adult audit character", likes: "0", chats: "0", creator: "Audit creator", canEditIdentity: true};
    const chars = [{...attrs, id: "character-a", title: "Character A", image: "/a.png"}, {...attrs, id: "character-b", title: "Character B", image: "/b.png"}];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/characters?limit=60") return Response.json({ok: true, data: {items: chars}});
      if (path.startsWith("/api/v1/media?")) return Response.json({ok: true, data: {items: [{...mediaItem("source-b"), characterId: "character-b", canEditIdentity: true}], nextCursor: null}});
      if (path === "/api/v1/media/source-b/save-as-look") {writes += 1; return Response.json({ok: false}, {status: 503});}
      if (path.endsWith("/looks")) {
        reads.push(path);
        return path.includes("character-b") ? (sourceReadable
          ? Response.json({ok: true, data: {items: [{id: "accepted-b", characterId: "character-b", label: "Source B retained draft", status: "active", appearanceDelta: {description: "Amber raincoat"}, referenceAssetId: "source-b"}], activeVisualProfileId: "visual-b"}})
          : Response.json({ok: false}, {status: 503}))
          : Response.json({ok: true, data: {items: [], activeVisualProfileId: "visual-a"}});
      }
      return base(input, init);
    }));
    await mount();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Character"]')?.value).toBe("character-a");
    await click(button("Save as Look")); await fillLook("Source B retained draft", "Amber raincoat"); await click(button("Save Look"));
    expect(writes).toBe(1); expect(button("Save Look").disabled).toBe(true);
    await fillLook("Later unsent draft", "Navy scarf");
    const before = reads.length; await click(button("Check saved Looks"));
    expect.soft(reads.slice(before)).toContain("/api/v1/characters/character-b/looks");
    expect.soft(button("Save Look").disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("Later unsent draft");
    sourceReadable = true; await click(button("Check saved Looks"));
    expect(container.textContent).toContain("Found saved Look \"Source B retained draft\" for this image's character");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Character"]')?.value).toBe("character-a");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Look name"]')?.value).toBe("Later unsent draft");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Look styling description"]')?.value).toBe("Navy scarf");
    expect(button("Save Look").disabled).toBe(false);
    const readInit = vi.mocked(fetch).mock.calls.find(([path]) => String(path) === "/api/v1/characters/character-b/looks")?.[1];
    expect(new Headers(readInit?.headers).get("x-idream-viewer-scope")).toBe("user:generator-viewer");
    expect(writes).toBe(1);
  });

});
