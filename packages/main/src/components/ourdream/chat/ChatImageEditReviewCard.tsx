"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Brush, Eraser, Hand, Loader2, Undo2, Wand2, X } from "lucide-react";
import { z } from "zod";
import { imageEditOperationSchema, type ImageEditOperation } from "@idream/shared/chat/image-action";
import { recolorRgba } from "@idream/shared/media/image-recolor";
import { apiPayloadErrorMessage } from "@/lib/generation-write-client";
import { parseChatImageEditReviewResponse, type ChatImageEditReview } from "@/lib/public-api-contracts";
import { imagePoint, maskFromRgba, maskRgba, paintMask, selectConnectedColor, type MaskPoint } from "./image-edit-mask";

type ViewerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type PendingConfirmation = { key: string; body: string };
const storedDraftSchema = z.object({
  sourceSha256: z.string(), draftFingerprint: z.string(), attempt: z.number(),
  maskPngBase64: z.string().max(699_052), operation: imageEditOperationSchema.nullable(),
  pending: z.object({ key: z.string(), body: z.string().max(710_000) }).nullable(),
});
const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/20 px-3 text-sm font-semibold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-40";

export function ChatImageEditReviewCard({ attachmentId, ownerScope, fetchForViewer, onChanged }: {
  attachmentId: string; ownerScope: string | null; fetchForViewer: ViewerFetch; onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return <div className="w-full max-w-[300px] rounded-xl border border-white/15 bg-black/20 p-3" data-testid="chat-image-edit-review-card">
    <p className="text-sm font-bold">Choose what changes</p>
    <p className="mt-1 text-xs leading-5 text-white/75">Review the image and mark the area to edit. Nothing runs or costs coins until you confirm.</p>
    <button type="button" className={`${control} mt-3 w-full bg-white text-[rgb(13,13,13)] hover:bg-white/90`} disabled={!ownerScope} onClick={() => setOpen(true)}>Review edit area</button>
    {open && ownerScope ? createPortal(<ImageEditDialog key={`${ownerScope}:${attachmentId}`} attachmentId={attachmentId} ownerScope={ownerScope} fetchForViewer={fetchForViewer} onChanged={onChanged} onClose={() => setOpen(false)} />, document.body) : null}
  </div>;
}

async function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("The image could not be opened. Try loading it again.")); image.src = url; });
  return image;
}
function imagePixels(image: HTMLImageElement, width: number, height: number): ImageData {
  if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error("The image dimensions changed. Reload this review.");
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Image editing is unavailable in this browser.");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, width, height);
}
function encodeMask(mask: Uint8Array, width: number, height: number): string {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The selection could not be saved in this browser.");
  context.putImageData(new ImageData(maskRgba(mask), width, height), 0, 0);
  return canvas.toDataURL("image/png").split(",")[1]!;
}
async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
}

