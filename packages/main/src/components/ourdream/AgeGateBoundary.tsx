"use client";

import { useEffect, useState } from "react";
import { AgeGate } from "./AgeGate";

type AgeGateState = "checking" | "accepted" | "blocked";

const AGE_GATE_STORAGE_KEY = "AdultContentAcceptedOD";
const AGE_GATE_COOKIE_NAME = "AdultContentAcceptedOD";
const AGE_GATE_COOKIE =
  "AdultContentAcceptedOD=true; path=/; max-age=31536000; samesite=lax";

type MePayload = {
  ok?: boolean;
  data?: {
    ageGate?: { accepted?: boolean };
  };
};

export function AgeGateBoundary({
  children,
  initialAccepted,
}: Readonly<{
  children: React.ReactNode;
  initialAccepted: boolean;
}>) {
  const [state, setState] = useState<AgeGateState>(
    initialAccepted ? "accepted" : "checking",
  );

  useEffect(() => {
    if (window.location.pathname.startsWith("/admin")) {
      const timer = window.setTimeout(() => setState("accepted"), 0);
      return () => window.clearTimeout(timer);
    }

    const localAccepted = localStorage.getItem(AGE_GATE_STORAGE_KEY) === "true";
    const cookieAccepted = hasAgeGateCookie();

    if (cookieAccepted) {
      const timer = window.setTimeout(() => setState("accepted"), 0);
      return () => window.clearTimeout(timer);
    }

    if (localAccepted) {
      let alive = true;
      restoreAgeGateCookie()
        .then(() => {
          if (alive) setState("accepted");
        })
        .catch(() => {
          if (alive) setState("blocked");
        });
      return () => {
        alive = false;
      };
    }

    let alive = true;
    fetch("/api/v1/me", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: MePayload | null) => {
        if (!alive) return;
        setState(payload?.data?.ageGate?.accepted ? "accepted" : "blocked");
      })
      .catch(() => {
        if (alive) setState("blocked");
      });

    const accept = () => setState("accepted");
    window.addEventListener("idream-age-gate-accepted", accept);
    return () => {
      alive = false;
      window.removeEventListener("idream-age-gate-accepted", accept);
    };
  }, []);

  if (state === "accepted") return <>{children}</>;

  if (state === "checking") {
    return <div className="min-h-screen bg-black" aria-hidden="true" />;
  }

  return <AgeGate forceVisible onAccepted={() => setState("accepted")} />;
}

function hasAgeGateCookie() {
  return document.cookie
    .split(";")
    .some((cookie) => cookie.trim() === `${AGE_GATE_COOKIE_NAME}=true`);
}

async function restoreAgeGateCookie() {
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
