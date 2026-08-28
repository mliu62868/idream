-- PRECONDITION: stop Chat writers and apply
-- db/sql/2026-08-26-chat-soul-v3-no-relationship.sql first. PostgreSQL will not
-- drop a column while the least-privilege Chat view still depends on it.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'core'
      AND table_name = 'chat_character_view'
      AND column_name = 'relationship'
  ) THEN
    RAISE EXCEPTION 'apply db/sql/2026-08-26-chat-soul-v3-no-relationship.sql before this migration';
  END IF;
END $$;

ALTER TABLE "characters" DROP COLUMN "relationship";
