"use client";

import { useState, type FormEvent } from "react";
import { RecoveryCodeCard } from "./RecoveryCodeCard";
export { RecoveryCodeCard } from "./RecoveryCodeCard";
import { EmailPasswordRecovery } from "./AccountEmailVerification";


export function AccountRecovery({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const [useEmail, setUseEmail] = useState(false);
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
  if (useEmail) return <EmailPasswordRecovery onBack={() => setUseEmail(false)} onComplete={onComplete} />;
  return <form className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-5" onSubmit={submit}>
    <h2 className="text-2xl font-bold">Recover account access</h2>
    <p className="mt-3 text-sm leading-6 text-white/70">Use the recovery code saved when you joined or generated in Account management. A successful recovery changes your password and signs out all other sessions.</p>
    <label className="mt-4 block text-sm">Email<input required type="email" autoComplete="email" className="mt-2 w-full rounded-lg bg-white/10 p-3" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label className="mt-4 block text-sm">Recovery code<input required autoComplete="off" className="mt-2 w-full rounded-lg bg-white/10 p-3" value={code} onChange={(e) => setCode(e.target.value)} /></label>
    <label className="mt-4 block text-sm">New password<input required type="password" minLength={8} maxLength={1024} autoComplete="new-password" className="mt-2 w-full rounded-lg bg-white/10 p-3" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    <button disabled={pending} className="mt-5 rounded-full bg-pink-600 px-5 py-3 font-bold disabled:opacity-40" type="submit">{pending ? "Recovering..." : "Reset password and log in"}</button>
    {status && <p className="mt-4 text-sm leading-6" role="alert">{status}</p>}
    <button onClick={() => setUseEmail(true)} disabled={pending} type="button" className="mt-5 block text-sm font-bold underline">Recover with an email code</button>
    <details className="mt-5 text-sm leading-6 text-white/70"><summary className="cursor-pointer text-white">Lost or expired recovery code?</summary><p className="mt-2">If you still know your password, log in and generate a new code in Account management. Otherwise, choose email recovery and use the mailbox registered to your account. If you also lost access to that mailbox, check your password manager and saved account records. Without your password, mailbox access, or a valid recovery code, we cannot safely establish account ownership or restore access. Creating another account will not restore the original account.</p></details>
    <button onClick={onBack} type="button" className="mt-5 text-sm underline">Back to login</button>
  </form>;
}
