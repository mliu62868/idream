CREATE TABLE "admin_user_grant_bundles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bundleKey" TEXT NOT NULL,
    "scope" JSONB,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_user_grant_bundles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_user_grant_bundles_userId_bundleKey_key"
ON "admin_user_grant_bundles"("userId", "bundleKey");

CREATE INDEX "admin_user_grant_bundles_userId_revokedAt_expiresAt_idx"
ON "admin_user_grant_bundles"("userId", "revokedAt", "expiresAt");
