"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { videoSequenceRequestSchema, videoSequenceCapabilitiesSchema, videoSequenceQuoteSchema, videoSequenceDtoSchema,
  type VideoSequenceRequest, type VideoSequenceQuote, type VideoSequenceDto } from "@idream/shared/contracts";

type Props = { viewerScope: string | null; characterId?: string; generationContextToken?: string; consistencyMode: "balanced" | "strict" | "creative"; seed?: string; disabled?: boolean; unavailableMessage?: string; onStatusChange?: () => void };
type Receipt = { key: string; request: VideoSequenceRequest; id: string | null };
class VideoRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }

// This receipt belongs to one authenticated viewer. Reload checks the original
// authority; it never replaces an uncertain submission with a fresh paid key.
export function VideoSequenceControls(props: Props) {
  const [scenes, setScenes] = useState<VideoSequenceRequest["scenes"]>([{ prompt: "", seconds: 5 }]);
  const [orientation, setOrientation] = useState<VideoSequenceRequest["orientation"]>("2:3");
  const [quality, setQuality] = useState<VideoSequenceRequest["quality"]>("standard");
  const [audio, setAudio] = useState<VideoSequenceRequest["audio"]>("generated");
  const [capabilities, setCapabilities] = useState<ReturnType<typeof videoSequenceCapabilitiesSchema.parse> | null>(null);
  const [quoted, setQuote] = useState<{ value: VideoSequenceQuote; draftKey: string } | null>(null);
  const [sequence, setSequence] = useState<VideoSequenceDto | null>(null);
  const [history, setHistory] = useState<VideoSequenceDto[]>([]);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const sequenceRead = useRef(0);
  const sequenceReadPending = useRef(false);
  const selectedSequenceId = useRef<string | null>(null);
  const receiptRef = useRef<Receipt | null>(null);
  const showSequence = useCallback((value: VideoSequenceDto) => {
    selectedSequenceId.current = value.id; sequenceRead.current += 1; sequenceReadPending.current = false; setSequence(value);
  }, []);
  const draftKey = JSON.stringify({ characterId: props.characterId, generationContextToken: props.generationContextToken, consistencyMode: props.consistencyMode, seed: props.seed, scenes, orientation, quality, audio });
  const currentDraft = useRef(draftKey);
  useLayoutEffect(() => { currentDraft.current = draftKey; }, [draftKey]);
  const quote = quoted?.draftKey === draftKey ? quoted.value : null;
  const storageKey = `idream:video-sequence:${props.viewerScope}`;
  const retainReceipt = useCallback((value: Receipt | null) => {
    receiptRef.current = value; setReceipt(value);
    try { if (value) localStorage.setItem(storageKey, JSON.stringify(value)); else localStorage.removeItem(storageKey); }
    catch { setError("Local recovery storage is unavailable. Keep this page open and use Check original request after a connection failure."); }
  }, [storageKey]);
  const api = useCallback(async (suffix: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (props.viewerScope) headers.set("x-idream-viewer-scope", props.viewerScope);
    if (init.body) headers.set("content-type", "application/json");
    const response = await fetch(`/api/v1/generation/video-sequences${suffix}`, { ...init, headers, cache: "no-store" });
    const value = await response.json();
    if (!response.ok || value.ok !== true) throw new VideoRequestError(value.error?.message ?? `Video request failed (${response.status})`, response.status);
    return value.data;
  }, [props.viewerScope]);
  const loadSequence = useCallback(async (id: string) => {
    if (receiptRef.current && receiptRef.current.id !== id) return;
    const ticket = epoch.current, read = ++sequenceRead.current;
    selectedSequenceId.current = id; sequenceReadPending.current = true;
    try {
      const value = videoSequenceDtoSchema.parse((await api(`/${encodeURIComponent(id)}`)).sequence);
      if (ticket !== epoch.current || read !== sequenceRead.current || selectedSequenceId.current !== id) return;
      showSequence(value);
      if (!["generating", "composing", "unknown"].includes(value.status)) retainReceipt(null);
    } catch (cause) {
      if (ticket === epoch.current && read === sequenceRead.current && selectedSequenceId.current === id) setError(cause instanceof Error ? cause.message : "Status disconnected. Check the original sequence.");
    }
    finally { if (ticket === epoch.current && read === sequenceRead.current) sequenceReadPending.current = false; }
  }, [api, retainReceipt, showSequence]);
  const refresh = useCallback(async () => {
    const ticket = epoch.current, read = sequenceRead.current;
    try {
      const [cap, list] = await Promise.allSettled([props.disabled ? Promise.resolve(null) : api("/capabilities"), api("")]);
      if (list.status === "rejected") throw list.reason;
      const options = cap.status === "fulfilled" && cap.value ? videoSequenceCapabilitiesSchema.parse(cap.value.capabilities) : null;
      const rows = list.value.sequences.map((row: unknown) => videoSequenceDtoSchema.parse(row)) as VideoSequenceDto[];
      if (ticket !== epoch.current) return;
      setCapabilities(options); setHistory(rows);
      if (!receiptRef.current && rows[0] && read === sequenceRead.current && (!selectedSequenceId.current || selectedSequenceId.current === rows[0].id)) showSequence(rows[0]);
      setError(cap.status === "rejected" ? cap.reason instanceof Error ? cap.reason.message : "Video settings could not load" : "");
    } catch (cause) { if (ticket === epoch.current) setError(cause instanceof Error ? cause.message : "Video status could not load"); }
  }, [api, props.disabled, showSequence]);
  const recoverOriginal = useCallback(async () => {
    const original = receiptRef.current;
    if (!original) return;
    const ticket = epoch.current, read = ++sequenceRead.current;
    selectedSequenceId.current = original.id ?? selectedSequenceId.current; sequenceReadPending.current = true; setBusy(true); setError("");
    try {
      const value = videoSequenceDtoSchema.parse((await api(original.id ? `/${original.id}` : `/request?${new URLSearchParams({ key: original.key })}`)).sequence);
      if (ticket !== epoch.current || read !== sequenceRead.current) return;
      retainReceipt({ ...original, id: value.id }); showSequence(value);
      if (!["generating", "composing", "unknown"].includes(value.status)) retainReceipt(null);
    } catch (cause) {
      if (ticket !== epoch.current || read !== sequenceRead.current) return;
      if (cause instanceof VideoRequestError && cause.status === 404) { retainReceipt(null); setQuote(null); setError("The original request was not accepted. Review a current price before creating the video."); }
      else setError(`${cause instanceof Error ? cause.message : "The original request is still unconfirmed"}. Keep its receipt and check again before submitting.`);
    }
    finally { if (ticket === epoch.current) { if (read === sequenceRead.current) sequenceReadPending.current = false; setBusy(false); } }
  }, [api, retainReceipt, showSequence]);
  useEffect(() => {
    const ticket = ++epoch.current;
    selectedSequenceId.current = null; sequenceRead.current += 1; sequenceReadPending.current = false;
    queueMicrotask(() => {
      if (ticket !== epoch.current || !props.viewerScope) return;
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const saved = JSON.parse(raw) as Receipt;
          if (typeof saved.key === "string" && saved.key.length >= 8 && (saved.id === null || typeof saved.id === "string")) {
            const request = videoSequenceRequestSchema.parse(saved.request); retainReceipt({ key: saved.key, id: saved.id, request });
            setScenes(request.scenes); setOrientation(request.orientation); setQuality(request.quality); setAudio(request.audio);
          }
        }
      } catch { setError("The saved video receipt could not be read. Check recent sequences before starting again."); }
      void refresh(); void recoverOriginal();
    });
    return () => { epoch.current += 1; };
  }, [props.viewerScope, storageKey, refresh, recoverOriginal, retainReceipt]);
  useEffect(() => {
    if (!sequence || !["generating", "composing", "unknown"].includes(sequence.status)) return;
    // A pending user selection owns the target before its response can render.
    const timer = setInterval(() => { if (!sequenceReadPending.current && selectedSequenceId.current === sequence.id) void loadSequence(sequence.id); }, 3000);
    return () => clearInterval(timer);
  }, [sequence, loadSequence]);

  // Admission, delivery and refunds change the surrounding balance and library.
  // Repeated polls of the same state must not keep refreshing that workspace.
  const statusKey = sequence ? JSON.stringify([sequence.id, sequence.status, sequence.cost, sequence.asset?.id,
    sequence.scenes.map(scene => [scene.job.id, scene.job.status, scene.assets.map(asset => asset.id)])]) : null;
  const onStatusChange = props.onStatusChange;
  useEffect(() => {
    if (statusKey) onStatusChange?.();
  }, [statusKey, onStatusChange]);

  const request = () => videoSequenceRequestSchema.parse({ characterId: props.characterId, generationContextToken: props.generationContextToken,
    consistencyMode: props.consistencyMode, seed: props.seed, scenes: scenes.map(scene => ({ ...scene, narration: audio === "narration" ? scene.narration : undefined })), orientation, quality, audio });
  const review = async () => {
    const ticket = epoch.current; const requestedDraft = currentDraft.current; setBusy(true); setError("");
    try {
      const value = videoSequenceQuoteSchema.parse((await api("/quote", { method: "POST", body: JSON.stringify(request()) })).quote);
      if (ticket === epoch.current && requestedDraft === currentDraft.current) setQuote({ value, draftKey: requestedDraft });
    }
    catch (cause) { if (ticket === epoch.current) setError(cause instanceof Error ? cause.message : "Video price could not load"); }
    finally { if (ticket === epoch.current) setBusy(false); }
  };
  const accept = async () => {
    if (!quote || receiptRef.current) return;
    if (quoted?.draftKey !== currentDraft.current) { setQuote(null); setError("The scene settings changed. Review their current price before accepting."); return; }
    const ticket = epoch.current;
    setBusy(true); setError("");
    try {
      const intent = { key: crypto.randomUUID(), request: { ...request(), quoteFingerprint: quote.fingerprint }, id: null };
      sequenceRead.current += 1; sequenceReadPending.current = false;
      retainReceipt(intent);
      const value = videoSequenceDtoSchema.parse((await api("", { method: "POST", headers: { "idempotency-key": intent.key }, body: JSON.stringify(intent.request) })).sequence);
      if (ticket !== epoch.current) return;
      retainReceipt({ ...intent, id: value.id }); showSequence(value); setQuote(null); void refresh();
    } catch (cause) {
      if (ticket !== epoch.current) return;
      setError(`${cause instanceof Error ? cause.message : "Submission disconnected"}. Check original request before accepting another quote.`);
      if (cause instanceof VideoRequestError) await recoverOriginal();
    }
    finally { if (ticket === epoch.current) setBusy(false); }
  };
  const action = async (name: "stop" | "retry-composition") => {
    if (!sequence || (receiptRef.current && receiptRef.current.id !== sequence.id)) return;
    const ticket = epoch.current; setBusy(true); setError("");
    try { const value = videoSequenceDtoSchema.parse((await api(`/${sequence.id}/${name}`, { method: "POST" })).sequence); if (ticket === epoch.current) { showSequence(value); if (name === "stop") retainReceipt(null); } }
    catch (cause) { if (ticket === epoch.current) setError(cause instanceof Error ? cause.message : "Check the original sequence before retrying this action"); }
    finally { if (ticket === epoch.current) setBusy(false); }
  };
  const locked = busy || Boolean(receipt) || props.disabled;
  const statusLocked = busy || Boolean(receipt && receipt.id !== sequence?.id);
  const inputClass = "mt-1 w-full rounded-lg bg-white/10 px-3 py-2 text-sm text-white disabled:opacity-50";
  return <section className="mt-4 space-y-4" aria-label="Video sequence">
    <p className="text-sm leading-6 text-white/70">Create up to three scenes from this character image, in order. Each completed scene keeps its own result and charge. If a scene fails or needs reconciliation, later scenes stop.</p>
    {capabilities ? <div className="grid grid-cols-3 gap-3 text-sm">
      <label>Aspect ratio<select className={inputClass} aria-label="Video aspect ratio" disabled={locked} value={orientation} onChange={event => setOrientation(event.target.value as VideoSequenceRequest["orientation"])}>{capabilities.options.orientations.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Resolution<select className={inputClass} aria-label="Video resolution" disabled={locked} value={quality} onChange={event => setQuality(event.target.value as VideoSequenceRequest["quality"])}>{capabilities.options.qualities.map(value => <option value={value} key={value}>{value === "preview" ? "Preview · 512px wide" : "Standard · 768px wide"}</option>)}</select></label>
      <label>Sound<select className={inputClass} aria-label="Video sound" disabled={locked} value={audio} onChange={event => setAudio(event.target.value as VideoSequenceRequest["audio"])}>{capabilities.audio.map(value => <option key={value} value={value}>{value === "narration" ? "English narration" : value === "silent" ? "Silent" : "Generated sound"}</option>)}</select></label>
    </div> : <p className="text-sm text-white/65">{props.disabled ? "Select an available character image to review video settings." : "Video settings are loading."} <button type="button" className="underline" onClick={() => void refresh()}>Reload settings</button></p>}
    {scenes.map((scene, ordinal) => <fieldset key={ordinal} className="rounded-xl border border-white/10 p-3" disabled={locked}>
      <legend className="px-1 text-sm font-bold">Scene {ordinal + 1}</legend>
      <label className="text-sm">Motion and setting<textarea className={inputClass} aria-label={`Scene ${ordinal + 1} prompt`} maxLength={2000} value={scene.prompt} onChange={event => setScenes(values => values.map((value, index) => index === ordinal ? { ...value, prompt: event.target.value } : value))} /></label>
      <label className="mt-3 block text-sm">Duration<select className={inputClass} aria-label={`Scene ${ordinal + 1} duration`} value={scene.seconds} onChange={event => setScenes(values => values.map((value, index) => index === ordinal ? { ...value, seconds: Number(event.target.value) as 3 | 5 } : value))}>{(capabilities?.options.seconds ?? [5]).map(value => <option key={value} value={value}>{value} seconds</option>)}</select></label>
      {audio === "narration" ? <label className="mt-3 block text-sm">English line<textarea className={inputClass} aria-label={`Scene ${ordinal + 1} narration`} maxLength={120} value={scene.narration ?? ""} onChange={event => setScenes(values => values.map((value, index) => index === ordinal ? { ...value, narration: event.target.value } : value))} /></label> : null}
      {scenes.length > 1 ? <button className="mt-2 text-sm underline" type="button" onClick={() => setScenes(values => values.filter((_, index) => index !== ordinal))}>Remove scene {ordinal + 1}</button> : null}
    </fieldset>)}
    {scenes.length < 3 ? <button className="text-sm underline disabled:opacity-50" disabled={locked} type="button" onClick={() => setScenes(values => [...values, { prompt: "", seconds: 5 }])}>Add scene</button> : null}
    {audio === "narration" ? <p className="text-sm leading-6 text-white/70">English system voice narration replaces generated sound. This is narration, without lip synchronization. If a line is longer than its scene, the final frame holds until the full line finishes.</p> : null}
    {props.unavailableMessage ? <p role="status" className="text-sm text-amber-200">{props.unavailableMessage}</p> : null}
    {!receipt ? <button className="rounded-full border border-white/30 px-4 py-2 text-sm font-bold disabled:opacity-50" type="button" disabled={busy || props.disabled || !props.characterId || !capabilities} onClick={() => void review()}>Review video price</button> : <button className="rounded-full border border-white/30 px-4 py-2 text-sm" type="button" disabled={busy} onClick={() => void recoverOriginal()}>Check original request</button>}
    {quote ? <div className="rounded-xl bg-white/5 p-4 text-sm" aria-label="Video price">
      {quote.scenes.map((scene, ordinal) => <p key={scene.ordinal}>Scene {ordinal + 1} · {scene.video.durationSeconds.toFixed(2)}s · {scene.video.width}×{scene.video.height} · {quote.costs[ordinal]?.costDreamcoins} coins</p>)}
      <p className="mt-2 font-bold">Total {quote.costDreamcoins} coins · balance {quote.balance}</p>
      <p className="mt-2 text-white/70">Unexecuted scenes are refunded. Delivered scenes retain their charge. Packaging retries cost no additional coins.{quote.narrationExtendsLastFrame ? " Narration is included; a longer line extends the final frame until it finishes." : ""}</p>
      <button type="button" className="mt-3 rounded-full bg-white px-4 py-2 font-bold text-black disabled:opacity-50" disabled={locked || quote.balance < quote.costDreamcoins} onClick={() => void accept()}>Accept {quote.costDreamcoins} coins & create video</button>
    </div> : null}
    {error ? <p role="alert" className="text-sm text-amber-200">{error}</p> : null}
    {history.length > 1 ? <label className="block text-sm">Recent sequences<select className={inputClass} aria-label="Recent video sequences" value={sequence?.id ?? ""} disabled={busy || Boolean(receipt)} onChange={event => void loadSequence(event.target.value)}>{history.map(value => <option key={value.id} value={value.id}>{new Date(value.createdAt).toLocaleString()} · {value.status} · {value.cost.finalCharge} coins</option>)}</select></label> : null}
    {sequence ? <div className="space-y-2 rounded-xl border border-white/10 p-4 text-sm" aria-label="Video sequence status">
      <p role="status">Sequence {sequence.status} · reserved {sequence.cost.charged} · refunded {sequence.cost.refunded} · final charge {sequence.cost.finalCharge} coins</p>
      {sequence.scenes.map(scene => <p key={scene.ordinal}>Scene {scene.ordinal + 1}: {scene.job.status} · {scene.job.cost.finalCharge} coins {scene.assets.map(asset => <a key={asset.id} href={asset.downloadUrl} className="ml-2 underline">Download scene {scene.ordinal + 1}</a>)}</p>)}
      {sequence.asset ? <><video controls playsInline className="max-h-96 w-full rounded-lg" src={sequence.asset.url} /><a className="block underline" href={sequence.asset.downloadUrl}>Download complete video</a></> : null}
      {sequence.status === "unknown" ? <p className="text-amber-200">A provider result needs reconciliation. Later scenes stopped; this request will not call that provider again automatically.</p> : null}
      {sequence.status === "failed" || sequence.status === "cancelled" ? <p className="text-white/65">Keep any completed scenes above. Unexecuted scenes have been stopped; review a new quote for any remaining work.</p> : null}
      {sequence.status === "composition_failed" ? <button className="underline" type="button" disabled={statusLocked} onClick={() => void action("retry-composition")}>Retry packaging · no model requests or extra coins</button> : null}
      {["generating", "composing", "unknown"].includes(sequence.status) ? <button className="underline" type="button" disabled={statusLocked} onClick={() => void action("stop")}>Stop remaining scenes</button> : null}
      <button className="ml-3 underline" type="button" disabled={statusLocked} onClick={() => void loadSequence(sequence.id)}>Refresh sequence</button>
    </div> : null}
  </section>;
}
