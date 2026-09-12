"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { z } from "zod";
import type { ChatVideoSource } from "@/lib/chat-video";
import { parseGenerationContextResponse, parseGenerationQuoteResponse, type RuntimeGenerationQuote } from "@/lib/public-api-contracts";
import { apiPayloadErrorMessage, exactGenerationQuoteForCount, type GenerationQuoteAuthority } from "@/lib/generation-write-client";

const capabilityResponseSchema = z.object({ data: z.object({ capability: z.object({ enabled: z.boolean(), entitled: z.boolean() }) }) });

export type ChatVideoSubmission = {
  sessionId: string;
  body: { generationContextToken: string; prompt: string; model?: string; quoteAuthority: GenerationQuoteAuthority };
};

export function ChatVideoComposer({ sources, initialSourceId, initialPrompt, ownerScope, onClose, onSubmit }: {
  sources: readonly ChatVideoSource[];
  initialSourceId?: string;
  initialPrompt?: string;
  ownerScope: string;
  onClose: () => void;
  onSubmit: (submission: ChatVideoSubmission) => Promise<boolean>;
}) {
  const [sourceId, setSourceId] = useState(initialSourceId ?? sources[0]?.mediaAssetId ?? "");
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [quoted, setQuoted] = useState<{ quote: RuntimeGenerationQuote; submission: ChatVideoSubmission } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [capability, setCapability] = useState<{ enabled: boolean; entitled: boolean } | null>(null);
  const epoch = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const selected = sources.find(source => source.mediaAssetId === sourceId);
  const sourceSessionId = selected?.sessionId;

  useEffect(() => {
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: "center", behavior: "smooth" });
    return () => { epoch.current += 1; };
  }, []);

  useEffect(() => {
    let active = true;
    if (!sourceSessionId) return;
    void fetch(`/api/v1/chat/${encodeURIComponent(sourceSessionId)}/video`, {
      cache: "no-store", headers: { "x-idream-viewer-scope": ownerScope },
    }).then(async response => {
      const payload = await response.json().catch(() => null);
      if (!active) return;
      if (!response.ok) { setError(apiPayloadErrorMessage(payload) ?? "Chat video availability could not be checked."); return; }
      const parsed = capabilityResponseSchema.safeParse(payload);
      if (!parsed.success) { setError("Chat video availability could not be confirmed."); return; }
      setCapability(parsed.data.data.capability);
    }).catch(() => { if (active) setError("Chat video availability could not be checked. Try again."); });
    return () => { active = false; epoch.current += 1; };
  }, [sourceSessionId, ownerScope]);

  function invalidate() {
    epoch.current += 1;
    setQuoted(null);
    setError("");
  }

  async function quote() {
    if (!selected || !prompt.trim()) return;
    const currentEpoch = ++epoch.current;
    setPending(true);
    setError("");
    setQuoted(null);
    try {
      const query = new URLSearchParams({ kind: "chat", sessionId: selected.sessionId, turnId: selected.turnId, attempt: String(selected.attempt), mediaAssetId: selected.mediaAssetId });
      const contextResponse = await fetch(`/api/v1/generation/context?${query}`, { cache: "no-store", headers: { "x-idream-viewer-scope": ownerScope } });
      const contextPayload: unknown = await contextResponse.json().catch(() => null);
      if (!contextResponse.ok) throw new Error(apiPayloadErrorMessage(contextPayload) ?? "The original chat image is no longer available.");
      const context = parseGenerationContextResponse(contextPayload);
      if (currentEpoch !== epoch.current) return;
      const body = { generationContextToken: context.token, prompt: prompt.trim() };
      const response = await fetch(`/api/v1/chat/${encodeURIComponent(selected.sessionId)}/video/quote`, {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json", "x-idream-viewer-scope": ownerScope }, body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiPayloadErrorMessage(payload) ?? "The video price could not be checked.");
      const { quote } = parseGenerationQuoteResponse(payload);
      const quoteAuthority = exactGenerationQuoteForCount(quote, 1)?.authority;
      if (!quote.video || !quoteAuthority) throw new Error("The selected video route has no complete price and duration.");
      if (currentEpoch === epoch.current) setQuoted({ quote, submission: { sessionId: selected.sessionId, body: { ...body, quoteAuthority } } });
    } catch (failure) {
      if (currentEpoch === epoch.current) setError(failure instanceof Error ? failure.message : "The video price could not be checked.");
    } finally {
      if (currentEpoch === epoch.current) setPending(false);
    }
  }

  async function confirm() {
    if (!quoted || pending) return;
    setPending(true);
    try { if (await onSubmit(quoted.submission)) onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The video request could not be confirmed. Check the original request before trying again."); }
    finally { setPending(false); }
  }

  return <section className="mt-4 space-y-4 rounded-2xl border border-white/20 bg-[rgb(26,26,26)] p-4" aria-labelledby="chat-video-heading" data-testid="chat-video-composer">
    <div className="flex items-center justify-between gap-3">
      <h2 id="chat-video-heading" className="text-base font-bold">Animate a chat image</h2>
      <button type="button" aria-label="Close video request" className="grid size-11 place-items-center rounded-full hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white" onClick={onClose} disabled={pending}><X className="size-5" /></button>
    </div>
    {!selected ? <p className="text-sm text-white/75">Request an image in this chat first. Once it is ready, choose Animate on the image.</p> : <>
      <div className="flex items-start gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={selected.url} alt="Source image for this video" className="h-28 w-24 rounded-lg object-cover" />
        <div className="grid min-w-0 flex-1 gap-2 text-sm font-semibold">
          <label htmlFor="chat-video-source">Source image</label>
          {/* Help text is a description, not part of the control's accessible name. */}
          <select id="chat-video-source" aria-describedby="chat-video-source-help" className="min-h-11 w-full rounded-lg border border-white/20 bg-black/30 px-3" value={sourceId} disabled={pending} onChange={event => { invalidate(); setSourceId(event.target.value); }}>
            {sources.map((source, index) => <option value={source.mediaAssetId} key={source.mediaAssetId}>{index === 0 ? "Most recent image" : `Earlier image ${index}`}</option>)}
          </select>
          <span id="chat-video-source-help" className="text-xs font-normal text-white/65">This image supplies the character and scene. Describe the motion you want.</span>
        </div>
      </div>
      <label className="grid gap-2 text-sm font-semibold" htmlFor="chat-video-motion">Motion
        <textarea ref={inputRef} id="chat-video-motion" rows={3} maxLength={900} className="w-full rounded-xl border border-white/20 bg-black/20 p-3 font-normal focus-visible:outline-2 focus-visible:outline-white" placeholder="For example: slowly turn toward the window and smile." value={prompt} disabled={pending} onChange={event => { invalidate(); setPrompt(event.target.value); }} />
      </label>
      {capability && !capability.enabled ? <p className="text-sm text-white/75">New Chat videos are currently unavailable. Your earlier videos remain in this chat.</p> : capability && !capability.entitled ? <p className="text-sm text-white/75">Chat videos require Deluxe video access.</p> : quoted ? <div className="space-y-3 rounded-xl bg-white/5 p-3">
        <p className="font-semibold">{quoted.quote.video?.durationSeconds}-second video · {quoted.submission.body.quoteAuthority.costDreamcoins} Dreamcoins</p>
        <p className="text-sm text-white/70">{quoted.quote.video?.width} × {quoted.quote.video?.height} · {quoted.quote.video?.audio === "generated" ? "Includes generated audio" : "No audio"}. The video will appear beside the original reply.</p>
        {quoted.submission.body.quoteAuthority.costDreamcoins > quoted.quote.balance ? <p className="text-sm text-white/75">You need more Dreamcoins before generating this video.</p> : null}
        <button type="button" className="min-h-11 rounded-full bg-white px-5 py-2 text-sm font-bold text-black disabled:opacity-50" onClick={() => void confirm()} disabled={pending || quoted.submission.body.quoteAuthority.costDreamcoins > quoted.quote.balance}>{pending ? "Confirming request…" : "Confirm and generate video"}</button>
      </div> : <button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 py-2 text-sm font-bold text-black disabled:opacity-50" onClick={() => void quote()} disabled={pending || !prompt.trim() || capability === null}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}{pending ? "Checking price…" : "Check video price"}
      </button>}
    </>}
    {error ? <p role="alert" className="text-sm text-rose-200">{error}</p> : null}
  </section>;
}
