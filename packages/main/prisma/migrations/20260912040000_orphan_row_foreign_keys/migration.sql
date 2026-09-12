-- 把四条离线不变式收成数据库约束：三条孤儿扫描 → 外键，一条终态扫描 → CHECK。
--
-- INTENT: reconciliation/invariants.ts 自己诊断过根因，原话是「缺 FK → 必须手写级联
-- → 手写必然漏 → 量产孤儿」的自我强化循环。扫描只能在孤儿产生之后发现它们；
-- 约束让它们一开始就写不进去。这是 ADR-13 §2.1.4「与其加一条检查，不如让错误
-- 不可表达」在存储层的同一手法。
--
-- 三列都是 NOT NULL 且都已有索引支撑删除查找，所以不能照
-- 2026-07-09-mediaasset-characterid-fk.sql 把孤儿置 NULL —— 存量只能删。
-- ON DELETE CASCADE 而非 RESTRICT：父行被删时子行本就该消失，而 RESTRICT 会让
-- 账号擦除在半路失败，比留孤儿更糟。
--
-- 执行前在 idream_runtime_20260812 实测的存量：
--   character_projects  孤儿 1  / 总 34
--   generation_attempts 孤儿 3  / 总 256   —— 三条全是 status='running'，对 stale 与
--                                            unknown 两个清扫器双重隐形，系统至今
--                                            认为有三次执行正在进行中
--   case_evidence       孤儿 33 / 总 85    —— 分属 11 个已不存在的 Case
--   generation_jobs status='refunded' 0 行

-- 删除指向已不存在角色的创作工作区。
DELETE FROM "character_projects" p
 WHERE NOT EXISTS (SELECT 1 FROM "characters" c WHERE c."id" = p."characterId");

-- 删除指向已不存在生成请求的执行记录。
-- INVARIANT: 只删父行已消失的行。Request 仍在的 Attempt 是不可变计费证据，不得触碰。
DELETE FROM "generation_attempts" a
 WHERE NOT EXISTS (SELECT 1 FROM "generation_jobs" j WHERE j."id" = a."requestId");

-- 删除指向已不存在案件的证据。
-- INTENT: case_evidence 上已有拒绝 UPDATE 的 immutable 触发器，所以这张表的孤儿
-- 不可能来自改写，只可能来自父行被删 —— 外键加 CASCADE 正好是这条唯一成因的解法。
-- 这些行指向的 Case 已不存在，而所有读取路径都按 caseId 关联 admin_cases，
-- 没有任何界面能再看到它们；审计链的另一端已经断了。
DELETE FROM "case_evidence" e
 WHERE NOT EXISTS (SELECT 1 FROM "admin_cases" c WHERE c."id" = e."caseId");

ALTER TABLE "character_projects"
  ADD CONSTRAINT "character_projects_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generation_attempts"
  ADD CONSTRAINT "generation_attempts_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "generation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "case_evidence"
  ADD CONSTRAINT "case_evidence_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "admin_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 退款不是执行终态。
-- INTENT: ADR-13 §2.1.1 已经把 unknown 从「failed 的一个可选字段」升为独立终态，
-- 理由是两者处置相反。refunded 同理：它是结算事实，不是 provider 执行结果。
-- 扫描版本只能在写进去之后发现，CHECK 让这个写入直接失败。
ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_status_not_refunded_check"
  CHECK ("status" <> 'refunded');
