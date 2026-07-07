-- 2026-07-07 P2: GenerationModelProfile 增加可空 workflowKey（引用 gen workflow 描述符）
-- 纯增量、可空；应用前旧代码可正常运行，应用后新代码方可读写该列。
ALTER TABLE "generation_model_profiles" ADD COLUMN IF NOT EXISTS "workflowKey" TEXT;
