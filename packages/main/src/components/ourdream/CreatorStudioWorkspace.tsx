"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { creatorStudioSummarySchema, type CreatorStudioSummary } from "@/lib/creator-studio";
import { useViewerGate } from "@/hooks/useViewerGate";
import { loadViewerResource } from "@/lib/viewer-resource-client";
import { authHrefForTarget } from "./authRedirect";

const responseSchema = z.object({ ok: z.literal(true), data: creatorStudioSummarySchema });
const buttonStyle = "inline-flex min-h-10 items-center justify-center rounded-full border border-white/15 px-4 text-sm font-semibold hover:bg-white/10 disabled:opacity-50";
const characterStatusLabels: Record<string, string> = {
  available: "Available", available_by_link: "Available by link", awaiting_publication: "Awaiting publication",
  private: "Private", paused: "Paused", rejected: "Not approved", removed: "Removed", archived: "Archived",
};

export function CreatorStudioWorkspace() {
  const viewer = useViewerGate();
  const gatedFetch = viewer.fetch;
  const actorId = viewer.identity?.kind === "user" ? viewer.identity.userId : null;
  const [data, setData] = useState<CreatorStudioSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAllDrafts, setShowAllDrafts] = useState(false);
  const alive = useRef(true), serial = useRef(0);
  const load = useCallback(async () => {
    if (!actorId) return;
    const ticket = ++serial.current;
    setLoading(true); setError(""); setData(null);
    const result = await loadViewerResource({
      path: "/api/v1/creator-studio", init: { method: "GET", cache: "no-store" },
      fallbackError: "Creator Studio could not load. Retry to see your saved work.",
      isCurrent: () => alive.current && ticket === serial.current,
      parse: raw => {
        const parsed = responseSchema.parse(raw).data;
        if (parsed.viewerId !== actorId) throw new Error("The signed-in account changed. Reload Creator Studio.");
        return parsed;
      },
    }, gatedFetch);
    if (result.kind === "discarded") return;
    setLoading(false);
    if (result.kind === "failed") { setError(result.error); return; }
    setData(result.data);
  }, [actorId, gatedFetch]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current += 1; }; }, []);
  useEffect(() => viewer.gate.onOwnerChange?.(() => { serial.current += 1; setData(null); setError(""); setLoading(true); setShowAllDrafts(false); }), [viewer.gate]);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  if (viewer.identity?.kind === "anonymous") return <section className="mx-auto max-w-3xl px-4 py-16"><h1 className="text-3xl font-bold">Creator Studio</h1><p className="mt-4 text-neutral-300">Sign in to manage your characters, drafts, Comics and Packs.</p><Link className={`${buttonStyle} mt-6`} href={authHrefForTarget("/login", "/creator-studio")}>Sign in</Link></section>;
  const summary = data?.viewerId === actorId ? data : null;
  const nextLevel = summary?.program.nextLevel;
  const nextSteps = nextLevel ? [
    nextLevel.remainingPublicWorks > 0 ? `Publish ${nextLevel.remainingPublicWorks} more public ${nextLevel.remainingPublicWorks === 1 ? "work" : "works"}` : null,
    nextLevel.remainingFollowers > 0 ? `Gain ${nextLevel.remainingFollowers} more ${nextLevel.remainingFollowers === 1 ? "follower" : "followers"}` : null,
  ].filter(Boolean).join(". ") : "";
  const groups = summary ? [
    { title: "Character drafts", total: summary.counts.drafts, items: showAllDrafts ? summary.recent.drafts : summary.recent.drafts.slice(0, 6), href: "/create", action: "Open Create" },
    { title: "Characters", total: summary.counts.characters, items: summary.recent.characters, href: "/custom?tab=created", action: "All your characters" },
    { title: "Comics", total: summary.counts.comics.total, items: summary.recent.comics, href: "/creator-studio/comics", action: "Manage Comics" },
    { title: "Packs", total: summary.counts.packs.total, items: summary.recent.packs, href: "/packs?scope=mine", action: "Manage Packs" },
  ] : [];

  return <section className="mx-auto max-w-6xl px-4 pb-16 pt-8 md:px-12 md:pt-12">
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-3xl font-bold md:text-4xl">Creator Studio</h1><p className="mt-3 text-sm text-neutral-300">Your saved work, current public availability and community progress.</p></div><button className={buttonStyle} disabled={loading && !viewer.error} onClick={() => { if (viewer.error) void viewer.revalidate(); else void load(); }} type="button">Reload studio</button></div>
    {(error || viewer.error) && <p className="mb-6 text-pink-200" role="alert">{error || viewer.error} <Link className="underline" href={authHrefForTarget("/login", "/creator-studio")}>Sign in</Link></p>}
    {loading && !viewer.error && <p className="text-neutral-300" role="status">Loading your saved work…</p>}
    {summary && <>
      <section className="mb-7 rounded-xl border border-white/10 bg-[rgb(18,18,18)] p-5" aria-label="Creator level">
        {summary.program.state === "published" && summary.program.level ? <>
          <h2 className="text-xl font-bold">Level {summary.program.level.level} · {summary.program.level.label}</h2>
          {nextLevel ? <p className="mt-3 text-sm leading-6 text-neutral-300">Next: {nextLevel.label}. {nextSteps}.</p> : <p className="mt-3 text-sm text-neutral-300">You meet the highest currently published level.</p>}
        </> : <><h2 className="text-xl font-bold">{summary.program.state === "ineligible" ? "Creator levels are not available for this account" : "Creator levels are not open yet"}</h2><p className="mt-3 text-sm text-neutral-300">Your saved work remains available below.</p></>}
        <p className="mt-4 text-xs leading-5 text-neutral-400">{summary.program.definitionVersion !== null ? `Rules v${summary.program.definitionVersion} · ` : ""}Levels reflect your available public works and followers. Private or unlisted work does not count toward levels.</p>
      </section>
      <dl className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="studio-totals">
        {[["Available public characters", summary.counts.publicCharacters], ["Available public Comics", summary.counts.comics.publicAvailable], ["Available public Packs", summary.counts.packs.publicAvailable], ["Followers", summary.counts.followers]].map(([label, total]) => <div className="rounded-xl border border-white/10 p-4" key={label}><dt className="text-sm text-neutral-400">{label}</dt><dd className="mt-2 text-2xl font-bold">{total}</dd></div>)}
      </dl>
      <p className="mb-2 text-sm leading-6 text-neutral-300">Public characters: {summary.publicCharacterQualification.available} available, {summary.publicCharacterQualification.awaiting} awaiting publication, {summary.publicCharacterQualification.paused} paused.</p>
      <p className="mb-2 text-sm leading-6 text-neutral-300">Pack claims: {summary.counts.packClaims} · {summary.counts.packClaimants} {summary.counts.packClaimants === 1 ? "reader" : "readers"}. Access from earlier claims remains available when a Pack is withdrawn.</p>
      <p className="mb-7 text-xs text-neutral-400">Updated {new Date(summary.asOf).toLocaleString()}. Availability and levels can change when work is withdrawn or accounts become inactive.</p>
      <div className="grid gap-6 lg:grid-cols-2">{groups.map(group => <section className="rounded-xl border border-white/10 bg-[rgb(18,18,18)] p-5" key={group.title}>
        <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-xl font-bold">{group.title} · {group.total}</h2><Link className="text-sm text-pink-200 underline" href={group.href}>{group.action}</Link></div>
        {group.title === "Comics" || group.title === "Packs" ? <p className="mb-4 text-xs text-neutral-400">{Object.entries(group.title === "Comics" ? summary.counts.comics.byStatus : summary.counts.packs.byStatus).map(([status, count]) => `${status.replaceAll("_", " ")}: ${count}`).join(" · ") || "No saved work"}</p> : null}
        {group.items.length ? <ul className="divide-y divide-white/10">{group.items.map(item => <li className="flex items-start justify-between gap-3 py-3" key={item.id}><div className="min-w-0"><h3 className="break-words text-sm font-semibold">{item.title}</h3><p className="mt-1 text-xs text-neutral-400">{group.title === "Characters" ? characterStatusLabels[item.status] ?? "Unavailable" : item.status.replaceAll("_", " ")}{group.title !== "Characters" && item.visibility ? ` · ${item.visibility}` : ""} · {new Date(item.updatedAt).toLocaleDateString()}</p></div><Link className={buttonStyle} href={item.href}>{group.title === "Character drafts" ? "Continue" : "Manage"}</Link></li>)}</ul> : <p className="text-sm text-neutral-300">No saved {group.title.toLowerCase()} yet.</p>}
        {group.total > group.items.length && <p className="mt-4 text-xs text-neutral-400">Showing the six most recently updated items.</p>}
        {group.title === "Character drafts" && summary.recent.drafts.length > 6 && <button className="mt-4 text-sm text-pink-200 underline" type="button" onClick={() => setShowAllDrafts(current => !current)}>{showAllDrafts ? "Show fewer drafts" : "Show all drafts"}</button>}
      </section>)}</div>
      <nav className="mt-8 flex flex-wrap gap-3" aria-label="Create work"><Link className={buttonStyle} href="/create">Create a character</Link><Link className={buttonStyle} href="/creator-studio/comics/new">New Comic</Link><Link className={buttonStyle} href="/packs/new">New Pack</Link><Link className={buttonStyle} href="/custom?tab=media">Your Gallery</Link></nav>
    </>}
  </section>;
}
