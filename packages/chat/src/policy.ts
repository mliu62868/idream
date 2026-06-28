// SPEC: policy resolver (design §3, SSoT). Maps an entitlement snapshot to the
// knobs the hot path + worker both need. ONE place — never re-derive inline.
// EXAMPLE: resolvePolicy({modelTier:"deluxe",...}) → { model, maxContextMessages,
//          maxMemories, rateLimitPerHour, voiceEnabled, allowMemoryWrite, ... }
import type { ChatEntitlementView } from "./db.js";
import { env } from "./env.js";

export interface EntitlementSnapshot {
  modelTier: string;
  memoryMultiplier: number;
  unlimitedMessages: boolean;
  voiceEnabled: boolean;
}

export interface ChatPolicy {
  model: string;
  maxContextMessages: number;
  /** Top-K long-term memories injected per turn (retrieval cap). */
  maxMemories: number;
  /** Total long-term memories retained on disk per character (storage cap, P1-C). */
  maxStoredMemories: number;
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
// Storage baseline (P1-C): how many long-term memories a Free tier retains on
// disk per character. Deluxe (memoryMultiplier=3) keeps 3× — "3x chat memory".
const BASE_STORED_MEMORIES = 30;

export function resolvePolicy(
  ent: EntitlementSnapshot,
  opts: { memoryEnabled: boolean } = { memoryEnabled: true },
): ChatPolicy {
  const tier = ent.modelTier;
  const isPaid = tier === "premium" || tier === "deluxe";
  const model = modelForTier(tier);

  const memoryAllowed = opts.memoryEnabled;
  return {
    model,
    maxContextMessages: isPaid ? BASE_CONTEXT * 2 : BASE_CONTEXT,
    maxMemories: memoryAllowed ? Math.round(BASE_MEMORIES * Math.max(1, ent.memoryMultiplier)) : 0,
    maxStoredMemories: memoryAllowed
      ? Math.round(BASE_STORED_MEMORIES * Math.max(1, ent.memoryMultiplier))
      : 0,
    rateLimitPerHour: tier === "deluxe" ? 600 : tier === "premium" ? 300 : 60,
    unlimitedMessages: ent.unlimitedMessages,
    voiceEnabled: ent.voiceEnabled,
    allowMemoryWrite: memoryAllowed,
    allowGlobalMemoryWrite: memoryAllowed && isPaid,
    allowRelationshipPatch: memoryAllowed,
    outputModerationRequired: true,
  };
}

/**
 * Map an entitlement tier to the REAL provider model (design P0-D). Centralized
 * here so the provider never needs to know product tiers. Deluxe/Premium get the
 * configured premium model; Free gets the base model. Single-model deploys leave
 * the CHAT_MODEL_* aliases unset, so every tier resolves to CHAT_MODEL_NAME.
 */
export function modelForTier(tier: string): string {
  if (tier === "deluxe") return env.CHAT_MODEL_DELUXE;
  if (tier === "premium") return env.CHAT_MODEL_PREMIUM;
  return env.CHAT_MODEL_FREE;
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
