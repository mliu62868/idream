"use client";
import { useEffect, useRef, useState } from "react";
import { voiceCallSchema, type VoiceCall } from "@idream/shared/contracts";
import { parseChatSendResponse, type RuntimeChatMessage } from "@/lib/public-api-contracts";

type Phase = "idle" | "quoting" | "confirm" | "connecting" | "listening" | "thinking" | "speaking" | "muted" | "disconnected" | "ended" | "error";
type Quote = { quoteToken: string; costPerReply: number; allowanceMinutes: number; remainingAllowanceMs: number; voiceFallback: boolean; maxCostDreamcoins: number; maxDurationMs: number };
type Intent = { id: string; clientLeaseToken: string; language: "en"; maxCostDreamcoins: number; maxDurationMs: number; quoteToken?: string };
type Options = { sessionPath: string; ownerScope: string | null; enabled: boolean; beforeConnect: () => void;
  onTurn: (value: { userMessage: RuntimeChatMessage; assistant: RuntimeChatMessage; streamUrl?: string | null }) => void };
const FORMATS = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// Mirrors the server Call lease. Every successful control command renews it.
const LEASE_MS = 15_000;
// A network failure, an unreadable body or a 5xx/429 says nothing about the
// Call itself; any other HTTP status is the server's definite answer.
const transient = (error: unknown) => {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
  return !status || status >= 500 || status === 429;
};

