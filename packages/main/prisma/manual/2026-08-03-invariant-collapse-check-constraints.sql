-- 把 admin_cases / ops_incidents 的「活跃身份键」不变量从离线对账搬进数据库约束。
-- DEV: 由用户执行，或由用户明确授权 agent 执行。PROD: 仅由发布系统执行。
--
-- 背景：packages/main/src/server/modules/admin-v2/reconciliation/invariants.ts 里有四条
-- SQL 检查（active_case_missing_active_key / terminal_case_retains_active_key /
-- duplicate_active_case）事后统计违规行。它们守的是同一件事：
--
--   活跃 Case 必须持有由 (type,targetType,targetId,caseKey) 确定推出的 activeKey；
--   终态 Case 必须释放它。activeKey 上已有 UNIQUE 索引，所以
--   「活跃行都有 key」+「key 由那四列推出」+「key 唯一」⇒ 同一身份最多一个活跃聚合。
--
-- 也就是说：加上下面的 CHECK 之后，那三条检查守的状态在数据库层面**不可表示**，可以删除。
-- duplicate_active_case 现在还额外有害 —— 它把 activeKey 的推导公式抄了第二遍（GROUP BY 那
-- 四列），公式一改它就开始报假阳性，而它并不拥有那个公式。
--
-- ops_incidents 同理，但只搬「终态必须释放 activeCorrelationKey」这一个方向 —— 与现有检查
-- terminal_incident_retains_active_correlation_key 逐字等价，不额外加强度。
--
-- ============================================================================
-- 第 0 步（必须先跑）：确认现有数据满足约束。任一查询返回非零行就**不要**执行下面的事务，
-- 先把数据修干净 —— ALTER TABLE ... ADD CONSTRAINT 会在存量违规上直接失败并回滚。
-- ============================================================================
--
--   -- (a) 活跃 Case 缺 activeKey
--   SELECT id, type, "targetType", "targetId", "caseKey", status
--     FROM public.admin_cases
--    WHERE status NOT IN ('closed','resolved') AND "activeKey" IS NULL;
--
--   -- (b) 终态 Case 仍持有 activeKey
--   SELECT id, status FROM public.admin_cases
--    WHERE status IN ('closed','resolved') AND "activeKey" IS NOT NULL;
--
--   -- (c) activeKey 与推导公式不符（历史公式写出来的行会在这里露出来）
--   SELECT id, "activeKey",
--          type || ':' || "targetType" || ':' || "targetId" || ':' || "caseKey" AS expected
--     FROM public.admin_cases
--    WHERE "activeKey" IS NOT NULL
--      AND "activeKey" <> type || ':' || "targetType" || ':' || "targetId" || ':' || "caseKey";
--
--   -- (d) 终态 Incident 仍持有 activeCorrelationKey
--   SELECT id, status FROM public.ops_incidents
--    WHERE status IN ('resolved','closed','duplicate','merged')
--      AND "activeCorrelationKey" IS NOT NULL;
--
-- ============================================================================
-- 第 1 步：加约束
-- ============================================================================
BEGIN;

-- INVARIANT: activeKey 非空 ⟺ Case 未终态；且非空时必须逐字等于四段身份串。
-- 与 admin_cases."activeKey" 上已有的 UNIQUE 索引合起来，
-- 「同一身份存在两个活跃 Case」在数据库层面不可表示。
ALTER TABLE public.admin_cases
  ADD CONSTRAINT "admin_cases_active_key_identity" CHECK (
    ("activeKey" IS NULL) = (status IN ('closed', 'resolved'))
    AND (
      "activeKey" IS NULL
      OR "activeKey" = type || ':' || "targetType" || ':' || "targetId" || ':' || "caseKey"
    )
  );

-- INVARIANT: 终态 Incident 必须释放活跃相关键，否则同一 signature 无法复发。
-- 只约束终态方向，与被取代的检查逐字等价。
ALTER TABLE public.ops_incidents
  ADD CONSTRAINT "ops_incidents_terminal_releases_active_correlation_key" CHECK (
    NOT (
      status IN ('resolved', 'closed', 'duplicate', 'merged')
      AND "activeCorrelationKey" IS NOT NULL
    )
  );

COMMIT;

-- ============================================================================
-- 第 2 步：约束落地并验证后，删除 invariants.ts 里这四条已不可表示的 SQL 检查
--   - active_case_missing_active_key
--   - terminal_case_retains_active_key
--   - duplicate_active_case
--   - terminal_incident_retains_active_correlation_key
-- 并在 reconciliation/invariants.ts 里补一条 "约束是否还在" 的集合相等检查
-- （形状参照同文件的 projection_dedupe_constraint_missing）。
-- 约束没落地之前不要删 —— 那会留下无人守卫的空档。
-- ============================================================================
