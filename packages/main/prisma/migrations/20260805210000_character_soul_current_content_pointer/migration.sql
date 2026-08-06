-- Character Soul: user-owned Characters point at an immutable content version.
-- The composite FK proves the pointed version belongs to the same Character;
-- a plain FK to content-version id would permit cross-character Soul binding.

ALTER TABLE "characters"
  ADD COLUMN "currentContentVersionId" TEXT;

CREATE INDEX "characters_currentContentVersionId_idx"
  ON "characters"("currentContentVersionId");

CREATE UNIQUE INDEX "character_content_versions_id_characterId_key"
  ON "character_content_versions"("id", "characterId");

ALTER TABLE "characters"
  ADD CONSTRAINT "characters_currentContentVersion_character_fkey"
  FOREIGN KEY ("currentContentVersionId", "id")
  REFERENCES "character_content_versions"("id", "characterId")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
