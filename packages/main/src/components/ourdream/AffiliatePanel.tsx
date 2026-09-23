"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const dashboardSchema = z.object({
  status: z.string(),
  clicks: z.number(),
  conversions: z.number(),
  linkPath: z.string().nullable(),
  attributionWindowDays: z.number(),
  application: z.object({ reviewNote: z.string().nullable() }).passthrough().nullable(),
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
  return value.split(/[\n,]/).map((channel) => channel.trim()).filter(Boolean).slice(0, 12);
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
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    void fetcher("/api/v1/affiliate/dashboard", { cache: "no-store" })
      .then(readPayload)
      .then((data) => { if (alive.current) setDashboard(dashboardSchema.parse(data)); })
      .catch((error: unknown) => {
        // AbortError: Profile confirmed another account and this panel is going away.
        if (!alive.current || (error instanceof DOMException && error.name === "AbortError")) return;
        setStatus("Affiliate status could not be loaded.");
      });
    return () => { alive.current = false; };
  }, [fetcher, loadAttempt]);

  const apply = useCallback(async () => {
    if (!dashboard || dashboard.terms.state !== "published" || pending) return;
    const list = channelsFrom(channels);
    if (list.length === 0) { setStatus("Add at least one channel where you'll share your link."); return; }
    setPending(true); setStatus("");
    try {
      await readPayload(await fetcher("/api/v1/affiliate/application", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ termsVersion: dashboard.terms.version, channels: list }),
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
              onClick={() => { void navigator.clipboard.writeText(link).then(() => setStatus("Affiliate link copied."), () => setStatus("Copy failed. Select the link to copy it.")); }}
              type="button"
            >
              Copy
            </button>
          </div>
          <p className="text-[12px] font-semibold text-[rgb(170,170,170)]" data-testid="profile-affiliate-stats">
            {dashboard.clicks} {dashboard.clicks === 1 ? "visit" : "visits"} · {dashboard.conversions} {dashboard.conversions === 1 ? "signup" : "signups"}
          </p>
          <p className="text-[11px] leading-5 text-[rgb(154,153,152)]">
            A signup counts when it happens within {dashboard.attributionWindowDays} days of a visit from your link. Commissions and payouts are not shown here yet.
          </p>
        </div>
      )}
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
            <textarea
              className="mt-2 min-h-16 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 py-2 text-[12px] font-medium text-white outline-none"
              onChange={(event) => setChannels(event.target.value)}
              placeholder="One channel per line, e.g. your YouTube or X profile URL"
              value={channels}
            />
          </label>
          <label className="flex items-start gap-2 text-[12px] text-[rgb(170,170,170)]">
            <input checked={accepted} className="mt-0.5" onChange={(event) => setAccepted(event.target.checked)} type="checkbox" />
            <span>
              I accept the <Link className="text-white underline" href={dashboard.terms.path}>{dashboard.terms.title}</Link> terms.
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