function ImageEditDialog({ attachmentId, ownerScope, fetchForViewer, onChanged, onClose }: {
  attachmentId: string; ownerScope: string; fetchForViewer: ViewerFetch; onChanged: () => Promise<void>; onClose: () => void;
}) {
  const id = useId();
  const endpoint = `/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/edit-review`;
  const storageKey = `idream:chat-image-edit:${ownerScope}:${attachmentId}`;
  const [review, setReview] = useState<ChatImageEditReview | null>(null);
  const [source, setSource] = useState<ImageData | null>(null);
  const [operation, setOperation] = useState<ImageEditOperation | null>(null);
  const [tool, setTool] = useState<"paint" | "erase" | "color" | "pan">("paint");
  const [view, setView] = useState<"selection" | "original" | "preview">("selection");
  const [brush, setBrush] = useState(20);
  const [tolerance, setTolerance] = useState(24);
  const [zoom, setZoom] = useState(1);
  const [revision, setRevision] = useState(0);
  const [selectionStats, setSelectionStats] = useState({ count: 0, undo: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [reload, setReload] = useState(0);
  const [keyboardPoint, setKeyboardPoint] = useState<MaskPoint | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef(new Uint8Array(0));
  const undoRef = useRef<Uint8Array<ArrayBuffer>[]>([]);
  const strokeRef = useRef<{ point: MaskPoint; client: MaskPoint } | null>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const closeAction = useRef(onClose);
  const changedAction = useRef(onChanged);
  useEffect(() => { closeAction.current = onClose; changedAction.current = onChanged; }, [onClose, onChanged]);

  useEffect(() => {
    alive.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; closeRef.current?.focus();
    function keydown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); closeAction.current(); }
      if (event.key !== "Tab") return;
      const nodes = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])];
      const first = nodes[0]; const last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { alive.current = false; document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); previousFocus?.focus(); };
  }, []);

  useEffect(() => {
    const abort = new AbortController(); let active = true;
    const headers = { "x-idream-viewer-scope": ownerScope };
    void (async () => {
      setLoading(true); setError(""); setSource(null); setReview(null);
      try {
        const response = await fetchForViewer(endpoint, { headers, cache: "no-store", signal: abort.signal });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          if (response.status === 409 || response.status === 404) await changedAction.current();
          throw new Error(apiPayloadErrorMessage(payload) ?? "This edit could not be loaded. Refresh the chat and try again.");
        }
        const next = parseChatImageEditReviewResponse(payload);
        if (next.attachmentId !== attachmentId || next.source.width * next.source.height > next.limits.maxPixels) throw new Error("The original image could not be verified.");
        if (!active) return;
        // The owner can discard a draft even when its source was removed or
        // access was revoked. Pixels are required for editing, not cancelling.
        setReview(next);
        const imageResponse = await fetchForViewer(next.source.url, { headers, cache: "no-store", signal: abort.signal });
        if (!imageResponse.ok) throw new Error(imageResponse.status === 404 || imageResponse.status === 410
          ? "The original image is no longer available. You can cancel this edit and choose another image."
          : "The original image could not be loaded. Try again.");
        const bytes = await imageResponse.arrayBuffer();
        if (await sha256(bytes) !== next.source.sha256) throw new Error("The original image changed. Reload this review.");
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        let pixels: ImageData;
        try { pixels = imagePixels(await decodeImage(url), next.source.width, next.source.height); }
        finally { URL.revokeObjectURL(url); }
        let mask = new Uint8Array(next.source.width * next.source.height);
        let savedOperation: ImageEditOperation | null = null; let savedPending: PendingConfirmation | null = null;
        try {
          const raw = window.localStorage.getItem(storageKey);
          const saved = raw ? storedDraftSchema.parse(JSON.parse(raw)) : null;
          if (saved && saved.sourceSha256 === next.source.sha256 && saved.draftFingerprint === next.draftFingerprint) {
            const image = await decodeImage(`data:image/png;base64,${saved.maskPngBase64}`);
            mask = maskFromRgba(imagePixels(image, next.source.width, next.source.height).data, next.source.width, next.source.height);
            savedOperation = saved.operation;
            if (saved.attempt === next.attempt) savedPending = saved.pending;
          }
        } catch { if (active) setWarning("Your saved selection could not be restored. Mark the area again."); }
        if (!active) return;
        maskRef.current = mask; undoRef.current = [];
        setSelectionStats({ count: mask.reduce((count, value) => count + Number(value === 255), 0), undo: 0 });
        setSource(pixels); setReview(next); setOperation(savedOperation); setPending(savedPending);
        setKeyboardPoint({ x: Math.floor(next.source.width / 2), y: Math.floor(next.source.height / 2) });
        setRevision(value => value + 1);
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : "The edit could not be loaded. Try again.");
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; abort.abort(); };
  }, [endpoint, attachmentId, ownerScope, storageKey, fetchForViewer, reload]);

  const selectedCount = selectionStats.count;
  const quote = operation ? review?.quotes[operation.kind] : null;
  const locked = busy || Boolean(pending);

  useEffect(() => {
    if (!source) return;
    const context = canvasRef.current?.getContext("2d"); if (!context) return;
    const pixels = view === "preview" && operation?.kind === "recolor"
      ? new Uint8ClampedArray(recolorRgba({ pixels: new Uint8Array(source.data), mask: maskRef.current, color: operation.color }))
      : new Uint8ClampedArray(source.data);
    if (view === "selection") {
      for (let index = 0; index < maskRef.current.length; index++) {
        if (!maskRef.current[index]) continue;
        const offset = index * 4;
        pixels[offset] = Math.round(pixels[offset]! * 0.45 + 255 * 0.55);
        pixels[offset + 1] = Math.round(pixels[offset + 1]! * 0.45 + 30 * 0.55);
        pixels[offset + 2] = Math.round(pixels[offset + 2]! * 0.45 + 155 * 0.55);
        pixels[offset + 3] = 255;
      }
    }
    context.putImageData(new ImageData(pixels, source.width, source.height), 0, 0);
    if (keyboardPoint && document.activeElement === canvasRef.current && view === "selection" && tool !== "pan") {
      context.beginPath(); context.arc(keyboardPoint.x, keyboardPoint.y, tool === "color" ? 3 : brush / 2, 0, Math.PI * 2);
      if (tool === "color") {
        context.moveTo(keyboardPoint.x - 8, keyboardPoint.y); context.lineTo(keyboardPoint.x + 8, keyboardPoint.y);
        context.moveTo(keyboardPoint.x, keyboardPoint.y - 8); context.lineTo(keyboardPoint.x, keyboardPoint.y + 8);
      }
      context.strokeStyle = "#fff"; context.lineWidth = 2; context.stroke();
      context.strokeStyle = "#111"; context.lineWidth = 1; context.stroke();
    }
  }, [source, view, operation, revision, keyboardPoint, brush, tool]);

  function saveDraft(nextOperation = operation, nextPending = pending): boolean {
    if (!review || !source) return false;
    try {
      const png = encodeMask(maskRef.current, source.width, source.height);
      if (Math.ceil(png.length * 3 / 4) > review.limits.maskMaxBytes) throw new Error("This selection is too complex to save. Simplify its edges and try again.");
      window.localStorage.setItem(storageKey, JSON.stringify({ sourceSha256: review.source.sha256, draftFingerprint: review.draftFingerprint, attempt: review.attempt, maskPngBase64: png, operation: nextOperation, pending: nextPending }));
      setWarning(""); return true;
    } catch (failure) {
      setWarning(failure instanceof Error && failure.message.includes("selection is") ? failure.message : "This browser could not save your selection. Keep this window open and enable site storage before confirming.");
      return false;
    }
  }
  function checkpoint() {
    undoRef.current.push(new Uint8Array(maskRef.current));
    // At the largest admitted image, history is bounded to 32 MiB.
    if (undoRef.current.length > 8) undoRef.current.shift();
  }
  function refreshMask() {
    setSelectionStats({ count: maskRef.current.reduce((count, value) => count + Number(value === 255), 0), undo: undoRef.current.length });
    setRevision(value => value + 1);
  }
  function finishStroke() {
    if (!strokeRef.current) return;
    strokeRef.current = null; saveDraft();
  }
  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (!source || locked || (view !== "selection" && tool !== "pan")) return;
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    const point = imagePoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), source.width, source.height);
    strokeRef.current = { point, client: { x: event.clientX, y: event.clientY } };
    if (tool === "pan") return;
    checkpoint();
    if (tool === "color") selectConnectedColor(maskRef.current, new Uint8Array(source.data), source.width, source.height, point, tolerance);
    else paintMask(maskRef.current, source.width, source.height, point, point, brush / 2, tool === "erase" ? 0 : 255);
    setKeyboardPoint(null); refreshMask();
  }
  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const stroke = strokeRef.current; if (!stroke || !source) return;
    if (tool === "pan") {
      scrollerRef.current?.scrollBy(stroke.client.x - event.clientX, stroke.client.y - event.clientY);
      stroke.client = { x: event.clientX, y: event.clientY }; return;
    }
    if (tool === "color") return;
    const point = imagePoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), source.width, source.height);
    paintMask(maskRef.current, source.width, source.height, stroke.point, point, brush / 2, tool === "erase" ? 0 : 255);
    stroke.point = point; refreshMask();
  }
  function keyboardSelect(event: KeyboardEvent<HTMLCanvasElement>) {
    if (!source || locked || view !== "selection") return;
    const point = keyboardPoint ?? { x: Math.floor(source.width / 2), y: Math.floor(source.height / 2) };
    const step = event.shiftKey ? 10 : 1;
    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      setKeyboardPoint({ x: Math.max(0, Math.min(source.width - 1, point.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0))), y: Math.max(0, Math.min(source.height - 1, point.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0))) });
    } else if (event.key === " " && tool !== "pan") {
      event.preventDefault(); checkpoint();
      if (tool === "color") selectConnectedColor(maskRef.current, new Uint8Array(source.data), source.width, source.height, point, tolerance);
      else paintMask(maskRef.current, source.width, source.height, point, point, brush / 2, tool === "erase" ? 0 : 255);
      refreshMask(); saveDraft();
    }
  }
  function changeOperation(next: ImageEditOperation) { setOperation(next); saveDraft(next); if (next.kind === "generate" && view === "preview") setView("selection"); }

  async function confirm() {
    if (!review || !source || busyRef.current || (!pending && (!selectedCount || !operation || !quote))) return;
    busyRef.current = true; setBusy(true); setError("");
    let request = pending;
    try {
      if (!request) {
        const maskPngBase64 = encodeMask(maskRef.current, source.width, source.height);
        const bytes = Uint8Array.from(atob(maskPngBase64), value => value.charCodeAt(0));
        if (bytes.length > review.limits.maskMaxBytes) throw new Error("The selection is too complex. Simplify its edges and try again.");
        request = { key: crypto.randomUUID(), body: JSON.stringify({ attempt: review.attempt, draftFingerprint: review.draftFingerprint, sourceSha256: review.source.sha256, maskPngBase64, maskSha256: await sha256(bytes.buffer), operation, quoteAuthority: quote }) };
        if (!alive.current) return;
        // Persist the exact body before dispatch. An interrupted request can
        // only replay this confirmation; changing the area cannot buy twice.
        if (!saveDraft(operation, request)) throw new Error("Confirmation was not sent because the recovery copy could not be saved.");
        setPending(request);
      }
      const response = await fetchForViewer(`${endpoint}/confirm`, { method: "POST", headers: { "content-type": "application/json", "x-idream-viewer-scope": ownerScope, "Idempotency-Key": request.key }, body: request.body });
      const payload: unknown = await response.json().catch(() => null);
      if (!alive.current) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          setPending(null); saveDraft(operation, null);
          if (response.status === 409 || response.status === 404) {
            await changedAction.current();
            if (alive.current) setReload(value => value + 1);
          }
        }
        throw new Error(apiPayloadErrorMessage(payload) ?? "The edit was not confirmed. Check this request before trying again.");
      }
      const receipt = z.object({ ok: z.literal(true), data: z.object({ attachmentId: z.literal(attachmentId), generationJobId: z.string().min(1) }).passthrough() }).safeParse(payload);
      if (!receipt.success) throw new Error("The edit response was incomplete. Check the same request again.");
      window.localStorage.removeItem(storageKey);
      await changedAction.current();
      if (alive.current) closeAction.current();
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "The edit could not be confirmed. Check the same request again.");
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function cancelEdit() {
    if (!review || busyRef.current || pending) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const response = await fetchForViewer(`${endpoint}/cancel`, { method: "POST", headers: { "content-type": "application/json", "x-idream-viewer-scope": ownerScope }, body: JSON.stringify({ attempt: review.attempt, draftFingerprint: review.draftFingerprint }) });
      const payload: unknown = await response.json().catch(() => null);
      if (!alive.current) return;
      if (!response.ok) throw new Error(apiPayloadErrorMessage(payload) ?? "Cancellation could not be confirmed. Try again.");
      window.localStorage.removeItem(storageKey); await changedAction.current();
      if (alive.current) closeAction.current();
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "Cancellation could not be confirmed."); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }

  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-2 text-white sm:p-5">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="flex max-h-[96dvh] w-full max-w-[1080px] flex-col overflow-hidden rounded-2xl bg-[rgb(26,26,26)] shadow-[0_20px_70px_rgba(0,0,0,0.5)]" data-testid="chat-image-edit-dialog">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-5">
        <div><h2 id={`${id}-title`} className="text-lg font-bold">Choose the edit area</h2><p className="mt-1 text-sm text-white/75">Everything outside your selection stays unchanged.</p></div>
        <button ref={closeRef} type="button" aria-label="Close edit review" className={control} disabled={busy} onClick={() => { if (source) saveDraft(); onClose(); }}><X className="size-5" /></button>
      </header>
      <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
        {loading ? <p role="status" className="flex items-center gap-2 py-12"><Loader2 className="size-5 animate-spin motion-reduce:animate-none" />Loading the original image…</p> : source && review ? <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0 space-y-3">
            <div role="group" aria-label="Area tools" className="flex flex-wrap gap-2">
              {([{ key: "paint", label: "Paint", Icon: Brush }, { key: "erase", label: "Erase", Icon: Eraser }, { key: "color", label: "Similar color", Icon: Wand2 }, { key: "pan", label: "Pan", Icon: Hand }] as const).map(({ key, label, Icon }) => <button type="button" key={key} className={`${control} ${tool === key ? "bg-white/15" : ""}`} aria-pressed={tool === key} disabled={locked} onClick={() => { finishStroke(); setTool(key); if (key !== "pan") setView("selection"); }}><Icon className="size-4" />{label}</button>)}
              <button type="button" className={control} disabled={locked || !selectionStats.undo} onClick={() => { maskRef.current = undoRef.current.pop()!; refreshMask(); saveDraft(); }}><Undo2 className="size-4" />Undo</button>
              <button type="button" className={control} disabled={locked || !selectedCount} onClick={() => { checkpoint(); maskRef.current.fill(0); refreshMask(); saveDraft(); }}>Clear</button>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-white/80">
              {tool === "color" ? <label className="flex items-center gap-2">Color range <input type="range" min="0" max="100" value={tolerance} disabled={locked} onChange={event => setTolerance(Number(event.target.value))} className="w-28 accent-[#e83e91]" />{tolerance}</label> : <label className="flex items-center gap-2">Brush <input type="range" min="2" max="100" value={brush} disabled={locked} onChange={event => setBrush(Number(event.target.value))} className="w-28 accent-[#e83e91]" />{brush} px</label>}
              <label className="flex items-center gap-2">Zoom <select value={zoom} onChange={event => setZoom(Number(event.target.value))} className="min-h-11 rounded-lg bg-[rgb(40,40,40)] px-2 text-white">{[1, 1.5, 2, 3, 4].map(value => <option key={value} value={value}>{value * 100}%</option>)}</select></label>
            </div>
            <div ref={scrollerRef} className="max-h-[55dvh] overflow-auto rounded-lg bg-black/40 [scrollbar-color:#777_#222]" tabIndex={0} aria-label="Image viewport">
              <div className="mx-auto" style={{ width: `min(${zoom * 100}%, ${55 * source.width / source.height * zoom}dvh)` }}><canvas ref={canvasRef} width={source.width} height={source.height} className={`block h-auto w-full touch-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white ${tool === "pan" ? "cursor-grab" : "cursor-crosshair"}`} tabIndex={0} aria-label="Image selection canvas" aria-describedby={`${id}-help`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={finishStroke} onPointerCancel={finishStroke} onLostPointerCapture={finishStroke} onKeyDown={keyboardSelect} onFocus={() => setRevision(value => value + 1)} onBlur={() => setRevision(value => value + 1)} /></div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div role="group" aria-label="Image view" className="flex gap-1">{([{ key: "selection", label: "Selection" }, { key: "original", label: "Original" }, { key: "preview", label: "Preview" }] as const).map(({ key, label }) => <button type="button" key={key} className={`${control} ${view === key ? "bg-white/15" : ""}`} aria-pressed={view === key} disabled={key === "preview" && operation?.kind !== "recolor"} onClick={() => setView(key)}>{label}</button>)}</div>
              <span className="text-xs tabular-nums text-white/75">{(selectedCount / (source.width * source.height) * 100).toFixed(1)}% selected</span>
            </div>
            <p id={`${id}-help`} className="text-xs leading-5 text-white/70">Pink marks what can change. Use Pan to move a zoomed image. Keyboard: arrows move the brush, Shift moves 10 pixels, Space applies it.{tool === "color" ? " Similar color selects touching pixels; inspect the edges and erase any spill." : ""}</p>
          </div>
          <div className="space-y-5">
            <div><h3 className="text-sm font-bold">Your requested change</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-white/80">{review.instruction}</p></div>
            <fieldset disabled={locked} className="space-y-3"><legend className="mb-3 text-sm font-bold">How should this area change?</legend>
              <label className="flex items-start gap-3 text-sm"><input type="radio" name={`${id}-operation`} className="mt-1 size-4 shrink-0 accent-[#e83e91]" checked={operation?.kind === "recolor"} onChange={() => changeOperation({ kind: "recolor", color: "#e03030" })} /><span><span className="font-semibold">Change color only</span><span className="mt-1 block text-xs leading-5 text-white/75">Keeps shape, texture, highlights and shadows. Choose the color below.</span></span></label>
              {operation?.kind === "recolor" ? <div className="space-y-2 pl-7"><label className="flex items-center gap-3 text-sm">New color<input type="color" value={operation.color} onChange={event => changeOperation({ kind: "recolor", color: event.target.value })} className="h-11 w-14 cursor-pointer rounded-md border border-white/20 bg-transparent p-1" /><span className="text-xs uppercase text-white/75">{operation.color}</span></label><p className="text-xs leading-5 text-white/75">Original brightness is kept. Black and white turn the area grayscale.</p></div> : null}
              <label className="flex items-start gap-3 text-sm"><input type="radio" name={`${id}-operation`} className="mt-1 size-4 shrink-0 accent-[#e83e91]" checked={operation?.kind === "generate"} onChange={() => changeOperation({ kind: "generate" })} /><span><span className="font-semibold">Generate a change</span><span className="mt-1 block text-xs leading-5 text-white/75">Follows your request within the selection. Shapes and details inside it may be redrawn.</span></span></label>
            </fieldset>
            {selectedCount === source.width * source.height ? <p className="text-sm leading-5 text-amber-200">The whole image is selected. Nothing outside the selection will be protected.</p> : null}
            {!selectedCount ? <p className="text-sm leading-5 text-white/75">Paint an area on the image to continue.</p> : null}
            {operation ? <p className="text-sm leading-5 text-white/80">{quote ? `${quote.costDreamcoins} Dreamcoins · charged only after confirmation` : review.unavailable?.[operation.kind] ?? "This edit option is currently unavailable."}</p> : null}
            <p className="text-xs leading-5 text-white/65">Your selection is saved on this browser. You can close this review and continue later.</p>
          </div>
        </div> : null}
        {warning ? <p role="status" className="mt-4 text-sm leading-5 text-amber-200">{warning}</p> : null}
        {error ? <div role="alert" className="mt-4 space-y-2 text-sm leading-5 text-rose-200"><p>{error}</p>{!source && !loading ? <button type="button" className={control} onClick={() => setReload(value => value + 1)}>Reload edit review</button> : null}</div> : null}
        {pending ? <p role="status" className="mt-4 text-sm leading-5 text-amber-200">This confirmation is saved. Check the same request to find out whether it was accepted; its area and price stay fixed.</p> : null}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-white/10 px-4 py-3 sm:px-5">
        <button type="button" className={control} disabled={!review || locked || loading} onClick={() => void cancelEdit()}>Cancel edit</button>
        <button type="button" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#c52e79] px-5 text-sm font-bold text-white hover:bg-[#b12369] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-40" disabled={busy || loading || !source || (!pending && (!selectedCount || !quote || !operation))} onClick={() => void confirm()}>{busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : null}{pending ? "Check same request" : quote ? `Confirm edit · ${quote.costDreamcoins} coins` : "Confirm edit"}</button>
      </footer>
    </div>
  </div>;
}
