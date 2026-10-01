// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceInput, type VoiceInputController } from "./useVoiceInput";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class FakeRecorder {
  static supported = true;
  static instances: FakeRecorder[] = [];
  static isTypeSupported() { return this.supported; }
  state = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: unknown, options: { mimeType: string }) { this.mimeType = options.mimeType; FakeRecorder.instances.push(this); }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["captured audio"], { type: this.mimeType }) }); this.onstop?.(); });
  }
}
let root: Root, container: HTMLDivElement, controller: VoiceInputController;
let editDraft: (text: string) => void;
let track: { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };
let getUserMedia: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let latestPostId: string;
const sent = vi.fn(), beforeRecording = vi.fn();
type HarnessProps = { session?: string; owner?: string; recipient?: string; initialDraft?: string };
function Harness({ session = "/api/v1/chat/sessions/s", owner = "user:u", recipient = "c", initialDraft = "" }: HarnessProps) {
  const [draft, setDraft] = useState(initialDraft);
  const voice = useVoiceInput({ sessionPath: session, ownerScope: owner, recipientId: recipient, enabled: true, draft, onDraft: setDraft, beforeRecording });
  useEffect(() => { editDraft = setDraft; controller = voice; }, [voice, setDraft]);
  return createElement("div", {},
    createElement("textarea", { value: draft, readOnly: voice.readOnly, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value) }),
    createElement("button", { disabled: voice.blocksSend, onClick: () => sent(draft) }, "Send"),
  );
}
function completed(text = "Hello there") { return Response.json({ ok: true, data: { requestId: latestPostId, status: "completed", text, audioDurationMs: 1200, expiresAt: new Date(Date.now() + 120_000).toISOString() } }); }
function posts() { return fetchMock.mock.calls.filter(call => call[1]?.method === "POST"); }
function draft() { return container.querySelector("textarea")!.value; }
function sendButton() { return container.querySelector("button")!; }
async function render(props: HarnessProps = {}) { await act(async () => root.render(createElement(Harness, props))); }
async function start() { await act(async () => { await controller.start(); }); }
async function finish() { await act(async () => controller.finish()); }

