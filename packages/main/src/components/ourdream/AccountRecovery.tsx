"use client";

import { useEffect, useState, type FormEvent } from "react";
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
    <p className="mt-3 text-sm leading-6 text-white/70">Keep this private in your password manager. This single-use code restores access if you forget your password. It expires in one year. Generating a new code replaces the previous one. Email password reset is currently unavailable.</p>
    <code className="my-4 block select-all break-all rounded-lg bg-black/30 p-4 text-sm" data-testid="account-recovery-code">{code}</code>
    <p className="text-sm text-white/70">This is the only time this code is shown. Anyone with your email and this code can access your account.</p>
    {onContinue && <><label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />I saved my recovery code</label><button className="mt-4 rounded-full bg-pink-600 px-5 py-3 font-bold disabled:opacity-40" disabled={!saved} onClick={onContinue} type="button">Continue</button></>}
  </div>;
}

export function AccountRecovery({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [replacement, setReplacement] = useState<{ code: string; ownerId: string } | null>(null);
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setStatus("");
    try {
      const response = await fetch("/api/v1/auth/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, recoveryCode: code, password }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        setStatus(response.status === 429 ? "Too many attempts. Wait 15 minutes before trying again." : payload.error?.message ?? "Recovery failed. Check your code and try again.");
        return;
      }
      setPassword(""); setCode(""); setReplacement({ code: payload.data.recoveryCode, ownerId: payload.data.userId });
    } catch { setStatus("The result could not be confirmed. Try logging in with your new password first. If it works, generate a new recovery code in Account management; otherwise retry your saved code."); }
    finally { setPending(false); }
  }
  if (replacement) return <RecoveryCodeCard code={replacement.code} ownerId={replacement.ownerId} onContinue={onComplete} />;
  return <form className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-5" onSubmit={submit}>
    <h2 className="text-2xl font-bold">Recover account access</h2>
    <p className="mt-3 text-sm leading-6 text-white/70">Use the recovery code saved when you joined or generated in Account management. A successful recovery changes your password and signs out all other sessions.</p>
    <label className="mt-4 block text-sm">Email<input required type="email" autoComplete="email" className="mt-2 w-full rounded-lg bg-white/10 p-3" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label className="mt-4 block text-sm">Recovery code<input required autoComplete="off" className="mt-2 w-full rounded-lg bg-white/10 p-3" value={code} onChange={(e) => setCode(e.target.value)} /></label>
    <label className="mt-4 block text-sm">New password<input required type="password" minLength={8} maxLength={1024} autoComplete="new-password" className="mt-2 w-full rounded-lg bg-white/10 p-3" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    <button disabled={pending} className="mt-5 rounded-full bg-pink-600 px-5 py-3 font-bold disabled:opacity-40" type="submit">{pending ? "Recovering..." : "Reset password and log in"}</button>
    {status && <p className="mt-4 text-sm leading-6" role="alert">{status}</p>}
    <details className="mt-5 text-sm leading-6 text-white/70"><summary className="cursor-pointer text-white">Lost or expired recovery code?</summary><p className="mt-2">If you still know your password, log in and generate a new code in Account management. Check your password manager and saved account records. Email reset is unavailable. Without your password or a valid saved recovery code, we cannot safely establish account ownership or restore access. Creating another account will not restore the original account.</p></details>
    <button onClick={onBack} type="button" className="mt-5 text-sm underline">Back to login</button>
  </form>;
}
