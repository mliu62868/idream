"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { adminCoinOfferCreateRequestSchema, adminCoinOfferListSchema, adminCoinOfferMutationSchema } from "@idream/shared/admin";
import type { CoinOffer } from "@idream/shared/coins";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";

const input = "mt-1 min-h-11 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 text-sm";
const button = "min-h-11 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold disabled:opacity-40";
const emptyDraft = { offerKey: "", name: "", dreamcoins: "", priceCents: "", currency: "usd", eligibility: "all", terms: "", reason: "" };

export function CoinOffersPanel({ canWrite }: { canWrite: boolean }) {
  const { t, value: label } = useAdminI18n();
  const [draft, setDraft] = useState(emptyDraft);
  const [items, setItems] = useState<CoinOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const mounted = useRef(false);
  const serial = useRef(0);
  const writes = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const ticket = ++serial.current; setLoading(true); setError("");
    try {
      const data = adminCoinOfferListSchema.parse(await apiGet("/api/v2/admin/billing/coin-offers"));
      if (mounted.current && ticket === serial.current) setItems(data.items);
    } catch (cause) { if (mounted.current && ticket === serial.current) setError(cause instanceof Error ? cause.message : "Coin catalog could not load."); }
    finally { if (mounted.current && ticket === serial.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); mounted.current = false; serial.current += 1; };
  }, [load]);

  async function write(path: string, body: Record<string, unknown>) {
    const fingerprint = JSON.stringify([path, body]);
    let key = writes.current.get(fingerprint);
    if (!key) { key = crypto.randomUUID(); writes.current.set(fingerprint, key); }
    const result = adminCoinOfferMutationSchema.parse(await apiWrite(path, "POST", body, { "idempotency-key": key }));
    writes.current.delete(fingerprint);
    return result.offer;
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || !canWrite) return;
    const body = adminCoinOfferCreateRequestSchema.safeParse({ ...draft, dreamcoins: Number(draft.dreamcoins), priceCents: Number(draft.priceCents) });
    if (!body.success) { setError(t("Complete the offer fields, including the customer purchase and refund terms.")); return; }
    setBusy(true); setError("");
    try {
      await write("/api/v2/admin/billing/coin-offers", body.data);
      if (mounted.current) { setDraft(emptyDraft); await load(); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Coin draft could not be saved."); }
    finally { if (mounted.current) setBusy(false); }
  }
  function change(offer: CoinOffer, action: "publish" | "retire") {
    setConfirmation({
      title: action === "publish" ? "Publish coin offer" : "Retire coin offer",
      summary: <div className="space-y-3"><p>{offer.name} · {offer.dreamcoins.toLocaleString()} {t("Dreamcoins")} · {(offer.priceCents / 100).toFixed(2)} {offer.currency.toUpperCase()}</p><p className="whitespace-pre-line text-sm">{offer.terms}</p></div>,
      destructive: { expectedName: offer.name },
      consequence: { reversible: true, effect: action === "publish"
        ? "New purchases use this version. Previously accepted invoices keep their original price, coin amount, and terms."
        : "New purchases stop. Previously accepted invoices remain payable under their original terms." },
      submitLabel: action === "publish" ? "Publish coin offer" : "Retire coin offer",
      onSubmit: async (reason) => {
        await write(`/api/v2/admin/billing/coin-offers/${encodeURIComponent(offer.id)}/state`, { version: offer.version, action, confirmation: `${offer.id}:${action}`, reason });
        if (mounted.current) await load();
      },
    });
  }

  return <section aria-label={t("Dreamcoin offers")} className="space-y-4 rounded-xl border border-[var(--ad-border)] p-4 md:p-5">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{t("Dreamcoin offers")}</h2><p className="mt-1 max-w-prose text-sm text-[var(--ad-text-muted)]">{t("Create a draft with approved commercial terms. Publishing replaces the previous live version of the same offer.")}</p></div><button className={button} disabled={loading || busy} onClick={() => void load()} type="button">{t("Refresh")}</button></header>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {loading ? <p role="status" className="text-sm">{t("Loading coin offers…")}</p> : !items.length ? <p className="text-sm text-[var(--ad-text-muted)]">{t("No coin offers have been configured.")}</p> : <div className="divide-y divide-[var(--ad-border)]">{items.map((offer) => <article className="py-4" key={offer.id}><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{offer.name} · {t("Version")} {offer.version}</h3><p className="mt-1 text-sm">{offer.dreamcoins.toLocaleString()} {t("Dreamcoins")} · {(offer.priceCents / 100).toFixed(2)} {offer.currency.toUpperCase()} · {label(offer.status)}</p></div>{canWrite && offer.status !== "retired" && <button className={button} disabled={busy} onClick={() => change(offer, offer.status === "draft" ? "publish" : "retire")} type="button">{offer.status === "draft" ? t("Publish coin offer") : t("Retire coin offer")}</button>}</div><details className="mt-3 text-sm"><summary>{t("Purchase terms")}</summary><p className="mt-2 whitespace-pre-line">{offer.terms}</p></details></article>)}</div>}
    {canWrite && <form aria-label={t("Create coin offer draft")} className="border-t border-[var(--ad-border)] pt-4" onSubmit={(event) => void create(event)}>
      <h3 className="mb-4 font-semibold">{t("Create coin offer draft")}</h3><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{([
        ["offerKey", "Offer key"], ["name", "Offer name"], ["dreamcoins", "Dreamcoin amount"], ["priceCents", "Price in cents"], ["currency", "Currency"], ["reason", "Reason (≥3)"],
      ] as const).map(([key, title]) => <label className="text-sm" key={key}>{t(title)}<input className={input} disabled={busy} min={key === "dreamcoins" || key === "priceCents" ? 1 : undefined} onChange={(event) => setDraft((value) => ({ ...value, [key]: event.target.value }))} required type={key === "dreamcoins" || key === "priceCents" ? "number" : "text"} value={draft[key]} /></label>)}
      <label className="text-sm">{t("Buyer eligibility")}<select className={input} disabled={busy} onChange={(event) => setDraft((value) => ({ ...value, eligibility: event.target.value }))} value={draft.eligibility}><option value="all">{t("All signed-in accounts")}</option><option value="paid_access">{t("Active paid access only")}</option></select></label></div>
      <label className="mt-4 block text-sm">{t("Customer purchase and refund terms")}<textarea className={`${input} min-h-28`} disabled={busy} minLength={20} maxLength={4000} onChange={(event) => setDraft((value) => ({ ...value, terms: event.target.value }))} required value={draft.terms} /></label>
      <button className={`${button} mt-4 bg-[var(--ad-ink)] text-white`} disabled={busy} type="submit">{busy ? t("Saving…") : t("Save coin offer draft")}</button>
    </form>}
    {confirmation && <ConfirmDialog spec={confirmation} onClose={() => setConfirmation(null)} />}
  </section>;
}
