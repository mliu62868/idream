"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseViewerAuthorityResponse } from "@/lib/public-api-contracts";
import { VIEWER_CHECK_TIMEOUT_MS } from "./viewer-auth";

type AccountCheck = { state: "verified"; ownerId: string } | { state: "checking" | "retry" | "changed" };

export function RecoveryCodeCard({ code, ownerId, onContinue }: { code: string; ownerId: string; onContinue?: () => void }) {
  const [copyStatus, setCopyStatus] = useState("");
  const [accountCheck, setAccountCheck] = useState<AccountCheck>({ state: "checking" });
  const requestRef = useRef<AbortController | null>(null);
  const check = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setAccountCheck({ state: "checking" });
    try {
      const response = await fetch("/api/v1/me", {
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(VIEWER_CHECK_TIMEOUT_MS)]),
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setAccountCheck({ state: response.status === 401 ? "changed" : "retry" });
        return;
      }
      const current = parseViewerAuthorityResponse(await response.json());
      if (controller.signal.aborted) return;
      setAccountCheck(current.user?.id === ownerId ? { state: "verified", ownerId } : { state: "changed" });
    } catch {
      if (!controller.signal.aborted) setAccountCheck({ state: "retry" });
    }
  }, [ownerId]);
  useEffect(() => {
    function hide() {
      requestRef.current?.abort();
      setAccountCheck({ state: "checking" });
    }
    const initial = window.setTimeout(() => void check(), 0);
    window.addEventListener("focus", check);
    window.addEventListener("blur", hide);
    return () => {
      requestRef.current?.abort();
      window.clearTimeout(initial);
      window.removeEventListener("focus", check);
      window.removeEventListener("blur", hide);
    };
  }, [check, code]);

  if (accountCheck.state !== "verified" || accountCheck.ownerId !== ownerId) {
    const retry = accountCheck.state === "retry";
    const changed = accountCheck.state === "changed";
    return (
      <div className="rounded-[16px] border border-white/15 bg-[rgb(18,18,18)] p-5 text-sm">
        <p role="status">{retry
          ? "Could not verify your account. Retry to see this code, or get a replacement in Account management later."
          : changed
            ? "Account changed. Open Profile to switch back to the original account and get a new code in Account management."
            : "Checking your account before showing the recovery code…"}</p>
        {retry && <div className="mt-4 flex flex-wrap gap-2">
          <button className="min-h-11 rounded-full bg-white px-5 py-2 font-bold text-black" onClick={() => void check()} type="button">Retry</button>
          {onContinue && <button className="min-h-11 rounded-full border border-white/20 px-5 py-2 font-bold" onClick={onContinue} type="button">Continue without code</button>}
        </div>}
        {changed && <Link className="mt-4 inline-flex min-h-11 items-center rounded-full bg-white px-5 py-2 font-bold text-black" href="/profile">Open Profile</Link>}
      </div>
    );
  }
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus("Recovery code copied.");
    } catch {
      setCopyStatus("Select the code to copy it manually.");
    }
  }

  return <div className="rounded-[16px] border border-white/15 bg-[rgb(18,18,18)] p-5">
    <h2 className="text-xl font-bold">Save your recovery code</h2>
    <p className="mt-3 text-sm leading-6 text-white/70">Keep this private. It can restore access once if you forget your password and expires in one year.</p>
    <code className="my-4 block select-all break-all rounded-lg bg-black/30 p-4 text-sm" data-testid="account-recovery-code">{code}</code>
    <p className="text-sm leading-6 text-white/70">This code is shown once. While signed in, you can generate a replacement in Account management.</p>
    <div className="mt-4 flex flex-wrap gap-2">
      <button className="min-h-11 rounded-full border border-white/20 px-5 py-2 text-sm font-bold" onClick={() => void copyCode()} type="button">Copy code</button>
      {onContinue && <button className="min-h-11 rounded-full bg-white px-5 py-2 text-sm font-bold text-black" onClick={onContinue} type="button">Continue</button>}
    </div>
    {copyStatus && <p className="mt-2 text-sm text-white/70" role="status">{copyStatus}</p>}
  </div>;
}


