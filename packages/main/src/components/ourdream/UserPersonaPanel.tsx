"use client";

import { useEffect, useRef, useState } from "react";
import { CHAT_PERSONA_MAX_CHARS, userChatPersonaResponseSchema } from "@idream/shared/contracts";
import { z } from "zod";

type Settings = z.infer<typeof userChatPersonaResponseSchema>;
const emptyDraft = { enabled: true, name: "", description: "" };
const path = "/api/v1/profile/chat-persona";

/** Reads and writes must match the account already confirmed by the profile page. */
export function UserPersonaPanel({ ownerScope }: { ownerScope: string }) {
  // React discards every draft and pending state before the new account renders.
  return <PersonaSettings key={ownerScope} ownerScope={ownerScope} />;
}

function PersonaSettings({ ownerScope }: { ownerScope: string }) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [accountChanged, setAccountChanged] = useState(false);
  const [reload, setReload] = useState(0);
  const epochRef = useRef(0);
  useEffect(() => {
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    void (async () => {
      try {
        const settings = await readResponse(await fetch(path, { cache: "no-store", signal: controller.signal }));
        if (epoch !== epochRef.current) return;
        if (settings.ownerScope !== ownerScope) {
          setAccountChanged(true);
          throw new Error("The signed-in account changed. Reload this page before editing your persona");
        }
        setSaved(settings);
        setDraft(settings.persona ?? emptyDraft);
      } catch (cause) {
        if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : "Your persona could not load.");
      }
    })();
    return () => { epochRef.current += 1; controller.abort(); };
  }, [ownerScope, reload]);

  async function save(clear = false) {
    if (!saved || saved.ownerScope !== ownerScope || pending || accountChanged) return;
    const epoch = epochRef.current;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(path, {
        method: clear ? "DELETE" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(clear ? { ownerScope: saved.ownerScope, version: saved.version } : {
          enabled: draft.enabled, name: draft.name, description: draft.description, ownerScope: saved.ownerScope, version: saved.version,
        }),
      });
      if (epoch !== epochRef.current) return;
      if (response.status === 403) {
        setSaved(null);
        setDraft(emptyDraft);
        setAccountChanged(true);
      }
      const settings = await readResponse(response);
      if (epoch !== epochRef.current) return;
      if (settings.ownerScope !== saved.ownerScope) throw new Error("The signed-in account changed. Reload this page before editing your persona");
      setSaved(settings);
      setDraft(settings.persona ?? emptyDraft);
      setNotice(settings.persona?.enabled ? "Persona saved for new messages across your chats." : "New messages will not use your persona.");
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : "Your persona could not save.");
    } finally {
      if (epoch === epochRef.current) setPending(false);
    }
  }

  function reloadSettings() {
    setSaved(null);
    setDraft(emptyDraft);
    setError("");
    setNotice("");
    setReload(value => value + 1);
  }

  const disabled = !saved || pending;
  const current = saved?.persona ?? emptyDraft;
  const unchanged = draft.name === current.name && draft.description === current.description && draft.enabled === current.enabled;
  return (
    <details className="mt-4 rounded-[10px] border border-white/10 p-3 text-[13px]" id="chat-persona">
      <summary className="cursor-pointer font-semibold">Your chat persona</summary>
      <p className="mt-3 text-[12px] text-[rgb(170,170,170)]">Tell characters about the person you play. This is your own description, shared across your chats, separate from memories each character learns.</p>
      <div className="mt-3 grid gap-3">
        <label className="grid gap-2">Persona name
          <input aria-label="Persona name" className="rounded-lg bg-[rgb(36,36,36)] px-3 py-2" disabled={disabled} maxLength={80} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} value={draft.name} />
        </label>
        <label className="grid gap-2">About your persona
          <textarea aria-label="About your persona" className="min-h-24 resize-y rounded-lg bg-[rgb(36,36,36)] px-3 py-2" disabled={disabled} maxLength={CHAT_PERSONA_MAX_CHARS} onChange={event => setDraft(value => ({ ...value, description: event.target.value }))} placeholder="Your background, interests, or how you would like to be addressed" value={draft.description} />
        </label>
        <label className="flex items-center gap-2"><input aria-label="Use my persona in chats" checked={draft.enabled} disabled={disabled} onChange={event => setDraft(value => ({ ...value, enabled: event.target.checked }))} type="checkbox" />Use my persona in chats</label>
      </div>
      <p className="mt-3 text-[12px] text-[rgb(170,170,170)]">Applies to new messages, including with memory off. Editing or regenerating keeps that message&apos;s original persona. Clearing a character&apos;s memory leaves this profile setting intact. Disable or clear it here to stop using it in future messages.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button className="rounded-full bg-white/10 px-4 py-2 font-semibold disabled:opacity-40" disabled={disabled || unchanged || !(draft.name.trim() || draft.description.trim())} onClick={() => void save()} type="button">{pending ? "Saving…" : "Save persona"}</button>
        {saved?.persona ? <button className="px-2 py-2 underline disabled:opacity-40" disabled={disabled} onClick={() => void save(true)} type="button">Clear persona</button> : null}
      </div>
      {!saved && !error ? <p className="mt-3" role="status">Loading persona…</p> : null}
      {notice ? <p className="mt-3" role="status">{notice}</p> : null}
      {error ? <div className="mt-3 text-[rgb(255,168,206)]" role="alert"><p>{error}</p><button className="mt-2 underline" disabled={pending} onClick={accountChanged ? () => window.location.reload() : reloadSettings} type="button">{accountChanged ? "Reload this page" : "Reload persona"}</button></div> : null}
    </details>
  );
}

async function readResponse(response: Response): Promise<Settings> {
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(raw);
    throw new Error(parsed.success ? parsed.data.error.message : "Your persona could not load or save. Please try again.");
  }
  return z.object({ ok: z.literal(true), data: userChatPersonaResponseSchema }).parse(raw).data;
}
