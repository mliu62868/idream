"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { comicDetailSchema, comicListSchema, type ComicDetail, type ComicSummary } from "@idream/shared/comics";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";

const button = "min-h-10 rounded-lg border border-[var(--ad-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--ad-surface)] disabled:opacity-40";

export function ComicReviewPanel({ canReview }: { canReview: boolean }) {
  const { t, value: label } = useAdminI18n();
  const [status, setStatus] = useState("pending_review");
  const [items, setItems] = useState<ComicSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ComicDetail | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const detailSerial = useRef(0);
  const alive = useRef(true);
  const load = useCallback(async (nextCursor?: string) => {
    const ticket = ++serial.current; setLoading(true); setError("");
    if (!nextCursor) { setItems([]); setCursor(null); }
    const query = new URLSearchParams({ status, limit: "12" });
    if (nextCursor) query.set("cursor", nextCursor);
    try {
      const result = comicListSchema.parse(await apiGet(`/api/v2/admin/comics?${query}`));
      if (!alive.current || ticket !== serial.current) return;
      setItems((current) => nextCursor ? [...current, ...result.items.filter((item) => !current.some((old) => old.id === item.id))] : result.items); setCursor(result.nextCursor);
    } catch (cause) { if (alive.current && ticket === serial.current) setError(cause instanceof Error ? cause.message : "Comic queue could not load."); }
    finally { if (alive.current && ticket === serial.current) setLoading(false); }
  }, [status]);
  useEffect(() => { alive.current = true; const initialLoad = window.setTimeout(() => { setSelected(null); detailSerial.current += 1; void load(); }, 0); return () => { window.clearTimeout(initialLoad); alive.current = false; serial.current += 1; detailSerial.current += 1; }; }, [load]);
  const inspect = useCallback(async (id: string) => {
    const ticket = ++detailSerial.current; setSelected(null); setReason(""); setError("");
    try {
      const result = comicDetailSchema.parse(await apiGet(`/api/v2/admin/comics/${encodeURIComponent(id)}`));
      if (alive.current && ticket === detailSerial.current) setSelected(result);
    } catch (cause) { if (alive.current && ticket === detailSerial.current) setError(cause instanceof Error ? cause.message : "Comic could not load."); }
  }, []);
  useEffect(() => {
    // Media dependency repair links name one Comic (`?comic=`): open its exact pages.
    const linked = new URLSearchParams(window.location.search).get("comic");
    if (!linked) return;
    const timer = window.setTimeout(() => void inspect(linked), 0);
    return () => window.clearTimeout(timer);
  }, [inspect]);
  async function decide(decision: "approve" | "reject" | "remove") {
    if (!selected || busy || reason.trim().length < 3) return;
    const current = selected; setBusy(true); setError("");
    try {
      const body = { version: current.version, reason: reason.trim(), decision, confirmation: current.id };
      const result = comicDetailSchema.parse(await apiWrite(`/api/v2/admin/comics/${encodeURIComponent(current.id)}/decision`, "POST", body));
      if (!alive.current) return;
      setSelected(result); setReason(""); await load();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "Review failed. Reload this Comic."); }
    finally { if (alive.current) setBusy(false); }
  }
  return <section aria-label={t("Comic publication review")} className="rounded-xl border border-[var(--ad-border)] p-4 md:p-5">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-xl font-semibold">{t("Comic publication review")}</h2><p className="mt-1 text-sm text-[var(--ad-text-muted)]">{t("Review the exact submitted pages before publishing. Every decision records the version and reason.")}</p></div>
      <select aria-label={t("Comic review status")} className="min-h-10 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3" disabled={busy} onChange={(event) => setStatus(event.target.value)} value={status}><option value="pending_review">{t("Awaiting review")}</option><option value="published">{t("Published")}</option></select>
    </header>
    {error && <p role="alert" className="mt-4 text-[var(--ad-danger)]">{error} <button className="underline" disabled={busy} onClick={() => void load()} type="button">{t("Reload queue")}</button></p>}
    {loading && <p role="status" className="mt-4 text-sm">{t("Loading Comics…")}</p>}
    {!loading && !error && !items.length && <p className="mt-4 text-sm text-[var(--ad-text-muted)]">{t("No Comics in this queue.")}</p>}
    <ul className="mt-4 divide-y divide-[var(--ad-border)]">{items.map((item) => <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={item.id}><div><h3 className="font-semibold">{item.title}</h3><p className="text-sm text-[var(--ad-text-muted)]">{item.creator.displayName} · {t("{count} pages", { count: item.pageCount })} · {label(item.visibility)} · {t("Version")} {item.version}</p></div><button className={button} disabled={busy} onClick={() => void inspect(item.id)} type="button">{t("Review pages")}</button></li>)}</ul>
    {cursor && <button className={`${button} mt-3`} disabled={loading || busy} onClick={() => void load(cursor)} type="button">{t("Load more Comics")}</button>}
    {selected && <div className="mt-6 border-t border-[var(--ad-border)] pt-5"><h3 className="text-xl font-semibold">{selected.title} · {t("Version")} {selected.version}</h3><p className="mt-2 whitespace-pre-line text-sm text-[var(--ad-text-muted)]">{selected.description}</p>
      <div className="mt-4 max-h-[65vh] space-y-6 overflow-y-auto pr-2">{selected.episodes.map((episode) => <section key={episode.id}><h4 className="mb-3 font-bold">{episode.ordinal + 1}. {episode.title}</h4><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{episode.pages.map((page) => <figure key={page.id}>{page.url ? <Image alt={page.caption || t("Page {page}", { page: page.ordinal + 1 })} className="h-auto w-full rounded-lg" height={768} width={512} src={page.url} unoptimized /> : <p>{t("Unavailable page")}</p>}<figcaption className="mt-2 whitespace-pre-line text-sm">{page.ordinal + 1}. {page.caption}</figcaption></figure>)}</div></section>)}</div>
      {canReview && ["pending_review", "published"].includes(selected.status) && <div className="mt-5"><label className="block text-sm font-semibold">{t("Decision reason")}<textarea className="mt-2 block w-full rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3" disabled={busy} maxLength={1000} onChange={(event) => setReason(event.target.value)} rows={2} value={reason} /></label>
        <div className="mt-3 flex flex-wrap gap-3">{selected.status === "pending_review" ? <><button className={button} disabled={busy || reason.trim().length < 3} onClick={() => void decide("approve")} type="button">{t("Approve version")} {selected.version}</button><button className={button} disabled={busy || reason.trim().length < 3} onClick={() => void decide("reject")} type="button">{t("Reject version")} {selected.version}</button></> : <button className={button} disabled={busy || reason.trim().length < 3} onClick={() => void decide("remove")} type="button">{t("Remove published version")} {selected.version}</button>}</div>
      </div>}
      <p className="mt-3 text-sm text-[var(--ad-text-muted)]">{t("Current status:")} {label(selected.status)}{selected.reviewNote ? ` · ${selected.reviewNote}` : ""}</p>
    </div>}
  </section>;
}
