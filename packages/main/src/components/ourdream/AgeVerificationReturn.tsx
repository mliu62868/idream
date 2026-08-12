"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { authHrefForTarget } from "./authRedirect";
import {
  parseAgeVerificationStatusResponse,
  type PublicAgeVerificationStatus,
} from "@/lib/public-api-contracts";
import {
  AGE_VERIFICATION_RETURN_PATH,
  safeAgeVerificationReturnTarget,
} from "@/lib/age-verification-return";

const POLL_INTERVAL_MS = 2_500;
const RESUME_DELAY_MS = 900;

export { safeAgeVerificationReturnTarget } from "@/lib/age-verification-return";

export type AgeVerificationReturnState =
  | "checking"
  | "pending"
  | "verified"
  | "failed"
  | "signed_out"
  | "unavailable";

export function ageVerificationReturnStateForStatus(
  status: PublicAgeVerificationStatus,
) {
  switch (status) {
    case "not_required":
    case "verified":
      return "verified" as const;
    case "required":
    case "pending":
      return "pending" as const;
    case "failed":
    case "expired":
      return "failed" as const;
  }
}

export async function loadAgeVerificationReturnStatus(
  fetcher: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
  signal?: AbortSignal,
) {
  const response = await fetcher("/api/v1/age-verification/status", {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  if (response.status === 401) return { kind: "signed_out" as const };
  if (!response.ok) throw new Error("Age verification status unavailable");
  const { status } = parseAgeVerificationStatusResponse(await response.json());
  return { kind: "status" as const, status };
}

export function AgeVerificationReturn({
  nextPath,
}: Readonly<{ nextPath: string }>) {
  const safeNextPath = safeAgeVerificationReturnTarget(nextPath);
  const [state, setState] = useState<AgeVerificationReturnState>("checking");
  const [refreshSerial, setRefreshSerial] = useState(0);

  const retry = useCallback(() => {
    setState("checking");
    setRefreshSerial((serial) => serial + 1);
  }, []);

  useEffect(() => {
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const check = async () => {
      try {
        const result = await loadAgeVerificationReturnStatus(
          fetch,
          controller.signal,
        );
        if (!active) return;
        if (result.kind === "signed_out") {
          setState("signed_out");
          return;
        }
        const nextState = ageVerificationReturnStateForStatus(result.status);
        setState(nextState);
        if (nextState === "pending") {
          pollTimer = setTimeout(() => void check(), POLL_INTERVAL_MS);
        }
      } catch {
        if (active && !controller.signal.aborted) {
          setState("unavailable");
        }
      }
    };

    void check();
    return () => {
      active = false;
      controller.abort();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [refreshSerial]);

  useEffect(() => {
    if (state !== "verified") return;
    const resumeTimer = window.setTimeout(() => {
      window.location.replace(safeNextPath);
    }, RESUME_DELAY_MS);
    return () => window.clearTimeout(resumeTimer);
  }, [safeNextPath, state]);

  return (
    <AgeVerificationReturnFrame
      nextPath={safeNextPath}
      onRetry={retry}
      state={state}
    />
  );
}

export function AgeVerificationReturnFrame({
  nextPath,
  onRetry,
  state,
}: Readonly<{
  nextPath: string;
  onRetry: () => void;
  state: AgeVerificationReturnState;
}>) {
  const returnHref = ageVerificationReturnHref(nextPath);
  const isAlert = state === "failed" || state === "unavailable";

  return (
    <section className="px-4 py-12 md:px-[60px] md:py-20">
      <div className="mx-auto max-w-2xl rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-6 md:p-9">
        <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
          Age verification
        </p>
        <div
          aria-live={isAlert ? "assertive" : "polite"}
          className="mt-4"
          role={isAlert ? "alert" : "status"}
        >
          {state === "checking" && (
            <>
              <h1 className="text-[32px] font-black uppercase leading-none text-white md:text-[44px]">
                Checking your verification
              </h1>
              <p className="mt-4 text-[14px] font-medium leading-7 text-[rgb(170,170,170)]">
                We’re securely confirming the result returned by the age
                verification provider.
              </p>
            </>
          )}
          {state === "pending" && (
            <>
              <h1 className="text-[32px] font-black uppercase leading-none text-white md:text-[44px]">
                Verification in progress
              </h1>
              <p className="mt-4 text-[14px] font-medium leading-7 text-[rgb(170,170,170)]">
                The provider has not sent a final result yet. This page checks
                automatically, so you can keep it open or refresh safely.
              </p>
            </>
          )}
          {state === "verified" && (
            <>
              <h1 className="text-[32px] font-black uppercase leading-none text-white md:text-[44px]">
                Age verified
              </h1>
              <p className="mt-4 text-[14px] font-medium leading-7 text-[rgb(170,170,170)]">
                Verification is complete. Returning you to Ourdream now.
              </p>
            </>
          )}
          {state === "failed" && (
            <>
              <h1 className="text-[32px] font-black uppercase leading-none text-white md:text-[44px]">
                Verification wasn’t completed
              </h1>
              <p className="mt-4 text-[14px] font-medium leading-7 text-[rgb(170,170,170)]">
                The verification failed or expired. Check again if you just
                completed it, or return to your profile for account options.
              </p>
            </>
          )}
          {state === "signed_out" && (
            <>
              <h1 className="text-[32px] font-black uppercase leading-none text-white md:text-[44px]">
                Sign in to finish verification
              </h1>
              <p className="mt-4 text-[14px] font-medium leading-7 text-[rgb(170,170,170)]">
                Your provider result is tied to your account. Sign in, then
                this page will confirm the saved result.
              </p>
            </>
          )}
          {state === "unavailable" && (
            <>
              <h1 className="text-[32px] font-black uppercase leading-none text-white md:text-[44px]">
                Couldn’t confirm verification
              </h1>
              <p className="mt-4 text-[14px] font-medium leading-7 text-[rgb(170,170,170)]">
                The verification service is temporarily unavailable. Your
                provider result is not lost; try checking again.
              </p>
            </>
          )}
        </div>

        <div className="mt-7 flex flex-wrap gap-3">
          {(state === "pending" || state === "failed" || state === "unavailable") && (
            <button
              className="inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)] hover:bg-white/90"
              onClick={onRetry}
              type="button"
            >
              Check again
            </button>
          )}
          {state === "verified" && (
            <Link
              className="inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)] hover:bg-white/90"
              href={nextPath}
            >
              Continue now
            </Link>
          )}
          {state === "signed_out" && (
            <Link
              className="inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)] hover:bg-white/90"
              href={authHrefForTarget("/login", returnHref)}
            >
              Log in
            </Link>
          )}
          {(state === "failed" || state === "unavailable") && (
            <Link
              className="inline-flex h-11 items-center justify-center rounded-full bg-[rgb(46,46,46)] px-5 text-[14px] font-bold text-white hover:bg-[rgb(53,53,54)]"
              href="/profile"
            >
              Return to profile
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

function ageVerificationReturnHref(nextPath: string) {
  return `${AGE_VERIFICATION_RETURN_PATH}?next=${encodeURIComponent(nextPath)}`;
}
