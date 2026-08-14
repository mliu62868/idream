"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { AGE_GATE_COOKIE_NAME } from "@/lib/age-gate";
import { parseViewerAuthorityResponse } from "@/lib/public-api-contracts";
import { AgeGate } from "./AgeGate";

export type AgeGateState = "checking" | "accepted" | "blocked";
export type AgeGateHistoryRecoveryAction = "restore" | "recheck" | null;

const AGE_GATE_STORAGE_KEY = "AdultContentAcceptedOD";
const AGE_GATE_COOKIE =
  "AdultContentAcceptedOD=true; path=/; max-age=31536000; samesite=lax";
const ageGateBypassPrefixes = ["/safety", "/internal-preview"];
const ageGateBypassExact = new Set(["/terms"]);

const AgeGateAccessContext = createContext<AgeGateState>("accepted");

export function AgeGateBoundary({
  children,
  initialAccepted = false,
}: Readonly<{
  children: React.ReactNode;
  initialAccepted?: boolean;
}>) {
  const pathname = usePathname();
  const [authoritativeAccepted, setAuthoritativeAccepted] =
    useState(initialAccepted);
  const [historyRecoveryEpoch, setHistoryRecoveryEpoch] = useState(0);
  const [resolution, setResolution] = useState<{
    pathname: string;
    state: AgeGateState;
  }>({
    pathname,
    state: initialAccepted ? "accepted" : "checking",
  });
  const bypass =
    isAgeGateBypassPath(pathname) || pathname.startsWith("/admin");
  const state: AgeGateState =
    bypass || authoritativeAccepted
      ? "accepted"
      : resolution.pathname === pathname
        ? resolution.state
        : "checking";

  useEffect(() => {
    if (
      isAgeGateBypassPath(pathname) ||
      pathname.startsWith("/admin") ||
      authoritativeAccepted
    ) {
      return;
    }

    if (hasAgeGateCookie() || readLocalAcceptance()) {
      let alive = true;
      let acceptedExternally = false;
      const accept = () => {
        acceptedExternally = true;
        setAuthoritativeAccepted(true);
      };
      window.addEventListener("idream-age-gate-accepted", accept);
      restoreAgeGateAuthority()
        .then(() => {
          if (alive && !acceptedExternally) {
            setAuthoritativeAccepted(true);
          }
        })
        .catch(() => {
          if (alive && !acceptedExternally) {
            setResolution({ pathname, state: "blocked" });
          }
        });
      return () => {
        alive = false;
        window.removeEventListener("idream-age-gate-accepted", accept);
      };
    }

    let alive = true;
    const controller = new AbortController();
    let acceptedExternally = false;
    const accept = () => {
      acceptedExternally = true;
      setAuthoritativeAccepted(true);
    };
    window.addEventListener("idream-age-gate-accepted", accept);
    fetch("/api/v1/me", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Age authority unavailable");
        return response.json();
      })
      .then((raw) => {
        if (!alive || acceptedExternally) return;
        const payload = parseViewerAuthorityResponse(raw);
        if (payload.ageGate?.accepted === true) {
          setAuthoritativeAccepted(true);
        } else {
          setResolution({ pathname, state: "blocked" });
        }
      })
      .catch(() => {
        if (alive && !acceptedExternally && !controller.signal.aborted) {
          setResolution({ pathname, state: "blocked" });
        }
      });

    return () => {
      alive = false;
      controller.abort();
      window.removeEventListener("idream-age-gate-accepted", accept);
    };
  }, [authoritativeAccepted, historyRecoveryEpoch, pathname]);

  useEffect(() => {
    const recoverFromHistory = (event: PageTransitionEvent) => {
      const action = ageGateHistoryRecoveryAction({
        persisted: event.persisted,
        acceptedLocally: hasAgeGateCookie() || readLocalAcceptance(),
      });
      if (action === "restore" || action === "recheck") {
        setAuthoritativeAccepted(false);
        setResolution({ pathname, state: "checking" });
        setHistoryRecoveryEpoch((epoch) => epoch + 1);
      }
    };
    window.addEventListener("pageshow", recoverFromHistory);
    return () => window.removeEventListener("pageshow", recoverFromHistory);
  }, [pathname]);

  useEffect(() => {
    if (state === "accepted") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [state]);

  return (
    <AgeGateFrame
      onAccepted={() => setAuthoritativeAccepted(true)}
      state={state}
    >
      {children}
    </AgeGateFrame>
  );
}

export function AgeGateFrame({
  children,
  onAccepted,
  state,
}: Readonly<{
  children: React.ReactNode;
  onAccepted: () => void;
  state: AgeGateState;
}>) {
  return (
    <AgeGateAccessContext.Provider value={state}>
      <div
        data-age-gate-content=""
        inert={state === "accepted" ? undefined : true}
      >
        {children}
      </div>
      {state === "checking" ? (
        <div
          aria-label="Checking age access"
          className="fixed inset-0 z-50 grid place-items-center bg-black"
          role="status"
        >
          <span className="sr-only">Checking age access</span>
        </div>
      ) : null}
      {state === "blocked" ? (
        <AgeGate
          forceVisible
          onAccepted={onAccepted}
        />
      ) : null}
    </AgeGateAccessContext.Provider>
  );
}

export function useAgeGateAccess() {
  const state = useContext(AgeGateAccessContext);
  return {
    accepted: state === "accepted",
    state,
  } as const;
}

// BFCache restores the exact suspended React heap. If navigation froze the
// boundary between a pathname update and its authority effect, no dependency
// changes after restore and the full-screen checking state would be permanent.
export function ageGateHistoryRecoveryAction(input: {
  persisted: boolean;
  acceptedLocally: boolean;
}): AgeGateHistoryRecoveryAction {
  if (!input.persisted) return null;
  // A browser cookie/localStorage value is only a recovery hint. Main's
  // persisted acceptance is the cross-service authority, so BFCache must run
  // the normal rematerialization request before protected UI becomes active.
  return input.acceptedLocally ? "restore" : "recheck";
}

function readLocalAcceptance() {
  try {
    return localStorage.getItem(AGE_GATE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function hasAgeGateCookie() {
  return document.cookie
    .split(";")
    .some((cookie) => cookie.trim() === `${AGE_GATE_COOKIE_NAME}=true`);
}

function isAgeGateBypassPath(pathname: string) {
  return (
    ageGateBypassExact.has(pathname) ||
    ageGateBypassPrefixes.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  );
}

async function restoreAgeGateAuthority() {
  const response = await fetch("/api/v1/age-gate/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourcePath: window.location.pathname,
      policyVersion: "2026-06-13",
    }),
  });
  if (!response.ok) throw new Error("Age gate restore failed");
  document.cookie = AGE_GATE_COOKIE;
}
