"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type DeletionState = { id: string; status: string; requestedAt: string; graceEndsAt: string; completedAt: string | null; retrying: boolean; expiresAt: string };

export function AccountDeletionStatus({ receipt }: { receipt: string }) {
  const [deletion, setDeletion] = useState<DeletionState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState(0);
  const requestSerial = useRef(0);
  const refresh = useCallback(async () => {
    const serial = ++requestSerial.current;
    setPending(true); setError("");
    try {
      const response = await fetch("/api/v1/account/deletion-status", { headers: { authorization: `Bearer ${receipt}` }, cache: "no-store" });
      const payload = await response.json();
      if (serial !== requestSerial.current) return;
      if (!response.ok || !payload.ok) { setError(payload.error?.message ?? "Could not load deletion status."); return; }
      setDeletion(payload.data.deletion); setLoaded(true); setCheckedAt(Date.now());
    } catch { if (serial === requestSerial.current) setError("Could not load deletion status. Check your connection and refresh. Your deletion request will not be submitted again."); }
    finally { if (serial === requestSerial.current) setPending(false); }
  }, [receipt]);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { requestSerial.current += 1; window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);
  const title = !loaded ? "Checking deletion request" : !deletion ? "No deletion request received" : deletion.status === "completed" ? "Account deletion completed" : deletion.retrying ? "Deletion delayed — recovery in progress" : new Date(deletion.graceEndsAt).getTime() > checkedAt ? "Account deletion scheduled" : "Account deletion in progress";
  return <section className="mx-auto my-10 max-w-2xl rounded-2xl border border-white/10 bg-[rgb(18,18,18)] p-6">
    <h1 className="text-2xl font-bold" aria-live="polite">{title}</h1>
    {deletion && <div className="mt-4 space-y-3 text-sm leading-6 text-white/70"><p>Receipt: <span className="break-all">{deletion.id}</span></p><p>Requested: {new Date(deletion.requestedAt).toLocaleString()}</p><p>Erasure due after: {new Date(deletion.graceEndsAt).toLocaleString()}</p><p>{deletion.status === "completed" ? `Completed: ${new Date(deletion.completedAt!).toLocaleString()}. Account content was erased; minimal retained records follow the deletion policy.` : "Account access has ended. The deletion service keeps retrying interrupted work automatically, without creating duplicate requests. Required retention can delay erasure. This page will show completion when all required stages finish."}</p><p>Keep this private status link to check after signing out. It expires on {new Date(deletion.expiresAt).toLocaleDateString()} and cannot restore or access your account.</p></div>}
    {loaded && !deletion && <p className="mt-4 text-sm leading-6">Deletion has not been accepted. If your submission lost its connection, refresh to check again. You can log in and repeat the password-confirmed request if no request appears.</p>}
    {error && <p role="alert" className="mt-4 text-sm">{error}</p>}
    <div className="mt-5 flex flex-wrap gap-4">
      <button className="rounded-full bg-white/10 px-5 py-2 disabled:opacity-40" disabled={pending} onClick={() => void refresh()} type="button">{pending ? "Checking..." : "Refresh status"}</button>
      <Link href={`/login#deletion=${encodeURIComponent(receipt)}`} className="py-2 text-sm underline">Private status link — bookmark this page</Link>
      {/* Leave the receipt-bound view with a fresh document. A same-path Next
          transition changes history without notifying the hash subscriber. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- This account boundary intentionally requires document navigation. */}
      <a href="/login" className="py-2 text-sm underline">Back to login</a>
    </div>
  </section>;
}
