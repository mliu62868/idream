-- Additive chat-side entry attribution. Apply before deploying a chat build
-- that emits exposure-linked exchange events. Main revalidates these claims
-- against canonical CharacterExposureFact rows before using them.

SET ROLE chat_owner;

ALTER TABLE chat.chat_sessions
  ADD COLUMN IF NOT EXISTS entry_exposure_id text,
  ADD COLUMN IF NOT EXISTS entry_journey_id text,
  ADD COLUMN IF NOT EXISTS entry_placement_id text;

RESET ROLE;
