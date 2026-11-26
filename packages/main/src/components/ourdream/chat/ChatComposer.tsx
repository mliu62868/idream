"use client";

import { ImageIcon, Loader2, Phone, Plus, Send, Square, Video } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";

const COMPOSER_BUTTON_CLASS =
  "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-white disabled:opacity-70";
const MENU_ITEM_CLASS =
  "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] font-semibold text-white hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none disabled:opacity-50";

export type ChatComposerExtras = {
  /** Present when this conversation offers a voice call. */
  readonly call?: { readonly open: boolean; readonly disabled: boolean; readonly onToggle: () => void };
  /** Present when this conversation can request a video. */
  readonly video?: { readonly disabled: boolean; readonly onOpen: () => void };
};

export type ChatComposerProps = {
  readonly inputId: string;
  readonly value: string;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly canSend: boolean;
  readonly generating: boolean;
  readonly stopping: boolean;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly callButton?: ReactNode;
  readonly voiceInputButton: ReactNode;
  readonly extras?: ChatComposerExtras;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onStop: () => void;
};

// SPEC: The message box keeps its width on a phone. Below md, Paid image, Video
//       and Voice call move into a "+" menu; dictation and Send stay inline.
//       From md up every control is inline as before.
export function ChatComposer({
  inputId,
  value,
  placeholder,
  disabled,
  readOnly,
  canSend,
  generating,
  stopping,
  composerRef,
  callButton,
  voiceInputButton,
  extras,
  onChange,
  onSubmit,
  onStop,
}: ChatComposerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || toggleRef.current?.contains(target))) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  const closeMenu = (restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  };

  return (
    <form
      className="relative flex items-end gap-2 py-2"
      onSubmit={(event) => {
        setMenuOpen(false);
        onSubmit(event);
      }}
    >
      <button
        aria-controls={menuId}
        aria-expanded={menuOpen}
        aria-haspopup="true"
        aria-label="More message options"
        className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[rgb(36,36,36)] text-white/90 hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff7ac8] disabled:opacity-50 md:hidden"
        data-testid="chat-composer-more"
        disabled={disabled}
        onClick={() => setMenuOpen((open) => !open)}
        ref={toggleRef}
        type="button"
      >
        <Plus aria-hidden className={`h-5 w-5 transition-transform ${menuOpen ? "rotate-45" : ""}`} />
      </button>
      {menuOpen ? (
        <div
          className="absolute bottom-full left-0 z-20 mb-2 w-64 rounded-2xl border border-white/15 bg-[rgb(24,24,24)] p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)] md:hidden"
          id={menuId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu(true);
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
            next?.focus();
          }}
          ref={menuRef}
          role="group"
          aria-label="Message options"
        >
          {!generating ? (
            <button
              className={MENU_ITEM_CLASS}
              data-paid-image="true"
              data-testid="chat-composer-menu-paid-image"
              disabled={!canSend}
              type="submit"
            >
              <ImageIcon aria-hidden className="h-4 w-4" />
              <span>Send as paid image<span className="block text-[11px] font-medium text-white/60">Uses Dreamcoins</span></span>
            </button>
          ) : null}
          {extras?.video ? (
            <button
              className={MENU_ITEM_CLASS}
              disabled={extras.video.disabled}
              onClick={() => { closeMenu(false); extras.video?.onOpen(); }}
              type="button"
            >
              <Video aria-hidden className="h-4 w-4" />Request a video
            </button>
          ) : null}
          {extras?.call ? (
            <button
              aria-pressed={extras.call.open}
              className={MENU_ITEM_CLASS}
              disabled={extras.call.disabled}
              onClick={() => { closeMenu(false); extras.call?.onToggle(); }}
              type="button"
            >
              <Phone aria-hidden className="h-4 w-4" />{extras.call.open ? "Hide voice call" : "Voice call"}
            </button>
          ) : null}
        </div>
      ) : null}
      <textarea
        ref={composerRef}
        rows={1}
        aria-label="Message"
        className="min-h-12 max-h-32 min-w-0 flex-1 resize-none rounded-3xl bg-[rgb(36,36,36)] px-5 py-3 text-[14px] leading-6 font-medium caret-[#ff7ac8] outline-none placeholder:text-white/50 focus-visible:ring-2 focus-visible:ring-[#ff7ac8]"
        id={inputId}
        onChange={(event) => onChange(event.target.value)}
        name="message"
        placeholder={placeholder}
        disabled={disabled}
        // Preserve one draft until its admission result is known.
        // Reply generation does not hold pending, so the next draft stays editable.
        readOnly={readOnly}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          if (canSend) event.currentTarget.form?.requestSubmit();
        }}
        value={value}
      />
      {callButton ? <span className="hidden md:contents">{callButton}</span> : null}
      {voiceInputButton}
      {!generating ? (
        <button
          aria-label="Send as paid image request"
          className="hidden h-12 shrink-0 rounded-3xl bg-[rgb(36,36,36)] px-3 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-50 md:inline-block"
          data-paid-image="true"
          disabled={!canSend}
          title="Send as paid image request (uses Dreamcoins)"
          type="submit"
        >
          Paid image
        </button>
      ) : null}
      {generating ? (
        <button
          aria-label="Stop reply"
          className={COMPOSER_BUTTON_CLASS}
          disabled={stopping}
          data-testid="chat-stop-reply"
          onClick={onStop}
          title="Stop reply"
          type="button"
        >
          {stopping
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <Square className="h-4 w-4" />}
        </button>
      ) : (
        <button
          aria-label="Send message"
          className={COMPOSER_BUTTON_CLASS}
          disabled={!canSend}
          type="submit"
        >
          <Send className="h-4 w-4" />
        </button>
      )}
    </form>
  );
}
