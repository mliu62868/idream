import { describe, expect, it } from "vitest";
import type { VoiceClipBillingAuthority } from "@idream/shared/contracts";
import { acceptVoiceClipQuote, signVoiceClipQuote } from "./voice-clip-quote";

const secret = "voice-quote-test-secret-not-a-live-credential";
const now = new Date("2026-09-09T12:00:00.000Z");
const terms: VoiceClipBillingAuthority = {
  version: 1, userId: "owner", requestFingerprint: "selected-reply", intent: "play", pricingFingerprint: "price-version-3",
  overflowCostDreamcoins: 2, maxCostDreamcoins: 2, allowanceMinutes: 30,
  allowanceWindowStartsAt: "2026-08-10T12:00:00.000Z", quotedAt: now.toISOString(), expiresAt: "2026-09-09T12:05:00.000Z",
};
const accept = (token: string, changes: Partial<Parameters<typeof acceptVoiceClipQuote>[0]> = {}) =>
  acceptVoiceClipQuote({ token, secret, userId: "owner", requestFingerprint: "selected-reply", now, ...changes });

describe("Voice quote acceptance", () => {
  it("accepts exactly the signed commercial terms", () => {
    expect(accept(signVoiceClipQuote(terms, secret))).toEqual(terms);
  });
  it("rejects a changed maximum instead of trusting a client-supplied cost", () => {
    const token = signVoiceClipQuote(terms, secret);
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...terms, maxCostDreamcoins: 0 })).toString("base64url");
    expect(() => accept(`${forged}.${signature}`)).toThrow("signature");
  });
  it("cannot transfer a quote between users or selected replies", () => {
    const token = signVoiceClipQuote(terms, secret);
    expect(() => accept(token, { userId: "other" })).toThrow("different");
    expect(() => accept(token, { requestFingerprint: "regenerated-reply" })).toThrow("different");
  });
  it("requires a new quote once the initial acceptance window ends", () => {
    expect(() => accept(signVoiceClipQuote(terms, secret), { now: new Date(terms.expiresAt) })).toThrow("expired");
  });
});
