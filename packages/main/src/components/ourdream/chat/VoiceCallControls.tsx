"use client";

import { Mic, MicOff, Phone, PhoneOff, Square, X } from "lucide-react";
import { useId, useState } from "react";
import Link from "next/link";
import type { VoiceCallController } from "@/hooks/useVoiceCall";

const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/20 px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40";
// Keep this chooser aligned with the existing gateway container whitelist;
// uploaded bytes are still validated by its bounded server-side decoder.
const recordingFormats = ".wav,.flac,.mp3,.ogg,.oga,.opus,.m4a,.mp4,.mov,.mkv,.mka,.webm,.aac,audio/wav,audio/x-wav,audio/flac,audio/mpeg,audio/ogg,audio/mp4,audio/webm,audio/aac";

export const VOICE_CALL_PANEL_ID = "chat-voice-call-panel";

// SPEC: 通话没开始、也没有待确认报价时，面板必须能收起；一旦在报价/接通/通话中就强制展开。
// INTENT: 面板挂在 sticky 输入区里，常驻时手机上占掉 44% 视口、盖住最新回复（审计 P1-1）。
//   通话是聊天页的次要入口：平时只留输入行里的一个电话按钮，展开后才出预算/报价表单；
//   通话中的控件（静音、挂断、恢复）不允许被收起，否则用户找不到挂断。
export function voiceCallPanelForced(voice: Pick<VoiceCallController, "active" | "quote" | "phase">): boolean {
  return voice.active || Boolean(voice.quote) || ["quoting", "connecting"].includes(voice.phase);
}

