CREATE TABLE "video_sequence_cancellations" (
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "video_sequence_cancellations_pkey" PRIMARY KEY ("userId", "idempotencyKey"),
    CONSTRAINT "video_sequence_cancellations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
