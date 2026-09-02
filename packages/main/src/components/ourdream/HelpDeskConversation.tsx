"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupportConversation } from "@idream/shared/contracts";
import { parseSupportConversationResponse, parseSupportReplyResponse, parseViewerAuthorityResponse } from "@/lib/public-api-contracts";
import { apiEnvelopeErrorMessage } from "@/lib/viewer-resource-client";

export function HelpDeskConversation({ ticketId, viewerScope, onReplied }: {
  ticketId: string;
  viewerScope: string;
  onReplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [conversation, setConversation] = useState<SupportConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const notifyReplied = useRef(onReplied);
  useEffect(() => { notifyReplied.current = onReplied; }, [onReplied]);
  const pendingReply = useRef<{ messageId: string; body: string } | null>(null);
  const request = useCallback(async (reply?: { messageId: string; body: string }) => {
    const current = ++serial.current;
    let accepted = false;
    setBusy(true); setError("");
    if (!reply) setConversation(null);
    try {
      // SPEC: Revalidate the account before sending a saved draft. Another tab
      // can change cookies while this conversation remains mounted.
      const viewerResponse = await fetch("/api/v1/me", { cache: "no-store" });
      if (current !== serial.current) return;
      const rawViewer: unknown = await viewerResponse.json();
      if (current !== serial.current) return;
      const viewer = viewerResponse.ok ? parseViewerAuthorityResponse(rawViewer).user : null;
      if (!viewer || `user:${viewer.id}` !== viewerScope) {
        setConversation(null); setDraft(""); pendingReply.current = null;
        throw new Error("Your account changed. Refresh Help Desk before replying.");
      }
      const path = `/api/v1/support/requests/${encodeURIComponent(ticketId)}`;
      const response = await fetch(reply ? `${path}/messages` : path, reply
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reply) }
        : { cache: "no-store" });
      const raw: unknown = await response.json();
      if (current !== serial.current) return;
      if (!response.ok) throw new Error(apiEnvelopeErrorMessage(raw) ?? "Could not load your support conversation.");
      setConversation((reply ? parseSupportReplyResponse(raw) : parseSupportConversationResponse(raw)).request);
      if (reply) { setDraft(""); pendingReply.current = null; accepted = true; }
    } catch (cause) {
      if (current === serial.current) setError(cause instanceof Error ? cause.message : "Could not load your support conversation.");
    } finally {
      if (current === serial.current) setBusy(false);
    }
    if (accepted && current === serial.current) notifyReplied.current();
  }, [ticketId, viewerScope]);

  useEffect(() => {
    const refresh = () => { if (open) void request(); };
    window.addEventListener("focus", refresh);
    return () => { serial.current += 1; window.removeEventListener("focus", refresh); };
  }, [open, request]);

  return <div className="mt-3 border-t border-white/10 pt-3">
    <button aria-expanded={open} className="font-bold text-white underline underline-offset-4" disabled={busy} onClick={() => {
      setOpen(!open);
      // Let the opening render install its viewer guard before the request.
    }} type="button">{open ? "Hide conversation" : "View conversation"}</button>
    {open ? <ConversationContent conversation={conversation} busy={busy} error={error} draft={draft} ticketId={ticketId}
      onLoad={() => void request()} onDraft={setDraft} onReply={() => {
        const body = draft.trim();
        if (!body || busy) return;
        if (pendingReply.current?.body !== body) pendingReply.current = { messageId: crypto.randomUUID(), body };
        void request(pendingReply.current);
      }} /> : null}
  </div>;
}

function ConversationContent({ conversation, busy, error, draft, ticketId, onLoad, onDraft, onReply }: {
  conversation: SupportConversation | null; busy: boolean; error: string; draft: string; ticketId: string;
  onLoad: () => void; onDraft: (value: string) => void; onReply: () => void;
}) {
  const initialLoad = useRef(onLoad);
  useEffect(() => { initialLoad.current(); }, []);
  return <div className="mt-3 space-y-3">
    {busy ? <p role="status">Loading conversation...</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!busy ? <button className="font-bold text-white" onClick={onLoad} type="button">Refresh conversation</button> : null}
    {conversation ? <>
      <p className="whitespace-pre-wrap break-words">{conversation.description}</p>
      <p>Status: {conversation.status.replaceAll("_", " ")}</p>
      {conversation.messages.map((message) => <div className="rounded-lg bg-white/5 p-3" key={message.id}>
        <p className="font-bold text-white">{message.author === "customer" ? "You" : "Support"} <time className="ml-2 font-normal text-white/50" dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString("en-US")}</time></p>
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
      </div>)}
      {conversation.canReply ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); onReply(); }}>
        <label className="block font-bold text-white">Reply to support
          <textarea aria-label={`Reply to ${ticketId}`} className="mt-2 min-h-24 w-full rounded-lg border border-white/10 bg-[rgb(36,36,36)] p-3 font-normal text-white" disabled={busy} maxLength={2000} onChange={(event) => onDraft(event.target.value)} value={draft} />
        </label>
        <button className="rounded-full bg-[rgb(253,95,194)] px-4 py-2 font-bold text-white disabled:opacity-50" disabled={busy || !draft.trim()} type="submit">Send reply</button>
      </form> : <p>This request is {conversation.status}. You can submit a new support request if you need more help.</p>}
    </> : null}
  </div>;
}
