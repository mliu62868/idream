"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { coinCheckoutResponseSchema, coinHistorySchema, coinStoreSchema, type CoinOffer, type CoinPurchase, type CoinStore } from "@idream/shared/coins";
import { clearPendingCoinCheckout, readPendingCoinCheckout, savePendingCoinCheckout, type PendingCoinCheckout } from "@/lib/coin-checkout-intent";
import { z } from "zod";
import { parsePublicApiError, parseViewerAuthorityResponse } from "@/lib/public-api-contracts";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { safeInternalAuthRedirect } from "./authRedirect";

const button = "inline-flex min-h-11 items-center justify-center rounded-full border border-white/20 px-5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40";
const terminal = new Set(["completed", "canceled", "expired", "refunded"]);
const money = (value: { priceCents: number; currency: string }) => new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).format(value.priceCents / 100);

class CoinRequestError extends Error {
  constructor(message: string, readonly requiresNewKey: boolean) { super(message); }
}
const successEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() });
async function payload(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  const success = response.ok ? successEnvelopeSchema.safeParse(body) : null;
  if (success?.success) return success.data.data;
  const error = parsePublicApiError(body);
  throw new CoinRequestError(error?.message ?? "The payment request could not be completed. Retry the saved checkout.", error?.idempotencyAction === "new_key");
}

// A failed or unreadable identity check counts as a different account: money
// results are shown only while the server still recognizes their owner.
async function signedInAs(viewerId: string) {
  try {
    const response = await fetch("/api/v1/me", { cache: "no-store" });
    return response.ok && parseViewerAuthorityResponse(await response.json()).user?.id === viewerId;
  } catch { return false; }
}

