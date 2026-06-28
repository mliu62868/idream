"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

export function AgeGate({
  forceVisible = false,
  onAccepted,
}: Readonly<{ forceVisible?: boolean; onAccepted?: () => void }>) {
  const [visible, setVisible] = useState(forceVisible);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (forceVisible) return;
    if (window.location.pathname.startsWith("/admin")) {
      return;
    }
    const accepted =
      localStorage.getItem("AdultContentAcceptedOD") === "true" ||
      document.cookie.includes("AdultContentAcceptedOD=true");
    const timer = window.setTimeout(() => {
      setVisible(!accepted);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [forceVisible]);

  async function accept() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/v1/age-gate/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourcePath: window.location.pathname,
          policyVersion: "2026-06-13",
        }),
      });
      if (!response.ok) throw new Error("Age gate accept failed");
      localStorage.setItem("AdultContentAcceptedOD", "true");
      document.cookie = "AdultContentAcceptedOD=true; path=/; max-age=31536000; samesite=lax";
      window.dispatchEvent(new Event("idream-age-gate-accepted"));
      onAccepted?.();
      setVisible(false);
    } catch {
      // Don't strand the user behind a silent gate — surface a retryable error.
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black p-2">
      <div className="flex w-full max-w-sm flex-col items-center rounded-[28px] border border-white/10 bg-[rgb(36,36,36)] p-6 text-center shadow-[2px_2px_8px_3px_rgba(0,0,0,0.25)]">
        <Image
          src="/images/ourdream/age-gate-logo.png"
          alt="ourdream.ai"
          width={100}
          height={16}
          className="h-4 w-[100px] opacity-60"
        />
        <h2 className="mt-6 text-[24px] font-bold uppercase leading-[26px] text-white">
          Adults Only
        </h2>
        <p className="mt-1.5 text-[14px] leading-5 text-[rgb(170,170,170)]">
          By entering, you agree to our{" "}
          <Link className="text-white underline underline-offset-2" href="/terms">
            Terms
          </Link>
        </p>
        <button
          className="mt-6 min-h-10 w-full rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] px-4 py-3 text-[14px] font-bold leading-[14px] text-white disabled:opacity-70"
          disabled={pending}
          onClick={accept}
          type="button"
        >
          {pending ? "Entering..." : "I'm over 18"}
        </button>
        {error && (
          <p className="mt-3 text-[12px] font-semibold text-[rgb(255,140,140)]">{error}</p>
        )}
        <a
          className="mt-4 text-[12px] font-medium leading-4 text-[rgb(114,113,112)]"
          href="https://www.google.com/"
          rel="noreferrer"
        >
          Leave site
        </a>
      </div>
    </div>
  );
}
