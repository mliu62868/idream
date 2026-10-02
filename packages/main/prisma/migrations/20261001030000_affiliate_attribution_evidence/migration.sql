-- Existing observations remain unversioned and unverified; never invent their
-- historical signup account or accepted rule from today's application.
ALTER TABLE "affiliate_clicks"
  ADD COLUMN "convertedUserId" TEXT,
  ADD COLUMN "attributionVersion" TEXT,
  ADD COLUMN "attributionWindowDays" INTEGER,
  ADD COLUMN "termsVersion" TEXT;
CREATE UNIQUE INDEX "affiliate_clicks_convertedUserId_key" ON "affiliate_clicks"("convertedUserId");

-- Authority constraints
ALTER TABLE "affiliate_clicks" ADD CONSTRAINT "affiliate_clicks_rule_snapshot_check" CHECK (
  ("attributionVersion" IS NULL AND "attributionWindowDays" IS NULL AND "termsVersion" IS NULL)
  OR ("attributionVersion" IS NOT NULL AND "attributionWindowDays" IS NOT NULL AND "attributionWindowDays" BETWEEN 1 AND 365 AND "termsVersion" IS NOT NULL)
);
ALTER TABLE "affiliate_clicks" ADD CONSTRAINT "affiliate_clicks_conversion_identity_check" CHECK (
  "convertedUserId" IS NULL OR "convertedAt" IS NOT NULL
);
CREATE OR REPLACE FUNCTION idream_affiliate_click_authority_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.id, OLD."affiliateUserId", OLD.code, OLD."visitorKey", OLD."landingPath", OLD."createdAt", OLD."attributionVersion", OLD."attributionWindowDays", OLD."termsVersion")
    IS DISTINCT FROM ROW(NEW.id, NEW."affiliateUserId", NEW.code, NEW."visitorKey", NEW."landingPath", NEW."createdAt", NEW."attributionVersion", NEW."attributionWindowDays", NEW."termsVersion") THEN
    RAISE EXCEPTION 'Affiliate click and accepted attribution rule are immutable';
  END IF;
  IF OLD."convertedAt" IS NOT NULL AND
    ROW(OLD."convertedAt", OLD."convertedUserId") IS DISTINCT FROM ROW(NEW."convertedAt", NEW."convertedUserId") THEN
    RAISE EXCEPTION 'Observed affiliate signup attribution is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "affiliate_clicks_authority_immutable" BEFORE UPDATE ON "affiliate_clicks"
  FOR EACH ROW EXECUTE FUNCTION idream_affiliate_click_authority_immutable();