export function VoiceCallButton({ voice, open, onToggle }: { voice: VoiceCallController; open: boolean; onToggle: () => void }) {
  if (!voice.available && !voice.call) return null;
  const forced = voiceCallPanelForced(voice);
  return <button type="button" aria-label="Voice call" aria-controls={VOICE_CALL_PANEL_ID} aria-expanded={open || forced} title="Voice call"
    disabled={forced} onClick={onToggle}
    className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff7ac8] disabled:cursor-default ${open || forced ? "bg-[#ff7ac8]/20 text-[#ff7ac8]" : "bg-[rgb(36,36,36)] text-white/90 hover:bg-white/15"}`}
  ><Phone aria-hidden="true" className="h-5 w-5" /></button>;
}

export function VoiceCallControls({ voice, disabled, open, onClose }: { voice: VoiceCallController; disabled: boolean; open: boolean; onClose: () => void }) {
  const [budget, setBudget] = useState(2);
  const recordingHelpId = useId();
  if (!voice.available && !voice.call) return null;
  const forced = voiceCallPanelForced(voice);
  if (!open && !forced) return null;
  const current = voice.call;
  const controlled = Boolean(current?.leaseToken);
  const busy = ["quoting", "connecting"].includes(voice.phase);
  return <section id={VOICE_CALL_PANEL_ID} aria-label="Voice call" className="mb-2 rounded-2xl border border-white/15 bg-white/[0.03] p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2 font-semibold"><Phone className="h-4 w-4" /> Voice call <span className="text-xs font-normal text-white/55">English · turn-based</span></span>
      {current ? <span className="text-xs text-white/65">{current.status} · {Math.floor(current.connectedMs / 1000)}s connected · {(current.voiceDurationMs / 60_000).toFixed(2)} voice min · {current.costDreamcoins}/{current.maxCostDreamcoins} coins</span> : null}
      {forced ? null : <button type="button" aria-label="Hide voice call" className="-m-2 inline-flex h-10 w-10 items-center justify-center rounded-full text-white/70 hover:bg-white/10" onClick={onClose}><X className="h-4 w-4" /></button>}
    </div>
    {!voice.active && !voice.quote ? <div className="mt-3 flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-xs text-white/70">Call budget
        <input aria-label="Call budget in Dreamcoins" type="number" min={0} max={Math.min(100, voice.balance)} step={1} value={Math.min(budget, voice.balance)}
          onChange={event => setBudget(Math.max(0, Math.min(100, Number(event.target.value) || 0)))} className="w-16 rounded-lg bg-white/10 px-2 py-2 text-white" />
        coins
      </label>
      <button type="button" className={button} disabled={disabled || busy || !voice.available || Boolean(voice.otherCallSessionId)} onClick={() => void voice.prepare(Math.min(budget, voice.balance))}>Review call price</button>
      {voice.otherCallSessionId ? <Link className="text-xs underline" href={`/chat/${encodeURIComponent(voice.otherCallSessionId)}`}>Return to your existing call</Link> : null}
      <p className="w-full text-xs text-white/55">Up to 3 minutes. Connection time is free. Voice minutes count generated reply audio; paid replies stay within this total budget.</p>
    </div> : null}
    {voice.quote ? <div className="mt-3 space-y-3">
      {voice.quote.voiceFallback ? <p className="text-xs text-white/75">This Character&apos;s own voice is not available for calls yet, so this call uses the standard voice.</p> : null}
      <p className="text-xs text-white/75">{voice.quote.allowanceMinutes > 0 ? `${(voice.quote.remainingAllowanceMs / 60_000).toFixed(1)} of ${voice.quote.allowanceMinutes} included voice minutes left.` : "No included voice minutes."} Each reply beyond your remaining minutes costs {voice.quote.costPerReply} coins, up to {voice.quote.maxCostDreamcoins} coins total. Recognition and replies take a few seconds after each sentence.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => void voice.connect()}><Mic className="h-4 w-4" /> Accept &amp; connect microphone</button>
        <button type="button" className={button} disabled={busy} onClick={() => void voice.connect(false)}>Accept &amp; use recordings</button>
        <button type="button" className={button} disabled={busy} onClick={voice.cancelQuote}>Cancel</button>
      </div>
    </div> : null}
    {voice.active && current ? <div className="mt-3 flex flex-wrap items-center gap-2">
      {current.status === "disconnected" ? <>
        <button type="button" className={button} disabled={busy} onClick={() => void voice.resume()}><Mic className="h-4 w-4" /> Resume microphone</button>
        <button type="button" className={button} disabled={busy} onClick={() => void voice.resume(false)}>Resume with recordings</button>
      </> : controlled ? <>
        <button type="button" className={button} disabled={busy} onClick={() => void voice.toggleMute()}>{current.status === "muted" ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}{current.status === "muted" ? "Unmute" : "Mute"}</button>
        <button type="button" className={button} disabled={current.status !== "active" || busy} onClick={() => void voice.interrupt()}><Square className="h-4 w-4" /> Interrupt / next sentence</button>
        {voice.microphoneActive ? <>
          <button type="button" className={button} disabled={voice.phase !== "listening"} onClick={voice.finishSentence}>Send sentence</button>
          {voice.microphonePaused ? <button type="button" className={button} disabled={voice.phase !== "listening"} onClick={voice.discardSentence}>Discard and keep listening</button> : null}
        </> : null}
        <label className={`${button} cursor-pointer ${current.status !== "active" || ["thinking", "speaking"].includes(voice.phase) ? "pointer-events-none opacity-40" : ""}`}>
          Send recording
          <input aria-label="Send English call recording" aria-describedby={recordingHelpId} className="sr-only" type="file" accept={recordingFormats} disabled={current.status !== "active" || ["thinking", "speaking"].includes(voice.phase)}
            onChange={event => { const file = event.currentTarget.files?.[0]; if (file) voice.submitRecording(file); event.currentTarget.value = ""; }} />
        </label>
      </> : <p className="text-xs text-white/60">Another tab controls this call. Wait for it to disconnect before resuming.</p>}
      <button type="button" className={`${button} text-rose-300`} disabled={!controlled || busy} onClick={() => void voice.end()}><PhoneOff className="h-4 w-4" /> End call</button>
      <button type="button" className={button} onClick={() => void voice.refresh()}>Check status</button>
      {voice.phase === "error" && controlled ? <button type="button" className={button} onClick={voice.retry}>Retry original turn</button> : null}
    </div> : null}
    {voice.quote || voice.active ? <p id={recordingHelpId} className="mt-2 text-xs leading-5 text-white/55">English recordings: WAV, FLAC, MP3, Ogg/Opus, M4A/MP4/MOV, MKV/WebM or AAC. Up to 60 seconds and 8 MiB per recording.</p> : null}
    {voice.notice ? <p role={voice.phase === "error" ? "alert" : "status"} className="mt-3 text-xs text-white/70">{voice.notice}</p> : null}
  </section>;
}
