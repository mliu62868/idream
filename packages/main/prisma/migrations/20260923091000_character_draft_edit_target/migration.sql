-- An edit draft revises one owned Character through the Create wizard; the
-- pointer keeps it out of Create resume and names the Character that receives
-- the new Soul / Visual Identity versions on submit.
ALTER TABLE "character_drafts" ADD COLUMN "editsCharacterId" TEXT;
CREATE INDEX "character_drafts_editsCharacterId_idx" ON "character_drafts"("editsCharacterId");
ALTER TABLE "character_drafts" ADD CONSTRAINT "character_drafts_editsCharacterId_fkey"
  FOREIGN KEY ("editsCharacterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
