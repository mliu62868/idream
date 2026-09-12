"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { RecoveryCodeCard } from "./RecoveryCodeCard";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const challengeSchema = z.object({ challengeId: z.string().min(1), expiresAt: z.string().datetime(), resendAt: z.string().datetime() });
const verificationSchema = z.object({ userId: z.string(), email: z.string().email(), verified: z.boolean(), available: z.boolean() });
const recoverySchema = z.object({ recovered: z.literal(true), userId: z.string().min(1), recoveryCode: z.string().min(1) });
const fieldClass = "mt-2 w-full rounded-lg bg-white/10 p-3 disabled:opacity-50";
const buttonClass = "rounded-full bg-pink-600 px-5 py-3 text-sm font-bold disabled:opacity-40";

class EmailRequestError extends Error {
  constructor(message: string, readonly retryAfterMs = 0, readonly status = 0) { super(message); }
}

async function readResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new EmailRequestError(
      typeof payload?.error?.message === "string" ? payload.error.message : "The request could not be completed. Try again.",
      typeof payload?.error?.details?.retryAfterMs === "number" ? payload.error.details.retryAfterMs : 0,
      response.status,
    );
  }
  return schema.parse(payload.data);
}

function useEmailChallenge() {
  const [challenge, setChallenge] = useState<z.infer<typeof challengeSchema> | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!challenge && !resendAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [challenge, resendAt]);
  return {
    challenge,
    secondsUntilResend: Math.max(0, Math.ceil((resendAt - now) / 1_000)),
    expired: Boolean(challenge && Date.parse(challenge.expiresAt) <= now),
    accept(next: z.infer<typeof challengeSchema>) { setNow(Date.now()); setChallenge(next); setResendAt(Date.parse(next.resendAt)); },
    failed(error: unknown) {
      setNow(Date.now());
      if (!(error instanceof EmailRequestError) || error.status !== 429) setChallenge(null);
      setResendAt(Date.now() + (error instanceof EmailRequestError && error.retryAfterMs > 0 ? error.retryAfterMs : 60_000));
    },
    clear() { setChallenge(null); setResendAt(0); setNow(Date.now()); },
  };
}

function CodeInput({ code, setCode, expired, pending }: { code: string; setCode: (code: string) => void; expired: boolean; pending: boolean }) {
  return <>
    <label className="mt-4 block text-sm">Email verification code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" minLength={8} maxLength={8} disabled={pending || expired} className={fieldClass} value={code} onChange={(event) => setCode(event.target.value)} /></label>
    <p className="mt-2 text-sm leading-6 text-white/70" role="status">{expired ? "This code has expired. Request a new code to continue." : "Codes expire after 10 minutes. Only the most recent code works, and it can be used once."}</p>
  </>;
}

