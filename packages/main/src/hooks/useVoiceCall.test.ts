// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceCall, type VoiceCallController } from "./useVoiceCall";
import { VoiceCallControls } from "@/components/ourdream/chat/VoiceCallControls";
import type { VoiceCall } from "@idream/shared/contracts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
let level = 0;
class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported() { return true; }
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { Recorder.instances.push(this); }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["speech"], { type: "audio/webm" }) }); this.onstop?.(); }); }
}
class Context {
  close = vi.fn(async () => undefined);
  createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(level) }; }
  createMediaStreamSource() { return { connect: vi.fn() }; }
}
class Player {
  static instances: Player[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  constructor(readonly src: string) { Player.instances.push(this); }
}
let root: Root, container: HTMLDivElement, voice: VoiceCallController, serverCall: VoiceCall | null;
let track: { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }, getUserMedia: ReturnType<typeof vi.fn>;
let fetcher: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
const onTurn = vi.fn(), beforeConnect = vi.fn();
function Harness({ owner = "user:owner", session = "s", controls = false }: { owner?: string; session?: string; controls?: boolean }) {
  const controller = useVoiceCall({ sessionPath: `/api/v1/chat/sessions/${session}`, ownerScope: owner, enabled: true, onTurn, beforeConnect });
  useEffect(() => { voice = controller; }, [controller]);
  return controls ? createElement(VoiceCallControls, { voice: controller, disabled: false }) : createElement("span", {}, controller.phase);
}
async function render(props: { owner?: string; session?: string; controls?: boolean } = {}) { await act(async () => root.render(createElement(Harness, props))); }
async function flush() { await act(async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); }); }
async function connect(useMicrophone = true) { await act(async () => { await voice.prepare(4); }); await act(async () => { await voice.connect(useMicrophone); }); }
function utterancePosts() { return fetcher.mock.calls.filter(([url, init]) => /\/utterances\/[^/]+$/.test(url) && init?.method === "POST"); }
beforeEach(() => {
  vi.useFakeTimers(); sessionStorage.clear(); serverCall = null; level = 0; Recorder.instances = []; Player.instances = [];
  onTurn.mockClear(); beforeConnect.mockClear(); track = { stop: vi.fn(), onended: null };
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [track] });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("MediaRecorder", Recorder); vi.stubGlobal("AudioContext", Context); vi.stubGlobal("Audio", Player);
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/quote")) return Response.json({ quoteToken: "signed", costPerReply: 2, allowanceMinutes: 0, maxCostDreamcoins: 4, maxDurationMs: 180_000 });
    if (url.endsWith("/voice-call") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      serverCall = { id: body.id, sessionId: "s", characterId: "c", status: "active", language: "en", leaseToken: body.clientLeaseToken,
        leaseExpiresAt: new Date(Date.now() + 15_000).toISOString(), deadlineAt: new Date(Date.now() + 180_000).toISOString(), startedAt: new Date().toISOString(), endedAt: null,
        connectedMs: 0, maxCostDreamcoins: 4, costDreamcoins: 0, voiceDurationMs: 0, endReason: null };
      return Response.json({ call: serverCall });
    }
    if (url.endsWith("/voice-call")) return Response.json({ status: "available", language: "en", transport: "turn-based", balance: 20, call: serverCall });
    if (/\/utterances\/[^/]+\/voice$/.test(url)) return Response.json({ ok: true, data: { contentUrl: "/api/v1/media/audio/content" } });
    if (/\/utterances\/[^/]+$/.test(url)) return Response.json({ assistantStatus: "sent", status: "linked",
      userMessage: { id: "user-message", role: "user", content: "Hello", status: "sent" }, assistant: { id: "reply", role: "assistant", content: "Good morning", status: "sent", attempt: 1 } });
    if (serverCall) {
      const action = url.split("/").at(-1);
      serverCall = { ...serverCall, status: action === "mute" ? "muted" : action === "end" ? "ended" : action === "disconnect" ? "disconnected" : "active" };
      return Response.json({ call: serverCall });
    }
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetcher); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("mounted Call microphone and playback ownership", () => {
  it("keeps nonzero low-level microphone speech past five seconds and sends the visible current sentence once", async () => {
    await render({ controls: true }); await connect(); level = .01;
    await act(async () => { await vi.advanceTimersByTimeAsync(6100); });
    expect(Recorder.instances).toHaveLength(1); expect(Recorder.instances[0].state).toBe("recording");
    expect(utterancePosts()).toHaveLength(0);
    const send = [...container.querySelectorAll("button")].find(button => button.textContent === "Send sentence")!;
    expect(send).toBeDefined(); await act(async () => { send.click(); send.click(); }); await flush();
    expect(utterancePosts()).toHaveLength(1); expect(utterancePosts()[0][0]).toContain(`/voice-call/${voice.call!.id}/utterances/`);
    expect(onTurn).toHaveBeenCalledOnce(); expect(voice.phase).toBe("speaking");
  });
  it("pauses an unsegmented low-level clip at the bound without inference and keeps explicit send or discard available", async () => {
    await render({ controls: true }); await connect(); level = .01;
    await act(async () => { await vi.advanceTimersByTimeAsync(26_000); });
    expect(utterancePosts()).toHaveLength(0); expect(Recorder.instances).toHaveLength(1);
    expect(Recorder.instances[0].state).toBe("inactive"); expect(voice.microphonePaused).toBe(true);
    expect(voice.notice).toContain("paused");
    const discard = [...container.querySelectorAll("button")].find(button => button.textContent === "Discard and keep listening")!;
    expect(discard).toBeDefined(); await act(async () => discard.click());
    expect(Recorder.instances).toHaveLength(2); expect(Recorder.instances[1].state).toBe("recording"); expect(voice.microphonePaused).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(26_000); }); expect(utterancePosts()).toHaveLength(0);
    const send = [...container.querySelectorAll("button")].find(button => button.textContent === "Send sentence")!;
    await act(async () => send.click()); await flush(); expect(utterancePosts()).toHaveLength(1);
  });
  it("handles the canonical no_speech rejection without starting a Turn or voice charge and leaves silent capture bounded", async () => {
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => /\/utterances\/[^/]+$/.test(url)
      ? Promise.resolve(Response.json({ status: "failed", errorCode: "no_speech" })) : base(url, init));
    await render({ controls: true }); await connect(); level = 0;
    const send = [...container.querySelectorAll("button")].find(button => button.textContent === "Send sentence")!;
    expect(send).toBeDefined(); await act(async () => send.click()); await flush();
    expect(utterancePosts()).toHaveLength(1);
    const originalUrl = utterancePosts()[0][0];
    expect(fetcher.mock.calls.filter(([url, init]) => url === originalUrl && !init?.method)).toHaveLength(0);
    expect(voice.phase).toBe("listening"); expect(voice.notice).toContain("No speech");
    expect(onTurn).not.toHaveBeenCalled(); expect(Player.instances).toHaveLength(0);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/voice"))).toHaveLength(0);
    expect(voice.call?.costDreamcoins).toBe(0); expect(voice.call?.voiceDurationMs).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(26_000); });
    expect(utterancePosts()).toHaveLength(1); expect(voice.microphonePaused).toBe(true);
    expect(Recorder.instances.at(-1)?.state).toBe("inactive");
  });
  it("does not apply a late original no_speech GET to a new account's Call", async () => {
    const pending = deferred<Response>(), base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => /\/utterances\/[^/]+$/.test(url)
      ? init?.method === "POST" ? Promise.resolve(Response.json({ status: "pending", retryAfterMs: 600 })) : pending.promise : base(url, init));
    await render(); await connect(false); await act(async () => voice.submitRecording(new Blob(["original recording"]))); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    const oldCallId = voice.call!.id; expect(voice.phase).toBe("thinking");
    expect(fetcher.mock.calls.filter(([url, init]) => /\/utterances\/[^/]+$/.test(url) && !init?.method)).toHaveLength(1);
    serverCall = null; await render({ owner: "user:other" }); await connect(false); const newCallId = voice.call!.id;
    expect(newCallId).not.toBe(oldCallId);
    await act(async () => pending.resolve(Response.json({ status: "failed", errorCode: "no_speech" }))); await flush();
    expect(voice.call!.id).toBe(newCallId); expect(voice.phase).toBe("listening");
    expect(voice.notice).toContain("Ready for next recording"); expect(voice.notice).not.toContain("No speech");
    expect(onTurn).not.toHaveBeenCalled(); expect(Player.instances).toHaveLength(0);
  });
  it.each(["mute", "end", "account"])("revokes a held microphone clip's manual callbacks after %s", async change => {
    await render(); await connect(); level = .01; await act(async () => { await vi.advanceTimersByTimeAsync(26_000); });
    expect(voice.microphonePaused).toBe(true); const old = voice;
    if (change === "mute") await act(async () => { await voice.toggleMute(); });
    else if (change === "end") await act(async () => { await voice.end(); });
    else await render({ owner: "user:other" });
    await act(async () => { old.finishSentence(); old.discardSentence(); });
    expect(utterancePosts()).toHaveLength(0); expect(track.stop).toHaveBeenCalledOnce();
    expect(Recorder.instances).toHaveLength(1); expect(voice.microphoneActive).toBe(false);
  });
  it("shows an oversized microphone clip error and releases capture instead of silently restarting", async () => {
    await render(); await connect(); const recording = Recorder.instances[0];
    await act(async () => { recording.ondataavailable?.({ data: new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]) }); await vi.advanceTimersByTimeAsync(80); });
    expect(voice.phase).toBe("error"); expect(voice.notice).toContain("8 MiB");
    expect(track.stop).toHaveBeenCalledOnce(); expect(recording.state).toBe("inactive");
    expect(Recorder.instances).toHaveLength(1); expect(utterancePosts()).toHaveLength(0);
  });
  it.each(["end", "account"])("releases a microphone permission result after %s without starting a Call", async change => {
    const permission = deferred<MediaStream>(); getUserMedia.mockReturnValue(permission.promise);
    await render(); await act(async () => { await voice.prepare(4); });
    let pending!: Promise<void>; await act(async () => { pending = voice.connect(); });
    if (change === "end") await act(async () => { await voice.end(); }); else await render({ owner: "user:other" });
    await act(async () => { permission.resolve({ getTracks: () => [track] } as unknown as MediaStream); await pending; });
    expect(track.stop).toHaveBeenCalledOnce(); expect(Recorder.instances).toHaveLength(0);
    expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith("/voice-call") && init?.method === "POST")).toHaveLength(0);
  });
  it("records a sentence through Recorder events, then automatically speaks the canonical reply", async () => {
    await render(); await connect(); expect(beforeConnect).toHaveBeenCalledOnce();
    level = .04; await act(async () => { await vi.advanceTimersByTimeAsync(320); });
    level = 0; await act(async () => { await vi.advanceTimersByTimeAsync(1100); }); await flush();
    expect(utterancePosts()).toHaveLength(1); expect(utterancePosts()[0][1]?.body).toBeInstanceOf(FormData);
    expect(onTurn).toHaveBeenCalledOnce(); expect(Player.instances).toHaveLength(1); expect(voice.phase).toBe("speaking");
    await act(async () => { Player.instances[0].onended?.(); }); expect(voice.phase).toBe("listening");
    await act(async () => { await voice.toggleMute(); }); expect(voice.phase).toBe("muted"); expect(track.stop).toHaveBeenCalledOnce();
  });
  it("stops capture and playback on mute, then reacquires capture when unmuted", async () => {
    await render(); await connect(); await act(async () => { await voice.toggleMute(); });
    expect(track.stop).toHaveBeenCalledOnce(); expect(voice.call?.status).toBe("muted");
    await act(async () => { await voice.toggleMute(); }); expect(getUserMedia).toHaveBeenCalledTimes(2); expect(voice.phase).toBe("listening");
    await act(async () => { await voice.end(); }); expect(track.stop).toHaveBeenCalledTimes(2); expect(voice.call?.status).toBe("ended");
  });
  it("never plays a late voice result after End or an account change", async () => {
    const result = deferred<Response>(), base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => url.endsWith("/voice") ? result.promise : base(url, init));
    await render(); await connect(false); await act(async () => voice.submitRecording(new Blob(["English recording"]))); await flush();
    expect(voice.phase).toBe("thinking");
    await act(async () => { await voice.end(); });
    await act(async () => { result.resolve(Response.json({ ok: true, data: { contentUrl: "/api/v1/media/late/content" } })); }); await flush();
    expect(Player.instances).toHaveLength(0); expect(voice.phase).toBe("ended");
  });
  it("keeps recording mode truthful after playback, interrupt, mute and resume without opening a microphone", async () => {
    await render(); await connect(false);
    expect(voice.notice).toContain("recording"); expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => voice.submitRecording(new Blob(["English recording"]))); await flush();
    expect(voice.phase).toBe("speaking");
    await act(async () => { Player.instances[0].onended?.(); }); await flush();
    expect(voice.notice).toContain("Ready for next recording"); expect(voice.notice).not.toContain("Listening");
    await act(async () => { await voice.interrupt(); }); expect(voice.notice).toContain("Ready for next recording");
    await act(async () => { await voice.toggleMute(); }); expect(voice.notice).toContain("Unmute");
    await act(async () => { await voice.toggleMute(); }); expect(voice.notice).toContain("Ready for next recording");
    serverCall = { ...serverCall!, status: "disconnected" };
    await act(async () => { await voice.refresh(); }); await act(async () => { await voice.resume(false); });
    expect(voice.notice).toContain("Ready for next recording"); expect(getUserMedia).not.toHaveBeenCalled();
  });
  it("explains exhausted voice minutes or budget after ending the original call", async () => {
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => url.endsWith("/voice") ? Promise.resolve(Response.json({ ok: true, data: {} })) : base(url, init));
    await render(); await connect(false); await act(async () => voice.submitRecording(new Blob(["English recording"]))); await flush();
    expect(voice.phase).toBe("ended"); expect(voice.notice).toContain("exhausted"); expect(Player.instances).toHaveLength(0);
  });
  it("discards a definitively expired uncreated quote and lets the user review a fresh price", async () => {
    const base = fetcher.getMockImplementation()!, ids: string[] = [];
    fetcher.mockImplementation(async (url, init) => {
      if (url.endsWith("/quote")) { ids.push(JSON.parse(String(init?.body)).id); return base(url, init); }
      if (url.endsWith("/voice-call") && init?.method === "POST") return Response.json({ error: "conflict", message: "Voice quote expired; request another quote", details: { reason: "voice_quote_stale" } }, { status: 409 });
      if (/\/voice-call\/[^/]+$/.test(url)) return Response.json({ error: "not_found", message: "Call not found" }, { status: 404 });
      return base(url, init);
    });
    await render(); await connect(false);
    expect(voice.phase).toBe("idle"); expect(voice.quote).toBeNull(); expect(voice.notice).toContain("Review call price again");
    expect(sessionStorage.getItem("idream:voice-call:user:owner:/api/v1/chat/sessions/s")).toBeNull();
    await act(async () => { await voice.prepare(4); }); expect(ids).toHaveLength(2); expect(ids[1]).not.toBe(ids[0]);
  });
  it("keeps the original quote and identity after an ambiguous submission instead of treating 404 as authorization to redial", async () => {
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => {
      if (url.endsWith("/voice-call") && init?.method === "POST") return Promise.reject(new Error("Connection lost"));
      if (!url.endsWith("/quote") && /\/voice-call\/[^/]+$/.test(url)) return Promise.resolve(Response.json({ error: "not_found", message: "Call not found" }, { status: 404 }));
      return base(url, init);
    });
    await render(); await connect(false);
    expect(voice.phase).toBe("error"); expect(voice.quote?.quoteToken).toBe("signed"); expect(voice.notice).toContain("Connection lost");
    expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith("/voice-call") && init?.method === "POST")).toHaveLength(1);
  });
  it("recovers an accepted start with a lost response into the same disconnected call for explicit resume", async () => {
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (url.endsWith("/voice-call") && init?.method === "POST") { await base(url, init); throw new Error("Start response lost"); }
      return base(url, init);
    });
    await render(); await connect(false);
    expect(voice.phase).toBe("disconnected"); expect(voice.call?.id).toBe(serverCall?.id); expect(voice.call?.status).toBe("disconnected");
    expect(voice.notice).toContain("Resume this original call"); expect(voice.quote).toBeNull();
    expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith("/voice-call") && init?.method === "POST")).toHaveLength(1);
  });
  it("closes microphone resources and fences pending work when heartbeat fails", async () => {
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => url.endsWith("/heartbeat") ? Promise.reject(new Error("offline")) : base(url, init));
    await render(); await connect(); await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
    expect(track.stop).toHaveBeenCalledOnce(); expect(voice.phase).toBe("disconnected"); expect(voice.call?.status).toBe("disconnected");
    const attempts = fetcher.mock.calls.filter(([url]) => url.endsWith("/heartbeat")).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/heartbeat"))).toHaveLength(attempts);
  });
});
