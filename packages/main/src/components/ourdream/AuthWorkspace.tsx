"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { parseViewerAuthorityResponse } from "@/lib/public-api-contracts";
import { authHrefForTarget, safeInternalAuthRedirect } from "./authRedirect";

export function AuthWorkspace({
  mode,
}: Readonly<{ mode: "login" | "signup" }>) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [loginRecoveryHref, setLoginRecoveryHref] = useState("/login");
  const shouldShowSignupLoginRecovery =
    mode === "signup" && status === "Email already registered";

  const redirectIfAlreadyAuthenticated = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/me");
      if (!response.ok) return false;
      const payload = parseViewerAuthorityResponse(await response.json());
      if (!payload.user) return false;
      window.location.replace(authRedirectTarget());
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setInteractive(true));
    void redirectIfAlreadyAuthenticated();
    return () => window.cancelAnimationFrame(frame);
  }, [redirectIfAlreadyAuthenticated]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus("");
    try {
      // Carry the referral code from /signup?ref=DREAM-XXXX through to the API so the
      // invitee + inviter both get their dreamcoins.
      const ref =
        mode === "signup"
          ? new URLSearchParams(window.location.search).get("ref")?.trim() || undefined
          : undefined;
      const response = await fetch(`/api/v1/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "signup" ? { email, password, name, ref } : { email, password },
        ),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message: string };
      };
      if (!response.ok || !payload.ok) {
        if (await redirectIfAlreadyAuthenticated()) return;
        setLoginRecoveryHref(authLoginRecoveryHref());
        setStatus(payload.error?.message ?? "Authentication failed");
        return;
      }
      window.location.replace(authRedirectTarget());
    } catch {
      // Network/parse failure: surface it and let the finally re-enable the button.
      setStatus("Network error. Please check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="px-4 py-10 md:px-[60px] md:py-16">
      <div className="mx-auto grid max-w-5xl gap-6 md:grid-cols-[1fr_420px]">
        <div className="flex flex-col justify-center">
          <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
            {mode === "signup" ? "Join free" : "Welcome back"}
          </p>
          <h1 className="mt-3 text-[44px] font-black uppercase leading-none md:text-[68px]">
            {mode === "signup" ? "Create your Ourdream account" : "Log in to Ourdream"}
          </h1>
          <p className="mt-5 max-w-xl text-[15px] font-medium leading-7 text-[rgb(170,170,170)]">
            Sign in to unlock Create, Chat, Generate, My AI, dreamcoins, and
            checkout across your account.
          </p>
        </div>
        <form
          aria-busy={!interactive || pending}
          className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-5"
          data-auth-ready={interactive ? "true" : "false"}
          onSubmit={submit}
        >
          {mode === "signup" && (
            <label className="block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
              Display name
              <input
                className="mt-2 h-12 w-full rounded-[12px] bg-[rgb(36,36,36)] px-4 text-[14px] normal-case text-white outline-none"
                disabled={!interactive}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </label>
          )}
          <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
            Email
            <input
              className="mt-2 h-12 w-full rounded-[12px] bg-[rgb(36,36,36)] px-4 text-[14px] normal-case text-white outline-none"
              disabled={!interactive}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </label>
          <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
            Password
            <input
              className="mt-2 h-12 w-full rounded-[12px] bg-[rgb(36,36,36)] px-4 text-[14px] normal-case text-white outline-none"
              disabled={!interactive}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>
          <button
            className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-[14px] font-black text-white disabled:opacity-70"
            disabled={!interactive || pending}
            type="submit"
          >
            {pending ? "Working..." : mode === "signup" ? "Join Free" : "Login"}
            <ArrowRight className="h-4 w-4" />
          </button>
          {status && (
            <div className="mt-4 space-y-2">
              <p
                aria-live="assertive"
                className="text-[13px] font-medium text-[rgb(170,170,170)]"
                data-testid="auth-status"
                role="alert"
              >
                {status}
              </p>
              {mode === "login" && (
                <p className="text-[13px] font-medium text-[rgb(170,170,170)]">
                  Need account help?{" "}
                  <Link
                    className="font-black text-white underline decoration-white/30 underline-offset-4 hover:decoration-white"
                    href="/helpdesk"
                  >
                    Contact Help Desk
                  </Link>
                </p>
              )}
              {shouldShowSignupLoginRecovery && (
                <p className="text-[13px] font-medium text-[rgb(170,170,170)]">
                  Already registered?{" "}
                  <Link
                    className="font-black text-white underline decoration-white/30 underline-offset-4 hover:decoration-white"
                    href={loginRecoveryHref}
                  >
                    Log in instead
                  </Link>
                </p>
              )}
            </div>
          )}
        </form>
      </div>
    </section>
  );
}

function authRedirectTarget() {
  const next = new URLSearchParams(window.location.search).get("next");
  return safeInternalAuthRedirect(next, window.location.origin);
}

function authLoginRecoveryHref() {
  const target = authRedirectTarget();
  return target === "/" ? "/login" : authHrefForTarget("/login", target);
}
