"use client";

import { useEffect, useState } from "react";
import { parseViewerAuthorityResponse } from "@/lib/public-api-contracts";

export function RecoveryCodeCard({ code, ownerId, onContinue }: { code: string; ownerId: string; onContinue?: () => void }) {
  const [saved, setSaved] = useState(false);
  const [verified, setVerified] = useState(false);
  const [scopeError, setScopeError] = useState("");
  useEffect(() => {
    let active = true;
    let serial = 0;
    async function check() {
      const requestSerial = ++serial;
      setVerified(false);
      try {
        const response = await fetch("/api/v1/me", { cache: "no-store" });
        const current = parseViewerAuthorityResponse(await response.json());
        if (!active || requestSerial !== serial) return;
        if (!response.ok || current.user?.id !== ownerId) { setScopeError("Account changed. Log in to the original account and generate a new recovery code in Account management."); return; }
        setScopeError(""); setVerified(true);
      } catch { if (active && requestSerial === serial) setScopeError("Could not verify your account. Return to this tab after reconnecting to check again."); }
    }
    function hide() { serial += 1; setVerified(false); }
    const initial = window.setTimeout(() => void check(), 0);
    const focus = () => void check();
    window.addEventListener("focus", focus);
    window.addEventListener("blur", hide);
    return () => { active = false; window.clearTimeout(initial); window.removeEventListener("focus", focus); window.removeEventListener("blur", hide); };
  }, [ownerId, code]);
  if (!verified) return <div role="status" className="rounded-2xl border border-white/15 p-5 text-sm">{scopeError || "Checking your account before showing the recovery code..."}</div>;
  return <div className="rounded-[16px] border border-white/15 bg-[rgb(18,18,18)] p-5" role="status">
    <h2 className="text-xl font-bold">Save your recovery code</h2>
    <p className="mt-3 text-sm leading-6 text-white/70">Keep this private in your password manager. This single-use code restores access if you forget your password. It expires in one year. Generating a new code replaces the previous one. You can also choose email recovery on the login page.</p>
    <code className="my-4 block select-all break-all rounded-lg bg-black/30 p-4 text-sm" data-testid="account-recovery-code">{code}</code>
    <p className="text-sm text-white/70">This is the only time this code is shown. Anyone with your email and this code can access your account.</p>
    {onContinue && <><label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />I saved my recovery code</label><button className="mt-4 rounded-full bg-pink-600 px-5 py-3 font-bold disabled:opacity-40" disabled={!saved} onClick={onContinue} type="button">Continue</button></>}
  </div>;
}


