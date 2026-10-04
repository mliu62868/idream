"use client";

import { Mic, MicOff, Phone, PhoneOff, Square } from "lucide-react";
import { useId, useState } from "react";
import Link from "next/link";
import type { VoiceCallController } from "@/hooks/useVoiceCall";

const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/20 px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40";
// Keep this chooser aligned with the existing gateway container whitelist;
// uploaded bytes are still validated by its bounded server-side decoder.
const recordingFormats = ".wav,.flac,.mp3,.ogg,.oga,.opus,.m4a,.mp4,.mov,.mkv,.mka,.webm,.aac,audio/wav,audio/x-wav,audio/flac,audio/mpeg,audio/ogg,audio/mp4,audio/webm,audio/aac";

export function VoiceCallControls({ voice, disabled }: { voice: VoiceCallController; disabled: boolean }) {
  const [budget, setBudget] = useState(2);
  const recordingHelpId = useId();
  if (!voice.available && !voice.call) return null;
  const current = voice.call;
  const controlled = Boolean(current?.leaseToken);
  const busy = ["quoting", "connecting"].includes(voice.phase);
  return <section aria-label="Voice call" className="mb-2 rounded-2xl border border-white/15 bg-white/[0.03] p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2 font-semibold"><Phone className="h-4 w-4" /> Voice call <span className="text-xs font-normal text-white/55">English · turn-based</span></span>
      {current ? <span className="text-xs text-white/65">{current.status} · {Math.floor(current.connectedMs / 1000)}s connected · {(current.voiceDurationMs / 60_000).toFixed(2)} voice min · {current.costDreamcoins}/{current.maxCostDreamcoins} coins</span> : null}
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
    <p id={recordingHelpId} className="mt-2 text-xs leading-5 text-white/55">English recordings: WAV, FLAC, MP3, Ogg/Opus, M4A/MP4/MOV, MKV/WebM or AAC. Up to 60 seconds and 8 MiB per recording.</p>
    {voice.notice ? <p role={voice.phase === "error" ? "alert" : "status"} className="mt-3 text-xs text-white/70">{voice.notice}</p> : null}
  </section>;
}
