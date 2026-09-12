-- 把四条离线不变式收成数据库约束：三条孤儿扫描 → 外键，一条终态扫描 → CHECK。
-- DEV: 由用户执行（本文件只产出，不代跑）。PROD: 部署窗口内执行，顺序见下。
--
-- INTENT: reconciliation/invariants.ts 自己已经诊断出根因，原话是
--   「缺 FK → 必须手写级联 → 手写必然漏 → 量产孤儿」的自我强化循环。
--   扫描只能在孤儿产生之后发现它们；约束让它们一开始就写不进去。
--   这是 ADR-13 §2.1.4 那句「与其加一条检查，不如让错误不可表达」在存储层的同一手法。
--
-- INTENT: 三列都是 NOT NULL 且都已有索引支撑删除查找，所以不能照
--   db/sql/2026-07-09-mediaasset-characterid-fk.sql 那样把孤儿置 NULL —— 存量只能删。
--   ON DELETE CASCADE 而不是 RESTRICT：这三条边的父行被删时，子行本就该消失，
--   而 RESTRICT 会让账号擦除在半路失败，比留孤儿更糟。
--
-- 2026-09-12 在开发库 idream_runtime_20260812 实测的存量（执行前请用 §1 重新核对）：
--   character_projects  孤儿 1  / 总 34
--   generation_attempts 孤儿 3  / 总 256   —— 三条全是 status='running'，
--                                            对 stale 与 unknown 两个清扫器双重隐形，
--                                            系统至今认为有三次执行正在进行中
--   case_evidence       孤儿 33 / 总 85    —— 分属 11 个已不存在的 Case
--   generation_jobs status='refunded' 0 行 —— CHECK 无存量违规，可直接加
--
-- 关于 case_evidence 那 33 条：它们指向的 Case 已不存在，而所有读取路径都按
-- caseId 与 admin_cases 关联，因此没有任何界面或查询能再看到它们 —— 审计链的另一端
-- 已经断了，删除不会再损失可用的证据。若仍要留档，先跑 §2.0 的导出再继续。
--
-- INTENT: case_evidence 上已经有一个拒绝 UPDATE 的 immutable 触发器（本次干跑实测：
--   改 caseId 被拒，报的是 "case_evidence is immutable"，还没轮到外键）。所以这张表的
--   孤儿不可能来自改写，只可能来自父行被删 —— 外键加 ON DELETE CASCADE 正好是这条
--   唯一成因的精确解法，而不是又一层泛泛的防护。
--
-- 本文件已在开发库 idream_runtime_20260812 以 BEGIN … ROLLBACK 干跑验证（psql exit 0）：
--   · 三条 DELETE 与三条 ALTER 全部成功；
--   · 加约束后写入违规数据被拒绝 —— character_projects 孤儿 characterId 触发外键错误，
--     generation_jobs status='refunded' 触发 CHECK 错误；
--   · 删除一个 admin_cases 行会级联删掉它的证据（52 → 51）。
--   验证全程回滚，开发库未被改动。

-- =====================================================================
-- §1 Preflight：执行前核对存量。数字与预期不符就停下来先弄清原因。
-- =====================================================================
-- SELECT 'character_project_orphan' AS invariant,
--        count(*) AS orphans
--   FROM character_projects p
--   LEFT JOIN characters c ON c.id = p."characterId"
--  WHERE c.id IS NULL
-- UNION ALL
-- SELECT 'attempt_without_request',
--        count(*)
--   FROM generation_attempts a
--   LEFT JOIN generation_jobs j ON j.id = a."requestId"
--  WHERE j.id IS NULL
-- UNION ALL
-- SELECT 'case_evidence_without_case',
--        count(*)
--   FROM case_evidence e
--   LEFT JOIN admin_cases c ON c.id = e."caseId"
--  WHERE c.id IS NULL
-- UNION ALL
-- SELECT 'refund_encoded_as_execution_outcome',
--        count(*)
--   FROM generation_jobs WHERE status = 'refunded';

-- =====================================================================
-- §2 存量处置 + 约束。整体一个事务：任一步失败则什么都不改。
-- =====================================================================
BEGIN;

