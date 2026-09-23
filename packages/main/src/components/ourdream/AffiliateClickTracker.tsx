"use client";

import { useEffect } from "react";

const VISITOR_KEY_STORAGE = "idream.affiliate.visitor";

function visitorKey() {
  try {
    const stored = window.localStorage.getItem(VISITOR_KEY_STORAGE);
    if (stored) return stored;
    const created = crypto.randomUUID();
    window.localStorage.setItem(VISITOR_KEY_STORAGE, created);
    return created;
  } catch {
    // Without storage every visit is new; the click is still deduplicated per page load.
    return crypto.randomUUID();
  }
}

/**
 * SPEC: a landing with ?aff=<code> records one affiliate click. The response
 * sets the attribution cookie that a later signup in this browser converts.
 * INTENT: best effort — an unknown or unapproved code must never disturb the page.
 */
export function AffiliateClickTracker() {
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("aff")?.trim();
    if (!code) return;
    void fetch("/api/v1/affiliate/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, visitorKey: visitorKey(), landingPath: window.location.pathname }),
    }).catch(() => undefined);
  }, []);
  return null;
}
