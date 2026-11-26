"use client";

import { Loader2, Send, Square } from "lucide-react";
import type { FormEvent, ReactNode, RefObject } from "react";

const COMPOSER_BUTTON_CLASS =
  "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-white disabled:opacity-70";

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
  readonly onChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onStop: () => void;
};

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
  onChange,
  onSubmit,
  onStop,
}: ChatComposerProps) {
  return (
    <form
      className="flex items-end gap-2 py-2"
      onSubmit={onSubmit}
    >
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
      {callButton}
      {voiceInputButton}
      {!generating ? (
        <button
          aria-label="Send as paid image request"
          className="h-12 shrink-0 rounded-3xl bg-[rgb(36,36,36)] px-3 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-50"
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
