-- 撤回 20260912040000 加的 character_projects.characterId 外键。
-- case_evidence 的外键与 generation_jobs 的 CHECK 保留。
--
-- WHY IT IS BEING DROPPED
-- 账号擦除对**保留**的 CharacterProject 做匿名化，而不是删除：已发布角色的 Project
-- 带着不可变资质证据必须留存，于是 `characterId` 被改写为 `erased:<sha256>` ——
-- 一个刻意不指向任何真实 Character 的合成值（account-deletion-authority.ts，
-- 经 admin-v2/characters/transition.ts 的 updateCharacterProjectMetadata 写入）。
-- 外键让这次写入直接失败，`account-deletion-authority.integration.test.ts` 的
-- "completes deletion for an owner whose published Character has immutable
-- qualification evidence" 由通过转为外键错误。
--
-- 由此暴露的第二件事：reconciliation/invariants.ts 的 `character_project_orphan`
-- 只做 `LEFT JOIN characters ... WHERE c.id IS NULL`，**不排除** `erased:` 前缀，
-- 所以它把设计内的匿名化产物一律报成违规。该扫描已同步收窄。
--
-- 代价说明：真正的孤儿 Project（既非匿名化、父行也确实消失）仍只能靠那条离线扫描
-- 发现。这是明知的取舍 —— 匿名化是产品要求，外键与它不可兼得。
ALTER TABLE "character_projects"
  DROP CONSTRAINT IF EXISTS "character_projects_characterId_fkey";
