"use client";

import { Flag, Loader2, Pencil, RefreshCw, Square, Trash2, Volume2 } from "lucide-react";

// SPEC: Per-message action cluster. Assistant turns get Play + Regenerate; both
//       roles get Delete + Report; the latest user turn may expose Edit. Pinned
//       top-right of the bubble.
// INTENT: keep the existing Flag/Report behavior; add management without clutter.
export function MessageActions({
  isUser,
  pending,
  voiceState,
  onEdit,
  onReport,
  onDelete,
  onRegenerate,
  onPlay,
  deleteConfirm,
}: Readonly<{
  isUser: boolean;
  pending: boolean;
  voiceState?: "loading" | "playing";
  onEdit?: () => void;
  onReport: () => void;
  onDelete: () => void;
  onRegenerate?: () => void;
  onPlay?: () => void;
  deleteConfirm?: boolean;
}>) {
  const tone = isUser ? "bg-black/10 text-[rgb(13,13,13)]" : "bg-black/30 text-white";
  const voiceActive = voiceState === "playing";
  const voiceLabel = voiceActive ? "Stop voice" : "Play voice";
  const voiceTone = voiceActive
    ? "bg-[var(--ds-brand-pink)] text-white opacity-100 shadow-[0_0_0_1px_rgba(255,255,255,0.28),0_0_18px_rgba(253,95,194,0.45)]"
    : tone;
  return (
    <div className="absolute right-2 top-2 flex items-center gap-1 opacity-70 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      {onPlay ? (
        <button
          aria-label={voiceLabel}
          aria-pressed={voiceActive}
          className={`grid h-7 w-7 place-items-center rounded-full transition ${voiceTone} disabled:opacity-50`}
          data-state={voiceState ?? "idle"}
          data-testid="chat-play-voice"
          disabled={pending || voiceState === "loading"}
          onClick={onPlay}
          title={voiceLabel}
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
      {onEdit ? (
        <button
          aria-label="Edit message"
          className={`grid h-7 w-7 place-items-center rounded-full ${tone} disabled:opacity-50`}
          data-testid="chat-edit-message"
          disabled={pending}
          onClick={onEdit}
          title="Edit message"
          type="button"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <button
        aria-label={deleteConfirm ? "Confirm delete message" : "Delete message"}
        className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full ${deleteConfirm ? "px-2 text-[11px] font-bold uppercase" : "w-7"} ${tone} disabled:opacity-50`}
        data-testid="chat-delete-message"
        disabled={pending}
        onClick={onDelete}
        title={deleteConfirm ? "Confirm delete message" : "Delete message"}
        type="button"
      >
        {deleteConfirm ? "Confirm" : <Trash2 className="h-3.5 w-3.5" />}
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
