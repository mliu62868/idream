"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { z } from "zod";
import { groupChatMemberSchema, GROUP_CHAT_MAX_MEMBERS } from "@idream/shared/contracts";
import { useViewerGate, type ViewerGate } from "@/hooks/useViewerGate";
import { useViewerResource } from "@/hooks/useViewerResource";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { authHrefForTarget } from "./authRedirect";
import { chatFailureCopy } from "@/lib/chat-failure-copy";

const groupListSchema = z.object({
  groups: z.array(z.object({
    id: z.string().min(1), title: z.string(), status: z.enum(["active", "archived"]),
    members: z.array(groupChatMemberSchema),
  })),
});
const candidateSchema = z.object({ id: z.string().min(1), name: z.string(), description: z.string(), owned: z.boolean() });
const candidatesSchema = z.object({ items: z.array(candidateSchema), nextCursor: z.string().nullable() });
type Candidate = z.infer<typeof candidateSchema>;
type CandidatePage = z.infer<typeof candidatesSchema>;
type Group = z.infer<typeof groupListSchema>["groups"][number];
const button = "min-h-11 rounded-full border border-white/20 px-4 py-2 text-sm font-bold hover:bg-white/10 disabled:opacity-40";

export function GroupChatManager() {
  const { accepted } = useAgeGateAccess();
  const viewer = useViewerGate();
  return <main className="min-h-screen bg-[rgb(13,13,13)] text-white"><div className="flex min-h-screen">
    <AppSidebar activeHref="/chat" />
    <section className="min-w-0 flex-1 px-4 py-8 pb-24 md:px-[60px]">
      <Link className="text-sm font-bold text-white/65 underline" href="/chat">Your chats</Link>
      <h1 className="mt-4 text-3xl font-black uppercase">Group chats</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-white/65">Bring 2–12 Characters into one conversation. Choose who replies each time; every Character keeps their own identity and memory.</p>
      {viewer.error ? <p role="alert" className="mt-6 text-sm text-pink-300">{viewer.error}</p> : null}
      {!viewer.error && viewer.identity === null ? <p role="status" className="mt-6">Loading your group chats…</p> : null}
      {viewer.identity?.kind === "anonymous" ? <Link className={`${button} mt-6 inline-flex items-center`} href={authHrefForTarget("/login", "/chat/groups")}>Log in to create a group</Link> : null}
      {/* INTENT: keyed on the confirmed owner. An account change discards every
          draft — the title, the search, the picked members — without this file
          keeping its own list of what a switch has to clear. */}
      {accepted && viewer.identity?.kind === "user"
        ? <GroupChats key={viewer.identity.scope} viewer={viewer} />
        : null}
    </section>
  </div><MobileBottomNav activeHref="/chat" /></main>;
}

