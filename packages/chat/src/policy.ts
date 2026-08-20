// SPEC: policy resolver (design §3, SSoT). Maps an entitlement snapshot to the
// knobs the hot path + worker both need. ONE place — never re-derive inline.
// EXAMPLE: resolvePolicy({modelTier:"deluxe",...}) → { model, maxContextMessages,
//          rateLimitPerHour, voiceEnabled, memoryEnabled, ... }
import type { ChatEntitlementView } from "./db.js";
import { resolveChatModelProfile, type ChatModelProfile } from "@idream/shared";

export interface EntitlementSnapshot {
  modelTier: string;
  unlimitedMessages: boolean;
  voiceEnabled: boolean;
  imageToolEnabled: boolean;
}

export interface ChatPolicy {
  tier: string;
  modelProfile: ChatModelProfile;
  model: string;
  maxContextMessages: number;
  /** Hard character budget for recent transcript input (separate from output tokens). */
  maxContextChars: number;
  rateLimitPerHour: number;
  unlimitedMessages: boolean;
  voiceEnabled: boolean;
  memoryEnabled: boolean;
  allowRelationshipPatch: boolean;
  outputModerationRequired: boolean;
  /** Entitlement flag AND character flag (image_tool_enabled on both boundary views). */
  imageToolEnabled: boolean;
}

const BASE_CONTEXT = 12;
const BASE_CONTEXT_CHARS = 24_000;

export function resolvePolicy(
  ent: EntitlementSnapshot,
  opts: { memoryEnabled: boolean; characterImageToolEnabled?: boolean } = { memoryEnabled: true },
): ChatPolicy {
  const tier = ent.modelTier;
  const isPaid = tier === "premium" || tier === "deluxe";
  const modelProfile = resolveChatModelProfile(process.env);

  const memoryAllowed = opts.memoryEnabled;
  return {
    tier,
    modelProfile,
    model: modelProfile.model,
    maxContextMessages: isPaid ? BASE_CONTEXT * 2 : BASE_CONTEXT,
    maxContextChars: isPaid ? BASE_CONTEXT_CHARS * 2 : BASE_CONTEXT_CHARS,
    rateLimitPerHour: tier === "deluxe" ? 600 : tier === "premium" ? 300 : 60,
    unlimitedMessages: ent.unlimitedMessages,
    voiceEnabled: ent.voiceEnabled,
    memoryEnabled: memoryAllowed,
    allowRelationshipPatch: memoryAllowed,
    outputModerationRequired: true,
    imageToolEnabled: ent.imageToolEnabled && (opts.characterImageToolEnabled ?? true),
  };
}

/** DSH has exactly one configured provider/model for every entitlement plan. */
export function currentModel(): string {
  return resolveChatModelProfile(process.env).model;
}

/** Normalize a Prisma entitlement view row (nullable for unknown users) → snapshot. */
export function snapshotFromView(row: ChatEntitlementView | null): EntitlementSnapshot {
  return {
    modelTier: row?.modelTier ?? "free",
    unlimitedMessages: row?.unlimitedMessages ?? false,
    voiceEnabled: row?.voiceEnabled ?? false,
    imageToolEnabled: row?.imageToolEnabled ?? true,
  };
}
