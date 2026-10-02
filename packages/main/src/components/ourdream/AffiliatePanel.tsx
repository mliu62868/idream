"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { affiliateApplicationSchema, affiliateAttributionHistorySchema, affiliateAttributionQuerySchema, affiliatePromotionMaterialSchema, affiliateAttributionStateLabels, affiliateAttributionReasonDescriptions } from "@idream/shared/contracts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const dashboardSchema = z.object({
  status: z.string(),
  clicks: z.number(),
  conversions: z.number(),
  linkPath: z.string().nullable(),
  attributionWindowDays: z.number(),
  application: z.object({ reviewNote: z.string().nullable(), termsVersion: z.string() }).passthrough().nullable(),
  attribution: affiliateAttributionHistorySchema,
  materials: z.array(affiliatePromotionMaterialSchema),
  terms: z.discriminatedUnion("state", [
    z.object({ state: z.literal("published"), version: z.string(), title: z.string(), path: z.string() }),
    z.object({ state: z.literal("unpublished") }),
    z.object({ state: z.literal("unavailable") }),
  ]),
});
type Dashboard = z.infer<typeof dashboardSchema>;

async function readPayload(response: Response) {
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(typeof payload?.error?.message === "string" ? payload.error.message : "The request could not be completed. Try again.");
  }
  return payload.data as unknown;
}

function channelsFrom(value: string) {
  return value.split(/[\n,]/).map((channel) => channel.trim()).filter(Boolean);
}

/**
 * SPEC: AF-01/AF-02 user side — apply against the published terms, see the
 * review result, and once approved get the attributed link with click and
 * signup counts.
 * INTENT: commissions and payouts (AF-03) are not settled anywhere yet, so this
 * panel shows no earnings at all rather than an estimate that reads as income.
 */
