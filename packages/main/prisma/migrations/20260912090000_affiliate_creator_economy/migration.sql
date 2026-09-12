-- Affiliate attribution and creator level facts. Apply with Prisma migrate deploy.
CREATE TABLE "AffiliateApplication" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
  "termsVersion" TEXT NOT NULL, "channels" JSONB NOT NULL DEFAULT '[]', "reviewNote" TEXT,
  "reviewedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AffiliateApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "AffiliateApplication_userId_key" ON "AffiliateApplication"("userId");
CREATE TABLE "AffiliateClick" (
  "id" TEXT PRIMARY KEY, "affiliateUserId" TEXT NOT NULL, "code" TEXT NOT NULL, "visitorKey" TEXT NOT NULL,
  "landingPath" TEXT NOT NULL, "convertedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AffiliateClick_userId_fkey" FOREIGN KEY ("affiliateUserId") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "AffiliateClick_code_createdAt_idx" ON "AffiliateClick"("code", "createdAt");
CREATE UNIQUE INDEX "AffiliateClick_code_visitorKey_key" ON "AffiliateClick"("code", "visitorKey");
CREATE TABLE "CreatorLevelFact" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "level" TEXT NOT NULL, "version" INTEGER NOT NULL,
  "publishedCharacters" INTEGER NOT NULL DEFAULT 0, "publishedComics" INTEGER NOT NULL DEFAULT 0, "followers" INTEGER NOT NULL DEFAULT 0,
  "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorLevelFact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "CreatorLevelFact_userId_version_key" ON "CreatorLevelFact"("userId", "version");
