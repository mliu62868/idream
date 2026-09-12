-- Keep affiliate click codes bound to an approved application row.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AffiliateClick_code_fkey') THEN
    ALTER TABLE "AffiliateClick"
      ADD CONSTRAINT "AffiliateClick_code_fkey"
      FOREIGN KEY ("code") REFERENCES "AffiliateApplication"("id") ON DELETE CASCADE;
  END IF;
END $$;
