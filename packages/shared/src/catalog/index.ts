// SPEC: cross-service enum catalog. Every value set that BOTH a service boundary
// (zod schema / Prisma string column) and a client surface must agree on lives
// here, exactly once.
// INTENT: hand-copied literal unions drift — the web filters silently dropped the
// `other` character style for months because four copies each had to be updated.
// Import from here instead of retyping the members.
// INVARIANT: this module stays dependency-free (no zod, no node builtins, no
// runtime side effects) so client bundles and worker processes can both take it.
// NOTE: tuple order is display order where a UI renders the set in sequence; the
// server treats every tuple as an unordered set.

export const CHARACTER_STYLES = ["realistic", "anime", "hybrid", "other"] as const;
export type CharacterStyle = (typeof CHARACTER_STYLES)[number];

export const GENDERS = ["female", "male", "trans"] as const;
export type Gender = (typeof GENDERS)[number];

// Character.visibility (prisma schema.prisma Character.visibility).
export const CHARACTER_VISIBILITY = ["private", "unlisted", "public"] as const;
export type CharacterVisibility = (typeof CHARACTER_VISIBILITY)[number];

// MediaAsset.visibility — deliberately NOT the same set as CHARACTER_VISIBILITY.
// A media asset becomes publicly readable by joining a pack, so its public state
// is `public_pack`, not `public`.
export const MEDIA_ASSET_VISIBILITY = ["private", "public_pack", "unlisted"] as const;
export type MediaAssetVisibility = (typeof MEDIA_ASSET_VISIBILITY)[number];

// GenerationJob.status — includes the moderation waypoints the admin JOB_STATUSES
// list (queued/running/completed/failed/dead) does not model.
// INVARIANT: this set MUST equal `generationJobStatusSchema` in
// shared/admin/contracts/jobs.ts — the server writes through that zod enum (and
// through GENERATION_REQUEST_STATES, which is derived from it), so a status the
// server can write but this list omits is a status no client can reason about.
// catalog.test.ts asserts the two sets are equal; see the `cancelled` note below
// for what the last omission cost.
export const GENERATION_JOB_STATUSES = [
  "queued",
  "moderating_input",
  "running",
  "moderating_output",
  "completed",
  "failed",
  "blocked",
  "refunded",
  // Written by the admin cancel command (server/ai/generation-request-lifecycle.ts).
  // It was missing here for as long as that command has existed, so
  // isTerminalGenerationJobStatus("cancelled") answered `false`: the generator
  // kept a cancelled job in its pending set and polled it forever, showed no
  // status message, and never refreshed the balance the cancel had already
  // refunded.
  "cancelled",
] as const;
export type GenerationJobStatus = (typeof GENERATION_JOB_STATUSES)[number];

// A job in one of these states will never change again — polling can stop.
// NOTE: `failed` is deliberately terminal HERE while the server's transition
// authority allows failed → queued on an operator retry. The two answer
// different questions — "may this row still change?" vs "should the viewer's
// spinner stop?" — and a retry reaches the client through a fresh job list, not
// through the poll loop. Do not collapse them.
export const TERMINAL_GENERATION_JOB_STATUSES = [
  "completed",
  "failed",
  "blocked",
  "refunded",
  "cancelled",
] as const;
export type TerminalGenerationJobStatus =
  (typeof TERMINAL_GENERATION_JOB_STATUSES)[number];

export function isTerminalGenerationJobStatus(
  status: string,
): status is TerminalGenerationJobStatus {
  return (TERMINAL_GENERATION_JOB_STATUSES as readonly string[]).includes(status);
}

export const SUPPORT_REQUEST_CATEGORIES = [
  "account",
  "billing",
  "generation",
  "chat",
  "bug",
  "feature",
  "other",
] as const;
export type SupportRequestCategory = (typeof SUPPORT_REQUEST_CATEGORIES)[number];

export const APPEAL_TARGET_TYPES = [
  "character",
  "media",
  "feed_item",
  "chat_message",
  "user_profile",
  "moderation_decision",
  "safety_issue",
  "copyright_likeness",
] as const;
export type AppealTargetType = (typeof APPEAL_TARGET_TYPES)[number];

export const PRODUCT_FEEDBACK_CATEGORIES = ["feature", "improvement", "bug"] as const;
export type ProductFeedbackCategory = (typeof PRODUCT_FEEDBACK_CATEGORIES)[number];

// ProductFeedbackItem.status. `under_review` is the default and MUST stay in the
// set — the roadmap list used to render it only through a fallback branch.
export const PRODUCT_FEEDBACK_STATUSES = ["under_review", "planned", "shipped"] as const;
export type ProductFeedbackStatus = (typeof PRODUCT_FEEDBACK_STATUSES)[number];

export function isCatalogMember<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
