"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { comicDetailSchema, comicListSchema, type ComicDetail, type ComicSummary } from "@idream/shared/comics";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import { useToast } from "@/components/admin/ui/Toast";
import { useWorkspaceRefresh } from "@/features/workspace-refresh";

const button = "min-h-10 rounded-lg border border-[var(--ad-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--ad-surface)] disabled:opacity-40";
const COMIC_PAGE_SIZE = 12;

const DECISION_RECORDED = {
  approve: "Comic version approved and published.",
  reject: "Comic version rejected and returned to its creator as a draft.",
  remove: "Published Comic version removed.",
} as const;

export function ComicReviewPanel({ canReview }: { canReview: boolean }) {
  const { t, value: label } = useAdminI18n();
  const format = useAdminFormat();
  const { toast } = useToast();
  const [status, setStatus] = useState("pending_review");
  const [items, setItems] = useState<ComicSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // SPEC: 「上一页」走自己走过的游标回头；这个接口是单向 keyset，没有反向游标。
  const [cursor, setCursor] = useState("");
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const [selected, setSelected] = useState<ComicDetail | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  // 读取失败：按钮真的重读，读成功就消失。
  const [error, setError] = useState<{ cause: unknown; targetId?: string } | null>(null);
  // INVARIANT: 写失败与读取分开存。重读列表不等于这次决定已经处理——它留到下一次提交或换目标才消失。
  const [writeError, setWriteError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [detailReady, setDetailReady] = useState(false);
  const serial = useRef(0);
  const detailSerial = useRef(0);
  const alive = useRef(true);
  const removalFailed = useRef(false);
  const load = useCallback(async (pageCursor = "") => {
    const ticket = ++serial.current; setLoading(true); setError(null);
    const query = new URLSearchParams({ status, limit: String(COMIC_PAGE_SIZE) });
    if (pageCursor) query.set("cursor", pageCursor);
    try {
      const result = comicListSchema.parse(await apiGet(`/api/v2/admin/comics?${query}`));
      if (!alive.current || ticket !== serial.current) return false;
      setItems(result.items); setNextCursor(result.nextCursor);
      return true;
    } catch (cause) { if (alive.current && ticket === serial.current) setError({ cause }); return false; }
    finally { if (alive.current && ticket === serial.current) setLoading(false); }
  }, [status]);
  useEffect(() => { alive.current = true; const initialLoad = window.setTimeout(() => { setSelected(null); setWriteError(null); setCursor(""); setCursorTrail([]); setItems([]); setNextCursor(null); detailSerial.current += 1; void load(); }, 0); return () => { window.clearTimeout(initialLoad); alive.current = false; serial.current += 1; detailSerial.current += 1; }; }, [load]);
  const inspect = useCallback(async (id: string, preserveSelection = false) => {
    const ticket = ++detailSerial.current; setDetailReady(false); setError(null);
    if (!preserveSelection) { setSelected(null); setReason(""); setWriteError(null); }
    try {
      const result = comicDetailSchema.parse(await apiGet(`/api/v2/admin/comics/${encodeURIComponent(id)}`));
      if (alive.current && ticket === detailSerial.current) { setSelected(result); setDetailReady(true); }
    } catch (cause) { if (alive.current && ticket === detailSerial.current) setError({ cause, targetId: id }); }
  }, []);
  async function reload() {
    if (busy) return;
    const id = error?.targetId ?? selected?.id, ticket = ++detailSerial.current;
    setDetailReady(false);
    // Refresh the inspected version as well as the queue before permitting another decision.
    if (await load(cursor) && alive.current && ticket === detailSerial.current && id) await inspect(id, true);
  }
  useWorkspaceRefresh(reload);
  function goToPage(pageCursor: string, trail: string[]) {
    setCursor(pageCursor); setCursorTrail(trail);
    void load(pageCursor);
  }
  useEffect(() => {
    // Media dependency repair links name one Comic (`?comic=`): open its exact pages.
    const linked = new URLSearchParams(window.location.search).get("comic");
    if (!linked) return;
    const timer = window.setTimeout(() => void inspect(linked), 0);
    return () => window.clearTimeout(timer);
  }, [inspect]);
  async function submitDecision(current: ComicDetail, decision: keyof typeof DECISION_RECORDED, decisionReason: string) {
    const body = { version: current.version, reason: decisionReason, decision, confirmation: current.id };
    const result = comicDetailSchema.parse(await apiWrite(`/api/v2/admin/comics/${encodeURIComponent(current.id)}/decision`, "POST", body));
    if (!alive.current) return;
    setSelected(result); setReason("");
    toast({ tone: "success", title: t(DECISION_RECORDED[decision]) });
    await load(cursor);
  }
  async function decide(decision: "approve" | "reject") {
    if (!selected || !detailReady || busy || reason.trim().length < 3) return;
    const current = selected; setBusy(true); setWriteError(null);
    try { await submitDecision(current, decision, reason.trim()); }
    catch (cause) { if (alive.current) setWriteError(cause); }
    finally { if (alive.current) setBusy(false); }
  }
  // SPEC: 撤下已上线内容走 ConfirmDialog：运营自己写理由、敲目标 ID，读到后果之后才能提交。
  // INTENT: 确认串以前由代码替运营填好（confirmation: current.id），后端那道校验形同虚设。
  function confirmRemoval() {
    if (!selected || !detailReady || busy) return;
    const current = selected;
    removalFailed.current = false;
    setConfirm({
      title: `${t("Remove published version")} ${current.version}`,
      summary: current.title,
      consequence: { effect: "Readers lose this Comic right away. This console cannot republish it; the creator has to edit and resubmit it for a new review.", reversible: false },
      destructive: { expectedName: current.id, inputLabel: "Type this Comic ID to confirm" },
      reasonLabel: "Decision reason",
      submitLabel: "Remove published version",
      onSubmit: async (removalReason) => {
        setBusy(true);
        removalFailed.current = false;
        try { await submitDecision(current, "remove", removalReason); }
        catch (cause) { removalFailed.current = true; throw cause; }
        finally { if (alive.current) setBusy(false); }
      },
    });
  }
  function closeConfirm() {
    setConfirm(null);
    // 失败后放弃：结果可能已写入，手上的版本号也可能过期，关框时重读一遍再让运营下决定。
    if (removalFailed.current) { removalFailed.current = false; void reload(); }
  }
  return <section aria-label={t("Comic publication review")} className="rounded-xl border border-[var(--ad-border)] p-4 md:p-5">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-xl font-semibold">{t("Comic publication review")}</h2><p className="mt-1 text-sm text-[var(--ad-text-muted)]">{t("Review the exact submitted pages before publishing. Every decision records the version and reason.")}</p></div>
      <select aria-label={t("Comic review status")} className="min-h-10 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3" disabled={busy} onChange={(event) => setStatus(event.target.value)} value={status}><option value="pending_review">{t("Awaiting review")}</option><option value="published">{t("Published")}</option></select>
    </header>
    {writeError !== null && <AuthorityRequestError cause={writeError} message={t("This action did not complete.")} onDismiss={() => setWriteError(null)} onRetry={() => void reload()} requestKind="write" retryLabel={t("Reload")} />}
    {error && <AuthorityRequestError cause={error.cause} message={t("This action did not complete.")} requestKind="read" onRetry={() => void reload()} />}
    {loading && <p role="status" className="mt-4 text-sm">{t("Loading Comics…")}</p>}
    {!loading && !error && !items.length && <p className="mt-4 text-sm text-[var(--ad-text-muted)]">{t("No Comics in this queue.")}</p>}
    <ul className="mt-4 divide-y divide-[var(--ad-border)]">{items.map((item) => <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={item.id}><div><h3 className="font-semibold">{item.title}</h3><p className="text-sm text-[var(--ad-text-muted)]">{item.creator.displayName} · {t("{count} pages", { count: format.count(item.pageCount) })} · {label(item.visibility)} · {t("Version")} {item.version}</p></div><button className={button} disabled={busy} onClick={() => void inspect(item.id)} type="button">{t("Review pages")}</button></li>)}</ul>
    {items.length > 0 || cursor ? <div className="mt-3"><Pagination
      hasNext={Boolean(nextCursor)}
      hasPrevious={Boolean(cursor)}
      loading={loading || busy}
      onNext={() => { if (nextCursor) goToPage(nextCursor, [...cursorTrail, cursor]); }}
      onPrevious={() => goToPage(cursorTrail.at(-1) ?? "", cursorTrail.slice(0, -1))}
      page={cursorTrail.length + 1}
      pageSize={COMIC_PAGE_SIZE}
      rowCount={items.length}
    /></div> : null}
    {selected && <div className="mt-6 border-t border-[var(--ad-border)] pt-5"><h3 className="text-xl font-semibold">{selected.title} · {t("Version")} {selected.version}</h3><p className="mt-2 whitespace-pre-line text-sm text-[var(--ad-text-muted)]">{selected.description}</p>
      <div className="mt-4 max-h-[65vh] space-y-6 overflow-y-auto pr-2">{selected.episodes.map((episode) => <section key={episode.id}><h4 className="mb-3 font-bold">{episode.ordinal + 1}. {episode.title}</h4><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{episode.pages.map((page) => <figure key={page.id}>{page.url ? <Image alt={page.caption || t("Page {page}", { page: page.ordinal + 1 })} className="h-auto w-full rounded-lg" height={768} width={512} src={page.url} unoptimized /> : <p>{t("Unavailable page")}</p>}<figcaption className="mt-2 whitespace-pre-line text-sm">{page.ordinal + 1}. {page.caption}</figcaption></figure>)}</div></section>)}</div>
      {canReview && selected.status === "pending_review" && <div className="mt-5"><label className="block text-sm font-semibold">{t("Decision reason")}<textarea className="mt-2 block w-full rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3" disabled={busy} maxLength={1000} onChange={(event) => setReason(event.target.value)} rows={2} value={reason} /></label>
        <div className="mt-3 flex flex-wrap gap-3"><button className={button} disabled={busy || !detailReady || reason.trim().length < 3} onClick={() => void decide("approve")} type="button">{t("Approve version")} {selected.version}</button><button className={button} disabled={busy || !detailReady || reason.trim().length < 3} onClick={() => void decide("reject")} type="button">{t("Reject version")} {selected.version}</button></div>
      </div>}
      {canReview && selected.status === "published" && <div className="mt-5"><button className={button} disabled={busy || !detailReady} onClick={confirmRemoval} type="button">{t("Remove published version")} {selected.version}</button></div>}
      <p className="mt-3 text-sm text-[var(--ad-text-muted)]">{t("Current status:")} {label(selected.status)}{selected.reviewNote ? ` · ${selected.reviewNote}` : ""}</p>
    </div>}
    {confirm ? <ConfirmDialog onClose={closeConfirm} spec={confirm} /> : null}
  </section>;
}
