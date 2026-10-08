"use client";

import { Loader2, Mic } from "lucide-react";
import type { VoiceInputController } from "@/hooks/useVoiceInput";

const ACTION = "min-h-11 rounded-full px-3 text-[13px] font-semibold text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff7ac8]";
const TRANSCRIPT_NOTE = "Transcripts can contain mistakes. Review your editable draft before sending.";

export function VoiceInputStatus({ voice }: Readonly<{ voice: VoiceInputController }>) {
  if (!voice.notice && !voice.capability?.supported) return null;
  const isRecording = voice.phase === "recording";
  // INTENT: 这块在 sticky 输入区里。没在用麦克风时只留一行可展开的说明（英语范围 + 转写提醒仍在 DOM 里，
  //   录音前可查）；开始用麦克风后再把转写提醒摊开，避免常驻两行挤占对话区（审计 P1-1）。
  const engaged = voice.phase !== "idle" || Boolean(voice.candidate) || voice.canUndo;
  return (
    <div className="pb-2 text-[13px] text-white/90" data-testid="voice-input-status">
      {voice.notice || (voice.capability?.supported && !voice.capability.available) ? <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1">
        {voice.phase === "transcribing" ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}
        <span role="status" aria-live="polite" className="min-w-0 flex-1">{voice.notice ?? "Voice input is temporarily unavailable. You can keep typing."}</span>
        {isRecording ? (
          <>
            <span aria-hidden="true" className="whitespace-nowrap tabular-nums">{`00:${Math.floor(voice.elapsedMs / 1000).toString().padStart(2, "0")} / 01:00`}</span>
            <span aria-label="Microphone level" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(voice.volume * 100)} className="h-1.5 w-12 overflow-hidden rounded-full bg-white/15">
              <span className="block h-full origin-left rounded-full bg-[#ff7ac8]" style={{ transform: `scaleX(${voice.volume})` }} />
            </span>
            <button type="button" className={ACTION} onClick={voice.cancel}>Cancel</button>
            <button type="button" className={`${ACTION} bg-white/10`} onClick={voice.finish}>Done</button>
          </>
        ) : null}
        {voice.phase === "requesting" || voice.phase === "transcribing" ? <button type="button" className={ACTION} onClick={voice.cancel}>Cancel</button> : null}
        {voice.phase === "interrupted" ? <>
          <button type="button" className={ACTION} onClick={voice.transcribeClip}>Transcribe</button>
          <button type="button" className={ACTION} onClick={voice.cancel}>Discard</button>
        </> : null}
        {voice.phase === "error" ? <>
          {voice.canRetry ? <button type="button" className={ACTION} onClick={voice.retry}>Retry</button> : null}
          <button type="button" className={ACTION} onClick={() => void voice.start()}>Record again</button>
          <button type="button" className={ACTION} onClick={voice.cancel}>Use keyboard</button>
        </> : null}
        {voice.canUndo ? <button type="button" className={ACTION} onClick={voice.undo}>Undo voice text</button> : null}
        {voice.capability?.supported && !voice.capability.available ? <button type="button" className={ACTION} onClick={voice.refreshCapability}>Check availability</button> : null}
      </div> : null}
      {voice.capability?.supported ? <details className="max-w-prose pb-1 text-[12px] leading-5 text-white/70">
        <summary className="cursor-pointer">Voice input · English only</summary>
        {engaged ? null : <p>{TRANSCRIPT_NOTE}</p>}
      </details> : null}
      {voice.capability?.supported && engaged ? <p className="max-w-prose pb-1 text-[12px] leading-5 text-white/70">{TRANSCRIPT_NOTE}</p> : null}
      {voice.phase === "requesting" || isRecording ? <p className="max-w-prose pb-1 text-[12px] leading-5 text-white/70">Your recording is transcribed on iDream’s servers. Audio isn’t saved to your chat.</p> : null}
      {voice.candidate ? <>
        <p className="max-h-32 overflow-auto whitespace-pre-wrap rounded-xl bg-white/5 p-3 leading-5">{voice.candidate}</p>
        <div className="flex gap-1">
          <button type="button" className={ACTION} onClick={voice.addCandidate}>Add to draft</button>
          <button type="button" className={ACTION} onClick={voice.cancel}>Discard</button>
        </div>
      </> : null}
    </div>
  );
}

export function VoiceInputButton({ voice, disabled }: Readonly<{ voice: VoiceInputController; disabled: boolean }>) {
  if (!voice.capability?.supported) return null;
  const recording = voice.phase === "recording";
  return <button
    type="button"
    aria-label={recording ? "Finish recording" : "Voice input"}
    aria-pressed={recording}
    title={recording ? "Finish recording" : "Speak your message in English. Review your editable draft before sending."}
    disabled={disabled || !voice.capability.available || (voice.blocksSend && !recording)}
    onClick={() => recording ? voice.finish() : void voice.start()}
    className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff7ac8] disabled:opacity-50 ${recording ? "bg-[#ff7ac8]/20 text-[#ff7ac8]" : "bg-[rgb(36,36,36)] text-white/90 hover:bg-white/15"}`}
  ><Mic aria-hidden="true" className="h-5 w-5" /></button>;
}