export function CoinStoreWorkspace() {
  const { accepted } = useAgeGateAccess();
  const [store, setStore] = useState<CoinStore | null>(null);
  const [history, setHistory] = useState<CoinPurchase[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCoinCheckout | null>(null);
  const [selected, setSelected] = useState<CoinOffer | null>(null);
  const [returnPath, setReturnPath] = useState("/generate");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const scope = useRef<string | null>(null);
  const writing = useRef(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const ticket = ++generation.current;
    scope.current = null;
    setStore(null); setHistory([]); setSelected(null); setCursor(null); setPending(null); setLoading(true); setError(""); setNotice("");
    try {
      const data = coinStoreSchema.parse(await payload(await fetch("/api/v1/billing/coin-offers", { cache: "no-store", signal: abort.signal })));
      // The scoped history read re-confirms the account on the server. Balance,
      // receipt and history are committed together only after it succeeds, so an
      // account switch mid-load never shows the previous account's money state.
      const purchases = data.viewerId ? coinHistorySchema.parse(await payload(await fetch("/api/v1/billing/coin-purchases", {
        cache: "no-store", signal: abort.signal, headers: { "x-idream-viewer-scope": `user:${data.viewerId}` },
      }))) : null;
      if (abort.signal.aborted || ticket !== generation.current) return;
      scope.current = data.viewerId; setStore(data);
      if (data.viewerId && purchases) {
        setPending(readPendingCoinCheckout(window.sessionStorage, data.viewerId));
        setHistory(purchases.items); setCursor(purchases.nextCursor);
      }
    } catch (cause) {
      if (!abort.signal.aborted && ticket === generation.current) setError(cause instanceof Error ? cause.message : "Coin Store could not load.");
    } finally { if (!abort.signal.aborted && ticket === generation.current) setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setReturnPath(safeInternalAuthRedirect(new URLSearchParams(window.location.search).get("returnTo") ?? "/generate", window.location.origin));
      if (accepted) void load();
    }, 0);
    const refresh = () => {
      if (!accepted) return;
      const viewerId = scope.current;
      if (!writing.current || !viewerId) { void load(); return; }
      // Reloading now would drop the in-flight payment result for the same
      // account; a different account must stop seeing it immediately.
      void signedInAs(viewerId).then((same) => { if (!same && scope.current === viewerId) void load(); });
    };
    window.addEventListener("focus", refresh);
    return () => { window.clearTimeout(timer); controller.current?.abort(); generation.current += 1; scope.current = null; window.removeEventListener("focus", refresh); };
  }, [accepted, load]);

  async function mutate(action: (viewerId: string) => Promise<unknown>, confirmsReceipt = false) {
    if (writing.current || !store?.viewerId) return;
    const viewerId = store.viewerId;
    const ticket = generation.current;
    const accountChanged = async () => {
      if (ticket === generation.current) await load();
      setError("Your account changed. Review the current account before continuing.");
    };
    writing.current = true; setBusy(true); setError(""); setNotice("");
    try {
      // Confirm the viewer before and after the request: another tab can change
      // accounts while a payment is in flight. The server constrains scope; an
      // unprojected result leaves its owner's receipt to replay idempotently.
      if (!await signedInAs(viewerId)) { await accountChanged(); return; }
      const result = coinCheckoutResponseSchema.parse(await action(viewerId));
      if (ticket !== generation.current || scope.current !== viewerId) return;
      if (!await signedInAs(viewerId)) { await accountChanged(); return; }
      if (ticket !== generation.current) return;
      if (confirmsReceipt) { clearPendingCoinCheckout(window.sessionStorage, viewerId); setPending(null); }
      setSelected(null);
      setHistory((items) => [result.purchase, ...items.filter((item) => item.id !== result.purchase.id)]);
      setStore((value) => value && { ...value, balance: result.balance });
      setNotice(result.purchase.status === "completed"
        ? `${result.purchase.offer.dreamcoins.toLocaleString()} dreamcoins added. Your previous task is ready when you are.`
        : "Your invoice is saved below. Coins are added after the payment provider confirms the payment.");
    } catch (cause) {
      if (ticket === generation.current) {
        if (confirmsReceipt && cause instanceof CoinRequestError && cause.requiresNewKey) {
          clearPendingCoinCheckout(window.sessionStorage, viewerId); setPending(null); setSelected(null);
        }
        setError(cause instanceof Error ? cause.message : "Checkout could not be confirmed. Resume the saved request.");
      }
    } finally { writing.current = false; setBusy(false); }
  }

  async function checkout(offer?: CoinOffer) {
    await mutate(async (viewerId) => {
      let receipt = readPendingCoinCheckout(window.sessionStorage, viewerId);
      if (!receipt) {
        if (!offer) throw new Error("There is no saved checkout to resume.");
        receipt = savePendingCoinCheckout(window.sessionStorage, viewerId, { offerId: offer.id, offerFingerprint: offer.fingerprint, returnPath });
        setPending(receipt);
      }
      return payload(await fetch("/api/v1/billing/coin-checkout", { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": receipt.key, "x-idream-viewer-scope": `user:${viewerId}` },
        body: JSON.stringify(receipt.body) }));
    }, true);
  }

  async function more() {
    if (!cursor || !store?.viewerId || busy) return;
    const viewerId = store.viewerId, ticket = generation.current;
    setBusy(true);
    try {
      const data = coinHistorySchema.parse(await payload(await fetch(`/api/v1/billing/coin-purchases?cursor=${encodeURIComponent(cursor)}`, {
        cache: "no-store", headers: { "x-idream-viewer-scope": `user:${viewerId}` },
      })));
      if (ticket !== generation.current || scope.current !== viewerId) return;
      setHistory((items) => [...items, ...data.items.filter((item) => !items.some((existing) => existing.id === item.id))]); setCursor(data.nextCursor);
    } catch (cause) { if (ticket === generation.current) setError(cause instanceof Error ? cause.message : "History could not load."); }
    finally { setBusy(false); }
  }

  return <section className="mx-auto max-w-5xl px-4 py-10 md:px-8 md:py-14">
    <header className="mb-8 flex flex-wrap items-end justify-between gap-5"><div><h1 className="text-4xl font-black">Dreamcoin Store</h1>
      <p className="mt-3 max-w-prose text-sm leading-6 text-neutral-300">Add dreamcoins with a one-time crypto payment. Your balance stays available when your plan ends.</p></div>
      {store?.balance !== null && store?.balance !== undefined && <p className="text-lg font-bold">{store.balance.toLocaleString()} dreamcoins</p>}
    </header>
    <nav className="mb-7 flex flex-wrap gap-5 text-sm" aria-label="Billing navigation"><Link className="underline underline-offset-4" href={returnPath}>Return to your task</Link><Link className="underline underline-offset-4" href={`/upgrade?returnTo=${encodeURIComponent(returnPath)}`}>Compare access plans</Link><Link className="underline underline-offset-4" href="/helpdesk">Payment help</Link></nav>
    {loading && <p role="status">Loading prices and purchases…</p>}
    {error && <div role="alert" className="mb-5 rounded-xl border border-red-300/30 bg-red-950/20 p-4 text-sm"><p>{error}</p><button className={`${button} mt-3`} disabled={busy} onClick={() => void load()} type="button">Refresh account and prices</button></div>}
    {notice && <p role="status" className="mb-5 rounded-xl border border-white/20 p-4 text-sm">{notice}</p>}
    {!loading && store?.billing.demoMode && <p className="mb-5 rounded-xl border border-amber-300/30 p-4 text-sm text-amber-100">Demo payments are enabled in this environment. No real cryptocurrency is collected by this checkout.</p>}
    {!loading && store && !store.viewerId && <p className="mb-6"><Link className={button} href={`/login?next=${encodeURIComponent(`/coins?returnTo=${encodeURIComponent(returnPath)}`)}`}>Sign in to buy dreamcoins</Link></p>}
    {pending && <section aria-label="Unconfirmed coin checkout" className="mb-6 rounded-xl border border-amber-300/40 p-5"><h2 className="font-bold">Check your previous checkout</h2><p className="mt-2 text-sm text-neutral-300">A previous submission has no confirmed response. Resume it before starting another purchase.</p><button className={`${button} mt-4`} disabled={busy} onClick={() => void checkout()} type="button">Resume saved checkout</button></section>}
    {!loading && store && store.offers.length === 0 && <p role="status" className="rounded-xl border border-white/10 p-6 text-neutral-300">No dreamcoin offers are available right now. You can still compare the current access plans.</p>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{store?.offers.map((offer) => <article key={offer.id} className="rounded-2xl border border-white/15 bg-white/[.03] p-6">
      <h2 className="text-lg font-bold">{offer.name}</h2><p className="mt-5 text-3xl font-black">{offer.dreamcoins.toLocaleString()} <span className="text-sm font-medium text-neutral-300">dreamcoins</span></p><p className="mt-3 text-xl font-bold">{money(offer)}</p>
      <p className="mt-3 text-sm text-neutral-300">{offer.eligibility === "paid_access" ? "Requires active paid access" : "Available to all signed-in accounts"}</p>
      <button className={`${button} mt-5 w-full bg-white text-neutral-950`} disabled={busy || Boolean(pending) || !offer.eligible} onClick={() => setSelected(offer)} type="button">Review purchase</button>
    </article>)}</div>
    {selected && <section aria-label="Review coin purchase" className="my-6 rounded-2xl border border-white/25 p-6"><h2 className="text-xl font-bold">{selected.name}: {selected.dreamcoins.toLocaleString()} dreamcoins for {money(selected)}</h2><p className="mt-4 whitespace-pre-line text-sm leading-6 text-neutral-200">{selected.terms}</p><div className="mt-5 flex flex-wrap gap-3"><button className={`${button} bg-white text-neutral-950`} disabled={busy} onClick={() => void checkout(selected)} type="button">{busy ? "Creating invoice…" : "Continue to crypto checkout"}</button><button className={button} disabled={busy} onClick={() => setSelected(null)} type="button">Back to offers</button></div></section>}
    {store?.viewerId && <section className="mt-10" aria-label="Coin purchases"><h2 className="mb-5 text-2xl font-bold">Your coin purchases</h2>{!loading && !history.length && <p className="text-sm text-neutral-300">You have no coin purchases yet.</p>}
      <div className="space-y-4">{history.map((purchase) => <article key={purchase.id} className="rounded-xl border border-white/15 p-5"><div className="flex flex-wrap justify-between gap-3"><h3 className="font-bold">{purchase.offer.dreamcoins.toLocaleString()} dreamcoins · {money(purchase.offer)}</h3><p className="text-sm text-neutral-300">{purchase.status.replaceAll("_", " ")}</p></div><p className="mt-2 break-all text-xs text-neutral-400">Purchase {purchase.id}</p><p className="mt-2 text-xs text-neutral-400">{new Date(purchase.createdAt).toLocaleString()}</p>
        {purchase.needsReconciliation && <p className="mt-3 text-sm text-amber-100">The provider status needs checking. Keep this invoice while support or a status refresh resolves it.</p>}
        <div className="mt-4 flex flex-wrap gap-3">{!terminal.has(purchase.status) && <><button className={button} disabled={busy} onClick={() => void mutate(async (viewerId) => payload(await fetch(`/api/v1/billing/coin-purchases/${encodeURIComponent(purchase.id)}/reconcile`, { method: "POST", headers: { "x-idream-viewer-scope": `user:${viewerId}` } })))} type="button">Refresh payment status</button>{purchase.checkoutUrl && !purchase.needsReconciliation && <a className={button} href={purchase.checkoutUrl} rel="noopener noreferrer" target="_blank">Open payment invoice</a>}</>}{purchase.status === "completed" && <Link className={button} href={safeInternalAuthRedirect(purchase.returnPath ?? "/generate", window.location.origin)}>Return to your task</Link>}</div>
      </article>)}</div>{cursor && <button className={`${button} mt-5`} disabled={busy} onClick={() => void more()} type="button">Load older purchases</button>}
    </section>}
  </section>;
}
