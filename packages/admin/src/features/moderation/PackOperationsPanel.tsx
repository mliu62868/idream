"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { packDetailSchema, packListSchema, type PackDetail, type PackSummary } from "@idream/shared/packs";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";

const button = "min-h-10 rounded-lg border border-[var(--ad-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--ad-surface)] disabled:opacity-40";
const input = "min-h-10 w-full rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2";
export function PackOperationsPanel({ canBlock }: { canBlock: boolean }) {
  const { t, value } = useAdminI18n();
  const [status, setStatus] = useState("published"), [items, setItems] = useState<PackSummary[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<PackDetail | null>(null), [reason, setReason] = useState(""), [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [detailReady, setDetailReady] = useState(false);
  const alive = useRef(true), serial = useRef(0), detailSerial = useRef(0), writing = useRef(false);
  const load = useCallback(async (nextCursor?: string) => {
    const ticket = ++serial.current; setLoading(true); setError(""); if (!nextCursor) { setItems([]); setCursor(null); }
    const query = new URLSearchParams({ limit: "12" }); if (status) query.set("status", status); if (nextCursor) query.set("cursor", nextCursor);
    try {
      const result = packListSchema.parse(await apiGet(`/api/v2/admin/packs?${query}`));
      if (!alive.current || ticket !== serial.current) return false;
      setItems(current => nextCursor ? [...current, ...result.items.filter(item => !current.some(old => old.id === item.id))] : result.items); setCursor(result.nextCursor);
      return true;
    } catch (cause) { if (alive.current && ticket === serial.current) setError(cause instanceof Error ? cause.message : "Packs could not load."); return false; }
    finally { if (alive.current && ticket === serial.current) setLoading(false); }
  }, [status]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current += 1; detailSerial.current += 1; }; }, []);
  useEffect(() => { const timer = window.setTimeout(() => { detailSerial.current += 1; setSelected(null); setDetailReady(false); void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  const inspect = useCallback(async (id: string, preserveSelection = false) => {
    const ticket = ++detailSerial.current; setDetailReady(false); setError("");
    if (!preserveSelection) { setSelected(null); setReason(""); setConfirmation(""); }
    try { const result = packDetailSchema.parse(await apiGet(`/api/v2/admin/packs/${encodeURIComponent(id)}`)); if (alive.current && ticket === detailSerial.current) { setSelected(result); setDetailReady(true); } }
    catch (cause) { if (alive.current && ticket === detailSerial.current) setError(cause instanceof Error ? cause.message : "Pack could not load."); }
  }, []);
  async function reload() {
    const id = selected?.id, ticket = ++detailSerial.current; setDetailReady(false);
    // A successful list refresh does not refresh the inspected command authority.
    if (await load() && alive.current && ticket === detailSerial.current && id) await inspect(id, true);
  }
  useEffect(() => { const linked = new URLSearchParams(window.location.search).get("pack"); if (!linked) return; const timer = window.setTimeout(() => void inspect(linked), 0); return () => window.clearTimeout(timer); }, [inspect]);
  async function block() {
    if (!selected || !detailReady || writing.current || !canBlock || confirmation !== selected.id || reason.trim().length < 3) return;
    const current = selected, ticket = detailSerial.current; writing.current = true; setBusy(true); setError("");
    try {
      const result = packDetailSchema.parse(await apiWrite(`/api/v2/admin/packs/${encodeURIComponent(current.id)}/block`, "POST", { version: current.version, confirmation, reason: reason.trim() }));
      if (!alive.current || ticket !== detailSerial.current) return;
      setSelected(result); setReason(""); setConfirmation(""); await load();
    } catch (cause) { if (alive.current && ticket === detailSerial.current) setError(cause instanceof Error ? cause.message : t("Pack block failed. Reload its current version.")); }
    finally { writing.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="rounded-xl border border-[var(--ad-border)] p-4 md:p-5" aria-label={t("Pack operations")}>
    <header className="flex flex-wrap justify-between gap-4"><div><h2 className="text-xl font-semibold">{t("Pack operations")}</h2><p className="mt-2 max-w-prose text-sm text-[var(--ad-text-muted)]">{t("Ordinary withdrawal preserves existing claims. Emergency blocking stops all content access and retains claim receipts.")}</p></div><select aria-label={t("Pack status")} className={input + " max-w-48"} disabled={busy} value={status} onChange={event => setStatus(event.target.value)}><option value="">{t("All statuses")}</option>{["published", "withdrawn", "blocked", "draft"].map(item => <option key={item} value={item}>{value(item)}</option>)}</select></header>
    {error && <p className="mt-4 text-[var(--ad-red-text)]" role="alert">{t(error)} <button className="underline" disabled={busy || loading} onClick={() => void reload()} type="button">{t("Reload Packs")}</button></p>}{loading && <p className="mt-4 text-sm" role="status">{t("Loading Packs…")}</p>}{!loading && !error && !items.length && <p className="mt-4 text-sm text-[var(--ad-text-muted)]">{t("No Packs in this list.")}</p>}
    <ul className="mt-4 divide-y divide-[var(--ad-border)]">{items.map(item => <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={item.id}><div><h3 className="font-semibold">{item.title}</h3><p className="text-sm text-[var(--ad-text-muted)]">{item.creator.displayName} · {item.itemCount} {t("Assets")} · {value(item.status)} · {value(item.visibility)} · {t("Version")} {item.version}</p></div><button className={button} disabled={busy} onClick={() => void inspect(item.id)} type="button">{t("Inspect Pack")}</button></li>)}</ul>{cursor && <button className={`${button} mt-4`} disabled={loading || busy} onClick={() => void load(cursor)} type="button">{t("Load more Packs")}</button>}
    {selected && <div className="mt-5 border-t border-[var(--ad-border)] pt-5"><h3 className="text-lg font-bold">{selected.title} · {t("Version")} {selected.version}</h3><p className="mt-2 break-all text-sm">{selected.id}</p><p className="mt-2 whitespace-pre-line text-sm text-[var(--ad-text-muted)]">{selected.description}</p>{selected.release && <ol className="mt-3 space-y-2">{selected.release.items.map((item, index) => <li key={item.id} className="text-sm">{index + 1}. {item.caption || value(item.type)} · {item.contentType} · {Math.ceil(item.sizeBytes / 1024)} {t("KB")}</li>)}</ol>}
    {selected.status === "blocked" ? <p className="mt-3 text-sm" role="status">{t("Blocked; existing receipts retained.")} {selected.blockedReason}</p> : canBlock ? <div className="mt-4 space-y-3"><label className="block text-sm font-semibold">{t("Block reason")}<textarea className={`${input} mt-2`} disabled={busy} rows={2} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label><label className="block text-sm font-semibold">{t("Type this Pack ID to confirm")}<input className={`${input} mt-2`} disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><button className={button} disabled={busy || !detailReady || confirmation !== selected.id || reason.trim().length < 3} onClick={() => void block()} type="button">{t("Block all access")}</button></div> : null}
    </div>}
  </section>;
}
