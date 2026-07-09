-- Recipe rename (three-name unification). Metadata-only RENAMEs; data preserved. Run ONCE.
-- DEV: run by agent. PROD: run at deploy, BEFORE activating the new code.
BEGIN;
ALTER TABLE public.generation_prompt_templates RENAME TO generation_recipes;
ALTER TABLE public.generation_recipes RENAME COLUMN "templateKey" TO "recipeKey";
ALTER INDEX public.generation_prompt_templates_templateKey_status_idx
  RENAME TO generation_recipes_recipeKey_status_idx;
ALTER TABLE public.generation_jobs RENAME COLUMN "promptTemplateId" TO "recipeId";
ALTER TABLE public.generation_jobs RENAME COLUMN "promptTemplateVersion" TO "recipeVersion";
ALTER INDEX public.generation_jobs_promptTemplateId_promptTemplateVersion_idx
  RENAME TO generation_jobs_recipeId_recipeVersion_idx;
COMMIT;
