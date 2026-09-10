import { createHmac, timingSafeEqual } from "node:crypto";
import { voiceClipBillingAuthoritySchema, type VoiceClipBillingAuthority } from "@idream/shared/contracts";
import { Errors } from "@/server/lib/errors";

const SIGNING_SCOPE = "voice-clip-quote-v1:";

export function signVoiceClipQuote(terms: VoiceClipBillingAuthority, secret: string): string {
  const payload = Buffer.from(JSON.stringify(voiceClipBillingAuthoritySchema.parse(terms))).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${SIGNING_SCOPE}${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}

export function acceptVoiceClipQuote(input: {
  token: string;
  secret: string;
  userId: string;
  requestFingerprint: string;
  now?: Date;
}): VoiceClipBillingAuthority {
  const [payload, signature, extra] = input.token.split(".");
  if (!payload || !signature || extra !== undefined || input.token.length > 8192) {
    throw Errors.conflict("A valid Voice quote is required before playback", { reason: "voice_quote_required" });
  }
  const expected = createHmac("sha256", input.secret).update(`${SIGNING_SCOPE}${payload}`).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw Errors.conflict("Voice quote signature is invalid; request another quote", { reason: "voice_quote_stale" });
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw Errors.conflict("Voice quote is invalid; request another quote", { reason: "voice_quote_stale" }); }
  const parsed = voiceClipBillingAuthoritySchema.safeParse(value);
  if (!parsed.success) throw Errors.conflict("Voice quote is invalid; request another quote", { reason: "voice_quote_stale" });
  const terms = parsed.data;
  const now = (input.now ?? new Date()).getTime();
  if (terms.userId !== input.userId || terms.requestFingerprint !== input.requestFingerprint) {
    throw Errors.conflict("Voice quote belongs to a different user or reply", { reason: "voice_quote_stale" });
  }
  if (Date.parse(terms.quotedAt) > now || Date.parse(terms.expiresAt) <= now) {
    throw Errors.conflict("Voice quote expired; request another quote", { reason: "voice_quote_stale" });
  }
  return terms;
}
