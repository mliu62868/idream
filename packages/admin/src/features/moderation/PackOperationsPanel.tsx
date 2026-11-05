"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { packDetailSchema, packListSchema, type PackDetail, type PackSummary } from "@idream/shared/packs";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import { useToast } from "@/components/admin/ui/Toast";
import { useWorkspaceRefresh } from "@/features/workspace-refresh";

const button = "min-h-10 rounded-lg border border-[var(--ad-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--ad-surface)] disabled:opacity-40";
const input = "min-h-10 w-full rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2";
const PACK_PAGE_SIZE = 12;
export function PackOperationsPanel({ canBlock }: { canBlock: boolean }) {
  const { t, value } = useAdminI18n();
  const format = useAdminFormat();
  const { toast } = useToast();
  const [status, setStatus] = useState("published"), [items, setItems] = useState<PackSummary[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  // SPEC: 「上一页」走自己走过的游标回头；这个接口是单向 keyset，没有反向游标。
  const [cursor, setCursor] = useState(""), [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const [selected, setSelected] = useState<PackDetail | null>(null), [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  // INVARIANT: 这里只装读取失败。封禁写入的失败留在 ConfirmDialog 里就地显示，不再被「重读列表」抹掉。
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<{ cause: unknown; targetId?: string } | null>(null), [detailReady, setDetailReady] = useState(false);
  const alive = useRef(true), serial = useRef(0), detailSerial = useRef(0), writing = useRef(false), blockFailed = useRef(false);
  const load = useCallback(async (pageCursor = "") => {
    const ticket = ++serial.current; setLoading(true); setError(null);
    const query = new URLSearchParams({ limit: String(PACK_PAGE_SIZE) }); if (status) query.set("status", status); if (pageCursor) query.set("cursor", pageCursor);
    try {
      const result = packListSchema.parse(await apiGet(`/api/v2/admin/packs?${query}`));
      if (!alive.current || ticket !== serial.current) return false;
      setItems(result.items); setNextCursor(result.nextCursor);
      return true;
    } catch (cause) { if (alive.current && ticket === serial.current) setError({ cause }); return false; }
    finally { if (alive.current && ticket === serial.current) setLoading(false); }
  }, [status]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current += 1; detailSerial.current += 1; }; }, []);
  useEffect(() => { const timer = window.setTimeout(() => { detailSerial.current += 1; setSelected(null); setDetailReady(false); setCursor(""); setCursorTrail([]); setItems([]); setNextCursor(null); void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  const inspect = useCallback(async (id: string, preserveSelection = false) => {
    const ticket = ++detailSerial.current; setDetailReady(false); setError(null);
    if (!preserveSelection) setSelected(null);
    try { const result = packDetailSchema.parse(await apiGet(`/api/v2/admin/packs/${encodeURIComponent(id)}`)); if (alive.current && ticket === detailSerial.current) { setSelected(result); setDetailReady(true); } }
    catch (cause) { if (alive.current && ticket === detailSerial.current) setError({ cause, targetId: id }); }
  }, []);
  async function reload() {
    if (busy) return;
    const id = error?.targetId ?? selected?.id, ticket = ++detailSerial.current; setDetailReady(false);
    // A successful list refresh does not refresh the inspected command authority.
    if (await load(cursor) && alive.current && ticket === detailSerial.current && id) await inspect(id, true);
  }
  useWorkspaceRefresh(reload);
  function goToPage(pageCursor: string, trail: string[]) {
    setCursor(pageCursor); setCursorTrail(trail);
    void load(pageCursor);
  }
  useEffect(() => { const linked = new URLSearchParams(window.location.search).get("pack"); if (!linked) return; const timer = window.setTimeout(() => void inspect(linked), 0); return () => window.clearTimeout(timer); }, [inspect]);
  // SPEC: 封禁走 ConfirmDialog：理由、目标 ID、不可撤销的后果都在一个模态里，失败就地显示且不关框。
  function confirmBlock() {
    if (!selected || !detailReady || !canBlock || busy) return;
    const current = selected;
    blockFailed.current = false;
    setConfirm({
      title: "Block all access",
      summary: `${current.title} · ${t("Version")} ${current.version}`,
      consequence: { effect: "Every customer loses access to this Pack's content, including anyone who already claimed it. Claim receipts are retained. This console has no command to lift the block.", reversible: false },
      destructive: { expectedName: current.id, inputLabel: "Type this Pack ID to confirm" },
      reasonLabel: "Block reason",
      submitLabel: "Block all access",
      onSubmit: async (reason) => {
        if (writing.current) return;
        const ticket = detailSerial.current;
        writing.current = true; blockFailed.current = false; setBusy(true);
        try {
          const result = packDetailSchema.parse(await apiWrite(`/api/v2/admin/packs/${encodeURIComponent(current.id)}/block`, "POST", { version: current.version, confirmation: current.id, reason }));
          if (!alive.current || ticket !== detailSerial.current) return;
          setSelected(result);
          toast({ tone: "success", title: t("Blocked; existing receipts retained.") });
          await load(cursor);
        } catch (cause) { blockFailed.current = true; throw cause; }
        finally { writing.current = false; if (alive.current) setBusy(false); }
      },
    });
  }
  function closeConfirm() {
    setConfirm(null);
    // 失败后放弃：结果可能已写入，手上的版本号也可能过期，关框时重读一遍再让运营下决定。
    if (blockFailed.current) { blockFailed.current = false; void reload(); }
  }
  return <section className="rounded-xl border border-[var(--ad-border)] p-4 md:p-5" aria-label={t("Pack operations")}>
    <header className="flex flex-wrap justify-between gap-4"><div><h2 className="text-xl font-semibold">{t("Pack operations")}</h2><p className="mt-2 max-w-prose text-sm text-[var(--ad-text-muted)]">{t("Ordinary withdrawal preserves existing claims. Emergency blocking stops all content access and retains claim receipts.")}</p></div><select aria-label={t("Pack status")} className={input + " max-w-48"} disabled={busy} value={status} onChange={event => setStatus(event.target.value)}><option value="">{t("All statuses")}</option>{["published", "withdrawn", "blocked", "draft"].map(item => <option key={item} value={item}>{value(item)}</option>)}</select></header>
    {error && <AuthorityRequestError cause={error.cause} message={t("This action did not complete.")} requestKind="read" onRetry={() => void reload()} />}{loading && <p className="mt-4 text-sm" role="status">{t("Loading Packs…")}</p>}{!loading && !error && !items.length && <p className="mt-4 text-sm text-[var(--ad-text-muted)]">{t("No Packs in this list.")}</p>}
    <ul className="mt-4 divide-y divide-[var(--ad-border)]">{items.map(item => <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={item.id}><div><h3 className="font-semibold">{item.title}</h3><p className="text-sm text-[var(--ad-text-muted)]">{item.creator.displayName} · {format.count(item.itemCount)} {t("Assets")} · {value(item.status)} · {value(item.visibility)} · {t("Version")} {item.version}</p></div><button className={button} disabled={busy} onClick={() => void inspect(item.id)} type="button">{t("Inspect Pack")}</button></li>)}</ul>
    {items.length > 0 || cursor ? <div className="mt-4"><Pagination
      hasNext={Boolean(nextCursor)}
      hasPrevious={Boolean(cursor)}
      loading={loading || busy}
      onNext={() => { if (nextCursor) goToPage(nextCursor, [...cursorTrail, cursor]); }}
      onPrevious={() => goToPage(cursorTrail.at(-1) ?? "", cursorTrail.slice(0, -1))}
      page={cursorTrail.length + 1}
      pageSize={PACK_PAGE_SIZE}
      rowCount={items.length}
    /></div> : null}
    {selected && <div className="mt-5 border-t border-[var(--ad-border)] pt-5"><h3 className="text-lg font-bold">{selected.title} · {t("Version")} {selected.version}</h3><p className="mt-2 break-all text-sm">{selected.id}</p><p className="mt-2 whitespace-pre-line text-sm text-[var(--ad-text-muted)]">{selected.description}</p>{selected.release && <ol className="mt-3 space-y-2">{selected.release.items.map((item, index) => <li key={item.id} className="text-sm">{index + 1}. {item.caption || value(item.type)} · {item.contentType} · {Math.ceil(item.sizeBytes / 1024)} {t("KB")}</li>)}</ol>}
    {selected.status === "blocked" ? <p className="mt-3 text-sm" role="status">{t("Blocked; existing receipts retained.")} {selected.blockedReason}</p> : canBlock ? <div className="mt-4"><button className={button} disabled={busy || !detailReady} onClick={confirmBlock} type="button">{t("Block all access")}</button></div> : null}
    </div>}
    {confirm ? <ConfirmDialog onClose={closeConfirm} spec={confirm} /> : null}
  </section>;
}
