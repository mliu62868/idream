"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw, Video } from "lucide-react";
import { z } from "zod";
import { parseGenerationRetryQuoteResponse, type RuntimeChatAttachment } from "@/lib/public-api-contracts";
import { apiPayloadErrorMessage, type GenerationQuoteAuthority } from "@/lib/generation-write-client";

const downloadResponseSchema = z.object({ ok: z.literal(true), data: z.object({ url: z.string().min(1) }) });

// The download endpoint is the authority for the file URL (a signed, named blob
// URL in production). A plain link to it would only open its JSON response.
async function mediaDownloadUrl(mediaAssetId: string, ownerScope: string | null) {
  const response = await fetch(`/api/v1/media/${encodeURIComponent(mediaAssetId)}/download`, {
    cache: "no-store", headers: ownerScope ? { "x-idream-viewer-scope": ownerScope } : undefined,
  });
  const payload: unknown = await response.json().catch(() => null);
  const parsed = response.ok ? downloadResponseSchema.safeParse(payload) : null;
  if (!parsed?.success) throw new Error(apiPayloadErrorMessage(payload) ?? "The video download could not start. Try again.");
  return parsed.data.data.url;
}

export function ChatVideoAttachmentCard({ attachment, ownerScope, retryPending, onRetry, onCancelled }: {
  attachment: RuntimeChatAttachment;
  ownerScope: string | null;
  retryPending: boolean;
  onRetry: (authority: GenerationQuoteAuthority) => Promise<void>;
  onCancelled: () => Promise<void>;
}) {
  const [quoted, setQuote] = useState<{ authority: GenerationQuoteAuthority; jobId: string; ownerScope: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [unplayableSource, setUnplayableSource] = useState<string | null>(null);
  const epoch = useRef(0);
  const jobId = attachment.generationJobId;
  const quote = quoted && quoted.jobId === jobId && quoted.ownerScope === ownerScope ? quoted.authority : null;
  const unplayable = unplayableSource === attachment.mediaUrl;
  useEffect(() => { epoch.current += 1; return () => { epoch.current += 1; }; }, [ownerScope, jobId]);

  async function checkRetry() {
    if (!jobId || !ownerScope || pending) return;
    const current = ++epoch.current;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/generation/jobs/${encodeURIComponent(jobId)}/retry/quote`, { method: "POST", cache: "no-store", headers: { "x-idream-viewer-scope": ownerScope } });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiPayloadErrorMessage(payload) ?? "The video retry price could not be checked.");
      const { quote } = parseGenerationRetryQuoteResponse(payload);
      if (current === epoch.current) setQuote({ jobId, ownerScope, authority: { profileId: quote.profileId, profileVersion: quote.profileVersion, routeFingerprint: quote.routeFingerprint, pricingFingerprint: quote.pricing.fingerprint, outputCount: quote.outputCount, costDreamcoins: quote.costDreamcoins } });
    } catch (failure) { if (current === epoch.current) setError(failure instanceof Error ? failure.message : "The retry price could not be checked."); }
    finally { if (current === epoch.current) setPending(false); }
  }

  async function confirmRetry() {
    if (!quote || pending || retryPending) return;
    setPending(true);
    try { await onRetry(quote); setQuote(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The video retry could not be confirmed."); }
    finally { setPending(false); }
  }

  async function cancel() {
    if (!jobId || !ownerScope || pending) return;
    const current = ++epoch.current;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/generation/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", headers: { "x-idream-viewer-scope": ownerScope } });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiPayloadErrorMessage(payload) ?? "The video could not be cancelled.");
      if (current === epoch.current) await onCancelled();
    } catch (failure) { if (current === epoch.current) setError(failure instanceof Error ? failure.message : "The video could not be cancelled. Check its current result."); }
    finally { if (current === epoch.current) setPending(false); }
  }

  const unknown = attachment.errorCode === "provider_outcome_unknown";
  const active = !unknown && ["requesting", "accepted", "queued", "running", "moderating_input", "moderating_output"].includes(attachment.status);
  const failed = ["failed", "refunded", "blocked", "rejected"].includes(attachment.status);
  const retryable = Boolean(jobId) && ["failed", "refunded"].includes(attachment.status);
  const completed = attachment.status === "completed";
  const cancelled = attachment.status === "cancelled";
  const classes = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 py-2 text-xs font-bold disabled:opacity-50";

  return <figure className="w-full max-w-[360px] overflow-hidden rounded-xl border border-white/15 bg-black/20" data-testid="chat-video-attachment-card">
    {completed && attachment.mediaUrl && !unplayable ? <video controls playsInline preload="metadata" className="max-h-[480px] w-full" poster={attachment.thumbnailUrl && attachment.thumbnailUrl !== attachment.mediaUrl ? attachment.thumbnailUrl : undefined} src={attachment.mediaUrl} onError={() => setUnplayableSource(attachment.mediaUrl ?? null)} data-testid="chat-video-attachment" /> : <div className="flex items-start gap-3 p-4">
      {active ? <Loader2 className="size-5 shrink-0 animate-spin" /> : <Video className="size-5 shrink-0" />}
      <div>
        <p className="text-sm font-bold">{unknown ? "Video result needs review" : cancelled ? "Video cancelled" : completed ? "Video playback unavailable" : failed ? "Video unavailable" : "Generating video"}</p>
        <p className="mt-1 text-xs leading-5 text-white/70">{unknown ? "The provider result is not yet confirmed. Contact support before requesting another video." : cancelled ? "The request stopped before processing. Reserved Dreamcoins were returned." : completed ? "The video was delivered. Use the download link to open it." : failed ? "The video could not be completed. Check the retry price before starting another attempt." : "You can keep chatting or return later. This request will keep its place."}</p>
      </div>
    </div>}
    <figcaption className="grid gap-2 border-t border-white/10 p-3">
      {completed && attachment.mediaAssetId ? <button type="button" className={`${classes} bg-white/10`} onClick={() => {
        const mediaAssetId = attachment.mediaAssetId!;
        setError("");
        void mediaDownloadUrl(mediaAssetId, ownerScope).then((url) => window.location.assign(url), (cause: unknown) => setError(cause instanceof Error ? cause.message : "The video download could not start. Try again."));
      }}><Download className="size-4" />Download video</button> : null}
      {unknown ? <Link href="/helpdesk" className={`${classes} bg-white/10`}>Contact support</Link> : retryable ? quote ? <>
        <p className="text-xs text-white/75">Retry this video · {quote.costDreamcoins} Dreamcoins</p>
        <button type="button" className={`${classes} bg-white text-black`} disabled={pending || retryPending || !ownerScope} onClick={() => void confirmRetry()}>{pending || retryPending ? "Confirming retry…" : "Confirm video retry"}</button>
      </> : <button type="button" className={`${classes} bg-white text-black`} disabled={pending || retryPending || !ownerScope} onClick={() => void checkRetry()}><RefreshCw className="size-4" />{pending ? "Checking price…" : "Check video retry price"}</button> : active && ["requesting", "accepted", "queued"].includes(attachment.status) ? <button type="button" className={`${classes} bg-white/10`} disabled={pending || !ownerScope} onClick={() => void cancel()}>{pending ? "Checking cancellation…" : "Cancel before processing"}</button> : null}
      {error ? <p role="alert" className="text-xs leading-5 text-rose-200">{error}</p> : null}
    </figcaption>
  </figure>;
}
