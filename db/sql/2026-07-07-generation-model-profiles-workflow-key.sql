-- 2026-07-07 P2: GenerationModelProfile 增加可空 workflowKey（引用 gen workflow 描述符）
-- 纯增量、可空。
-- ⚠️ 部署顺序（硬依赖）：本 SQL 必须先于（或同步于）部署带此 schema 的 main。
--    一旦 Prisma client 重新生成，它对 GenerationModelProfile 的每一次查询都会 SELECT 该列，
--    未应用本 SQL 前所有 profile 读取（列表/发布/回滚/健康/内容运营等 ~24 处查询点）都会报错，
--    不仅是 workflowKey 本身的读写。旧 client（未 regenerate）不受影响。
ALTER TABLE "generation_model_profiles" ADD COLUMN IF NOT EXISTS "workflowKey" TEXT;
