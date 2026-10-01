"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  voiceInputCapabilitySchema,
  voiceInputResultSchema,
  VOICE_INPUT_MAX_DURATION_MS,
  VOICE_INPUT_MAX_UPLOAD_BYTES,
  VOICE_INPUT_RESULT_TTL_MS,
  type VoiceInputCapability,
  type VoiceInputResult,
} from "@idream/shared/contracts";

export type VoiceInputPhase = "idle" | "requesting" | "recording" | "interrupted" | "transcribing" | "review" | "error";
type Options = {
  sessionPath: string;
  ownerScope: string | null;
  enabled: boolean;
  recipientId: string | null;
  draft: string;
  onDraft: (text: string) => void;
  beforeRecording: () => void;
};
type Recording = {
  generation: number;
  requestId: string;
  sessionPath: string;
  ownerScope: string;
  recipientId: string | null;
  draft: string;
  draftRevision: number;
  blob?: Blob;
  posted: boolean;
  controller?: AbortController;
  interrupted: boolean;
  startedAt: number;
};
type View = {
  phase: VoiceInputPhase;
  elapsedMs: number;
  volume: number;
  notice: string | null;
  candidate: string | null;
  canRetry: boolean;
};
const initialView: View = { phase: "idle", elapsedMs: 0, volume: 0, notice: null, candidate: null, canRetry: false };
function scopeHeaders(ownerScope: string, recipientId: string | null) {
  return { "x-idream-viewer-scope": ownerScope, ...(recipientId ? { "x-idream-voice-character-id": recipientId } : {}) };
}

const FORMATS = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];

export function appendVoiceText(draft: string, transcript: string): string {
  return draft ? `${draft}${/\s$/.test(draft) ? "" : " "}${transcript}` : transcript;
}

function failureCopy(code: string): string {
  if (code === "no_speech") return "No speech was detected. Try again or type your message.";
  if (code === "duration_exceeded" || code === "audio_too_long") return "Keep your recording under one minute and try again.";
  if (code === "upload_too_large" || code === "audio_too_large") return "Your recording is too large. Record a shorter message.";
  if (code === "invalid_audio") return "Couldn't read this recording. Please record it again.";
  if (code === "rate_limited" || code === "user_busy" || code === "queue_full") return "Voice input is busy. Wait a moment, then try again.";
  return "Couldn't transcribe your recording. Retry or keep typing.";
}

async function readResult(response: Response, requestId: string): Promise<VoiceInputResult> {
  const payload = await response.json();
  if (!response.ok) {
    const error = payload?.error;
    const code = error?.details?.errorCode ?? payload?.details?.errorCode ?? (typeof error === "string" ? error : error?.code);
    throw new Error(typeof code === "string" ? code : "unavailable");
  }
  const result = voiceInputResultSchema.parse(payload.data);
  if (result.requestId !== requestId) throw new Error("invalid_response");
  return result;
}

