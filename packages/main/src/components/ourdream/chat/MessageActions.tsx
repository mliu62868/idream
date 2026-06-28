"use client";

import { Flag, Loader2, RefreshCw, Square, Trash2, Volume2 } from "lucide-react";

// SPEC: Per-message action cluster. Assistant turns get Play + Regenerate; both
//       roles get Delete + Report. Pinned top-right of the bubble.
// INTENT: keep the existing Flag/Report behavior; add management without clutter.
export function MessageActions({
  isUser,
  pending,
  voiceState,
  onReport,
  onDelete,
  onRegenerate,
  onPlay,
}: Readonly<{
  isUser: boolean;
  pending: boolean;
  voiceState?: "loading" | "playing";
  onReport: () => void;
  onDelete: () => void;
  onRegenerate?: () => void;
  onPlay?: () => void;
}>) {
  const tone = isUser ? "bg-black/10 text-[rgb(13,13,13)]" : "bg-black/30 text-white";
  return (
    <div className="absolute right-2 top-2 flex items-center gap-1 opacity-70 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      {onPlay ? (
        <button
          aria-label={voiceState === "playing" ? "Stop voice" : "Play voice"}
          className={`grid h-7 w-7 place-items-center rounded-full ${tone} disabled:opacity-50`}
          data-testid="chat-play-voice"
          disabled={pending || voiceState === "loading"}
          onClick={onPlay}
          title={voiceState === "playing" ? "Stop voice" : "Play voice"}
          type="button"
        >
          {voiceState === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : voiceState === "playing" ? (
            <Square className="h-3.5 w-3.5" />
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
        </button>
      ) : null}
      {onRegenerate ? (
        <button
          aria-label="Regenerate reply"
          className={`grid h-7 w-7 place-items-center rounded-full ${tone} disabled:opacity-50`}
          data-testid="chat-regenerate"
          disabled={pending}
          onClick={onRegenerate}
          title="Regenerate reply"
          type="button"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <button
        aria-label="Delete message"
        className={`grid h-7 w-7 place-items-center rounded-full ${tone} disabled:opacity-50`}
        data-testid="chat-delete-message"
        disabled={pending}
        onClick={onDelete}
        title="Delete message"
        type="button"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <button
        aria-label="Report message"
        className={`grid h-7 w-7 place-items-center rounded-full ${tone}`}
        onClick={onReport}
        title="Report message"
        type="button"
      >
        <Flag className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
