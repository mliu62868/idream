-- 撤回 20260912040000 加的 generation_attempts.requestId 外键。另外两条外键与 CHECK 保留。
--
-- WHY IT IS BEING DROPPED
-- PostgreSQL 在写子行时会对父行取 `FOR KEY SHARE`，它与 `FOR UPDATE` 冲突。
-- `generation_jobs` 的行锁正好在生成热路径上被密集持有 —— 陈旧对账、finalize、
-- settlement 都会持有它。加上这条外键之后，任何 Attempt 写入都要排在这些锁后面。
--
-- 实测：`generation-terminal-record-ingest.test.ts` 的
-- "does not let stale reconciliation overwrite terminal evidence committed while
-- the Job lock waits" 由通过变为 5 秒超时。那条用例断言的正是本次退化掉的性质 ——
-- 当对账正在等 Job 锁时，终态证据的 ingest 必须仍能提交。移除本外键后，该文件
-- 38 项全部恢复通过。
--
-- 收益与代价不成比例：这条外键防的是孤儿 Attempt，开发库实测存量 3 条、且是历史
-- 遗留而非持续量产；代价却是把最高频的写入路径串行化到对账锁后面，在生产上表现为
-- 终态记录积压。`character_projects` 与 `case_evidence` 没有这个问题 —— 它们写入
-- 频率低，父行也不在任何热路径的锁上，因此那两条外键保留。
--
-- 孤儿 Attempt 因此仍然只能靠 reconciliation/invariants.ts 的
-- `attempt_without_request` 离线扫描发现。这是明知的取舍，不是遗漏。

ALTER TABLE "generation_attempts"
  DROP CONSTRAINT IF EXISTS "generation_attempts_requestId_fkey";
