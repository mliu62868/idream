// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/image", () => ({ default: ({ unoptimized: _unoptimized, ...props }: ComponentProps<"img"> & { unoptimized?: boolean }) => createElement("img", props) }));
import { VideoSequenceControls } from "./VideoSequenceControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scope = "user:sequence-viewer", storageKey = `idream:video-sequence:${scope}`;
const cap = { options: { seconds: [3, 5], orientations: ["2:3", "1:1"], qualities: ["preview", "standard"] }, audio: ["generated", "silent", "narration"] };
const price = { fingerprint: "a".repeat(64), costDreamcoins: 200, balance: 500, audio: "narration", narrationExtendsLastFrame: true, narrationExtraCostDreamcoins: 0,
  costs: [{ ordinal: 0, costDreamcoins: 100 }, { ordinal: 1, costDreamcoins: 100 }], scenes: [{ ordinal: 0, video: { durationSeconds: 3.0417, width: 512, height: 512, audio: "generated" } }, { ordinal: 1, video: { durationSeconds: 5.0417, width: 512, height: 512, audio: "generated" } }] };
function sequence(status = "generating") { return { id: "sequence-original", status, errorCode: null, request: { characterId: "character-one", consistencyMode: "balanced", orientation: "2:3", quality: "standard", audio: "generated", scenes: [{ prompt: "A calm wave", seconds: 5 }] }, scenes: [{ ordinal: 0, narrationState: "pending", job: { id: "native-original", status: "queued", controls: { sourceImageAssetId: "original-reference" }, cost: { charged: 100, refunded: 0, finalCharge: 100 } }, assets: [] }], cost: { charged: 100, refunded: 0, finalCharge: 100 }, asset: null, createdAt: "2026-10-02T00:00:00.000Z", completedAt: null }; }
function deliveredSequence(id: string) {
  const asset = { id: `${id}-complete`, url: `/api/v1/media/${id}-complete/content`, downloadUrl: `/api/v1/media/${id}-complete/content?download=1` };
  return { ...sequence("completed"), id, scenes: [{ ...sequence().scenes[0]!, job: { ...sequence().scenes[0]!.job, id: `${id}-scene`, status: "completed", controls: { sourceImageAssetId: `${id}-reference` } }, assets: [asset] }],
    asset: { ...asset, width: 512, height: 768, metadata: {} }, completedAt: "2026-10-02T00:00:10.000Z" };
}
const envelope = (data: unknown, status = 200) => Response.json({ ok: true, data }, { status });
function deferred() { let resolve!: (value: Response) => void, reject!: (cause: Error) => void; return { promise: new Promise<Response>((finish, fail) => { resolve = finish; reject = fail; }), resolve: (value: Response) => resolve(value), reject: (cause: Error) => reject(cause) }; }

