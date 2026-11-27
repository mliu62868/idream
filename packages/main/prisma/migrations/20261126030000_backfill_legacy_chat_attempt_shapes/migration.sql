-- The runtime no longer reads two legacy shapes. Move any surviving rows to the
-- current shape so the removed read paths are safe in every environment, not
-- only in the database that was counted when they were removed.

-- 1. Attachments that recorded their attempt only under metadata.effect.attempt.
UPDATE "chat_turn_attachments"
SET "metadata" = jsonb_set("metadata"::jsonb, '{attempt}', ("metadata"::jsonb -> 'effect' -> 'attempt'))
WHERE ("metadata"::jsonb ? 'attempt') IS NOT TRUE
  AND jsonb_typeof("metadata"::jsonb -> 'effect' -> 'attempt') = 'number'
  AND ("metadata"::jsonb -> 'effect' ->> 'attempt')::numeric >= 1;

-- 2. Generating attempts admitted before Chat pinned a deadline. The retired
--    reclaim fired 6 minutes after the last write; reclaim now fires at
--    deadline + 60 s commit grace, so a deadline of updatedAt + 5 minutes keeps
--    the same moment.
UPDATE "chat_turns"
SET "executionDeadlineAt" = "updatedAt" + INTERVAL '5 minutes'
WHERE "assistantStatus" = 'generating'
  AND "executionDeadlineAt" IS NULL;
