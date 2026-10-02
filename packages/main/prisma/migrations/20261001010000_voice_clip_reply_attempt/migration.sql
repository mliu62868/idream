BEGIN;

-- attemptNo is a provider execution retry; replyAttempt is the immutable Main
-- reply version. Zero preserves historical deliveries whose version is unknown.
ALTER TABLE "voice_clip_requests" ADD COLUMN IF NOT EXISTS "replyAttempt" INTEGER NOT NULL DEFAULT 0;

-- Only a request created after the current terminal reply, with its exact
-- pinned text and scene, can be assigned that reply's version. An earlier clip
-- must not become a free replay of a later revision with identical words.
UPDATE "voice_clip_requests" AS request
   SET "replyAttempt" = turn.attempt
  FROM "chat_turns" AS turn
  JOIN "recent_chats" AS session ON session."sessionId" = turn."sessionId"
 WHERE request."replyAttempt" = 0
   AND request."userId" = session."userId"
   AND request."characterId" = session."characterId"
   AND request."messageId" = turn."assistantMessageId"
   AND request."synthesisPayload"->>'sessionId' = turn."sessionId"
   AND request."synthesisPayload"->>'text' = turn."assistantContent"
   AND COALESCE(request."synthesisPayload"->'sceneVersion', '0'::jsonb) = to_jsonb(turn."sceneVersion")
   AND COALESCE(request."synthesisPayload"->'scene', 'null'::jsonb) = COALESCE(turn.scene, 'null'::jsonb)
   AND turn."assistantStatus" = 'sent'
   AND turn."terminalAt" IS NOT NULL
   AND request."createdAt" >= turn."terminalAt";

UPDATE "voice_clip_requests" AS request
   SET "replyAttempt" = 1
  FROM "recent_chats" AS session
 WHERE request."replyAttempt" = 0
   AND request."userId" = session."userId"
   AND request."characterId" = session."characterId"
   AND request."messageId" = 'opening:' || session."sessionId"
   AND request."synthesisPayload"->>'sessionId' = session."sessionId"
   AND request."synthesisPayload"->>'text' = session."openingMessage";

DROP INDEX IF EXISTS "voice_clip_requests_userId_messageId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "voice_clip_requests_userId_messageId_replyAttempt_key"
  ON "voice_clip_requests"("userId", "messageId", "replyAttempt");
ALTER TABLE "voice_clip_requests" DROP CONSTRAINT IF EXISTS "voice_clip_requests_reply_attempt_nonnegative";
ALTER TABLE "voice_clip_requests" ADD CONSTRAINT "voice_clip_requests_reply_attempt_nonnegative" CHECK ("replyAttempt" >= 0);

CREATE OR REPLACE FUNCTION reject_voice_clip_reply_attempt_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."replyAttempt" IS DISTINCT FROM OLD."replyAttempt" THEN
    RAISE EXCEPTION 'voice_clip_requests reply version is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS voice_clip_requests_reply_attempt_immutable_update ON "voice_clip_requests";
CREATE TRIGGER voice_clip_requests_reply_attempt_immutable_update
  BEFORE UPDATE ON "voice_clip_requests"
  FOR EACH ROW EXECUTE FUNCTION reject_voice_clip_reply_attempt_update();

COMMIT;
