ALTER TABLE "chat_exchange_facts"
  ADD COLUMN "entryExposureId" TEXT,
  ADD COLUMN "journeyId" TEXT,
  ADD COLUMN "placementId" TEXT;

CREATE INDEX "chat_exchange_facts_characterReleaseId_placementId_productDay_idx"
  ON "chat_exchange_facts"("characterReleaseId", "placementId", "productDay");

CREATE INDEX "chat_exchange_facts_entryExposureId_idx"
  ON "chat_exchange_facts"("entryExposureId");