// INTENT: Recording resources and their late callbacks belong to one viewer /
// conversation generation. A late permission or transcript can never cross it.
export function useVoiceInput(options: Options) {
  const [view, setView] = useState<View>(initialView);
  const [capability, setCapability] = useState<VoiceInputCapability | null>(null);
  const [undo, setUndo] = useState<{ before: string; after: string; revision: number } | null>(null);
  const latest = useRef(options);
  const draftRevision = useRef(0);
  const previousDraft = useRef(options.draft);
  const generation = useRef(0);
  const active = useRef<Recording | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const clock = useRef<ReturnType<typeof setInterval> | null>(null);
  const retention = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const capabilityRecipient = useRef<string | null | undefined>(undefined);
  const previousRecipient = useRef(options.recipientId);

  useEffect(() => {
    latest.current = options;
    if (previousDraft.current !== options.draft) {
      previousDraft.current = options.draft;
      draftRevision.current += 1;
      setUndo(current => current && current.revision === draftRevision.current && current.after === options.draft ? current : null);
    }
  }, [options]);

  const alive = useCallback((operation: Recording) => mounted.current && active.current === operation && operation.generation === generation.current, []);
  const releaseCapture = useCallback(() => {
    if (clock.current !== null) clearInterval(clock.current);
    clock.current = null;
    const recording = recorder.current;
    recorder.current = null;
    if (recording) {
      recording.ondataavailable = null;
      recording.onstop = null;
      recording.onerror = null;
      if (recording.state !== "inactive") recording.stop();
    }
    stream.current?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    stream.current = null;
    const context = audioContext.current;
    audioContext.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }, []);

  const discardRemote = useCallback((operation: Recording) => {
    if (!operation.posted) return;
    // Best effort: local delivery is already revoked; server deadline / TTL is
    // the cleanup bound if the network cannot carry this cancellation.
    void fetch(`${operation.sessionPath}/transcriptions/${operation.requestId}`, {
      method: "DELETE", headers: scopeHeaders(operation.ownerScope, operation.recipientId),
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  const cancel = useCallback(() => {
    generation.current += 1;
    const operation = active.current;
    active.current = null;
    operation?.controller?.abort();
    if (operation) { discardRemote(operation); operation.blob = undefined; }
    if (retention.current !== null) clearTimeout(retention.current);
    retention.current = null;
    releaseCapture();
    if (mounted.current) setView(initialView);
  }, [discardRemote, releaseCapture]);

  const fetchCapability = useCallback(async (signal?: AbortSignal) => {
    const { sessionPath, ownerScope, enabled, recipientId } = latest.current;
    if (!enabled || !ownerScope) return;
    try {
      const response = await fetch(`${sessionPath}/voice-input`, {
        headers: scopeHeaders(ownerScope, recipientId), signal, cache: "no-store",
      });
      if (!response.ok) throw new Error("unavailable");
      const value = voiceInputCapabilitySchema.parse((await response.json()).data);
      if (signal?.aborted || !mounted.current || latest.current.sessionPath !== sessionPath || latest.current.ownerScope !== ownerScope || latest.current.recipientId !== recipientId) return;
      if (value.ownerScope !== ownerScope) throw new Error("viewer_changed");
      capabilityRecipient.current = recipientId;
      setCapability(value);
    } catch {
      if (signal?.aborted || !mounted.current || latest.current.sessionPath !== sessionPath || latest.current.ownerScope !== ownerScope || latest.current.recipientId !== recipientId) return;
      setCapability(current => current ? { ...current, available: false, reason: "unavailable" } : null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    cancel();
    capabilityRecipient.current = undefined;
    const controller = new AbortController();
    // Scope teardown revokes capture synchronously; presentation resets before
    // the asynchronous capability response can become visible.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setCapability(null);
      setUndo(null);
      void fetchCapability(controller.signal);
    });
    return () => { controller.abort(); cancel(); };
  }, [options.sessionPath, options.ownerScope, options.enabled, cancel, fetchCapability]);

  useEffect(() => () => { mounted.current = false; cancel(); }, [cancel]);

  const fail = useCallback((operation: Recording, code: string) => {
    if (!alive(operation)) return;
    setView(current => ({ ...current, phase: "error", volume: 0, candidate: null, notice: failureCopy(code), canRetry: Boolean(operation.blob) && !["invalid_audio", "duration_exceeded", "upload_too_large", "audio_too_long", "audio_too_large", "no_speech"].includes(code) }));
  }, [alive]);

  const deliver = useCallback((operation: Recording, result: VoiceInputResult) => {
    if (!alive(operation)) return;
    if (result.status === "failed") { fail(operation, result.errorCode); return; }
    if (result.status === "cancelled") { cancel(); return; }
    if (result.status !== "completed") return;
    discardRemote(operation);
    operation.blob = undefined;
    if (retention.current !== null) clearTimeout(retention.current);
    retention.current = null;
    const current = latest.current;
    if (draftRevision.current !== operation.draftRevision || current.recipientId !== operation.recipientId) {
      setView(previous => ({ ...previous, phase: "review", candidate: result.text, notice: "Your draft or recipient changed. Review the voice text before adding it.", canRetry: false }));
      return;
    }
    const text = appendVoiceText(current.draft, result.text);
    setUndo({ before: current.draft, after: text, revision: draftRevision.current + 1 });
    current.onDraft(text);
    active.current = null;
    setView({ ...initialView, notice: "Voice text added. Review before sending." });
  }, [alive, cancel, discardRemote, fail]);

  const transcribe = useCallback(async (operation: Recording, retry = false) => {
    if (!alive(operation) || !operation.blob) return;
    setView(current => ({ ...current, phase: "transcribing", volume: 0, notice: "Transcribing…", canRetry: false }));
    const controller = new AbortController();
    operation.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 55_000);
    const headers = scopeHeaders(operation.ownerScope, operation.recipientId);
    try {
      let result: VoiceInputResult | undefined;
      if (retry && operation.posted) {
        const previous = await fetch(`${operation.sessionPath}/transcriptions/${operation.requestId}`, { headers, signal: controller.signal, cache: "no-store" });
        if (previous.ok) result = await readResult(previous, operation.requestId);
        else if (![404, 410].includes(previous.status)) await readResult(previous, operation.requestId);
        if (!result || result.status === "failed" || result.status === "cancelled") {
          discardRemote(operation);
          operation.requestId = crypto.randomUUID();
          operation.posted = false;
          result = undefined;
        }
      }
      if (!result) {
        const body = new FormData();
        body.append("audio", operation.blob, "recording");
        operation.posted = true;
        try {
          const response = await fetch(`${operation.sessionPath}/transcriptions`, {
            method: "POST", headers: { ...headers, "idempotency-key": operation.requestId }, body, signal: controller.signal,
          });
          result = await readResult(response, operation.requestId);
        } catch (error) {
          if (!alive(operation) || controller.signal.aborted) throw error;
          // A lost POST response does not authorize another inference.
          const response = await fetch(`${operation.sessionPath}/transcriptions/${operation.requestId}`, { headers, signal: controller.signal, cache: "no-store" });
          if (!response.ok) throw error;
          result = await readResult(response, operation.requestId);
        }
      }
      while (result.status === "pending" && alive(operation)) {
        const retryAfterMs = result.retryAfterMs;
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(new Error("cancelled")); };
          const timer = setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, Math.min(2_000, Math.max(100, retryAfterMs)));
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        const response = await fetch(`${operation.sessionPath}/transcriptions/${operation.requestId}`, { headers, signal: controller.signal, cache: "no-store" });
        result = await readResult(response, operation.requestId);
      }
      deliver(operation, result);
    } catch (error) {
      fail(operation, error instanceof Error ? error.message : "unavailable");
    } finally {
      clearTimeout(timeout);
      if (operation.controller === controller) operation.controller = undefined;
    }
  }, [alive, deliver, discardRemote, fail]);

  const finish = useCallback((interrupted = false) => {
    const operation = active.current;
    const recording = recorder.current;
    if (!operation || !recording || recording.state === "inactive") return;
    operation.interrupted = interrupted;
    if (clock.current !== null) clearInterval(clock.current);
    clock.current = null;
    recording.stop();
    stream.current?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    stream.current = null;
    const context = audioContext.current;
    audioContext.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }, []);

  const start = useCallback(async () => {
    const current = latest.current;
    if (!current.enabled || !current.ownerScope || !capability?.supported || !capability.available || capabilityRecipient.current !== current.recipientId) return;
    cancel();
    setUndo(null);
    current.beforeRecording();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setView({ ...initialView, phase: "error", notice: "Voice input needs a secure connection and a browser that supports microphone recording." });
      return;
    }
    const mimeType = FORMATS.find(format => MediaRecorder.isTypeSupported(format));
    if (!mimeType) {
      setView({ ...initialView, phase: "error", notice: "This browser can't record a supported audio format. You can keep typing." });
      return;
    }
    const operation: Recording = {
      generation: generation.current, requestId: crypto.randomUUID(), sessionPath: current.sessionPath,
      ownerScope: current.ownerScope, recipientId: current.recipientId, draft: current.draft,
      draftRevision: draftRevision.current, posted: false, interrupted: false, startedAt: 0,
    };
    active.current = operation;
    setView({ ...initialView, phase: "requesting", notice: "Allow microphone access to start recording." });
    try {
      const captured = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true } });
      if (!alive(operation)) { captured.getTracks().forEach(track => track.stop()); return; }
      stream.current = captured;
      const recording = new MediaRecorder(captured, { mimeType });
      recorder.current = recording;
      const chunks: Blob[] = [];
      let bytes = 0;
      recording.ondataavailable = event => {
        if (!alive(operation) || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > VOICE_INPUT_MAX_UPLOAD_BYTES) { cancel(); setView({ ...initialView, phase: "error", notice: failureCopy("upload_too_large") }); return; }
        chunks.push(event.data);
      };
      recording.onerror = () => { cancel(); setView({ ...initialView, phase: "error", notice: "Recording was interrupted. Please record your message again." }); };
      recording.onstop = () => {
        if (!alive(operation)) return;
        recorder.current = null;
        operation.blob = new Blob(chunks, { type: recording.mimeType || mimeType });
        chunks.length = 0;
        if (!operation.blob.size) { fail(operation, "no_speech"); return; }
        retention.current = setTimeout(() => {
          if (!alive(operation)) return;
          cancel();
          setView({ ...initialView, notice: "The recording expired. Record again or keep typing." });
        }, VOICE_INPUT_RESULT_TTL_MS);
        if (operation.interrupted) setView(previous => ({ ...previous, phase: "interrupted", volume: 0, notice: "Recording stopped. Transcribe this clip?" }));
        else void transcribe(operation);
      };
      captured.getTracks().forEach(track => { track.onended = () => finish(true); });
      operation.startedAt = Date.now();
      recording.start(250);
      setView({ ...initialView, phase: "recording", notice: "Listening…" });
      let analyser: AnalyserNode | null = null;
      let samples: Float32Array<ArrayBuffer> | null = null;
      try {
        if (typeof AudioContext !== "undefined") {
          const context = new AudioContext();
          audioContext.current = context;
          analyser = context.createAnalyser();
          analyser.fftSize = 256;
          context.createMediaStreamSource(captured).connect(analyser);
          samples = new Float32Array(analyser.fftSize);
        }
      } catch { /* Level feedback is optional; recording does not depend on it. */ }
      clock.current = setInterval(() => {
        if (!alive(operation)) return;
        const elapsedMs = Math.min(VOICE_INPUT_MAX_DURATION_MS, Date.now() - operation.startedAt);
        let volume = 0;
        if (analyser && samples) {
          analyser.getFloatTimeDomainData(samples);
          volume = Math.min(1, Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length) * 6);
        }
        setView(previous => ({ ...previous, elapsedMs, volume, notice: elapsedMs >= 55_000 ? "Recording ends in a few seconds…" : "Listening…" }));
        // Encoder padding and stop-event scheduling must fit inside the server
        // decoded 60-second bound; leave 500 ms rather than truncating audio.
        if (elapsedMs >= VOICE_INPUT_MAX_DURATION_MS - 500) finish();
      }, 100);
    } catch (error) {
      if (!alive(operation)) return;
      releaseCapture();
      const code = error instanceof Error ? error.name : "";
      setView({ ...initialView, phase: "error", notice: code === "NotAllowedError" ? "Microphone access is blocked. Enable it in your browser settings, or keep typing." : "Couldn't access your microphone. Check your device and try again." });
    }
  }, [alive, cancel, capability, fail, finish, releaseCapture, transcribe]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) finish(true); };
    const onPageHide = () => cancel();
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && active.current) { event.preventDefault(); cancel(); } };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("keydown", onEscape);
    };
  }, [cancel, finish]);

  useEffect(() => {
    const changed = previousRecipient.current !== options.recipientId;
    previousRecipient.current = options.recipientId;
    const controller = new AbortController();
    if (changed) void fetchCapability(controller.signal);
    const operation = active.current;
    if (operation && operation.recipientId !== options.recipientId) {
      if (recorder.current) finish(true);
      else if (!operation.blob && !operation.posted) cancel();
    }
    return () => controller.abort();
  }, [options.recipientId, cancel, finish, fetchCapability]);

  const addCandidate = () => {
    if (!view.candidate || !active.current) return;
    const current = latest.current;
    const text = appendVoiceText(current.draft, view.candidate);
    setUndo({ before: current.draft, after: text, revision: draftRevision.current + 1 });
    current.onDraft(text);
    active.current = null;
    setView({ ...initialView, notice: "Voice text added. Review before sending." });
  };
  const canUndo = undo !== null && options.draft === undo.after;
  return {
    ...view, capability, start, finish: () => finish(), cancel, addCandidate,
    refreshCapability: () => void fetchCapability(),
    retry: () => { const operation = active.current; if (operation) void transcribe(operation, true); },
    transcribeClip: () => { const operation = active.current; if (operation) void transcribe(operation); },
    blocksSend: ["requesting", "recording", "interrupted", "transcribing", "review"].includes(view.phase),
    readOnly: view.phase === "requesting" || view.phase === "recording",
    canUndo,
    undo: () => { if (canUndo && undo && draftRevision.current === undo.revision) { latest.current.onDraft(undo.before); setUndo(null); setView(initialView); } },
  };
}

export type VoiceInputController = ReturnType<typeof useVoiceInput>;
