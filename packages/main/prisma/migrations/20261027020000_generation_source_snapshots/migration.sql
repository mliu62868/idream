CREATE TABLE "generation_source_snapshots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "generation_source_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "generation_source_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "generation_source_snapshots_size_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 67108864),
    CONSTRAINT "generation_source_snapshots_sha_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "generation_source_snapshots_userId_sha256_key" ON "generation_source_snapshots"("userId", "sha256");
CREATE INDEX "generation_source_snapshots_userId_idx" ON "generation_source_snapshots"("userId");
CREATE TABLE "generation_source_snapshot_chunks" (
    "snapshotId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    CONSTRAINT "generation_source_snapshot_chunks_pkey" PRIMARY KEY ("snapshotId", "ordinal"),
    CONSTRAINT "generation_source_snapshot_chunks_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "generation_source_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "generation_source_snapshot_chunks_ordinal_check" CHECK ("ordinal" >= 0),
    CONSTRAINT "generation_source_snapshot_chunks_size_check" CHECK (octet_length("bytes") > 0 AND octet_length("bytes") <= 65536)
);