export function AffiliatePanel({ fetcher }: Readonly<{ fetcher: Fetcher }>) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [channels, setChannels] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [dates, setDates] = useState<{ from?: string; to?: string }>({});
  const [trail, setTrail] = useState<string[]>([]);
  const alive = useRef(false);
  const readVersion = useRef(0);
  const cursor = trail.at(-1);

  useEffect(() => {
    alive.current = true;
    const version = ++readVersion.current, controller = new AbortController();
    const params = new URLSearchParams({ limit: "20", ...dates, ...(cursor ? { cursor } : {}) });
    void fetcher(`/api/v1/affiliate/dashboard?${params}`, { cache: "no-store", signal: controller.signal })
      .then(readPayload)
      .then((data) => { if (alive.current && version === readVersion.current) setDashboard(dashboardSchema.parse(data)); })
      .catch((error: unknown) => {
        // AbortError: Profile confirmed another account and this panel is going away.
        if (!alive.current || version !== readVersion.current || controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setStatus("Affiliate status could not be loaded.");
      });
    return () => { alive.current = false; controller.abort(); };
  }, [fetcher, loadAttempt, dates, cursor]);

  const apply = useCallback(async () => {
    if (!dashboard || dashboard.terms.state !== "published" || pending) return;
    const list = channelsFrom(channels);
    const parsed = affiliateApplicationSchema.safeParse({ termsVersion: dashboard.terms.version, channels: list });
    if (!parsed.success) {
      const channelIndex = parsed.error.issues.find(issue => issue.path[0] === "channels" && typeof issue.path[1] === "number")?.path[1];
      setStatus(typeof channelIndex === "number" ? `Channel ${channelIndex + 1} must have 1–120 characters. Shorten it and try again.` : "Add between 1 and 12 promotion channels, with up to 120 characters each.");
      return;
    }
    setPending(true); setStatus("");
    try {
      await readPayload(await fetcher("/api/v1/affiliate/application", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      }));
      if (!alive.current) return;
      setStatus("Application received. We'll show the review result here.");
      setLoadAttempt((value) => value + 1);
    } catch (error) {
      if (alive.current) setStatus(error instanceof Error ? error.message : "Application failed. Try again.");
    } finally {
      if (alive.current) setPending(false);
    }
  }, [channels, dashboard, fetcher, pending]);

  const copyLink = (path: string) => {
    const value = new URL(path, window.location.origin).toString();
    if (!navigator.clipboard) { setStatus("Copy is unavailable. Select the affiliate link to copy it."); return; }
    void navigator.clipboard.writeText(value).then(() => { if (alive.current) setStatus("Affiliate link copied."); }, () => { if (alive.current) setStatus("Copy failed. Select the link to copy it."); });
  };

  const link = dashboard?.linkPath && typeof window !== "undefined"
    ? new URL(dashboard.linkPath, window.location.origin).toString()
    : null;
  const canApply = dashboard !== null && dashboard.terms.state === "published" &&
    (dashboard.status === "not_applied" || dashboard.status === "rejected");

  return (
    <div className="rounded-[14px] bg-[rgb(18,18,18)] p-4" data-testid="profile-affiliate">
      <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">Affiliate program</p>
      {!dashboard && !status && <p className="mt-2 text-[12px] text-[rgb(170,170,170)]">Checking affiliate status…</p>}
      {!dashboard && status && (
        <button className="mt-2 text-[12px] font-bold text-white underline" onClick={() => { setStatus(""); setLoadAttempt((value) => value + 1); }} type="button">
          Retry affiliate status
        </button>
      )}
      {dashboard && dashboard.status === "pending" && (
        <p className="mt-2 text-[12px] font-semibold text-[rgb(170,170,170)]">Your application is under review.</p>
      )}
      {dashboard && dashboard.status === "rejected" && (
        <p className="mt-2 text-[12px] font-semibold text-[rgb(255,184,112)]">
          Your application was not approved{dashboard.application?.reviewNote ? `: ${dashboard.application.reviewNote}` : "."}
        </p>
      )}
      {dashboard && dashboard.status === "approved" && link && (
        <div className="mt-2 grid gap-2">
          <div className="flex gap-2">
            <input aria-label="Affiliate link" className="min-w-0 flex-1 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[12px] text-white" readOnly value={link} />
            <button
              className="inline-flex h-9 items-center rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)]"
              onClick={() => copyLink(dashboard.linkPath!)}
              type="button"
            >
              Copy
            </button>
          </div>
          <p className="text-[12px] font-semibold text-[rgb(170,170,170)]" data-testid="profile-affiliate-stats">
            {dashboard.clicks} deduplicated visits · {dashboard.conversions} observed signups
          </p>
          <p className="text-[11px] leading-5 text-[rgb(154,153,152)]">
            {dashboard.attribution.currentRule.version}: a signup is attributed within {dashboard.attributionWindowDays} days of its visit. Current account checks below are separate from the recorded signup and do not qualify a commission.
          </p>
          {dashboard.materials.length ? <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {dashboard.materials.map(material => <div key={material.assetId} className="rounded-lg border border-white/10 p-3">
              <p className="text-xs font-bold text-white">{material.name}</p>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-white">
                <a className="underline" href={material.imagePath} target="_blank" rel="noreferrer">Preview image</a>
                <a className="underline" href={material.downloadPath} download>Download image</a>
                <button className="underline" type="button" onClick={() => copyLink(material.linkPath)}>Copy promotion link</button>
              </div>
            </div>)}
          </div> : <p className="text-xs text-white/60">No current public Character materials are available. Your approved link remains usable.</p>}
        </div>
      )}
      {dashboard?.application ? <div className="mt-4 space-y-3">
        <p className="text-xs font-bold text-white">Visit and signup evidence</p>
        <form className="flex flex-wrap items-end gap-2 text-xs text-white/70" onSubmit={event => {
          event.preventDefault();
          const parsed = affiliateAttributionQuerySchema.safeParse({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
          if (!parsed.success) { setStatus("Choose valid visit dates; the start must not follow the end."); return; }
          setDates({ ...(from ? { from } : {}), ...(to ? { to } : {}) }); setTrail([]); setDashboard(null); setStatus("");
        }}>
          <label>Visits from (UTC)<input aria-label="Affiliate visits from" className="mt-1 block rounded bg-white/10 px-2 py-1" type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
          <label>Through (UTC)<input aria-label="Affiliate visits through" className="mt-1 block rounded bg-white/10 px-2 py-1" type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
          <button className="rounded border border-white/20 px-3 py-1.5" type="submit">Apply dates</button>
          <button className="underline" type="button" onClick={() => { setFrom(""); setTo(""); setDates({}); setTrail([]); setDashboard(null); setStatus(""); }}>Clear dates</button>
          <button className="underline" type="button" onClick={() => { setLoadAttempt(value => value + 1); setDashboard(null); setStatus(""); }}>Refresh evidence</button>
        </form>
        {dashboard.attribution.items.length ? <ul className="space-y-2">
          {dashboard.attribution.items.map(item => <li key={item.id} className="rounded-lg border border-white/10 p-3 text-xs text-white/70">
            <p className="font-semibold text-white">{affiliateAttributionStateLabels[item.state]}</p>
            <p className="mt-1">{affiliateAttributionReasonDescriptions[item.reason]}</p>
            <p className="mt-1 break-all">Visit {item.id} · {item.createdAt} · {item.landingPath}</p>
            <p>Signup: {item.convertedAt ?? "None observed"} · Window ends: {item.expiresAt}</p>
            <p>Rule: {item.attributionVersion ?? "Historical version not recorded"} · {item.attributionWindowDays} days · Terms: {item.termsVersion ?? "Historical version not recorded"}</p>
          </li>)}
        </ul> : <p className="text-xs text-white/60">No visits in this date range.</p>}
        <div className="flex items-center gap-3 text-xs text-white">
          <button className="underline disabled:opacity-40" disabled={!trail.length} type="button" onClick={() => { setTrail(value => value.slice(0, -1)); setDashboard(null); }}>Previous visits</button>
          <span>Page {trail.length + 1}</span>
          <button className="underline disabled:opacity-40" disabled={!dashboard.attribution.pageInfo.hasNextPage} type="button" onClick={() => { if (dashboard.attribution.pageInfo.endCursor) { setTrail(value => [...value, dashboard.attribution.pageInfo.endCursor!]); setDashboard(null); } }}>Next visits</button>
        </div>
        <p className="text-[11px] text-white/50">Visit snapshot: {dashboard.attribution.asOf}. Account status is checked on each refresh. Visits without a signup are not pending conversions.</p>
      </div> : null}
      {dashboard && dashboard.status !== "approved" && dashboard.terms.state === "unpublished" && (
        <p className="mt-2 text-[12px] font-semibold text-[rgb(170,170,170)]">
          The affiliate terms haven&apos;t been published yet, so applications are closed.
        </p>
      )}
      {dashboard && dashboard.status !== "approved" && dashboard.terms.state === "unavailable" && (
        <p className="mt-2 text-[12px] font-semibold text-[rgb(170,170,170)]">The affiliate terms could not be loaded. Reload to try again.</p>
      )}
      {canApply && dashboard.terms.state === "published" && (
        <div className="mt-2 grid gap-2">
          <label className="block text-[12px] font-semibold text-white">
            Where will you share your link?
            <span className="mt-1 block text-[11px] text-white/60" id="affiliate-channel-rules">Add 1–12 channels. Each channel can have up to 120 characters.</span>
            <textarea
              aria-describedby="affiliate-channel-rules"
              className="mt-2 min-h-16 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 py-2 text-[12px] font-medium text-white outline-none"
              onChange={(event) => setChannels(event.target.value)}
              placeholder="One channel per line, e.g. your YouTube or X profile URL"
              value={channels}
            />
          </label>
          <label className="flex items-start gap-2 text-[12px] text-[rgb(170,170,170)]">
            <input checked={accepted} className="mt-0.5" onChange={(event) => setAccepted(event.target.checked)} type="checkbox" />
            <span>
              I accept the <Link className="text-white underline" href={dashboard.terms.path}>{dashboard.terms.title}</Link>.
            </span>
          </label>
          <button
            className="inline-flex h-9 w-fit items-center rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)] disabled:opacity-50"
            disabled={pending || !accepted}
            onClick={() => void apply()}
            type="button"
          >
            {pending ? "Submitting…" : "Apply"}
          </button>
        </div>
      )}
      {dashboard && status && <p className="mt-2 text-[12px] text-[rgb(220,220,220)]" role="status">{status}</p>}
    </div>
  );
}
