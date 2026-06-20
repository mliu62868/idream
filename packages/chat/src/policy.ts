// SPEC: policy resolver (design §3, SSoT). Maps an entitlement snapshot to the
// knobs the hot path + worker both need. ONE place — never re-derive inline.
// EXAMPLE: resolvePolicy({modelTier:"deluxe",...}) → { model, maxContextMessages,
//          maxMemories, rateLimitPerHour, voiceEnabled, allowMemoryWrite, ... }
import type { ChatEntitlementView } from "./db.js";

export interface EntitlementSnapshot {
  modelTier: string;
  memoryMultiplier: number;
  unlimitedMessages: boolean;
  voiceEnabled: boolean;
}

export interface ChatPolicy {
  model: string;
  maxContextMessages: number;
  maxMemories: number;
  rateLimitPerHour: number;
  unlimitedMessages: boolean;
  voiceEnabled: boolean;
  allowMemoryWrite: boolean;
  allowGlobalMemoryWrite: boolean;
  allowRelationshipPatch: boolean;
  outputModerationRequired: boolean;
}

const BASE_CONTEXT = 12;
const BASE_MEMORIES = 6;

export function resolvePolicy(
  ent: EntitlementSnapshot,
  opts: { memoryEnabled: boolean } = { memoryEnabled: true },
): ChatPolicy {
  const tier = ent.modelTier;
  const isPaid = tier === "premium" || tier === "deluxe";
  const model =
    tier === "deluxe"
      ? "pi-agent-local-plus"
      : tier === "premium"
        ? "pi-agent-local-plus"
        : "pi-agent-local-free";

  const memoryAllowed = opts.memoryEnabled;
  return {
    model,
    maxContextMessages: isPaid ? BASE_CONTEXT * 2 : BASE_CONTEXT,
    maxMemories: memoryAllowed ? Math.round(BASE_MEMORIES * Math.max(1, ent.memoryMultiplier)) : 0,
    rateLimitPerHour: tier === "deluxe" ? 600 : tier === "premium" ? 300 : 60,
    unlimitedMessages: ent.unlimitedMessages,
    voiceEnabled: ent.voiceEnabled,
    allowMemoryWrite: memoryAllowed,
    allowGlobalMemoryWrite: memoryAllowed && isPaid,
    allowRelationshipPatch: memoryAllowed,
    outputModerationRequired: true,
  };
}

/** Normalize a Prisma entitlement view row (nullable for unknown users) → snapshot. */
export function snapshotFromView(row: ChatEntitlementView | null): EntitlementSnapshot {
  return {
    modelTier: row?.modelTier ?? "free",
    memoryMultiplier: row?.memoryMultiplier ?? 1,
    unlimitedMessages: row?.unlimitedMessages ?? false,
    voiceEnabled: row?.voiceEnabled ?? false,
  };
}
