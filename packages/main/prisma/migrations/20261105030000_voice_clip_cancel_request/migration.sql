-- A cancelled Call turn flags its running clip request so the owner stops on its next
-- heartbeat, in any process, and the user's next turn no longer waits on it.
ALTER TABLE "voice_clip_requests" ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);
