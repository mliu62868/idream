CREATE TABLE "coin_offers" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "offerKey" TEXT NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "name" TEXT NOT NULL,
  "dreamcoins" INTEGER NOT NULL CHECK ("dreamcoins" > 0),
  "priceCents" INTEGER NOT NULL CHECK ("priceCents" > 0),
  "currency" TEXT NOT NULL DEFAULT 'usd',
  "eligibility" TEXT NOT NULL DEFAULT 'all' CHECK ("eligibility" IN ('all', 'paid_access')),
  "terms" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'published', 'retired')),
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "coin_offers_offerKey_version_key" ON "coin_offers"("offerKey", "version");
CREATE UNIQUE INDEX "coin_offers_one_published_version" ON "coin_offers"("offerKey") WHERE "status" = 'published';
CREATE INDEX "coin_offers_status_offerKey_idx" ON "coin_offers"("status", "offerKey");
ALTER TABLE "checkout_sessions" ADD COLUMN "coinOfferId" TEXT;
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_one_product_check" CHECK ("coinOfferId" IS NULL OR "planId" IS NULL);
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_coinOfferId_fkey" FOREIGN KEY ("coinOfferId") REFERENCES "coin_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "checkout_sessions_coinOfferId_createdAt_idx" ON "checkout_sessions"("coinOfferId", "createdAt");
