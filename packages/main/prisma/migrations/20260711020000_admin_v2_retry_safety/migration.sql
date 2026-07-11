-- Retry policy is explicit and fail-closed. Commands are only automatically replayed
-- after a lost lease when their executor contract guarantees idempotency.
ALTER TABLE "control_plane_commands"
ADD COLUMN "retryMode" TEXT NOT NULL DEFAULT 'non_replayable';

ALTER TABLE "control_plane_commands"
ADD CONSTRAINT "control_plane_command_retry_mode_check"
CHECK ("retryMode" IN ('idempotent', 'non_replayable'));
