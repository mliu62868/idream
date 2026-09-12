"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { groupChatMemberSchema, GROUP_CHAT_MAX_MEMBERS } from "@idream/shared/contracts";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { authHrefForTarget } from "./authRedirect";
import { chatFailureCopy } from "@/lib/chat-failure-copy";

const ownerScopeSchema = z.string().startsWith("user:");
const groupListSchema = z.object({
  ownerScope: ownerScopeSchema,
  groups: z.array(z.object({
    id: z.string().min(1), title: z.string(), status: z.enum(["active", "archived"]),
    members: z.array(groupChatMemberSchema),
  })),
});
const candidateSchema = z.object({ id: z.string().min(1), name: z.string(), description: z.string(), owned: z.boolean() });
const candidatesSchema = z.object({ ownerScope: ownerScopeSchema, items: z.array(candidateSchema), nextCursor: z.string().nullable() });
type Candidate = z.infer<typeof candidateSchema>;
type Group = z.infer<typeof groupListSchema>["groups"][number];
const button = "min-h-11 rounded-full border border-white/20 px-4 py-2 text-sm font-bold hover:bg-white/10 disabled:opacity-40";

export function GroupChatManager() {
  const { accepted } = useAgeGateAccess();
  const [state, setState] = useState<"loading" | "ready" | "anonymous" | "error">("loading");
  const [groups, setGroups] = useState<Group[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Candidate[]>([]);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const owner = useRef<string | null>(null);
  const epoch = useRef(0);
  const candidateEpoch = useRef(0);

  const load = useCallback(async () => {
    const current = ++epoch.current;
    candidateEpoch.current += 1;
    setState("loading");
    setStatus("");
    try {
      const response = await fetch("/api/v1/chat/groups", { cache: "no-store" });
      if (current !== epoch.current) return;
      if (response.status === 401) {
        owner.current = null; setGroups([]); setCandidates([]); setSelected([]); setState("anonymous"); return;
      }
      if (!response.ok) throw new Error("Group chats could not load");
      const result = groupListSchema.parse(await response.json());
      if (current !== epoch.current) return;
      if (owner.current !== result.ownerScope) { setSelected([]); setTitle(""); setQuery(""); }
      owner.current = result.ownerScope;
      setGroups(result.groups);
      const picker = await fetch("/api/v1/chat/groups/candidates", { cache: "no-store" });
      if (!picker.ok) throw new Error("Available Characters could not load");
      const choices = candidatesSchema.parse(await picker.json());
      if (current !== epoch.current) return;
      if (choices.ownerScope !== owner.current) throw new Error("Your account changed. Reload your group chats");
      setCandidates(choices.items); setCursor(choices.nextCursor); setCandidateBusy(false); setState("ready");
    } catch (error) {
      if (current === epoch.current) { setGroups([]); setCandidates([]); setSelected([]); owner.current = null; setState("error"); setStatus(error instanceof Error ? error.message : "Group chats could not load"); }
    }
  }, []);

  useEffect(() => {
    if (!accepted) return;
    const timer = window.setTimeout(() => void load(), 0);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => { epoch.current += 1; candidateEpoch.current += 1; window.clearTimeout(timer); window.removeEventListener("focus", focus); };
  }, [accepted, load]);

  async function search(more = false) {
    if (!owner.current) return;
    const current = ++candidateEpoch.current;
    const actor = owner.current;
    setCandidateBusy(true); setStatus("");
    try {
      const params = new URLSearchParams({ q: query });
      if (more && cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/v1/chat/groups/candidates?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Characters could not load. Try again");
      const result = candidatesSchema.parse(await response.json());
      if (current !== candidateEpoch.current || actor !== owner.current) return;
      if (result.ownerScope !== actor) { void load(); return; }
      setCandidates(previous => more ? [...new Map([...previous, ...result.items].map(item => [item.id, item])).values()] : result.items);
      setCursor(result.nextCursor);
    } catch (error) { if (current === candidateEpoch.current) setStatus(error instanceof Error ? error.message : "Characters could not load"); }
    finally { if (current === candidateEpoch.current) setCandidateBusy(false); }
  }

  async function create() {
    const actor = owner.current;
    if (!actor || pending || selected.length < 2 || selected.length > GROUP_CHAT_MAX_MEMBERS || !title.trim()) return;
    setPending(true); setStatus("");
    try {
      const response = await fetch("/api/v1/chat/groups", {
        method: "POST", headers: { "content-type": "application/json", "x-idream-viewer-scope": actor },
        body: JSON.stringify({ title: title.trim(), characterIds: selected.map(item => item.id) }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (actor !== owner.current) return;
      if (!response.ok) { setStatus(chatFailureCopy(payload, "This group could not be created. Check the Characters and try again.")); return; }
      const created = z.object({ ok: z.literal(true), data: z.object({ group: z.object({ id: z.string().min(1) }) }) }).parse(payload);
      window.location.assign(`/chat/groups/${encodeURIComponent(created.data.group.id)}`);
    } catch { setStatus("The result could not be confirmed. Reload your group chats before creating another one."); }
    finally { setPending(false); }
  }

  async function changeGroup(group: Group, deleting: boolean) {
    const actor = owner.current;
    if (!actor || pending) return;
    if (deleting && confirmDelete !== group.id) { setConfirmDelete(group.id); return; }
    setPending(true); setStatus("");
    try {
      const response = await fetch(`/api/v1/chat/groups/${encodeURIComponent(group.id)}`, {
        method: deleting ? "DELETE" : "PATCH", headers: { "content-type": "application/json" },
        ...(deleting ? {} : { body: JSON.stringify({ status: "archived" }) }),
      });
      if (actor !== owner.current) return;
      if (!response.ok) { setStatus(chatFailureCopy(await response.json().catch(() => null), "The group could not be updated")); return; }
      setConfirmDelete(null);
      await load();
    } catch { setStatus("The result could not be confirmed. Reload to check the group."); }
    finally { setPending(false); }
  }

  return <main className="min-h-screen bg-[rgb(13,13,13)] text-white"><div className="flex min-h-screen">
    <AppSidebar activeHref="/chat" />
    <section className="min-w-0 flex-1 px-4 py-8 pb-24 md:px-[60px]">
      <Link className="text-sm font-bold text-white/65 underline" href="/chat">Your chats</Link>
      <h1 className="mt-4 text-3xl font-black uppercase">Group chats</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-white/65">Bring 2–12 Characters into one conversation. Choose who replies each time; every Character keeps their own identity and memory.</p>
      {state === "loading" ? <p role="status" className="mt-6">Loading your group chats…</p> : null}
      {state === "anonymous" ? <Link className={`${button} mt-6 inline-flex items-center`} href={authHrefForTarget("/login", "/chat/groups")}>Log in to create a group</Link> : null}
      {state === "error" ? <button className={`${button} mt-6`} onClick={() => void load()}>Reload group chats</button> : null}
      {state === "ready" ? <div className="mt-7 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
        <section aria-label="Create a group chat" className="rounded-2xl border border-white/10 bg-[rgb(18,18,18)] p-5">
          <h2 className="text-xl font-bold">Create a group</h2>
          <label className="mt-4 block text-sm font-bold">Group name<input className="mt-2 block min-h-11 w-full rounded-lg bg-white/10 px-3" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>
          <form className="mt-4 flex gap-2" onSubmit={event => { event.preventDefault(); void search(); }}>
            <input aria-label="Search Characters for group" className="min-h-11 min-w-0 flex-1 rounded-lg bg-white/10 px-3 text-sm" value={query} maxLength={80} onChange={event => setQuery(event.target.value)} placeholder="Find a Character" />
            <button className={button} disabled={candidateBusy} type="submit">Search</button>
          </form>
          <p className="mt-4 text-sm font-bold" aria-live="polite">{selected.length} of {GROUP_CHAT_MAX_MEMBERS} selected</p>
          {selected.length ? <ul aria-label="Selected group members" className="mt-2 flex flex-wrap gap-2">{selected.map(item => <li key={item.id}><button className="min-h-9 rounded-full bg-white px-3 text-xs font-bold text-black" onClick={() => setSelected(previous => previous.filter(candidate => candidate.id !== item.id))} disabled={pending}>{item.name} ×<span className="sr-only"> Remove</span></button></li>)}</ul> : null}
          <div className="mt-3 grid max-h-[400px] gap-2 overflow-y-auto sm:grid-cols-2" aria-label="Available group Characters">
            {candidates.map(item => <label key={item.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 p-3 hover:bg-white/5">
              <input className="mt-1 size-4 shrink-0 accent-pink-400" type="checkbox" checked={selected.some(candidate => candidate.id === item.id)} disabled={pending || (!selected.some(candidate => candidate.id === item.id) && selected.length >= GROUP_CHAT_MAX_MEMBERS)}
                onChange={event => setSelected(previous => event.target.checked ? [...previous, item] : previous.filter(candidate => candidate.id !== item.id))} />
              <span className="min-w-0"><span className="block text-sm font-bold">{item.name}</span><span className="mt-1 block text-xs leading-5 text-white/60">{item.owned ? "Your Character" : "Public Character"} · {item.description}</span></span>
            </label>)}
          </div>
          {!candidates.length ? <p className="mt-4 text-sm text-white/65">No available Characters match this search.</p> : null}
          {cursor ? <button className={`${button} mt-3`} disabled={candidateBusy} onClick={() => void search(true)}>Load more Characters</button> : null}
          <button className="mt-5 min-h-11 rounded-full bg-white px-6 text-sm font-bold text-black disabled:opacity-40" disabled={pending || selected.length < 2 || !title.trim()} onClick={() => void create()}>{pending ? "Saving…" : "Create group chat"}</button>
        </section>
        <section aria-label="Your saved group chats"><h2 className="text-xl font-bold">Your groups</h2>
          {!groups.length ? <p className="mt-4 text-sm text-white/65">Your new group will appear here with its full conversation history.</p> : null}
          <ul className="mt-4 space-y-3">{groups.map(group => <li key={group.id} className="rounded-xl border border-white/10 p-4">
            <Link className="text-lg font-bold underline-offset-4 hover:underline" href={`/chat/groups/${encodeURIComponent(group.id)}`}>{group.title}</Link>
            <p className="mt-2 text-sm leading-6 text-white/65">{group.members.map(member => member.name).join(" · ")}</p>
            {group.status === "archived" ? <p className="mt-2 text-xs font-bold text-white/60">Archived · history available</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {group.status === "active" ? <button className={button} disabled={pending} onClick={() => void changeGroup(group, false)}>Archive</button> : null}
              <button className={button} disabled={pending} onClick={() => void changeGroup(group, true)}>{confirmDelete === group.id ? "Confirm delete group and history" : "Delete group"}</button>
              {confirmDelete === group.id ? <button className={button} onClick={() => setConfirmDelete(null)}>Keep group</button> : null}
            </div>
          </li>)}</ul>
        </section>
      </div> : null}
      {status ? <p role="status" className="mt-5 text-sm text-pink-300">{status}</p> : null}
    </section>
  </div><MobileBottomNav activeHref="/chat" /></main>;
}
