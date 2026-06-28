export const DB_PROVIDER = "postgresql" as const;
export const DEFAULT_POSTGRES_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5433/idream";

export const ROLES = ["user", "moderator", "support", "ops", "analyst", "admin"] as const;
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
// Wired BullMQ queues with a live producer AND consumer. Names that had only a
// dead producer (moderation.input / report.triage / age.verification.webhook —
// their work is done synchronously inline) were removed to avoid orphan queues.
export const JOB_QUEUES = [
  "ai.image.generate",
  "ai.video.generate",
  "app.ai.finalize",
  "character.preview",
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
