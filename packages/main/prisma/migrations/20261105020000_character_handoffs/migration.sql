-- Creation handoff: one immutable, non-blocking record per "mark ready to publish" click.
CREATE TABLE "character_handoffs" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contentVersionId" TEXT,
    "visualProfileId" TEXT,
    "visualProfileVersion" INTEGER,
    "referenceSetRevisionId" TEXT,
    "selectableImageCount" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_handoffs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "character_handoffs_characterId_createdAt_id_idx" ON "character_handoffs"("characterId", "createdAt", "id");