-- §2.0 可选留档（需要就在 psql 里先单独跑，\copy 不能放在本文件的事务里）：
--   \copy (SELECT e.* FROM case_evidence e LEFT JOIN admin_cases c ON c.id = e."caseId" WHERE c.id IS NULL) TO 'orphan-case-evidence-2026-09-12.csv' CSV HEADER

-- §2.1 删除指向已不存在角色的创作工作区。
DELETE FROM public.character_projects p
 WHERE NOT EXISTS (
   SELECT 1 FROM public.characters c WHERE c.id = p."characterId"
 );

-- §2.2 删除指向已不存在生成请求的执行记录。
-- INVARIANT: 只删父行已消失的行。Request 仍在的 Attempt 是不可变计费证据，不得触碰。
DELETE FROM public.generation_attempts a
 WHERE NOT EXISTS (
   SELECT 1 FROM public.generation_jobs j WHERE j.id = a."requestId"
 );

-- §2.3 删除指向已不存在案件的证据。
DELETE FROM public.case_evidence e
 WHERE NOT EXISTS (
   SELECT 1 FROM public.admin_cases c WHERE c.id = e."caseId"
 );

-- §2.4 三条外键。约束名对齐 Prisma 默认 {table}_{col}_fkey；camelCase 列必须加引号。
-- 大表可改为先 ADD CONSTRAINT ... NOT VALID，再单独 VALIDATE CONSTRAINT，避免长时间持锁。
ALTER TABLE public.character_projects
  ADD CONSTRAINT "character_projects_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES public.characters(id) ON DELETE CASCADE;

-- 注意：generation_attempts 的外键已于同日撤回，本文件不再添加它。
-- PostgreSQL 写子行要对父行取 FOR KEY SHARE，与 FOR UPDATE 冲突，而
-- generation_jobs 的行锁正在生成热路径上被对账 / finalize / settlement 密集持有。
-- 实测该外键会让「对账等锁期间仍须能提交终态证据」这条性质失效（用例由通过转为
-- 5 秒超时）。孤儿 Attempt 继续由 invariants.ts 的离线扫描负责。
-- 详见 packages/main/prisma/migrations/20260912060000_drop_generation_attempt_request_fkey/。

ALTER TABLE public.case_evidence
  ADD CONSTRAINT "case_evidence_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES public.admin_cases(id) ON DELETE CASCADE;

-- §2.5 退款不是执行终态。
-- INTENT: ADR-13 §2.1.1 已经把 unknown 从「failed 的一个可选字段」升为独立终态，
--   理由是两者处置相反。refunded 同理：它是结算事实，不是 provider 执行结果。
--   扫描版本只能在写进去之后发现，CHECK 让这个写入直接失败。
ALTER TABLE public.generation_jobs
  ADD CONSTRAINT "generation_jobs_status_not_refunded_check"
  CHECK (status <> 'refunded');

COMMIT;

-- =====================================================================
-- §3 执行后核对：四条约束必须都在，且 validated。
-- =====================================================================
-- SELECT conrelid::regclass::text AS table_name, conname, contype, convalidated
--   FROM pg_constraint
--  WHERE conname IN (
--    'character_projects_characterId_fkey',
--    'generation_attempts_requestId_fkey',
--    'case_evidence_caseId_fkey',
--    'generation_jobs_status_not_refunded_check'
--  )
--  ORDER BY 1;

-- =====================================================================
-- §4 代码侧配套（本文件不改代码，执行后请一并处理）
-- =====================================================================
-- 1. packages/main/prisma/schema.prisma：给这三个裸 String 列补 @relation(onDelete: Cascade)，
--    否则下一次 prisma db push 会把它不认识的约束删掉。改完生成 migration，不要用 db push。
-- 2. reconciliation/invariants.ts：四条扫描改为「期望约束集合恰好存在」，
--    与 §1.1 已经做过的 active identity CHECK 同形（projection_dedupe_constraint_missing
--    是现成范例）。约束在，原扫描恒返回零行，留着只是恒真的 passed。
-- 3. account-deletion-authority.ts 的手写级联里，这三张表可以从清单中移除 ——
--    级联现在由数据库保证，手写清单少一处可漏的地方。
