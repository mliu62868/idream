ALTER TABLE "users"
  ADD COLUMN "dataClass" TEXT NOT NULL DEFAULT 'customer';

-- Existing databases predate explicit provenance. Reserved test domains are
-- classified first so a privileged role or seed-like id cannot hide fixture
-- traffic inside the internal bucket.
UPDATE "users"
SET "dataClass" = CASE
  WHEN lower(split_part("email", '@', 2)) = 'test.local'
    OR lower(split_part("email", '@', 2)) = 'example.com'
    OR lower(split_part("email", '@', 2)) LIKE '%.test'
    THEN 'fixture'
  WHEN lower(split_part("email", '@', 2)) IN ('idream.local', 'idream.internal')
    OR lower(split_part("email", '@', 2)) LIKE '%.idream.local'
    OR lower(split_part("email", '@', 2)) LIKE '%.idream.internal'
    OR "id" LIKE 'seed-%'
    OR "role" <> 'user'
    THEN 'internal'
  ELSE 'customer'
END;

ALTER TABLE "users"
  ADD CONSTRAINT "users_dataClass_check"
  CHECK ("dataClass" IN ('customer', 'internal', 'fixture', 'audit'));

CREATE INDEX "users_dataClass_status_deletedAt_idx"
  ON "users"("dataClass", "status", "deletedAt");

ALTER TABLE "media_collections"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'user';

ALTER TABLE "media_collections"
  ADD CONSTRAINT "media_collections_source_check"
  CHECK ("source" IN ('official', 'user'));

CREATE INDEX "media_collections_source_visibility_idx"
  ON "media_collections"("source", "visibility");

UPDATE "media_collections"
SET "source" = 'official'
WHERE "id" IN (
  'seed-collection-slow-burn-favorites',
  'seed-collection-high-drama',
  'seed-collection-fantasy-escapes'
);

UPDATE "characters"
SET "source" = 'official'
WHERE "id" IN (
  'melissa-burke',
  'summoned-world',
  'sarah-mercer',
  'alexa-reeves',
  'tamsin-jacobs',
  'truth-confessional',
  'truth-stepmother',
  'stephanie',
  'kennedy-graham',
  'eleanor-dawn',
  'bailey-price',
  'sophie',
  'raya-reyes',
  'emily-coming-home',
  'diana-weird-girl',
  'lola-moonstruck'
);

-- The original catalog cards carried copied presentation counters. Preserve
-- the curated content and imagery while resetting invented engagement.
UPDATE "character_stats"
SET "likesCount" = 0,
    "chatsCount" = 0
WHERE "characterId" IN (
  'melissa-burke',
  'summoned-world',
  'sarah-mercer',
  'alexa-reeves',
  'tamsin-jacobs',
  'truth-confessional',
  'truth-stepmother',
  'stephanie',
  'kennedy-graham',
  'eleanor-dawn',
  'bailey-price',
  'sophie',
  'raya-reyes',
  'emily-coming-home',
  'diana-weird-girl',
  'lola-moonstruck'
);

INSERT INTO "product_feedback_items" (
  "id",
  "sourceKey",
  "title",
  "description",
  "category",
  "status",
  "voteCount",
  "createdAt",
  "updatedAt"
)
VALUES
  (
    'seed-feedback-generator-recipes',
    'generator-recipes',
    'Saved generator recipes',
    'Save a prompt, character, style, orientation, and preset stack so it can be reused later.',
    'feature',
    'planned',
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'seed-feedback-creator-collections',
    'creator-collections',
    'Creator collection boards',
    'Let creators group characters and generated media into public boards followers can browse.',
    'feature',
    'under_review',
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'seed-feedback-chat-memory-review',
    'chat-memory-review',
    'Memory review before long chats',
    'Give users a quick way to inspect and adjust remembered facts before continuing a session.',
    'improvement',
    'under_review',
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("sourceKey") DO UPDATE
SET "title" = EXCLUDED."title",
    "description" = EXCLUDED."description",
    "category" = EXCLUDED."category",
    "status" = EXCLUDED."status";
