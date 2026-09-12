-- Proactive companion messages: opt-in, bounded cadence, and durable provenance.
-- Apply through the normal migration runner; do not run against production directly.
ALTER TABLE "recent_chats"
  ADD COLUMN IF NOT EXISTS "proactive_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "proactive_interval_hours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS "proactive_next_at" TIMESTAMP(3);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recent_chats_proactive_interval_hours_check') THEN
    ALTER TABLE "recent_chats" ADD CONSTRAINT "recent_chats_proactive_interval_hours_check"
      CHECK ("proactive_interval_hours" BETWEEN 6 AND 168);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "recent_chats_proactive_due_idx"
  ON "recent_chats" ("proactive_enabled", "proactive_next_at")
  WHERE "proactive_enabled" = true AND "status" = 'active';
ALTER TABLE "chat_turns"
  ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'user';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_turns_origin_check') THEN
    ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_origin_check"
      CHECK ("origin" IN ('user', 'proactive'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "chat_turns_origin_idx" ON "chat_turns" ("origin", "createdAt");