describe("Video sequence exact acceptance and recoverable delivery UI", () => {
  let container: HTMLDivElement, root: Root, calls: Array<{ path: string; init?: RequestInit }>, customize: (path: string, init?: RequestInit) => Promise<Response> | undefined;
  const props: ComponentProps<typeof VideoSequenceControls> = { viewerScope: scope, characterId: "character-one", consistencyMode: "balanced" };
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key), clear: () => storage.clear() });
    calls = []; customize = () => undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); calls.push({ path, init }); const custom = customize(path, init); if (custom) return custom;
      if (path.endsWith("/capabilities")) return envelope({ capabilities: cap });
      if (path.endsWith("/quote")) return envelope({ quote: price });
      if (init?.method === "POST") return envelope({ sequence: sequence() }, 202);
      if (path.endsWith("/video-sequences")) return envelope({ sequences: [] });
      return envelope({ sequence: sequence() });
    }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  async function settle() { for (let index = 0; index < 4; index++) await act(async () => new Promise(resolve => setTimeout(resolve, 0))); }
  async function mount(value = props) { await act(async () => root.render(createElement(VideoSequenceControls, value))); await settle(); }
  function button(label: string) { const value = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === label); expect(value, label).toBeDefined(); return value!; }
  async function click(label: string) { await act(async () => button(label).click()); await settle(); }
  async function type(label: string, value: string) { const field = container.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }); }
  async function select(label: string, value: string) { const field = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; await act(async () => { field.value = value; field.dispatchEvent(new Event("change", { bubbles: true })); }); }

  it("reviews all scene prices and the longer-narration rule before one paid submission", async () => {
    await mount(); await select("Video aspect ratio", "1:1"); await select("Video resolution", "preview"); await select("Video sound", "narration");
    await type("Scene 1 prompt", "Wave in the garden"); await type("Scene 1 narration", "Hello from the garden."); await select("Scene 1 duration", "3"); await click("Add scene");
    await type("Scene 2 prompt", "Turn toward the sunset"); await type("Scene 2 narration", "Let's watch the sunset.");
    expect(calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
    await click("Review video price"); expect(container.textContent).toContain("Total 200 coins · balance 500"); expect(container.textContent).toContain("longer line extends the final frame"); expect(container.textContent).toContain("without lip synchronization");
    expect(calls.filter(call => call.init?.method === "POST" && !call.path.endsWith("/quote"))).toHaveLength(0);
    await click("Accept 200 coins & create video");
    const writes = calls.filter(call => call.init?.method === "POST" && !call.path.endsWith("/quote")); expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]!.init!.body))).toMatchObject({ characterId: "character-one", orientation: "1:1", quality: "preview", audio: "narration", quoteFingerprint: price.fingerprint, scenes: [{ prompt: "Wave in the garden", seconds: 3, narration: "Hello from the garden." }, { prompt: "Turn toward the sunset", seconds: 5, narration: "Let's watch the sunset." }] });
    expect(new Headers(writes[0]!.init!.headers).get("x-idream-viewer-scope")).toBe(scope);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ id: "sequence-original", key: new Headers(writes[0]!.init!.headers).get("idempotency-key") });
  });

  it("ignores a quote whose selected character changed while its response was in flight", async () => {
    const old = deferred(); customize = path => path.endsWith("/quote") ? old.promise : undefined;
    await mount(); await type("Scene 1 prompt", "A calm wave"); await click("Review video price"); await mount({ ...props, characterId: "character-two" });
    await act(async () => old.resolve(envelope({ quote: price }))); await settle();
    expect(container.querySelector('[aria-label="Video price"]')).toBeNull(); expect(calls.filter(call => call.init?.method === "POST" && !call.path.endsWith("/quote"))).toHaveLength(0);
  });

  it("requires a new price when the script changes after its quote is reviewed", async () => {
    await mount(); await type("Scene 1 prompt", "A calm wave"); await click("Review video price");
    expect(container.querySelector('[aria-label="Video price"]')).not.toBeNull();
    await type("Scene 1 prompt", "A different movement");
    expect(container.querySelector('[aria-label="Video price"]')).toBeNull();
    expect(button("Review video price").disabled).toBe(false);
    expect(calls.filter(call => call.init?.method === "POST" && !call.path.endsWith("/quote"))).toHaveLength(0);
  });

  it("ignores the previous viewer's late history when its resources move to another viewer", async () => {
    const oldHistory = deferred(); customize = path => path.endsWith("/video-sequences") ? oldHistory.promise : undefined;
    await mount(); customize = () => undefined;
    await act(async () => root.unmount()); root = createRoot(container);
    await mount({ ...props, viewerScope: "user:next-viewer" });
    await act(async () => oldHistory.resolve(envelope({ sequences: [sequence("composition_failed")] }))); await settle();
    expect(container.querySelector('[aria-label="Video sequence status"]')).toBeNull();
    expect(calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
  });

  it("keeps the selected sequence and its download when a previous sequence read arrives late", async () => {
    const first = deliveredSequence("sequence-a"), second = deliveredSequence("sequence-b"), old = deferred();
    const onStatusChange = vi.fn();
    customize = path => path.endsWith("/video-sequences") ? Promise.resolve(envelope({ sequences: [first, second] }))
      : path.endsWith("/sequence-a") ? old.promise
      : path.endsWith("/sequence-b") ? Promise.resolve(envelope({ sequence: second })) : undefined;
    await mount({ ...props, onStatusChange });
    await click("Refresh sequence");
    await select("Recent video sequences", second.id); await settle();
    expect(container.querySelector("video")?.getAttribute("src")).toBe(second.asset.url);
    await act(async () => old.resolve(envelope({ sequence: first }))); await settle();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Recent video sequences"]')?.value).toBe(second.id);
    expect(container.querySelector('a[href="/api/v1/media/sequence-b-complete/content?download=1"]')).not.toBeNull();
    expect(container.querySelector("video")?.getAttribute("src")).toBe(second.asset.url);
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img[alt="Original video reference"]')?.getAttribute("src")).toBe("/api/v1/media/sequence-b-reference/content");
    expect(calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
  });

  it("keeps the new selection while its response is pending instead of polling the old sequence", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = { ...sequence(), id: "sequence-a" }, second = deliveredSequence("sequence-b");
    const oldPoll = deferred(), selected = deferred();
    customize = path => path.endsWith("/video-sequences") ? Promise.resolve(envelope({ sequences: [first, second] }))
      : path.endsWith("/sequence-a") ? oldPoll.promise
      : path.endsWith("/sequence-b") ? selected.promise : undefined;
    await mount();
    await select("Recent video sequences", second.id);
    await act(async () => vi.advanceTimersByTime(3000)); await settle();
    await act(async () => selected.resolve(envelope({ sequence: second }))); await settle();
    await act(async () => oldPoll.resolve(envelope({ sequence: deliveredSequence(first.id) }))); await settle();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Recent video sequences"]')?.value).toBe(second.id);
    expect(container.querySelector("video")?.getAttribute("src")).toBe(second.asset.url);
    expect(container.querySelector('a[href="/api/v1/media/sequence-b-complete/content?download=1"]')).not.toBeNull();
    expect(calls.filter(call => call.path.endsWith("/sequence-a"))).toHaveLength(0);
    expect(calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
  });

  it("keeps the new request receipt when an old sequence completes during uncertain admission", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = { ...sequence(), id: "sequence-a" }, oldPoll = deferred(), admission = deferred();
    customize = (path, init) => path.endsWith("/video-sequences")
      ? init?.method === "POST" ? admission.promise : Promise.resolve(envelope({ sequences: [first] }))
      : path.endsWith("/sequence-a") ? oldPoll.promise : undefined;
    await mount(); await type("Scene 1 prompt", "A calm wave"); await click("Review video price");
    await act(async () => vi.advanceTimersByTime(3000)); await settle();
    await click("Accept 200 coins & create video");
    const saved = localStorage.getItem(storageKey);
    expect(saved).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(3000)); await settle();
    expect(calls.filter(call => call.path.endsWith("/sequence-a"))).toHaveLength(1);
    await act(async () => oldPoll.resolve(envelope({ sequence: deliveredSequence(first.id) }))); await settle();
    await act(async () => admission.reject(new TypeError("Connection lost"))); await settle();
    expect(localStorage.getItem(storageKey)).toBe(saved);
    expect(button("Check original request").disabled).toBe(false);
    expect(button("Refresh sequence").disabled).toBe(true);
    expect(button("Stop remaining scenes").disabled).toBe(true);
    expect(container.textContent).toContain("Check original request before accepting another quote");
    expect(calls.filter(call => call.init?.method === "POST" && !call.path.endsWith("/quote"))).toHaveLength(1);
  });

  it("does not replace the selected sequence's state with a previous poll's connection error", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = { ...sequence(), id: "sequence-a" }, second = deliveredSequence("sequence-b"), oldPoll = deferred();
    customize = path => path.endsWith("/video-sequences") ? Promise.resolve(envelope({ sequences: [first, second] }))
      : path.endsWith("/sequence-a") ? oldPoll.promise
      : path.endsWith("/sequence-b") ? Promise.resolve(envelope({ sequence: second })) : undefined;
    await mount();
    await act(async () => vi.advanceTimersByTime(3000)); await settle();
    await select("Recent video sequences", second.id); await settle();
    await act(async () => oldPoll.reject(new TypeError("Old sequence disconnected"))); await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("video")?.getAttribute("src")).toBe(second.asset.url);
    expect(calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
  });

  it("keeps delivered status when an earlier read of the same sequence arrives late", async () => {
    const first = { ...sequence(), id: "sequence-a" }, completed = deliveredSequence(first.id), old = deferred();
    let reads = 0;
    const onStatusChange = vi.fn();
    customize = path => path.endsWith("/video-sequences") ? Promise.resolve(envelope({ sequences: [first] }))
      : path.endsWith("/sequence-a") ? ++reads === 1 ? old.promise : Promise.resolve(envelope({ sequence: completed })) : undefined;
    await mount({ ...props, onStatusChange }); await click("Refresh sequence"); await click("Refresh sequence");
    await act(async () => old.resolve(envelope({ sequence: first }))); await settle();
    expect(container.textContent).toContain("Sequence completed");
    expect(container.querySelector("video")?.getAttribute("src")).toBe(completed.asset.url);
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    expect(calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
  });

  it("receives a slow poll's delivered video without repeatedly overtaking its pending read", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = { ...sequence(), id: "sequence-a" }, pending = deferred();
    customize = path => path.endsWith("/video-sequences") ? Promise.resolve(envelope({ sequences: [first] }))
      : path.endsWith("/sequence-a") ? pending.promise : undefined;
    await mount();
    await act(async () => vi.advanceTimersByTime(6000)); await settle();
    expect(calls.filter(call => call.path.endsWith("/sequence-a"))).toHaveLength(1);
    await act(async () => pending.resolve(envelope({ sequence: deliveredSequence(first.id) }))); await settle();
    expect(container.textContent).toContain("Sequence completed");
    expect(container.querySelector('a[href="/api/v1/media/sequence-a-complete/content?download=1"]')).not.toBeNull();
    expect(calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
  });

  it("tracks an in-flight scene after cancellation until delivery without another paid submission", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const original = sequence();
    const scene = original.scenes[0]!;
    const asset = (id: string) => ({ id, url: `/api/v1/media/${id}/content`, downloadUrl: `/api/v1/media/${id}/content?download=1` });
    const first = { ...original, request: { ...original.request, scenes: [{ prompt: "A calm wave", seconds: 5 }, { prompt: "Turn toward the plant", seconds: 5 }, { prompt: "Smile again", seconds: 5 }] },
      scenes: [
        { ...scene, ordinal: 0, job: { ...scene.job, id: "scene-one", status: "completed" }, assets: [asset("scene-one-video")] },
        { ...scene, ordinal: 1, job: { ...scene.job, id: "scene-two", status: "running" } },
        { ...scene, ordinal: 2, job: { ...scene.job, id: "scene-three", status: "queued" } },
      ], cost: { charged: 300, refunded: 0, finalCharge: 300 } };
    const cancelled = { ...first, status: "cancelled", cost: { charged: 300, refunded: 100, finalCharge: 200 },
      scenes: first.scenes.map(value => value.ordinal === 2 ? { ...value, job: { ...value.job, status: "cancelled", cost: { charged: 100, refunded: 100, finalCharge: 0 } } } : value) };
    const delivered = { ...cancelled, scenes: cancelled.scenes.map(value => value.ordinal === 1 ? { ...value, job: { ...value.job, status: "completed" }, assets: [asset("scene-two-video")] } : value) };
    customize = (path, init) => path.endsWith("/video-sequences") ? Promise.resolve(envelope({ sequences: [first] }))
      : path.endsWith("/sequence-original/stop") && init?.method === "POST" ? Promise.resolve(envelope({ sequence: cancelled }))
      : path.endsWith("/sequence-original") ? Promise.resolve(envelope({ sequence: delivered })) : undefined;
    await mount(); await click("Stop remaining scenes");
    expect(container.textContent).toContain("Sequence cancelled · reserved 300 · refunded 100 · final charge 200 coins");
    expect(container.textContent).toContain("Scene 2: running");
    await act(async () => vi.advanceTimersByTime(3000)); await settle();
    expect(container.textContent).toContain("Scene 2: completed");
    expect(container.querySelector('a[href="/api/v1/media/scene-two-video/content?download=1"]')).not.toBeNull();
    expect(calls.filter(call => call.path.endsWith("/sequence-original"))).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(9000)); await settle();
    expect(calls.filter(call => call.path.endsWith("/sequence-original"))).toHaveLength(1);
    expect(calls.filter(call => call.init?.method === "POST").map(call => call.path)).toEqual(["/api/v1/generation/video-sequences/sequence-original/stop"]);
  });

  it("reports a failed current sequence read while keeping its delivered video available", async () => {
    const first = deliveredSequence("sequence-a");
    customize = path => path.endsWith("/video-sequences") ? Promise.resolve(envelope({ sequences: [first] }))
      : path.endsWith("/sequence-a") ? Promise.resolve(Response.json({ ok: false, error: { message: "Sequence service unavailable" } }, { status: 503 })) : undefined;
    await mount(); await click("Refresh sequence");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Sequence service unavailable");
    expect(container.querySelector("video")?.getAttribute("src")).toBe(first.asset.url);
    expect(calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
  });

  it("keeps an uncertain submission receipt across reload and checks its original key without another POST", async () => {
    customize = (path, init) => path.endsWith("/video-sequences") && init?.method === "POST" ? Promise.reject(new TypeError("Connection lost")) : undefined;
    await mount(); await type("Scene 1 prompt", "A calm wave"); await click("Review video price"); await click("Accept 200 coins & create video");
    const saved = JSON.parse(localStorage.getItem(storageKey)!); expect(saved.id).toBeNull(); expect(container.textContent).toContain("Check original request");
    await act(async () => root.unmount()); root = createRoot(container); await mount();
    const reads = calls.filter(call => call.path.includes("/request?")); expect(reads).toHaveLength(1); expect(new URL(reads[0]!.path, "http://localhost").searchParams.get("key")).toBe(saved.key);
    expect(calls.filter(call => call.init?.method === "POST" && !call.path.endsWith("/quote"))).toHaveLength(1);
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Scene 1 prompt"]')?.value).toBe("A calm wave");
  });

  it("releases a deterministically absent stale request and retains the script for a new price", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    customize = (path, init) => path.endsWith("/video-sequences") && init?.method === "POST"
      ? Promise.resolve(Response.json({ ok: false, error: { message: "Video sequence quote changed" } }, { status: 409 }))
      : path.includes("/request?") ? Promise.resolve(Response.json({ ok: false, error: { message: "Video sequence not found" } }, { status: 404 }))
      : path.endsWith("/video-sequences") ? Promise.resolve(envelope({ sequences: [sequence()] })) : undefined;
    await mount(); await select("Video sound", "narration"); await type("Scene 1 prompt", "A calm wave"); await type("Scene 1 narration", "Welcome to the garden.");
    await click("Review video price"); await click("Accept 200 coins & create video");
    expect(container.textContent).toContain("original request was not accepted"); expect(button("Review video price").disabled).toBe(false); expect(localStorage.getItem(storageKey)).toBeNull();
    expect(container.querySelector('[aria-label="Video price"]')).toBeNull(); expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Scene 1 narration"]')?.value).toBe("Welcome to the garden.");
    await act(async () => vi.advanceTimersByTime(3000)); await settle();
    expect(calls.filter(call => call.path.endsWith("/sequence-original"))).toHaveLength(1);
    expect(calls.filter(call => call.init?.method === "POST" && !call.path.endsWith("/quote"))).toHaveLength(1);
  });

  it("offers packaging recovery and the delivered scene without issuing a new native generation", async () => {
    const failed = { ...sequence("composition_failed"), scenes: [{ ...sequence().scenes[0]!, job: { ...sequence().scenes[0]!.job, status: "completed" }, assets: [{ id: "delivered-scene", url: "/api/v1/media/delivered-scene/content", downloadUrl: "/api/v1/media/delivered-scene/content?download=1" }] }] };
    customize = (path, init) => path.endsWith("/video-sequences") && !init?.method ? Promise.resolve(envelope({ sequences: [failed] })) : undefined;
    await mount(); expect(container.querySelector('a[href="/api/v1/media/delivered-scene/content?download=1"]')).not.toBeNull(); await click("Retry finishing · no extra coins");
    expect(calls.filter(call => call.init?.method === "POST").map(call => call.path)).toEqual(["/api/v1/generation/video-sequences/sequence-original/retry-composition"]);
  });

  it("shows all three narration states and explains missing-line recovery without promising no model calls", async () => {
    const original = sequence("composition_failed");
    const failed = { ...original, request: { ...original.request, audio: "narration", scenes: ["First line.", "Second line.", "Third line."].map(narration => ({ prompt: "A calm wave", seconds: 5, narration })) },
      scenes: ["completed", "completed", "failed"].map((narrationState, ordinal) => ({ ...original.scenes[0]!, ordinal, narrationState, job: { ...original.scenes[0]!.job, id: `scene-${ordinal}`, status: "completed" } })) };
    customize = (path, init) => path.endsWith("/video-sequences") && !init?.method ? Promise.resolve(envelope({ sequences: [failed] })) : undefined;
    await mount();
    expect(container.textContent).toContain("Scene 1: completed · 100 coins · narration ready");
    expect(container.textContent).toContain("Scene 2: completed · 100 coins · narration ready");
    expect(container.textContent).toContain("Scene 3: completed · 100 coins · narration failed");
    expect(container.textContent).toContain("missing lines will be generated on retry");
    expect(container.textContent).not.toContain("no model requests");
    await click("Retry finishing · no extra coins");
    expect(calls.filter(call => call.init?.method === "POST").map(call => call.path)).toEqual(["/api/v1/generation/video-sequences/sequence-original/retry-composition"]);
  });

  it("refreshes the surrounding balance and library on changed delivery state, not repeated status reads", async () => {
    let current = sequence();
    const onStatusChange = vi.fn();
    customize = (path, init) => !init?.method && path.endsWith("/video-sequences")
      ? Promise.resolve(envelope({ sequences: [current] }))
      : path.endsWith("/sequence-original") ? Promise.resolve(envelope({ sequence: current })) : undefined;
    await mount({ ...props, onStatusChange });
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    await click("Refresh sequence");
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    current = { ...current, scenes: [{ ...current.scenes[0]!, job: { ...current.scenes[0]!.job, status: "completed" } }] };
    await click("Refresh sequence");
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    current = { ...current, status: "completed" };
    await click("Refresh sequence");
    expect(onStatusChange).toHaveBeenCalledTimes(3);
    await click("Refresh sequence");
    expect(onStatusChange).toHaveBeenCalledTimes(3);
    expect(calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
  });
});
