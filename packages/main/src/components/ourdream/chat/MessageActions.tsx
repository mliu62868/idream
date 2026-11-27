"use client";

import { Flag, Loader2, MoreHorizontal, Pencil, RefreshCw, Square, Trash2, Volume2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

// SPEC: Per-message action cluster. Assistant turns get Play + Regenerate inline;
//       Edit, Delete and Report sit behind a "More actions" disclosure. Only the
//       latest Turn gets Delete/Regenerate/Edit. Actions sit below the content so
//       controls never take width away from reading.
// INTENT: a permanent row of 44px buttons under every bubble doubled the height
//         of short messages on phones. On hover-capable screens the row stays
//         out of sight until the bubble is hovered or focused; touch screens
//         keep the compact row visible because they cannot hover.
// INVARIANT: every action stays a keyboard-reachable button — the disclosure
//            is a plain aria-expanded toggle, Escape closes it and returns
//            focus to the toggle.
export function MessageActions({
  isUser,
  pending,
  prominent = false,
  voiceState,
  onEdit,
  onReport,
  onDelete,
  onRegenerate,
  onPlay,
  deleteConfirm,
  onCancelDelete,
}: Readonly<{
  isUser: boolean;
  pending: boolean;
  /** The latest Turn keeps its actions in view on every device. */
  prominent?: boolean;
  voiceState?: "loading" | "playing";
  onEdit?: () => void;
  onReport: () => void;
  onDelete?: () => void;
  onRegenerate?: () => void;
  onPlay?: () => void;
  deleteConfirm?: boolean;
  /** Disarms an armed delete; collapsing the panel backs out of it. */
  onCancelDelete?: () => void;
}>) {
  const [moreOpen, setMoreOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  // An armed delete must stay visible so its Confirm can be pressed.
  const expanded = moreOpen || Boolean(deleteConfirm);
  const tone = isUser ? "bg-black/10 text-[rgb(13,13,13)]" : "bg-black/30 text-white";
  const voiceActive = voiceState === "playing";
  const voiceLabel = voiceActive ? "Stop voice" : "Play voice";
  const voiceTone = voiceActive
    ? "bg-[var(--ds-brand-pink)] text-white opacity-100 shadow-[0_0_0_1px_rgba(255,255,255,0.28),0_0_18px_rgba(253,95,194,0.45)]"
    : tone;
  const iconButton = `grid h-10 w-10 md:h-7 md:w-7 place-items-center rounded-full ${tone} disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#ff7ac8]`;
  const pinned = prominent || expanded || voiceActive || voiceState === "loading";
  const collapse = () => {
    setMoreOpen(false);
    if (deleteConfirm) onCancelDelete?.();
  };

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: PointerEvent) => {
      const panel = document.getElementById(panelId);
      const target = event.target as Node | null;
      if (target && (panel?.contains(target) || toggleRef.current?.contains(target))) return;
      setMoreOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [moreOpen, panelId]);

  return (
    <div
      className={`mt-2 flex flex-wrap items-center justify-end gap-1 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${pinned ? "opacity-100" : "opacity-80 [@media(hover:hover)]:opacity-0"}`}
      data-testid="chat-message-actions"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !expanded) return;
        event.stopPropagation();
        collapse();
        toggleRef.current?.focus();
      }}
    >
      {onPlay ? (
        <button
          aria-label={voiceLabel}
          aria-pressed={voiceActive}
          className={`grid h-10 w-10 md:h-7 md:w-7 place-items-center rounded-full transition ${voiceTone} disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#ff7ac8]`}
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
          className={iconButton}
          data-testid="chat-regenerate"
          disabled={pending}
          onClick={onRegenerate}
          title="Regenerate reply"
          type="button"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <div className="flex items-center gap-1" hidden={!expanded} id={panelId}>
        {onEdit ? (
          <button
            aria-label="Edit message"
            className={iconButton}
            data-testid="chat-edit-message"
            disabled={pending}
            onClick={() => { setMoreOpen(false); onEdit(); }}
            title="Edit message"
            type="button"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {onDelete ? (
          <button
            aria-label={deleteConfirm ? "Confirm delete message" : "Delete message"}
            className={`inline-flex h-10 min-w-10 md:h-7 md:min-w-7 items-center justify-center rounded-full ${deleteConfirm ? "px-2 text-[11px] font-bold uppercase" : "w-10 md:w-7"} ${tone} disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#ff7ac8]`}
            data-testid="chat-delete-message"
            disabled={pending}
            onClick={onDelete}
            title={deleteConfirm ? "Confirm delete message" : "Delete message"}
            type="button"
          >
            {deleteConfirm ? "Confirm" : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        ) : null}
        <button
          aria-label="Report message"
          className={iconButton}
          onClick={() => { setMoreOpen(false); onReport(); }}
          title="Report message"
          type="button"
        >
          <Flag className="h-3.5 w-3.5" />
        </button>
      </div>
      <button
        aria-controls={panelId}
        aria-expanded={expanded}
        aria-label={expanded ? "Fewer actions" : "More actions"}
        className={iconButton}
        data-testid="chat-message-more"
        onClick={() => (expanded ? collapse() : setMoreOpen(true))}
        ref={toggleRef}
        title={expanded ? "Fewer actions" : "More actions"}
        type="button"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
