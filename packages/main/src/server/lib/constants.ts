export const DB_PROVIDERS = ["sqlite", "postgresql"] as const;

export const ROLES = ["user", "moderator", "admin"] as const;
export const USER_STATUSES = ["active", "suspended", "deleted"] as const;

export const VISIBILITY = ["private", "unlisted", "public"] as const;
export const CHARACTER_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "removed",
  "archived",
] as const;
export const CHARACTER_STYLES = ["realistic", "anime", "hybrid", "other"] as const;
export const GENDERS = ["female", "male", "trans"] as const;

export const JOB_STATUSES = ["queued", "running", "completed", "failed", "dead"] as const;
export const JOB_QUEUES = [
  "ai.chat.generate",
  "ai.memory.forget",
  "ai.image.generate",
  "ai.video.generate",
  "app.ai.finalize",
  "moderation.input",
  "moderation.output",
  "character.preview",
  "billing.webhook",
  "age.verification.webhook",
  "reward.ledger",
  "report.triage",
  "analytics.events",
] as const;

export const PROVIDER_KIND = ["mock", "pipeline", "btcpay", "r2", "vercel_blob"] as const;

export const PLAN_SLUGS = ["premium", "deluxe"] as const;
export const BILLING_PERIODS = ["monthly", "yearly"] as const;

export const SAFETY_STATUSES = ["unknown", "passed", "flagged", "blocked"] as const;

export const POLICY_CODES = [
  "age_under_18",
  "potential_underage_content",
  "potential_deepfake_content",
  "prohibited_content",
  "unsafe_request",
  "manual_review",
] as const;

export const DEFAULT_SQLITE_DATABASE_URL = "file:./dev.db";