export function useVoiceCall(options: Options) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [call, setCall] = useState<VoiceCall | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [available, setAvailable] = useState(false);
  const [balance, setBalance] = useState(0);
  const [otherCallSessionId, setOtherCallSessionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [microphonePaused, setMicrophonePaused] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const liveCall = useRef<VoiceCall | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const intent = useRef<Intent | null>(null);
  const scopeEpoch = useRef(0);
  const operationEpoch = useRef(0);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const context = useRef<AudioContext | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const playbackDone = useRef<(() => void) | null>(null);
  const interruptPending = useRef<Promise<void> | null>(null);
  const vad = useRef<ReturnType<typeof setInterval> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const retryRecording = useRef<{ id: string; expiresAt: number } | null>(null);
  const leaseRenewedAt = useRef(0);
  const recordingMode = useRef(false);
  const microphoneClip = useRef<{ send: () => void; discard?: () => void } | null>(null);
  const isListening = () => liveCall.current?.status === "active";
  const setView = (next: Phase) => { phaseRef.current = next; setPhase(next); };
  const applyCall = (value: unknown) => {
    const parsed = voiceCallSchema.parse(value);
    if (!parsed.leaseToken && liveCall.current?.id === parsed.id) parsed.leaseToken = liveCall.current.leaseToken;
    liveCall.current = parsed; setCall(parsed);
    if (parsed.leaseToken) sessionStorage.setItem(storageKey(), parsed.leaseToken);
    return parsed;
  };
  function storageKey() { return `idream:voice-call:${latest.current.ownerScope}:${latest.current.sessionPath}`; }
  function headers() {
    return { "x-idream-viewer-scope": latest.current.ownerScope ?? "", ...((liveCall.current?.leaseToken || sessionStorage.getItem(storageKey())) ? { "x-idream-call-lease": liveCall.current?.leaseToken || sessionStorage.getItem(storageKey())! } : {}) };
  }
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${latest.current.sessionPath}/voice-call${path}`, { ...init, headers: { ...headers(), ...init.headers }, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message ?? payload?.message ?? "Call could not continue. Check its original state before retrying."), {
      status: response.status, reason: payload?.error?.details?.reason ?? payload?.details?.reason,
    });
    return payload;
  }
  function stopPlayback() { audio.current?.pause(); audio.current = null; playbackDone.current?.(); playbackDone.current = null; }
  function readyNotice() {
    if (microphoneClip.current?.discard) return "Recording paused after 25 seconds. Send sentence or discard it and keep listening.";
    return stream.current ? "Listening. Pause at the end of your sentence to send it."
      : "Ready for next recording. Send an English audio recording to speak in this call.";
  }
  function releaseCapture() {
    microphoneClip.current = null; setMicrophoneActive(false); setMicrophonePaused(false);
    if (vad.current) clearInterval(vad.current);
    vad.current = null;
    const current = recorder.current; recorder.current = null;
    if (current) { current.onstop = null; current.ondataavailable = null; current.onerror = null; if (current.state !== "inactive") current.stop(); }
    stream.current?.getTracks().forEach(track => { track.onended = null; track.stop(); }); stream.current = null;
    if (context.current) void context.current.close().catch(() => {});
    context.current = null;
  }
  async function command(action: string) {
    if (!liveCall.current) return null;
    const current = liveCall.current, epoch = scopeEpoch.current;
    const payload = await request(`/${current.id}/${action}`, { method: "POST" });
    if (epoch !== scopeEpoch.current || liveCall.current?.id !== current.id) return null;
    leaseRenewedAt.current = Date.now();
    return applyCall(payload.call);
  }
  async function refresh() {
    if (!latest.current.enabled || !latest.current.ownerScope) return;
    const epoch = scopeEpoch.current;
    try {
      const payload = await request("");
      if (epoch !== scopeEpoch.current) return;
      setAvailable(payload.status === "available"); setBalance(payload.balance ?? 0);
      setOtherCallSessionId(payload.otherCallSessionId ?? null);
      if (payload.call && payload.call.status !== "ended") {
        const current = applyCall(payload.call);
        if (phaseRef.current === "idle" && current.leaseToken && ["active", "muted"].includes(current.status)) {
          await command("disconnect"); setView("disconnected");
        } else if (!current.leaseToken || current.status === "disconnected") setView("disconnected");
      }
    } catch { if (epoch === scopeEpoch.current) setAvailable(false); }
  }
  async function prepare(maxCostDreamcoins: number) {
    if (liveCall.current && liveCall.current.status !== "ended") return;
    setNotice(null); setView("quoting");
    const epoch = scopeEpoch.current;
    intent.current = { id: crypto.randomUUID(), clientLeaseToken: crypto.randomUUID(), language: "en", maxCostDreamcoins, maxDurationMs: 180_000 };
    try {
      const payload = await request("/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intent.current) });
      if (epoch !== scopeEpoch.current || !intent.current) return;
      intent.current.quoteToken = payload.quoteToken; setQuote(payload); setView("confirm");
    } catch (error) { if (epoch === scopeEpoch.current) { setNotice(error instanceof Error ? error.message : "Call quote unavailable"); setView("error"); } }
  }
  // existingId re-attaches to an already submitted recording (retry, resume).
  async function processRecording(blob: Blob | null, existingId?: string) {
    const current = liveCall.current;
    const epoch = scopeEpoch.current;
    if (!current || current.status !== "active") return;
    if (interruptPending.current) await interruptPending.current;
    if (epoch !== scopeEpoch.current || liveCall.current?.id !== current.id || !isListening()) return;
    const op = ++operationEpoch.current;
    const alive = () => epoch === scopeEpoch.current && op === operationEpoch.current && liveCall.current?.id === current.id;
    const id = existingId ?? crypto.randomUUID();
    controller.current?.abort(); controller.current = new AbortController();
    const signal = controller.current.signal;
    retryRecording.current = { id, expiresAt: Date.now() + 120_000 };
    setView("thinking"); setNotice("Recognizing your words, then preparing a reply…");
    try {
      let state;
      if (!existingId && blob) {
        const form = new FormData(); form.set("audio", blob, "utterance.webm");
        try { state = await request(`/${current.id}/utterances/${id}`, { method: "POST", body: form, signal }); }
        catch (error) {
          if (!alive() || signal.aborted) throw error;
          if (!transient(error)) { retryRecording.current = null; throw error; }
          state = await request(`/${current.id}/utterances/${id}`, { signal });
        }
      } else state = await request(`/${current.id}/utterances/${id}`, { signal });
      while (alive() && Date.now() < Date.parse(current.deadlineAt)) {
        if (state.userMessage && state.assistant) {
          latest.current.onTurn(parseChatSendResponse({ ok: true, data: state }));
          setNotice("Heard you. Your Character is writing a reply…");
        }
        if (["failed", "cancelled"].includes(state.status) || ["failed", "blocked", "cancelled"].includes(state.assistantStatus)) throw new Error(state.errorCode ?? "This spoken turn stopped. Try another sentence.");
        if (state.assistantStatus === "sent") break;
        await pause(600);
        if (!alive()) return;
        // A dropped poll is retried on the next tick; the heartbeat owns
        // deciding when the connection is actually lost.
        try { state = await request(`/${current.id}/utterances/${id}`, { signal }); }
        catch (error) { if (signal.aborted || !transient(error)) throw error; }
      }
      if (!alive()) return;
      if (Date.now() >= Date.parse(current.deadlineAt)) { await end(); return; }
      setNotice("Preparing your Character's voice…");
      const response = await request(`/${current.id}/utterances/${id}/voice`, { method: "POST", signal });
      if (!alive()) return;
      const url = response.data?.contentUrl;
      if (!url) {
        await end();
        if (epoch === scopeEpoch.current && liveCall.current?.id === current.id) {
          setNotice(`The accepted voice minutes or call budget are exhausted.${liveCall.current.status === "ended" ? "" : " Check the original call to confirm it ended."}`);
        }
        return;
      }
      const player = new Audio(url); audio.current = player;
      setView("speaking"); setNotice("Your Character is speaking. You can interrupt at any time.");
      const finished = new Promise<void>((resolve, reject) => {
        playbackDone.current = resolve; player.onended = () => resolve();
        player.onerror = () => reject(new Error("Reply audio could not play. Retry this original turn."));
      });
      await player.play();
      await finished;
      if (!alive()) return;
      retryRecording.current = null;
      stopPlayback(); setView("listening"); setNotice(readyNotice());
    } catch (error) {
      if (!alive() || signal.aborted) return;
      stopPlayback();
      if (error instanceof Error && error.message === "no_speech") {
        retryRecording.current = null; setView("listening");
        setNotice("No speech was recognized. Speak again or send another recording.");
      } else {
        releaseCapture(); setView("error"); setNotice(error instanceof Error ? error.message : "Call interrupted. Check the original turn.");
      }
    }
  }
  function interrupt(): Promise<void> {
    if (interruptPending.current) return interruptPending.current;
    const epoch = scopeEpoch.current;
    ++operationEpoch.current; controller.current?.abort(); retryRecording.current = null; stopPlayback();
    interruptPending.current = command("interrupt").then(result => {
      if (result) { setView("listening"); setNotice(readyNotice()); }
    }).catch(error => {
      if (epoch !== scopeEpoch.current) return;
      setView("disconnected"); setNotice(error instanceof Error ? error.message : "Call disconnected"); releaseCapture();
    }).finally(() => { interruptPending.current = null; });
    return interruptPending.current;
  }
  function startCapture(captured: MediaStream) {
    stream.current = captured;
    const epoch = scopeEpoch.current, callId = liveCall.current?.id;
    const ownsCapture = () => epoch === scopeEpoch.current && stream.current === captured && liveCall.current?.id === callId && liveCall.current?.status === "active";
    const mimeType = FORMATS.find(format => MediaRecorder.isTypeSupported(format));
    if (!mimeType) throw new Error("This browser cannot record supported audio.");
    const audioContext = new AudioContext(); context.current = audioContext;
    const analyser = audioContext.createAnalyser(); analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(captured).connect(analyser);
    setMicrophoneActive(true);
    const samples = new Float32Array(analyser.fftSize);
    let chunks: Blob[] = [], speechAt = 0, lastSpeechAt = 0, startedAt = Date.now(), bytes = 0;
    let submit = false, pauseAtLimit = false;
    const begin = () => {
      if (!ownsCapture()) return;
      microphoneClip.current = null; setMicrophonePaused(false);
      chunks = []; bytes = 0; speechAt = 0; lastSpeechAt = 0; startedAt = Date.now(); submit = false; pauseAtLimit = false;
      const current = new MediaRecorder(captured, { mimeType }); recorder.current = current;
      current.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); bytes += event.data.size; } };
      current.onerror = () => { if (recorder.current !== current || !ownsCapture()) return; releaseCapture(); setView("error"); setNotice("Microphone recording was interrupted. Resume or use a recording."); };
      current.onstop = () => {
        if (recorder.current !== current || !ownsCapture()) return;
        const blob = new Blob(chunks, { type: mimeType }); recorder.current = null;
        current.onstop = null; current.ondataavailable = null; current.onerror = null; chunks = [];
        if (bytes > 8 * 1024 * 1024) { releaseCapture(); setView("error"); setNotice("Microphone recording exceeded 8 MiB. Mute and unmute or use a shorter recording."); return; }
        if (pauseAtLimit && blob.size) {
          // RMS only times automatic sentence boundaries. A quiet clip stays
          // local and bounded until its owner sends or discards it.
          const ready = () => ownsCapture() && phaseRef.current === "listening";
          microphoneClip.current = {
            send: () => { if (!ready()) return; microphoneClip.current = null; setMicrophonePaused(false); void processRecording(blob); begin(); },
            discard: () => { if (!ready()) return; begin(); setNotice(readyNotice()); },
          };
          setMicrophonePaused(true); setNotice(readyNotice()); return;
        }
        if (submit && blob.size) void processRecording(blob);
        else if (!blob.size) setNotice("The microphone did not capture audio. Speak again or use a recording.");
        begin();
      };
      microphoneClip.current = { send: () => {
        if (!ownsCapture() || phaseRef.current !== "listening" || recorder.current !== current || current.state !== "recording") return;
        submit = true; current.stop();
      } };
      current.start(250);
    };
    begin();
    captured.getTracks().forEach(track => { track.onended = () => { if (ownsCapture()) void disconnect(); }; });
    vad.current = setInterval(() => {
      const current = recorder.current;
      if (!current || current.state === "inactive" || !ownsCapture()) return;
      if (bytes > 8 * 1024 * 1024) { releaseCapture(); setView("error"); setNotice("Microphone recording exceeded 8 MiB. Mute and unmute or use a shorter recording."); return; }
      if (!["listening", "speaking", "thinking"].includes(phaseRef.current)) return;
      analyser.getFloatTimeDomainData(samples);
      const level = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      const now = Date.now();
      if (level > 0.018) {
        if (!speechAt) { speechAt = now; if (["speaking", "thinking"].includes(phaseRef.current)) void interrupt(); }
        lastSpeechAt = now;
      }
      if (speechAt && now - speechAt >= 200 && now - lastSpeechAt > 900) {
        submit = true; current.stop();
      } else if (now - startedAt > 25_000) { pauseAtLimit = true; current.stop(); }
    }, 80);
  }
  async function connect(useMicrophone = true, resume = false) {
    const epoch = scopeEpoch.current;
    const op = ++operationEpoch.current;
    const alive = () => epoch === scopeEpoch.current && op === operationEpoch.current;
    let captured: MediaStream | null = null;
    setView("connecting"); setNotice(null); latest.current.beforeConnect();
    try {
      if (useMicrophone) {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Microphone calls need HTTPS and microphone support.");
        captured = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true } });
      }
      if (!alive()) { captured?.getTracks().forEach(track => track.stop()); return; }
      if (resume) await command("resume");
      else {
        if (!intent.current?.quoteToken) throw new Error("Accept a quote first");
        sessionStorage.setItem(storageKey(), intent.current.clientLeaseToken);
        const payload = await request("", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intent.current) });
        if (!alive()) { captured?.getTracks().forEach(track => track.stop()); return; }
        leaseRenewedAt.current = Date.now();
        applyCall(payload.call);
      }
      if (!alive() || !isListening()) { captured?.getTracks().forEach(track => track.stop()); return; }
      recordingMode.current = !useMicrophone;
      if (captured) startCapture(captured);
      setView("listening"); setQuote(null); setNotice(readyNotice());
      // A disconnect keeps the in-flight spoken turn alive on the server;
      // Resume continues that same reply instead of asking the user to repeat.
      if (resume) {
        const detail = await request(`/${liveCall.current!.id}`).catch(() => null);
        const pending = (detail?.utterances ?? []).filter((u: { status: string }) => ["transcribing", "linked"].includes(u.status)).at(-1);
        if (alive() && pending) void processRecording(null, pending.utteranceId);
      }
    } catch (error) {
      captured?.getTracks().forEach(track => track.stop());
      if (!alive()) return;
      releaseCapture();
      setView("error"); setNotice(error instanceof Error ? error.message : "Call could not connect");
      // A lost start response is inspected under the same call key; never dial
      // a new ID and expand the user's accepted budget.
      if (intent.current) {
        try {
          const payload = await request(`/${intent.current.id}`);
          if (!alive()) return;
          applyCall(payload.call); setQuote(null);
          if (liveCall.current?.status !== "ended") await command("disconnect");
          if (!alive()) return;
          setView(liveCall.current?.status === "ended" ? "ended" : "disconnected");
          setNotice("The start response was interrupted. Resume this original call when you are ready.");
        } catch (recoveryError) {
          if (!alive()) return;
          // Only a definite quote rejection plus an authoritative missing Call
          // frees this intent. An uncertain response keeps its original ID.
          if (!resume && error instanceof Error && "reason" in error && error.reason === "voice_quote_stale" &&
              recoveryError instanceof Error && "status" in recoveryError && recoveryError.status === 404) {
            sessionStorage.removeItem(storageKey()); intent.current = null; setQuote(null); setView("idle");
            setNotice("Call price expired. Review call price again before connecting.");
          }
        }
      }
    }
  }
  async function end() {
    const epoch = scopeEpoch.current;
    ++operationEpoch.current; controller.current?.abort(); retryRecording.current = null; releaseCapture(); stopPlayback();
    try { const result = await command("end"); if (epoch === scopeEpoch.current) { setView(result?.status === "ended" ? "ended" : liveCall.current ? "disconnected" : "idle"); setNotice(null); } }
    catch (error) { if (epoch === scopeEpoch.current) { setView("disconnected"); setNotice(error instanceof Error ? error.message : "End could not be confirmed. Check the original call."); } }
  }
  async function disconnect() {
    const epoch = scopeEpoch.current;
    ++operationEpoch.current; controller.current?.abort(); releaseCapture(); stopPlayback();
    await command("disconnect").catch(() => {});
    if (epoch === scopeEpoch.current && liveCall.current) { applyCall({ ...liveCall.current, status: "disconnected" }); setView("disconnected"); setNotice("Call paused. Resume when you are ready."); }
  }
  async function toggleMute() {
    const epoch = scopeEpoch.current;
    ++operationEpoch.current; controller.current?.abort(); stopPlayback(); releaseCapture();
    try {
      if (liveCall.current?.status === "muted") {
        await command("unmute");
        if (!recordingMode.current) {
          const captured = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          if (epoch !== scopeEpoch.current || !isListening()) { captured.getTracks().forEach(track => track.stop()); return; }
          startCapture(captured);
        }
        if (epoch === scopeEpoch.current) { setView("listening"); setNotice(readyNotice()); }
      } else { await command("mute"); if (epoch === scopeEpoch.current) { setView("muted"); setNotice("Call muted. Unmute when you are ready."); } }
    } catch (error) { if (epoch === scopeEpoch.current) { setView("error"); setNotice(error instanceof Error ? error.message : "Mute failed"); } }
  }
  useEffect(() => {
    const epoch = ++scopeEpoch.current;
    liveCall.current = null; intent.current = null; retryRecording.current = null; phaseRef.current = "idle";
    // Resource ownership changes immediately; publish its view after cleanup
    // and before the new server capability response can be applied.
    queueMicrotask(() => {
      if (epoch !== scopeEpoch.current) return;
      setQuote(null); setCall(null); setOtherCallSessionId(null); setView("idle"); void refresh();
    });
    return () => {
      scopeEpoch.current += 1; operationEpoch.current += 1; controller.current?.abort(); releaseCapture(); stopPlayback();
    };
    // The call's resources belong to one authenticated conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.sessionPath, options.ownerScope, options.enabled]);
  function lose(notice: string) {
    ++operationEpoch.current; controller.current?.abort(); releaseCapture(); stopPlayback();
    if (liveCall.current) applyCall({ ...liveCall.current, status: "disconnected" });
    setView("disconnected"); setNotice(notice);
  }
  useEffect(() => {
    // INVARIANT: a transient heartbeat failure is retried on the next tick
    // (about three tries per lease); the call is only shown as lost once the
    // server lease has certainly lapsed, or the server definitely refused it.
    const lapsed = "Connection lost. Resume the call to continue; a reply in progress is kept.";
    const heartbeat = setInterval(() => {
      if (!liveCall.current || !["active", "muted"].includes(liveCall.current.status) || !liveCall.current.leaseToken) return;
      if (document.visibilityState !== "visible") { void disconnect(); return; }
      if (Date.now() - leaseRenewedAt.current >= LEASE_MS) { lose(lapsed); return; }
      const epoch = scopeEpoch.current;
      void command("heartbeat").then(result => { if (result && !["active", "muted"].includes(result.status)) { ++operationEpoch.current; controller.current?.abort(); releaseCapture(); stopPlayback(); setView(result.status === "ended" ? "ended" : "disconnected"); } })
        .catch(error => {
          if (epoch !== scopeEpoch.current || !liveCall.current || !["active", "muted"].includes(liveCall.current.status)) return;
          if (!transient(error)) lose(error instanceof Error ? error.message : lapsed);
          else if (Date.now() - leaseRenewedAt.current >= LEASE_MS) lose(lapsed);
        });
    }, 4000);
    const hidden = () => { if (document.visibilityState !== "visible" && liveCall.current?.status !== "ended") void disconnect(); };
    const leaving = () => {
      ++operationEpoch.current; controller.current?.abort(); releaseCapture(); stopPlayback();
      if (liveCall.current) void fetch(`${latest.current.sessionPath}/voice-call/${liveCall.current.id}/end`, { method: "POST", headers: headers(), keepalive: true });
    };
    document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", leaving);
    return () => { clearInterval(heartbeat); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", leaving); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { phase, call, quote, available, balance, otherCallSessionId, notice, microphoneActive, microphonePaused,
    canRetryOriginal: Boolean(retryRecording.current && retryRecording.current.expiresAt > Date.now()),
    prepare, connect, end, interrupt, toggleMute, refresh,
    finishSentence: () => { if (latest.current.ownerScope === options.ownerScope && latest.current.sessionPath === options.sessionPath && liveCall.current?.id === call?.id) microphoneClip.current?.send(); },
    discardSentence: () => { if (latest.current.ownerScope === options.ownerScope && latest.current.sessionPath === options.sessionPath && liveCall.current?.id === call?.id) microphoneClip.current?.discard?.(); },
    cancelQuote: () => { ++operationEpoch.current; setQuote(null); intent.current = null; setView("idle"); },
    resume: (useMicrophone = true) => connect(useMicrophone, true),
    submitRecording: (blob: Blob) => { if (blob.size <= 8 * 1024 * 1024) void processRecording(blob); else setNotice("Keep recordings below 8 MiB and one minute."); },
    retry: () => { const pending = retryRecording.current; if (pending && pending.expiresAt > Date.now()) void processRecording(null, pending.id); else setNotice("This recording expired. Speak again or end the call."); },
    active: Boolean(call && call.status !== "ended"),
  };
}
export type VoiceCallController = ReturnType<typeof useVoiceCall>;
