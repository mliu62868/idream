"use client";

import { useEffect, useRef, useState } from "react";
import { chatExperienceValuesSchema } from "@idream/shared/contracts";
import { z } from "zod";

const responseSchema = z.object({
  settings: chatExperienceValuesSchema.extend({ version: z.number().int().nonnegative() }).strict(),
  editable: z.boolean(),
}).strict();
type Settings = z.infer<typeof responseSchema>["settings"];
const defaults: Settings = { responseLength: "auto", interactionIntensity: "balanced", version: 0 };

export function ConversationPreferences({ sessionId }: Readonly<{ sessionId: string }>) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings>(defaults);
  const [editable, setEditable] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const epochRef = useRef(0);
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/experience`;
  useEffect(() => {
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await readResponse(await fetch(path, { cache: "no-store", signal: controller.signal }));
        if (epoch !== epochRef.current) return;
        setSaved(result.settings);
        setDraft(result.settings);
        setEditable(result.editable);
      } catch (cause) {
        if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : "Conversation preferences could not load.");
      }
    })();
    return () => { epochRef.current += 1; controller.abort(); };
  }, [path, reload]);

  async function save() {
    if (!saved || pending || !editable) return;
    const epoch = epochRef.current;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await readResponse(await fetch(path, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, version: saved.version }),
      }));
      if (epoch !== epochRef.current) return;
      setSaved(result.settings);
      setDraft(result.settings);
      setEditable(result.editable);
      setNotice("Saved for new messages in this conversation.");
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : "Conversation preferences could not save.");
    } finally {
      if (epoch === epochRef.current) setPending(false);
    }
  }

  function reloadPreferences() {
    setSaved(null);
    setError("");
    setNotice("");
    setReload(value => value + 1);
  }

  const disabled = !saved || pending || !editable;
  const unchanged = draft.responseLength === saved?.responseLength && draft.interactionIntensity === saved?.interactionIntensity;
  return (
    <details className="mt-3 rounded-xl border border-white/10 bg-[rgb(24,24,24)] px-4 py-3 text-[13px]">
      <summary className="cursor-pointer font-semibold text-[rgb(190,190,190)]">Conversation preferences</summary>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 font-semibold">Reply length
          <select aria-label="Reply length" className="rounded-lg bg-[rgb(40,40,40)] px-3 py-2 disabled:opacity-50" disabled={disabled} value={draft.responseLength}
            onChange={event => setDraft(current => ({ ...current, responseLength: chatExperienceValuesSchema.shape.responseLength.parse(event.target.value) }))}>
            <option value="auto">Natural</option><option value="short">Brief</option><option value="long">Detailed</option>
          </select>
          <span className="text-[12px] font-normal text-[rgb(170,170,170)]">Natural follows the conversation. Brief favors a few sentences; Detailed gives room for richer replies.</span>
        </label>
        <label className="grid gap-2 font-semibold">Interaction style
          <select aria-label="Interaction style" className="rounded-lg bg-[rgb(40,40,40)] px-3 py-2 disabled:opacity-50" disabled={disabled} value={draft.interactionIntensity}
            onChange={event => setDraft(current => ({ ...current, interactionIntensity: chatExperienceValuesSchema.shape.interactionIntensity.parse(event.target.value) }))}>
            <option value="gentle">Gentle</option><option value="balanced">Balanced</option><option value="expressive">Expressive</option>
          </select>
          <span className="text-[12px] font-normal text-[rgb(170,170,170)]">Choose understated, natural, or more vivid expression within this character&apos;s personality.</span>
        </label>
      </div>
      <p className="mt-3 text-[12px] text-[rgb(170,170,170)]">Applies to new messages here, including with memory off. Editing or regenerating a message keeps its original preferences. New chats start with Natural and Balanced.</p>
      <div className="mt-3 flex items-center gap-3">
        <button className="rounded-full bg-white/10 px-4 py-2 font-semibold disabled:opacity-40" disabled={disabled || unchanged} onClick={() => void save()} type="button">{pending ? "Saving…" : "Save preferences"}</button>
        {saved ? <span className="text-[12px] text-[rgb(170,170,170)]">{saved.version ? "Saved preferences" : "Default preferences"}</span> : !error ? <span role="status">Loading preferences…</span> : null}
      </div>
      {saved && !editable ? <p className="mt-3 text-[12px]">This conversation is archived. Its preferences are read-only.</p> : null}
      {notice ? <p className="mt-3" role="status">{notice}</p> : null}
      {error ? <div className="mt-3 text-[rgb(255,168,206)]" role="alert"><p>{error}</p><button className="mt-2 underline" disabled={pending} onClick={reloadPreferences} type="button">Reload preferences</button></div> : null}
    </details>
  );
}

async function readResponse(response: Response) {
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(raw);
    throw new Error(parsed.success ? parsed.data.error.message : "Conversation preferences could not load or save. Please try again.");
  }
  return responseSchema.parse(raw);
}
