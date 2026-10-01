BEGIN;

-- A draft may restore earlier bytes without mutating its immutable history.
-- Version identity remains unique; hash lookups retain an equivalent index.
DROP INDEX "character_content_versions_characterId_contentHash_key";
CREATE INDEX "character_content_versions_characterId_contentHash_idx"
  ON "character_content_versions" ("characterId", "contentHash");

COMMIT;