export function AccountEmailVerification({ ownerId, fetcher = fetch }: { ownerId: string; fetcher?: Fetcher }) {
  const [account, setAccount] = useState<z.infer<typeof verificationSchema> | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const alive = useRef(false);
  const emailCode = useEmailChallenge();
  useEffect(() => {
    alive.current = true;
    void fetcher("/api/v1/account/email-verification", { cache: "no-store" })
      .then((response) => readResponse(response, verificationSchema))
      .then((next) => {
        if (!alive.current) return;
        if (next.userId !== ownerId) throw new Error("Your account changed. Reload before verifying your email.");
        setAccount(next);
      })
      .catch((error: unknown) => { if (alive.current) setStatus(error instanceof Error ? error.message : "Could not check email verification. Reload and try again."); });
    return () => { alive.current = false; };
  }, [fetcher, ownerId]);

  async function requestCode() {
    if (pending || !account || !account.available) return;
    setPending(true); setStatus("");
    try {
      const response = await fetcher("/api/v1/account/email-verification/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUserId: ownerId }) });
      const next = await readResponse(response, challengeSchema);
      if (!alive.current) return;
      emailCode.accept(next); setCode(""); setStatus("Check your mailbox and spam folder for the new code.");
    } catch (error) {
      if (!alive.current) return;
      emailCode.failed(error); setStatus(error instanceof Error ? error.message : "The email request could not be confirmed. Request a new code after the cooldown.");
    } finally { if (alive.current) setPending(false); }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (pending || !emailCode.challenge || emailCode.expired) return;
    setPending(true); setStatus("");
    try {
      const response = await fetcher("/api/v1/account/email-verification/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUserId: ownerId, challengeId: emailCode.challenge.challengeId, code }) });
      const result = await readResponse(response, z.object({ userId: z.literal(ownerId), verified: z.literal(true) }));
      if (!alive.current) return;
      setAccount((current) => current ? { ...current, verified: result.verified } : null);
      emailCode.clear(); setCode(""); setStatus("Your email is verified.");
    } catch (error) { if (alive.current) setStatus(error instanceof Error ? error.message : "Verification could not be confirmed. Reload to check before requesting a new code."); }
    finally { if (alive.current) setPending(false); }
  }

  return <form className="mt-5 border-t border-white/10 pt-5" onSubmit={confirm}>
    <h3 className="text-base font-bold">Email verification</h3>
    {account ? <p className="mt-2 text-sm leading-6 text-white/70">{account.email} · {account.verified ? "Verified" : "Not verified"}</p> : <p className="mt-2 text-sm text-white/70">Checking email verification…</p>}
    {account && !account.verified && <>
      {!account.available && <p className="mt-2 text-sm leading-6 text-white/70">Email delivery is temporarily unavailable. Your saved recovery code remains usable.</p>}
      <button className={`${buttonClass} mt-3`} type="button" disabled={pending || !account.available || emailCode.secondsUntilResend > 0} onClick={() => void requestCode()}>{emailCode.secondsUntilResend > 0 ? `Resend in ${emailCode.secondsUntilResend}s` : emailCode.challenge ? "Resend email code" : "Send verification code"}</button>
      {emailCode.challenge && <><CodeInput code={code} setCode={setCode} expired={emailCode.expired} pending={pending} /><button className={`${buttonClass} mt-4`} type="submit" disabled={pending || emailCode.expired || !/^\d{8}$/.test(code)}>Verify email</button></>}
    </>}
    {status && <p className="mt-3 text-sm leading-6" role="status">{status}</p>}
  </form>;
}

export function EmailPasswordRecovery({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [replacement, setReplacement] = useState<z.infer<typeof recoverySchema> | null>(null);
  const emailCode = useEmailChallenge();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    if (pending || emailCode.secondsUntilResend > 0) return;
    setPending(true); setStatus("");
    try {
      const response = await fetch("/api/v1/auth/password-reset/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      const next = await readResponse(response, challengeSchema);
      if (!alive.current) return;
      emailCode.accept(next); setCode(""); setStatus("Check your mailbox and spam folder. A code can only recover an eligible account; this response does not confirm that one exists.");
    } catch (error) {
      if (!alive.current) return;
      emailCode.failed(error); setStatus(error instanceof Error ? error.message : "The email request could not be confirmed. Request a new code after the cooldown.");
    } finally { if (alive.current) setPending(false); }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    if (pending || !emailCode.challenge || emailCode.expired) return;
    setPending(true); setStatus("");
    try {
      const response = await fetch("/api/v1/auth/password-reset/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, challengeId: emailCode.challenge.challengeId, code, password }) });
      const result = await readResponse(response, recoverySchema);
      if (!alive.current) return;
      setCode(""); setPassword(""); emailCode.clear(); setReplacement(result);
    } catch (error) {
      if (!alive.current) return;
      setStatus(error instanceof EmailRequestError ? error.message : "The result could not be confirmed. Try logging in with your new password first. If it works, generate a new recovery code in Account management; otherwise request a new email code.");
    } finally { if (alive.current) setPending(false); }
  }

  if (replacement) return <RecoveryCodeCard code={replacement.recoveryCode} ownerId={replacement.userId} onContinue={onComplete} />;
  return <div className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-5">
    <h2 className="text-2xl font-bold">Recover with email</h2>
    <p className="mt-3 text-sm leading-6 text-white/70">Receive a code at your account email, then choose a new password. Successful recovery signs out all other sessions and replaces your saved recovery code.</p>
    <form onSubmit={requestCode}>
      <label className="mt-4 block text-sm">Email<input required type="email" autoComplete="email" disabled={pending} className={fieldClass} value={email} onChange={(event) => { setEmail(event.target.value); setCode(""); emailCode.clear(); setStatus(""); }} /></label>
      <button className={`${buttonClass} mt-4`} type="submit" disabled={pending || !email.trim() || emailCode.secondsUntilResend > 0}>{emailCode.secondsUntilResend > 0 ? `Resend in ${emailCode.secondsUntilResend}s` : emailCode.challenge ? "Resend email code" : "Send email code"}</button>
    </form>
    {emailCode.challenge && <form onSubmit={resetPassword}>
      <CodeInput code={code} setCode={setCode} expired={emailCode.expired} pending={pending} />
      <label className="mt-4 block text-sm">New password<input required type="password" autoComplete="new-password" minLength={8} maxLength={1024} disabled={pending} className={fieldClass} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className={`${buttonClass} mt-4`} type="submit" disabled={pending || emailCode.expired || !/^\d{8}$/.test(code) || password.length < 8}>{pending ? "Recovering…" : "Reset password and log in"}</button>
    </form>}
    {status && <p className="mt-4 text-sm leading-6" role="alert">{status}</p>}
    <p className="mt-4 text-sm leading-6 text-white/70">If you cannot access this mailbox, use a saved recovery code. Without either credential or your password, account ownership cannot be verified safely.</p>
    <button className="mt-5 text-sm underline" type="button" disabled={pending} onClick={onBack}>Use saved recovery code</button>
  </div>;
}