beforeEach(() => {
  vi.useFakeTimers(); FakeRecorder.instances = []; FakeRecorder.supported = true;
  sent.mockReset(); beforeRecording.mockReset();
  track = { stop: vi.fn(), onended: null };
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [track] });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.stubGlobal("MediaRecorder", FakeRecorder); vi.stubGlobal("AudioContext", undefined);
  fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/voice-input")) return Response.json({ ok: true, data: { supported: true, available: true, ownerScope: init?.headers && (init.headers as Record<string, string>)["x-idream-viewer-scope"], languages: ["en"], maxDurationMs: 60_000, maxUploadBytes: 8388608, resultTtlMs: 120_000 } });
    if (init?.method === "POST") { latestPostId = (init.headers as Record<string, string>)["idempotency-key"]; return completed(); }
    return Response.json({ ok: true, data: { requestId: latestPostId, status: "cancelled" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("mounted voice input lifecycle", () => {
  it("closes a permission result that arrives after Cancel", async () => {
    const permission = deferred<MediaStream>(); getUserMedia.mockReturnValue(permission.promise);
    await render();
    let starting!: Promise<void>;
    await act(async () => { starting = controller.start(); });
    expect(controller.phase).toBe("requesting"); expect(sendButton().disabled).toBe(true);
    await act(async () => controller.cancel());
    await act(async () => { permission.resolve({ getTracks: () => [track] } as unknown as MediaStream); await starting; });
    expect(track.stop).toHaveBeenCalledOnce(); expect(FakeRecorder.instances).toHaveLength(0);
    expect(controller.phase).toBe("idle"); expect(posts()).toHaveLength(0);
  });
  it.each(["", "My original draft"])("fills an editable draft %j from actual Recorder events without sending", async initialDraft => {
    await render({ initialDraft }); await start();
    expect(controller.phase).toBe("recording"); expect(sendButton().disabled).toBe(true);
    expect(container.querySelector("textarea")!.readOnly).toBe(true);
    expect(beforeRecording).toHaveBeenCalledOnce();
    await finish();
    expect(draft()).toBe(initialDraft ? `${initialDraft} Hello there` : "Hello there");
    expect(posts()).toHaveLength(1); expect(posts()[0][1]!.body).toBeInstanceOf(FormData);
    expect((posts()[0][1]!.body as FormData).get("audio")).toBeInstanceOf(Blob);
    expect(track.stop).toHaveBeenCalledOnce(); expect(sent).not.toHaveBeenCalled();
    expect(sendButton().disabled).toBe(false); expect(controller.phase).toBe("idle");
    expect(controller.canUndo).toBe(true);
    await act(async () => controller.undo());
    expect(draft()).toBe(initialDraft);
  });
  it("protects edits during transcription until explicitly adding the candidate", async () => {
    const response = deferred<Response>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { latestPostId = (init.headers as Record<string, string>)["idempotency-key"]; return response.promise; }
      if (String(url).endsWith("/voice-input")) return Response.json({ ok: true, data: { supported: true, available: true, ownerScope: "user:u", languages: ["en"], maxDurationMs: 60000, maxUploadBytes: 8388608, resultTtlMs: 120000 } });
      return Response.json({ ok: true, data: { requestId: latestPostId, status: "cancelled" } });
    });
    await render({ initialDraft: "Original" }); await start(); await finish();
    expect(controller.phase).toBe("transcribing"); expect(sendButton().disabled).toBe(true);
    expect(container.querySelector("textarea")!.readOnly).toBe(false);
    await act(async () => editDraft("Edited"));
    await act(async () => response.resolve(completed()));
    expect(draft()).toBe("Edited"); expect(controller.phase).toBe("review"); expect(controller.candidate).toBe("Hello there");
    await act(async () => controller.addCandidate());
    expect(draft()).toBe("Edited Hello there"); expect(sent).not.toHaveBeenCalled();
  });
  it.each([{ session: "/api/v1/chat/sessions/other" }, { owner: "user:other" }])("fences late results after scope changes %j", async props => {
    const response = deferred<Response>();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") { latestPostId = (init.headers as Record<string, string>)["idempotency-key"]; return response.promise; }
      return original(url, init);
    });
    await render({ initialDraft: "Keep" }); await start(); await finish();
    await render({ ...props, initialDraft: "Keep" });
    await act(async () => response.resolve(completed("Late text")));
    expect(draft()).toBe("Keep"); expect(controller.phase).toBe("idle");
    expect(fetchMock.mock.calls.some(call => call[1]?.method === "DELETE")).toBe(true);
  });
  it("stops capture on hidden and waits for explicit clip transcription", async () => {
    await render(); await start();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(controller.phase).toBe("interrupted"); expect(posts()).toHaveLength(0);
    expect(track.stop).toHaveBeenCalledOnce(); expect(sendButton().disabled).toBe(true);
    await act(async () => controller.transcribeClip());
    expect(posts()).toHaveLength(1); expect(draft()).toBe("Hello there");
  });
  it("revokes a POST result racing with Cancel and releases all tracks", async () => {
    const response = deferred<Response>(); const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") { latestPostId = (init.headers as Record<string, string>)["idempotency-key"]; return response.promise; }
      return original(url, init);
    });
    await render({ initialDraft: "Keep" }); await start(); await finish();
    await act(async () => { controller.cancel(); response.resolve(completed("Discard me")); });
    expect(draft()).toBe("Keep"); expect(controller.phase).toBe("idle");
    expect(fetchMock.mock.calls.some(call => call[1]?.method === "DELETE")).toBe(true);
    expect((posts()[0][1]!.signal as AbortSignal).aborted).toBe(true); expect(track.stop).toHaveBeenCalledOnce();
  });
  it("warns at 55 seconds and stops at 59.5 seconds to leave codec padding", async () => {
    await render(); await start();
    await act(async () => vi.advanceTimersByTimeAsync(55_000));
    expect(controller.phase).toBe("recording"); expect(controller.notice).toContain("few seconds"); expect(posts()).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(4400)); expect(posts()).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(posts()).toHaveLength(1); expect(track.stop).toHaveBeenCalledOnce(); expect(draft()).toBe("Hello there");
  });
  it("refreshes group capability by recipient while keeping POST, polling and cleanup bound to the recording recipient", async () => {
    const session = "/api/v1/chat/groups/group-1";
    const polling = deferred<Response>(); const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        latestPostId = (init.headers as Record<string, string>)["idempotency-key"];
        if (posts().length > 1) return Promise.resolve(completed("New recipient text"));
        return Promise.resolve(Response.json({ ok: true, data: { requestId: latestPostId, status: "pending", retryAfterMs: 250 } }, { status: 202 }));
      }
      if (url.includes("/transcriptions/") && !init?.method) return polling.promise;
      return original(url, init);
    });
    await render({ session, recipient: "a", initialDraft: "Keep" }); await start(); await finish();
    expect(controller.phase).toBe("transcribing");
    await render({ session, recipient: "b", initialDraft: "Keep" });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    const capabilities = fetchMock.mock.calls.filter(call => call[0].endsWith("/voice-input"));
    expect(capabilities.map(call => (call[1]!.headers as Record<string, string>)["x-idream-voice-character-id"])).toEqual(["a", "b"]);
    expect((posts()[0][1]!.headers as Record<string, string>)["x-idream-voice-character-id"]).toBe("a");
    const polls = fetchMock.mock.calls.filter(call => call[0].includes("/transcriptions/") && !call[1]?.method);
    expect(polls).toHaveLength(1);
    expect((polls[0][1]!.headers as Record<string, string>)["x-idream-voice-character-id"]).toBe("a");
    await act(async () => polling.resolve(completed("Old recipient text")));
    expect(controller.phase).toBe("review"); expect(controller.candidate).toBe("Old recipient text");
    expect(draft()).toBe("Keep"); expect(sent).not.toHaveBeenCalled();
    const cleanup = fetchMock.mock.calls.filter(call => call[1]?.method === "DELETE");
    expect(cleanup).toHaveLength(1);
    expect((cleanup[0][1]!.headers as Record<string, string>)["x-idream-voice-character-id"]).toBe("a");
    await act(async () => controller.cancel());
    await start(); await finish();
    expect((posts()[1][1]!.headers as Record<string, string>)["x-idream-voice-character-id"]).toBe("b");
    expect(draft()).toBe("Keep New recipient text");
  });
  it("does not reuse a previous recipient's microphone permission while new capability is pending", async () => {
    const session = "/api/v1/chat/groups/group-1";
    const capability = deferred<Response>(); const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/voice-input") && (init?.headers as Record<string, string>)["x-idream-voice-character-id"] === "b") return capability.promise;
      return original(url, init);
    });
    await render({ session, recipient: "a" });
    await render({ session, recipient: "b" }); await start();
    expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => capability.resolve(Response.json({ ok: true, data: { supported: true, available: true, ownerScope: "user:u", languages: ["en"], maxDurationMs: 60_000, maxUploadBytes: 8388608, resultTtlMs: 120_000 } })));
    await start(); expect(getUserMedia).toHaveBeenCalledOnce();
    await finish();
    expect((posts()[0][1]!.headers as Record<string, string>)["x-idream-voice-character-id"]).toBe("b");
  });
  it("rejects unsupported formats before requesting the microphone", async () => {
    FakeRecorder.supported = false; await render(); await start();
    expect(controller.phase).toBe("error"); expect(controller.notice).toContain("supported audio format");
    expect(getUserMedia).not.toHaveBeenCalled(); expect(sendButton().disabled).toBe(false);
  });
  it("releases the active device on unmount without uploading", async () => {
    await render(); await start(); await act(async () => root.unmount());
    expect(track.stop).toHaveBeenCalledOnce(); expect(posts()).toHaveLength(0); root = createRoot(container);
  });
});
