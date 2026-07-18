import { createHash } from "node:crypto";

export const MIN_REDEEM_CODE_DREAMCOINS = 1;
export const MAX_REDEEM_CODE_DREAMCOINS = 1_000_000;

export function redeemCodeDreamcoins(reward: unknown) {
  if (typeof reward !== "object" || reward === null || Array.isArray(reward)) {
    return null;
  }
  const dreamcoins = (reward as Record<string, unknown>).dreamcoins;
  if (
    typeof dreamcoins !== "number" ||
    !Number.isFinite(dreamcoins) ||
    !Number.isInteger(dreamcoins) ||
    dreamcoins < MIN_REDEEM_CODE_DREAMCOINS ||
    dreamcoins > MAX_REDEEM_CODE_DREAMCOINS
  ) {
    return null;
  }
  return dreamcoins;
}

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
