"use client";

import { useRef, useState } from "react";
import { Camera, Film, Loader2 } from "lucide-react";
import { apiPayloadErrorMessage } from "@/lib/generation-write-client";

type ViewerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function ChatMediaQuoteCard({
  attachmentId,
  kind,
  costDreamcoins,
  ownerScope,
  paymentHref,
  fetchForViewer,
  onChanged,
}: {
  attachmentId: string;
  kind: "generated_image" | "generated_video";
  costDreamcoins: number;
  ownerScope: string | null;
  paymentHref: string;
  fetchForViewer: ViewerFetch;
  onChanged: () => Promise<void>;
}) {
  const endpoint = `/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/media-quote`;
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = useState("");
  const [insufficientCoins, setInsufficientCoins] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);

  const isVideo = kind === "generated_video";
  const label = isVideo ? "Video" : "Photo";

  async function confirmQuote() {
    if (!ownerScope || busy) return;
    setBusy("confirm");
    setError("");
    setInsufficientCoins(false);
    try {
      idempotencyKeyRef.current ??= crypto.randomUUID();
      const response = await fetchForViewer(`${endpoint}/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-viewer-scope": ownerScope,
          "Idempotency-Key": idempotencyKeyRef.current,
        },
        body: "{}",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 402) setInsufficientCoins(true);
        if (response.status === 409 || response.status === 404) {
          idempotencyKeyRef.current = null;
          await onChanged();
        }
        throw new Error(
          apiPayloadErrorMessage(payload) ??
            `Could not send this ${label.toLowerCase()}. Please try again.`,
        );
      }
      await onChanged();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : `Could not send this ${label.toLowerCase()}.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function cancelQuote() {
    if (!ownerScope || busy) return;
    setBusy("cancel");
    setError("");
    try {
      const response = await fetchForViewer(`${endpoint}/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-viewer-scope": ownerScope,
        },
        body: "{}",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          apiPayloadErrorMessage(payload) ?? "Could not cancel this request.",
        );
      }
      await onChanged();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not cancel this request.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="w-full max-w-[300px] rounded-xl border border-white/15 bg-black/25 p-3"
      data-testid="chat-media-quote-card"
    >
      <div className="flex items-center gap-2 text-sm font-bold text-white">
        {isVideo ? <Film className="size-4 text-[#f472b6]" /> : <Camera className="size-4 text-[#f472b6]" />}
        <span>{label} · {costDreamcoins} DreamCoins</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-white/75">
        Confirm to send this {label.toLowerCase()}. Coins are charged only after you confirm.
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-xs leading-5 text-rose-200">
          {error}
        </p>
      ) : null}
      {insufficientCoins ? (
        <a
          href={paymentHref}
          className="mt-2 inline-block text-xs font-semibold text-[#f472b6] underline underline-offset-2"
        >
          Get more DreamCoins
        </a>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          data-testid="chat-media-quote-confirm"
          className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#c52e79] px-3 text-xs font-bold text-white hover:bg-[#b12369] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!ownerScope || busy !== null}
          onClick={() => void confirmQuote()}
        >
          {busy === "confirm" ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Send · {costDreamcoins} coins
        </button>
        <button
          type="button"
          data-testid="chat-media-quote-cancel"
          className="inline-flex min-h-10 items-center justify-center rounded-lg border border-white/20 px-3 text-xs font-semibold text-white/85 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!ownerScope || busy !== null}
          onClick={() => void cancelQuote()}
        >
          {busy === "cancel" ? <Loader2 className="size-3.5 animate-spin" /> : "Cancel"}
        </button>
      </div>
    </div>
  );
}
