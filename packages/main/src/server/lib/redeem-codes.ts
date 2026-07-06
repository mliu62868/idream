import { createHash } from "node:crypto";

export function redeemCodeHash(code: string) {
  let hash = 5381;
  for (const char of code.trim().toUpperCase()) hash = (hash * 33) ^ char.charCodeAt(0);
  return `redeem_${Math.abs(hash)}`;
}

export function legacyRedeemCodeHash(code: string) {
  return createHash("sha256").update(code.trim()).digest("hex");
}

export function redeemCodeHashCandidates(code: string) {
  const trimmed = code.trim();
  return Array.from(
    new Set([
      redeemCodeHash(trimmed),
      legacyRedeemCodeHash(trimmed),
      legacyRedeemCodeHash(trimmed.toUpperCase()),
    ]),
  );
}
