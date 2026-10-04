"use client";

import { useEffect, useRef, useState } from "react";
import { chatExperienceValuesSchema, conversationProfileCatalogSchema, DEFAULT_CHAT_EXPERIENCE } from "@idream/shared/contracts";
import { z } from "zod";

const responseSchema = z.object({
  settings: chatExperienceValuesSchema.extend({ version: z.number().int().nonnegative() }).strict(),
  editable: z.boolean(),
  catalog: conversationProfileCatalogSchema,
}).strict();
type Settings = z.infer<typeof responseSchema>["settings"];

// SPEC: 每次改动立即保存；保存失败时保留用户选择，并给出重试 / 重新加载。
// INTENT: 原来改了下拉要再点一个 Save，按钮常被 sticky 输入区盖住或在视口外，不点就静默丢弃，
//   下拉却已显示新值（如「Custom preferences」）像已生效（审计 adv-b#1）。这里的设置不扣费、
//   只影响之后的新消息、服务端有版本号兜冲突，所以「改即存」最简单且不丢输入；保存期间下拉禁用，
//   避免两次 PUT 拿同一个版本号互相冲突。
export function ConversationPreferences({ sessionId }: Readonly<{ sessionId: string }>) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings>(DEFAULT_CHAT_EXPERIENCE);
  const [editable, setEditable] = useState(false);
  const [catalog, setCatalog] = useState<z.infer<typeof conversationProfileCatalogSchema> | null>(null);
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
        setCatalog(result.catalog);
      } catch (cause) {
        if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : "Conversation preferences could not load.");
      }
    })();
    return () => { epochRef.current += 1; controller.abort(); };
  }, [path, reload]);

  function change(next: Settings) {
    setDraft(next);
    void save(next);
  }

  async function save(next: Settings) {
    if (!saved || pending || !editable) return;
    const epoch = epochRef.current;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await readResponse(await fetch(path, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...next, version: saved.version,
          conversationProfile: next.conversationProfile ? { id: next.conversationProfile.id, version: next.conversationProfile.version } : undefined,
        }),
      }));
      if (epoch !== epochRef.current) return;
      setSaved(result.settings);
      setDraft(result.settings);
      setEditable(result.editable);
      setCatalog(result.catalog);
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
  const unchanged = draft.responseLength === saved?.responseLength && draft.interactionIntensity === saved?.interactionIntensity && draft.sceneGeneration === saved?.sceneGeneration && draft.conversationProfile?.id === saved?.conversationProfile?.id && draft.conversationProfile?.version === saved?.conversationProfile?.version;
  const selectedProfile = catalog?.items.find(item => item.id === draft.conversationProfile?.id);
  return (
    <details className="mt-3 rounded-xl border border-white/10 bg-[rgb(24,24,24)] px-4 py-3 text-[13px]">
      <summary className="cursor-pointer font-semibold text-[rgb(190,190,190)]">Conversation preferences</summary>
      <label className="mt-4 grid gap-2 font-semibold">Conversation profile
        <select aria-label="Conversation profile" className="rounded-lg bg-[rgb(40,40,40)] px-3 py-2 disabled:opacity-50" disabled={disabled || !catalog} value={draft.conversationProfile?.id ?? "custom"}
          onChange={event => {
            const entry = catalog?.items.find(item => item.id === event.target.value);
            change(entry ? { ...draft, ...entry.preferences, conversationProfile: {
              id: entry.id, version: entry.version, replyStyle: entry.replyStyle, answerMaxOutputTokens: entry.answerMaxOutputTokens,
              messageUnits: entry.messageUnits, costDreamcoins: entry.costDreamcoins,
            } } : { ...draft, conversationProfile: undefined });
          }}>
          {catalog?.items.map(item => <option key={`${item.id}:${item.version}`} value={item.id}>{item.label}</option>)}
          <option value="custom">Custom preferences</option>
        </select>
        <span className="text-[12px] font-normal text-[rgb(170,170,170)]">{selectedProfile?.description ?? "Choose your own reply length, style and scene direction."} 1 message · 0 Dreamcoins. Images, video and voice keep their displayed prices.</span>
      </label>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 font-semibold">Reply length
          <select aria-label="Reply length" className="rounded-lg bg-[rgb(40,40,40)] px-3 py-2 disabled:opacity-50" disabled={disabled} value={draft.responseLength}
            onChange={event => change({ ...draft, conversationProfile: undefined, responseLength: chatExperienceValuesSchema.shape.responseLength.parse(event.target.value) })}>
            <option value="auto">Natural</option><option value="short">Brief</option><option value="long">Detailed</option>
          </select>
          <span className="text-[12px] font-normal text-[rgb(170,170,170)]">Natural follows the conversation. Brief favors a few sentences; Detailed gives room for richer replies.</span>
        </label>
        <label className="grid gap-2 font-semibold">Interaction style
          <select aria-label="Interaction style" className="rounded-lg bg-[rgb(40,40,40)] px-3 py-2 disabled:opacity-50" disabled={disabled} value={draft.interactionIntensity}
            onChange={event => change({ ...draft, conversationProfile: undefined, interactionIntensity: chatExperienceValuesSchema.shape.interactionIntensity.parse(event.target.value) })}>
            <option value="gentle">Gentle</option><option value="balanced">Balanced</option><option value="expressive">Expressive</option>
          </select>
          <span className="text-[12px] font-normal text-[rgb(170,170,170)]">Choose understated, natural, or more vivid expression within this character&apos;s personality.</span>
        </label>
        <label className="grid gap-2 font-semibold md:col-span-2">Scene direction
          <select aria-label="Scene direction" className="rounded-lg bg-[rgb(40,40,40)] px-3 py-2 disabled:opacity-50" disabled={disabled} value={draft.sceneGeneration}
            onChange={event => change({ ...draft, conversationProfile: undefined, sceneGeneration: chatExperienceValuesSchema.shape.sceneGeneration.parse(event.target.value) })}>
            <option value="follow">Follow my lead</option><option value="advance">Gently advance</option>
          </select>
          <span className="text-[12px] font-normal text-[rgb(170,170,170)]">Follow keeps the scene on your course. Gently advance invites a small character action or scene detail, leaving your choices to you. This does not generate images.</span>
        </label>
      </div>
      <p className="mt-3 text-[12px] text-[rgb(170,170,170)]">Applies to new messages here, including with memory off. Editing or regenerating a message keeps its original preferences. New chats start with Natural. Changing individual preferences creates a custom profile.</p>
      <div className="mt-3 flex items-center gap-3">
        {pending ? <span role="status">Saving…</span>
          : !saved ? (!error ? <span role="status">Loading preferences…</span> : null)
          : unchanged ? <span className="text-[12px] text-[rgb(170,170,170)]">{saved.version ? "Saved preferences" : "Default preferences"}</span>
          : <>
            <span className="text-[12px] text-[rgb(255,168,206)]">Not saved yet</span>
            <button className="rounded-full bg-white/10 px-4 py-2 font-semibold disabled:opacity-40" disabled={disabled} onClick={() => void save(draft)} type="button">Try saving again</button>
          </>}
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
    // The Chat façade answers { error: code, message }; its 409/410 messages
    // (archived chat, changed elsewhere) are written for the reader.
    const parsed = z.object({ message: z.string() }).safeParse(raw);
    throw new Error(parsed.success && (response.status === 409 || response.status === 410)
      ? parsed.data.message
      : "Conversation preferences could not load or save. Please try again.");
  }
  return responseSchema.parse(raw);
}
