"use client";

import { useEffect, useRef, useState } from "react";
import {
  CHAT_INSTRUCTION_MAX_CHARS,
  CHAT_PIN_LIMIT,
  CHAT_PIN_MAX_CHARS,
  chatContextDirectiveSchema,
  chatContextDirectivesSchema,
  type ChatContextDirective,
} from "@idream/shared/contracts";

const inputClass = "mt-2 w-full rounded-xl border border-white/10 bg-[rgb(28,28,28)] p-3 text-[13px] text-white disabled:opacity-50";
const buttonClass = "rounded-full border border-white/10 px-3 py-1.5 text-[12px] font-semibold disabled:opacity-40";

// Settings are explicit user context. They never masquerade as automatically learned memory.
export function ChatContextSettings({ sessionId, memoryEnabled }: Readonly<{ sessionId: string; memoryEnabled: boolean }>) {
  const [items, setItems] = useState<ChatContextDirective[]>([]);
  const [pinText, setPinText] = useState("");
  const [editingPin, setEditingPin] = useState<ChatContextDirective | null>(null);
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const scope = useRef(0);
  const requestKeys = useRef(new Map<string, string>());
  const base = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/context-directives`;

  useEffect(() => {
    const epoch = ++scope.current;
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const raw = await readResponse(await fetch(base, { cache: "no-store", signal: controller.signal }));
        const next = chatContextDirectivesSchema.parse(raw.items);
        if (scope.current !== epoch) return;
        setItems(next);
        setLoaded(true);
        setInstructions(next.find((item) => item.kind === "custom_instruction")?.content ?? "");
        setPinText("");
        setEditingPin(null);
      } catch (cause) {
        if (scope.current === epoch) setError(cause instanceof Error ? cause.message : "Couldn't load your settings.");
      } finally {
        if (scope.current === epoch) setLoading(false);
      }
    })();
    return () => { scope.current += 1; controller.abort(); };
  }, [base, reload]);

  const custom = items.find((item) => item.kind === "custom_instruction");
  const pins = items.filter((item) => item.kind === "pinned_memory");
  const disabled = loading || pending || !loaded;

  async function save(kind: ChatContextDirective["kind"], content: string, prior?: ChatContextDirective | null) {
    const epoch = scope.current;
    const intent = JSON.stringify([kind, content.trim()]);
    let key = requestKeys.current.get(intent);
    if (!key) { key = crypto.randomUUID(); requestKeys.current.set(intent, key); }
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const raw = await readResponse(await fetch(prior ? `${base}/${encodeURIComponent(prior.id)}` : base, {
        method: prior ? "PATCH" : "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(prior ? { content, version: prior.version } : { kind, content }),
      }));
      const saved = chatContextDirectiveSchema.parse(raw.item);
      if (scope.current !== epoch) return;
      setItems((current) => current.some((item) => item.id === saved.id)
        ? current.map((item) => item.id === saved.id ? saved : item)
        : [...current, saved]);
      requestKeys.current.delete(intent);
      if (kind === "pinned_memory") { setPinText(""); setEditingPin(null); }
      else setInstructions(saved.content);
      setNotice("Saved for future messages.");
    } catch (cause) {
      if (scope.current === epoch) setError(cause instanceof Error ? cause.message : "Couldn't save this setting.");
    } finally {
      if (scope.current === epoch) setPending(false);
    }
  }

  async function remove(item: ChatContextDirective) {
    const epoch = scope.current;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await readResponse(await fetch(`${base}/${encodeURIComponent(item.id)}`, {
        method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: item.version }),
      }));
      if (scope.current !== epoch) return;
      setItems((current) => current.filter((row) => row.id !== item.id));
      if (item.kind === "custom_instruction") setInstructions("");
      if (editingPin?.id === item.id) { setPinText(""); setEditingPin(null); }
      setNotice("Removed from future messages. Past chats stay unchanged.");
    } catch (cause) {
      if (scope.current === epoch) setError(cause instanceof Error ? cause.message : "Couldn't remove this setting.");
    } finally {
      if (scope.current === epoch) setPending(false);
    }
  }

  return (
    <section className="my-4 space-y-4 border-y border-white/10 py-4" aria-label="Your saved chat context">
      <div>
        <h3 className="text-[13px] font-bold">Pinned memories <span className="font-normal text-[rgb(170,170,170)]">{pins.length}/{CHAT_PIN_LIMIT}</span></h3>
        <p className="mt-1 text-[12px] leading-4 text-[rgb(170,170,170)]">
          Facts saved by you for this character, included in each new message while memory is on. Removing a pin does not erase past chats or facts learned from them; use Clear memory to reset those.
        </p>
        {!memoryEnabled ? <p className="mt-2 text-[12px]">Pins are paused for new messages while memory is off.</p> : null}
        {pins.map((item) => (
          <div key={item.id} className="mt-3 rounded-xl bg-white/5 p-3">
            <p className="whitespace-pre-wrap break-words text-[13px]">{item.content}</p>
            <p className="mt-1 text-[11px] text-[rgb(170,170,170)]">Saved by you · Version {item.version}</p>
            <div className="mt-2 flex gap-2">
              <button className={buttonClass} disabled={disabled} onClick={() => { setEditingPin(item); setPinText(item.content); }} type="button">Edit pin</button>
              <button className={buttonClass} disabled={disabled} onClick={() => void remove(item)} type="button">Remove pin</button>
            </div>
          </div>
        ))}
        <textarea aria-label="Pinned memory" className={inputClass} disabled={disabled} maxLength={CHAT_PIN_MAX_CHARS} onChange={(event) => setPinText(event.target.value)} placeholder="A fact you want this character to keep in context" rows={3} value={pinText} />
        <div className="mt-2 flex gap-2">
          <button className={buttonClass} disabled={disabled || !pinText.trim() || (!editingPin && pins.length >= CHAT_PIN_LIMIT)} onClick={() => void save("pinned_memory", pinText, editingPin)} type="button">{editingPin ? "Save pin" : "Add pin"}</button>
          {editingPin ? <button className={buttonClass} disabled={disabled} onClick={() => { setEditingPin(null); setPinText(""); }} type="button">Cancel edit</button> : null}
        </div>
      </div>
      <div>
        <h3 className="text-[13px] font-bold">Custom instructions</h3>
        <p className="mt-1 text-[12px] leading-4 text-[rgb(170,170,170)]">Your interaction preferences for this character, including new chats. These remain active with memory off; they cannot change the character&apos;s identity or authorize media generation.</p>
        {custom ? <p className="mt-1 text-[11px] text-[rgb(170,170,170)]">Saved by you · Version {custom.version}</p> : null}
        <textarea aria-label="Custom instructions" className={inputClass} disabled={disabled} maxLength={CHAT_INSTRUCTION_MAX_CHARS} onChange={(event) => setInstructions(event.target.value)} placeholder="How would you like to interact?" rows={4} value={instructions} />
        <div className="mt-2 flex gap-2">
          <button className={buttonClass} data-testid="chat-instructions-save" disabled={disabled || !instructions.trim() || instructions.trim() === custom?.content} onClick={() => void save("custom_instruction", instructions, custom)} type="button">Save instructions</button>
          {custom ? <button className={buttonClass} disabled={disabled} onClick={() => void remove(custom)} type="button">Remove instructions</button> : null}
        </div>
      </div>
      <p className="text-[12px] leading-4 text-[rgb(170,170,170)]">Changes apply to new messages. Editing or regenerating an existing message keeps its original saved context. Clear memory removes pins and resets learned memory; custom instructions stay until you remove them.</p>
      {loading ? <p className="text-[12px]" role="status">Loading your settings…</p> : null}
      {notice ? <p className="text-[12px]" role="status">{notice}</p> : null}
      {error ? <div role="alert" className="text-[12px] text-[rgb(255,138,128)]"><p>{error}</p><button className={`${buttonClass} mt-2`} disabled={pending} onClick={() => setReload((value) => value + 1)} type="button">Reload settings</button></div> : null}
    </section>
  );
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const raw: unknown = await response.json().catch(() => null);
  const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!response.ok) {
    const error = object?.error;
    const message = error && typeof error === "object" && "message" in error ? error.message : null;
    throw new Error(typeof message === "string" ? message : "Couldn't load or save your chat settings. Please try again.");
  }
  if (!object) throw new Error("Chat settings response was incomplete.");
  return object;
}
