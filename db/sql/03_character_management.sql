-- Character Management (CHARACTER_MANAGEMENT_PLAN.md) — additive migration.
-- Safe: only ADD COLUMN / CREATE TABLE / CREATE INDEX / ADD FK. No drops, no rewrites.
-- Column names are camelCase to match this project's Prisma->Postgres mapping.
-- Run on production by a human; applied to local dev by tooling.

-- A: official-vs-user source field on characters
ALTER TABLE "characters" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'user';
-- backfill: seed/system characters are official
UPDATE "characters" SET "source" = 'official' WHERE "creatorId" = 'seed-system-creator' AND "source" <> 'official';
CREATE INDEX IF NOT EXISTS "characters_source_visibility_status_idx" ON "characters"("source", "visibility", "status");

-- B: character creation templates
CREATE TABLE IF NOT EXISTS "character_templates" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'built_in',
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "gender" TEXT,
    "style" TEXT,
    "appearance" JSONB NOT NULL,
    "advancedDetails" JSONB NOT NULL,
    "tags" JSONB NOT NULL,
    "coverAssetId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- no DB default: Prisma's @updatedAt sets this in application code (matches `prisma migrate diff`)
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "character_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "character_templates_isActive_sortOrder_idx" ON "character_templates"("isActive", "sortOrder");

DO $$ BEGIN
  ALTER TABLE "character_templates" ADD CONSTRAINT "character_templates_coverAssetId_fkey"
    FOREIGN KEY ("coverAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
