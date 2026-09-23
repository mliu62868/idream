"use client";

import { useEffect } from "react";

/**
 * SPEC: a landing with ?aff=<code> records one affiliate click. The response
 * sets the attribution cookie that a later signup in this browser converts.
 * The server identifies the visitor itself; this page sends only the code.
 * INTENT: best effort — an unknown or unapproved code must never disturb the page.
 */
export function AffiliateClickTracker() {
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("aff")?.trim();
    if (!code) return;
    void fetch("/api/v1/affiliate/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, landingPath: window.location.pathname }),
    }).catch(() => undefined);
  }, []);
  return null;
}
