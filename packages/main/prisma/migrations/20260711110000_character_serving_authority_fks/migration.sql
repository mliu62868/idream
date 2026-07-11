-- Expand-only authority guards. NOT VALID preserves rollout on databases that
-- may still contain historical pointer drift while enforcing all new writes.
-- DEFERRABLE keeps repair transactions able to move an authority graph atomically.
ALTER TABLE "character_serving"
  ADD CONSTRAINT "character_serving_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id")
  ON DELETE CASCADE ON UPDATE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE
  NOT VALID;

ALTER TABLE "character_serving"
  ADD CONSTRAINT "character_serving_currentReleaseId_fkey"
  FOREIGN KEY ("currentReleaseId") REFERENCES "character_releases"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE
  NOT VALID;

ALTER TABLE "character_serving"
  ADD CONSTRAINT "character_serving_scheduledReleaseId_fkey"
  FOREIGN KEY ("scheduledReleaseId") REFERENCES "character_releases"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE
  NOT VALID;

-- Deliberately do not VALIDATE in this expand migration. After the cutover
-- invariant ledger reports zero pointer violations, ship a separate migration:
--   ALTER TABLE "character_serving" VALIDATE CONSTRAINT "character_serving_characterId_fkey";
--   ALTER TABLE "character_serving" VALIDATE CONSTRAINT "character_serving_currentReleaseId_fkey";
--   ALTER TABLE "character_serving" VALIDATE CONSTRAINT "character_serving_scheduledReleaseId_fkey";
