-- §9-③ Normalize MediaAsset.characterId into a real FK (onDelete SET NULL). Run ONCE.
-- DEV: run by agent. PROD: run at deploy. Data-preserving (only nulls orphan refs, then adds constraint).
-- Index media_assets_characterId_idx already exists.
BEGIN;
-- 1) Clean orphan characterId values (point to a non-existent character) → NULL, else ADD CONSTRAINT fails.
UPDATE public.media_assets m
   SET "characterId" = NULL
 WHERE m."characterId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = m."characterId");
-- 2) Add the FK (name aligns with Prisma default {table}_{col}_fkey; camelCase col must be quoted).
ALTER TABLE public.media_assets
  ADD CONSTRAINT "media_assets_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES public.characters(id) ON DELETE SET NULL;
COMMIT;
