-- A registered voice artifact writer now records the instant by which it has stopped
-- writing, so account erasure can finish after that writer crashes.
ALTER TABLE "voice_clip_requests" ADD COLUMN "artifactWriteDeadlineAt" TIMESTAMP(3);

-- Writers registered before this column had no bound of their own. Deploying restarts
-- Main, which ends them, so one hour from here comfortably covers that restart.
UPDATE "voice_clip_requests"
SET "artifactWriteDeadlineAt" = now() + interval '1 hour'
WHERE cardinality("activeArtifactOwners") > 0;
