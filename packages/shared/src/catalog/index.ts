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
export const GENERATION_JOB_STATUSES = [
  "queued",
  "moderating_input",
  "running",
  "moderating_output",
  "completed",
  "failed",
  "blocked",
  "refunded",
] as const;
export type GenerationJobStatus = (typeof GENERATION_JOB_STATUSES)[number];

// A job in one of these states will never change again — polling can stop.
export const TERMINAL_GENERATION_JOB_STATUSES = [
  "completed",
  "failed",
  "blocked",
  "refunded",
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