function GroupChats({ viewer }: { viewer: ViewerGate }) {
  const [selected, setSelected] = useState<Candidate[]>([]);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const groups = useViewerResource({
    request: () => ({ path: "/api/v1/chat/groups", init: { cache: "no-store" } }),
    parse: (raw) => groupListSchema.parse(raw).groups,
    fallbackError: "Group chats could not load",
    initialData: [] as Group[],
    gate: viewer.gate,
  });
  const candidates = useViewerResource({
    request: (search: string) => ({
      path: `/api/v1/chat/groups/candidates?${new URLSearchParams({ q: search })}`,
      init: { cache: "no-store" },
    }),
    parse: (raw) => candidatesSchema.parse(raw),
    fallbackError: "Characters could not load. Try again",
    initialData: { items: [], nextCursor: null } as CandidatePage,
    gate: viewer.gate,
    snapshotKey: (search) => search,
    initialSnapshotKey: "",
  });

  const refreshGroups = groups.refresh;
  const refreshCandidates = candidates.refresh;
  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups, viewer.revalidation]);
  useEffect(() => {
    void refreshCandidates(searched);
  }, [refreshCandidates, searched, viewer.revalidation]);

  async function more() {
    const cursor = candidates.data.nextCursor;
    if (!cursor || pending) return;
    setPending(true);
    setStatus("");
    try {
      // The picker appends, which is the one shape `useViewerResource` does not
      // hold for us: it owns the page, this owns the running list.
      const response = await viewer.fetch(`/api/v1/chat/groups/candidates?${new URLSearchParams({ q: searched, cursor })}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Characters could not load. Try again");
      const page = candidatesSchema.parse(await response.json());
      candidates.setData((current) => ({
        items: [...new Map([...current.items, ...page.items].map((item) => [item.id, item])).values()],
        nextCursor: page.nextCursor,
      }));
    } catch (error) { setStatus(error instanceof Error ? error.message : "Characters could not load"); }
    finally { setPending(false); }
  }

  async function create() {
    if (pending || selected.length < 2 || selected.length > GROUP_CHAT_MAX_MEMBERS || !title.trim()) return;
    setPending(true); setStatus("");
    try {
      const response = await viewer.fetch("/api/v1/chat/groups", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), characterIds: selected.map(item => item.id) }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) { setStatus(chatFailureCopy(payload, "This group could not be created. Check the Characters and try again.")); return; }
      const created = z.object({ ok: z.literal(true), data: z.object({ group: z.object({ id: z.string().min(1) }) }) }).parse(payload);
      window.location.assign(`/chat/groups/${encodeURIComponent(created.data.group.id)}`);
    } catch { setStatus("The result could not be confirmed. Reload your group chats before creating another one."); }
    finally { setPending(false); }
  }

  async function changeGroup(group: Group, deleting: boolean) {
    if (pending) return;
    if (deleting && confirmDelete !== group.id) { setConfirmDelete(group.id); return; }
    setPending(true); setStatus("");
    try {
      const response = await viewer.fetch(`/api/v1/chat/groups/${encodeURIComponent(group.id)}`, {
        method: deleting ? "DELETE" : "PATCH",
        headers: { "content-type": "application/json" },
        ...(deleting ? {} : { body: JSON.stringify({ status: "archived" }) }),
      });
      if (!response.ok) { setStatus(chatFailureCopy(await response.json().catch(() => null), "The group could not be updated")); return; }
      setConfirmDelete(null);
      await groups.refresh();
    } catch { setStatus("The result could not be confirmed. Reload to check the group."); }
    finally { setPending(false); }
  }

  const failure = groups.status.error ?? candidates.status.error;
  if (failure) {
    return <>
      <button className={`${button} mt-6`} onClick={() => { void groups.refresh(); void candidates.refresh(searched); }}>Reload group chats</button>
      <p role="status" className="mt-5 text-sm text-pink-300">{failure}</p>
    </>;
  }
  if (!groups.status.hasSnapshot || !candidates.status.hasSnapshot) {
    return <p role="status" className="mt-6">Loading your group chats…</p>;
  }
  const picker = candidates.data;
  return <>
    <div className="mt-7 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
      <section aria-label="Create a group chat" className="rounded-2xl border border-white/10 bg-[rgb(18,18,18)] p-5">
        <h2 className="text-xl font-bold">Create a group</h2>
        <label className="mt-4 block text-sm font-bold">Group name<input className="mt-2 block min-h-11 w-full rounded-lg bg-white/10 px-3" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>
        <form className="mt-4 flex gap-2" onSubmit={event => { event.preventDefault(); setSearched(query); }}>
          <input aria-label="Search Characters for group" className="min-h-11 min-w-0 flex-1 rounded-lg bg-white/10 px-3 text-sm" value={query} maxLength={80} onChange={event => setQuery(event.target.value)} placeholder="Find a Character" />
          <button className={button} disabled={pending} type="submit">Search</button>
        </form>
        <p className="mt-4 text-sm font-bold" aria-live="polite">{selected.length} of {GROUP_CHAT_MAX_MEMBERS} selected</p>
        {selected.length ? <ul aria-label="Selected group members" className="mt-2 flex flex-wrap gap-2">{selected.map(item => <li key={item.id}><button className="min-h-9 rounded-full bg-white px-3 text-xs font-bold text-black" onClick={() => setSelected(previous => previous.filter(candidate => candidate.id !== item.id))} disabled={pending}>{item.name} ×<span className="sr-only"> Remove</span></button></li>)}</ul> : null}
        <div className="mt-3 grid max-h-[400px] gap-2 overflow-y-auto sm:grid-cols-2" aria-label="Available group Characters">
          {picker.items.map(item => <label key={item.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 p-3 hover:bg-white/5">
            <input className="mt-1 size-4 shrink-0 accent-pink-400" type="checkbox" checked={selected.some(candidate => candidate.id === item.id)} disabled={pending || (!selected.some(candidate => candidate.id === item.id) && selected.length >= GROUP_CHAT_MAX_MEMBERS)}
              onChange={event => setSelected(previous => event.target.checked ? [...previous, item] : previous.filter(candidate => candidate.id !== item.id))} />
            <span className="min-w-0"><span className="block text-sm font-bold">{item.name}</span><span className="mt-1 block text-xs leading-5 text-white/60">{item.owned ? "Your Character" : "Public Character"} · {item.description}</span></span>
          </label>)}
        </div>
        {!picker.items.length ? <p className="mt-4 text-sm text-white/65">No available Characters match this search.</p> : null}
        {picker.nextCursor ? <button className={`${button} mt-3`} disabled={pending} onClick={() => void more()}>Load more Characters</button> : null}
        <button className="mt-5 min-h-11 rounded-full bg-white px-6 text-sm font-bold text-black disabled:opacity-40" disabled={pending || selected.length < 2 || !title.trim()} onClick={() => void create()}>{pending ? "Saving…" : "Create group chat"}</button>
      </section>
      <section aria-label="Your saved group chats"><h2 className="text-xl font-bold">Your groups</h2>
        {!groups.data.length ? <p className="mt-4 text-sm text-white/65">Your new group will appear here with its full conversation history.</p> : null}
        <ul className="mt-4 space-y-3">{groups.data.map(group => <li key={group.id} className="rounded-xl border border-white/10 p-4">
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
    </div>
    {status ? <p role="status" className="mt-5 text-sm text-pink-300">{status}</p> : null}
  </>;
}
