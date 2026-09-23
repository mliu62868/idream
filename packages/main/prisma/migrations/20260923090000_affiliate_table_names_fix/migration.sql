-- 20260912090000_affiliate_creator_economy created the affiliate tables under
-- their model names, while schema.prisma maps them to "affiliate_applications"
-- and "affiliate_clicks". Some databases were repaired by hand (tables renamed,
-- constraint/index names left as-is), others still carry the original names.
-- Every statement below is conditional, so both shapes converge on exactly what
-- the schema declares.
DO $$ BEGIN
  IF to_regclass('"AffiliateApplication"') IS NOT NULL AND to_regclass('"affiliate_applications"') IS NULL THEN
    ALTER TABLE "AffiliateApplication" RENAME TO "affiliate_applications";
  END IF;
  IF to_regclass('"AffiliateClick"') IS NOT NULL AND to_regclass('"affiliate_clicks"') IS NULL THEN
    ALTER TABLE "AffiliateClick" RENAME TO "affiliate_clicks";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AffiliateApplication_pkey') THEN
    ALTER TABLE "affiliate_applications" RENAME CONSTRAINT "AffiliateApplication_pkey" TO "affiliate_applications_pkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AffiliateClick_pkey') THEN
    ALTER TABLE "affiliate_clicks" RENAME CONSTRAINT "AffiliateClick_pkey" TO "affiliate_clicks_pkey";
  END IF;
END $$;

ALTER INDEX IF EXISTS "AffiliateApplication_userId_key" RENAME TO "affiliate_applications_userId_key";
ALTER INDEX IF EXISTS "AffiliateClick_code_createdAt_idx" RENAME TO "affiliate_clicks_code_createdAt_idx";
ALTER INDEX IF EXISTS "AffiliateClick_code_visitorKey_key" RENAME TO "affiliate_clicks_code_visitorKey_key";

-- The original foreign keys used NO ACTION on update; Prisma declares CASCADE.
ALTER TABLE "affiliate_clicks" DROP CONSTRAINT IF EXISTS "AffiliateClick_code_fkey";
ALTER TABLE "affiliate_clicks" DROP CONSTRAINT IF EXISTS "AffiliateClick_userId_fkey";
ALTER TABLE "affiliate_clicks" DROP CONSTRAINT IF EXISTS "affiliate_clicks_code_fkey";
ALTER TABLE "affiliate_clicks" DROP CONSTRAINT IF EXISTS "affiliate_clicks_affiliateUserId_fkey";
ALTER TABLE "affiliate_applications" DROP CONSTRAINT IF EXISTS "AffiliateApplication_userId_fkey";
ALTER TABLE "affiliate_applications" DROP CONSTRAINT IF EXISTS "affiliate_applications_userId_fkey";
ALTER TABLE "affiliate_applications" ADD CONSTRAINT "affiliate_applications_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "affiliate_clicks" ADD CONSTRAINT "affiliate_clicks_affiliateUserId_fkey"
  FOREIGN KEY ("affiliateUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "affiliate_clicks" ADD CONSTRAINT "affiliate_clicks_code_fkey"
  FOREIGN KEY ("code") REFERENCES "affiliate_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma's @updatedAt is written by the client; the schema declares no default.
ALTER TABLE "affiliate_applications" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreatorLevelFact has no model and no reader or writer anywhere in the code.
DROP TABLE IF EXISTS "CreatorLevelFact";
