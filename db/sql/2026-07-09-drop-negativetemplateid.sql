-- §9-④ Remove dead GenerationModelProfile.negativeTemplateId (stored but NEVER applied in generation).
-- The effective negative is composed in imageNegativePrompt() from recipe.negativeBase + visualProfile.negativeIdentityPrompt;
-- negativeTemplateId was a vestigial admin field. Dropping it changes ZERO output. Run ONCE.
-- DEV: run by agent (after build). PROD: run at deploy, before activating new code.
BEGIN;
ALTER TABLE public.generation_model_profiles DROP COLUMN "negativeTemplateId";
COMMIT;
