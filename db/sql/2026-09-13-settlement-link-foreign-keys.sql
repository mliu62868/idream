-- 把 generation_settlement_link_mismatch 那条离线不变式的一半收成数据库约束，
-- 并修正 legacy 创作批次里「全失败却叫 completed」的存量状态。
-- DEV: 由用户执行（本文件只产出，不代跑）。PROD: 部署窗口内执行，顺序见下。
--
-- INTENT: generation_settlement_links 此前**只有主键、零外键**，requestId 与
--   ledgerEntryId 都能指向虚空。结算账目的引用完整性因此只能靠 reconciliation 的
--   离线扫描事后发现 —— 而扫描只在孤儿产生之后说话。这与
--   db/sql/2026-09-12-orphan-row-foreign-keys.sql 是同一手法：与其加一条检查，
--   不如让错误不可表达（ADR-13 §2.1.4）。
--
-- INTENT: ON DELETE CASCADE 而不是 RESTRICT，理由同上一份脚本 —— 这两条边的父行
--   被删时子行本就该消失（账号擦除会删 dreamcoin_ledger 行并留下 erased_ 墓碑），
--   而 RESTRICT 会让擦除在半路失败，比留孤儿更糟。
--
-- 2026-09-13 在开发库 idream_runtime_20260812 实测的存量（执行前请用 §1 重新核对）：
--   ledgerEntryId 悬空  3 / 总 173  —— 全部 2026-07-25，对应的 generation_jobs
--                                     也已不存在，审计链两端都断了
--   requestId 悬空      6 / 总 173  —— 同批历史夹具
--   content_production_batches status='completed' 且零成功产出  5 行
--
-- 关于那 9 条（两类有重叠）：它们指向的 ledger 条目与 generation_job 都已不存在，
-- 而所有读取路径都要 join 这两张表之一，因此没有任何界面或对账能再看到它们 ——
-- 删除不会再损失可用的证据。若仍要留档，先跑 §2.0 的导出再继续。
--
-- 另外 4 条「ledger 有 generation_spend/refund 但没有 link」的 zt-admin-* 夹具不在
-- 本文件处理范围：外键约束的是 link → 父行这个方向，缺 link 的账本条目加约束也拦不住，
-- 那是对账口径问题，留给 reconciliation 继续报。

-- =====================================================================
-- §1 Preflight：执行前核对存量。数字与预期不符就停下来先弄清原因。
-- =====================================================================
-- SELECT 'settlement_link_ledger_orphan' AS check,
--        count(*) AS orphans
--   FROM generation_settlement_links l
--   LEFT JOIN dreamcoin_ledger d ON d.id = l."ledgerEntryId"
--  WHERE d.id IS NULL
-- UNION ALL
-- SELECT 'settlement_link_request_orphan',
--        count(*)
--   FROM generation_settlement_links l
--   LEFT JOIN generation_jobs j ON j.id = l."requestId"
--  WHERE j.id IS NULL
-- UNION ALL
-- SELECT 'creative_completed_without_success',
--        count(*)
--   FROM content_production_batches
--  WHERE status = 'completed' AND greatest("completedItems", "approvedItems") = 0;

-- =====================================================================
-- §2 存量处置 + 约束。整体一个事务：任一步失败则什么都不改。
-- =====================================================================
BEGIN;

-- §2.0 可选留档（需要就在 psql 里先单独跑，\copy 不能放在本文件的事务里）：
--   \copy (SELECT l.* FROM generation_settlement_links l LEFT JOIN dreamcoin_ledger d ON d.id = l."ledgerEntryId" LEFT JOIN generation_jobs j ON j.id = l."requestId" WHERE d.id IS NULL OR j.id IS NULL) TO 'orphan-settlement-links-2026-09-13.csv' CSV HEADER

-- §2.1 删除指向已不存在账本条目或已不存在请求的结算关联。
DELETE FROM public.generation_settlement_links l
 WHERE NOT EXISTS (
   SELECT 1 FROM public.dreamcoin_ledger d WHERE d.id = l."ledgerEntryId"
 )
    OR NOT EXISTS (
   SELECT 1 FROM public.generation_jobs j WHERE j.id = l."requestId"
 );

-- §2.2 两条外键。父行消失时子行随之消失，与账号擦除路径一致。
ALTER TABLE public.generation_settlement_links
  ADD CONSTRAINT generation_settlement_links_ledgerEntryId_fkey
  FOREIGN KEY ("ledgerEntryId") REFERENCES public.dreamcoin_ledger(id)
  ON DELETE CASCADE;

ALTER TABLE public.generation_settlement_links
  ADD CONSTRAINT generation_settlement_links_requestId_fkey
  FOREIGN KEY ("requestId") REFERENCES public.generation_jobs(id)
  ON DELETE CASCADE;

-- §2.3 修正 legacy 批次状态。
-- INTENT: 状态机此前没有 `failed` 这一格，于是「一条都没做出来」的批次只能叫
--   completed —— 一个叫 completed 的状态，任何人读到都会理解成成功完成。
--   content-production-state.ts 已补上这一格（reviewedItems 满且 completedItems=0 → failed），
--   这里把存量对齐，否则 creative_succeeded_without_successful_item 会一直报这 5 行。
-- INVARIANT: 只改「全部条目终态且零成功产出」的行；有任何成功产出的 completed 不动。
UPDATE public.content_production_batches
   SET status = 'failed'
 WHERE status = 'completed'
   AND greatest("completedItems", "approvedItems") = 0;

COMMIT;

-- =====================================================================
-- §3 验证：应全部返回 0。
-- =====================================================================
-- SELECT count(*) AS ledger_orphans
--   FROM generation_settlement_links l
--   LEFT JOIN dreamcoin_ledger d ON d.id = l."ledgerEntryId"
--  WHERE d.id IS NULL;
-- SELECT count(*) AS completed_without_success
--   FROM content_production_batches
--  WHERE status = 'completed' AND greatest("completedItems", "approvedItems") = 0;
-- 写入侧验证（应被外键拒绝）：
--   INSERT INTO generation_settlement_links (id, "requestId", "ledgerEntryId", kind, "createdAt")
--   VALUES ('probe', 'does-not-exist', 'does-not-exist', 'generation_spend', now());

-- =====================================================================
-- §4 追加：把创作批次的四个计数器与状态重算回子事实。
-- =====================================================================
-- INTENT: §2.3 只按 `greatest(completedItems, approvedItems) = 0` 修状态，
--   命不中那些**计数器本身就错**的行：条目被审核驳回（rejected）后
--   completedItems 没有回退，于是批次看上去还有成功产出。实测 4 行如此，
--   它们又连带让 5 行的 status 判据对不上。
-- INTENT: content_production_items 是权威，批次上的四个计数器与 status 都是投影。
--   投影偏离权威时，正确的方向永远是按权威重算，而不是反过来迁就投影。
--   重算规则与 content-production-state.ts 的 recompute 逐字一致；
--   代码侧在任一条目状态变化时都会重算，所以这里只需要修一次存量。
BEGIN;

WITH facts AS (
  SELECT b.id,
         count(i.id)::int AS total_items,
         count(i.id) FILTER (WHERE i.status IN ('generated','approved','published'))::int AS completed_items,
         count(i.id) FILTER (WHERE i.status = 'failed')::int AS failed_items,
         count(i.id) FILTER (WHERE i.status IN ('approved','published'))::int AS approved_items,
         count(i.id) FILTER (WHERE i.status IN ('approved','rejected','published','failed'))::int AS reviewed_items,
         count(i.id) FILTER (WHERE i.status IN ('queued','regenerate_requested'))::int AS active_items,
         count(i.id) FILTER (WHERE i.status = 'generated')::int AS generated_items
    FROM public.content_production_batches b
    LEFT JOIN public.content_production_items i ON i."batchId" = b.id
   GROUP BY b.id
)
UPDATE public.content_production_batches b
   SET "totalItems"     = f.total_items,
       "completedItems" = f.completed_items,
       "failedItems"    = f.failed_items,
       "approvedItems"  = f.approved_items,
       status = CASE
         WHEN f.total_items > 0 AND f.reviewed_items = f.total_items
           THEN CASE WHEN f.completed_items > 0 THEN 'completed' ELSE 'failed' END
         WHEN f.generated_items > 0 OR f.reviewed_items > 0 THEN 'reviewing'
         WHEN f.active_items > 0 THEN 'queued'
         ELSE 'draft'
       END
  FROM facts f
 WHERE f.id = b.id
   AND (b."totalItems"     IS DISTINCT FROM f.total_items
     OR b."completedItems" IS DISTINCT FROM f.completed_items
     OR b."failedItems"    IS DISTINCT FROM f.failed_items
     OR b."approvedItems"  IS DISTINCT FROM f.approved_items
     OR b.status IS DISTINCT FROM CASE
         WHEN f.total_items > 0 AND f.reviewed_items = f.total_items
           THEN CASE WHEN f.completed_items > 0 THEN 'completed' ELSE 'failed' END
         WHEN f.generated_items > 0 OR f.reviewed_items > 0 THEN 'reviewing'
         WHEN f.active_items > 0 THEN 'queued'
         ELSE 'draft'
       END);

COMMIT;

-- =====================================================================
-- §5 未采纳：users.dataClass 默认值
-- =====================================================================
-- 本轮试过把默认值从 'customer' 改成最保守的 'fixture'，**已回退**，原因如下。
--
-- 问题是真的：dataClass='customer' 的 47 个账号里 42 个是测试账号
--   （31 个 @customer.invalid、6 个 .test 域、5 个 e2e-*），而
--   CUSTOMER_METRIC_DATA_SCOPE 只按 dataClass 过滤，排不掉它们。
--
-- 但改默认值是错的下手点：两条生产注册路径都**显式**声明身份
--   （ourdream/service.ts 的 registeredUserDataClass(email)、server/test/helpers.ts 的
--   显式传参），所以默认值的唯一消费者是测试与 e2e —— 被污染的是开发库，不是生产库。
--   实测改了之后 admin-v2 有 18 个测试文件 / 51 条用例转红：那 48 处
--   `prisma.user.create` 里有 44 处不指定 dataClass，靠默认值来表达"这是个客户用户"。
--   让 44 处单测陪改，去修一个只发生在开发库的污染，收益抵不上风险。
--
-- 精准的修法是让**产生污染的那一侧**显式声明：e2e 建的账号本来就是夹具，
--   应当写 dataClass: 'fixture'（e2e 侧的 user.create 只有 17 处，且语义明确）。
--   那属于测试卫生，不在本文件的数据修正范围，留作下一步。


-- =====================================================================
-- §6 追加：清理两张孤儿表，并把两张 camelCase 表名归位。
-- =====================================================================
-- INTENT: `CreatorLevelFact` 与 `PublicContentRepairItem` 全仓零读零写
--   （前者的策略代码本轮已被删除，后者连删掉的代码都没有；两张表都是 0 行）。
--   留着只会让下一个人以为它们承载了什么。
-- INTENT: `AffiliateApplication` / `AffiliateClick` 是全库 141 张表里唯二的
--   camelCase 表名，而且不是漏写 @@map —— 140 个 model 全都有 @@map，是 map 的
--   目标名写成了 camelCase。后果是今后所有 raw SQL 对这两张表都必须加引号且
--   大小写敏感，而 account-deletion-authority.ts 里已有多处走表名的 raw SQL。
-- INVARIANT: 改名前两张表都是 0 行，所以不涉及数据迁移；Prisma 侧只改 @@map 目标，
--   model 名不变，代码零改动。
BEGIN;

DROP TABLE IF EXISTS public."CreatorLevelFact";
DROP TABLE IF EXISTS public.public_content_repair_items;

ALTER TABLE IF EXISTS public."AffiliateClick" RENAME TO affiliate_clicks;
ALTER TABLE IF EXISTS public."AffiliateApplication" RENAME TO affiliate_applications;

COMMIT;

-- §6 验证：应返回 0 行（不再有 camelCase 表名，也不再有这两张孤儿表）。
-- SELECT tablename FROM pg_tables
--  WHERE schemaname='public'
--    AND (tablename !~ '^[a-z_0-9]+$'
--         OR tablename IN ('CreatorLevelFact','public_content_repair_items'));

-- =====================================================================
-- §7 追加：删除 character_stats.viewsCount 死列。
-- =====================================================================
-- INTENT: 这一列**零写入方** —— 全仓没有任何 increment，也没有第二套浏览量实现；
--   唯一写过它的是一次性迁移 20260716033000（从 character_exposure_facts 回填），
--   而那张事实表至今 0 行。读取方有三处（前台读模型投影成 `views`、admin-v2 两处
--   select、shared 契约声明为必填 int），但**前台组件与 admin 前端都不渲染它**。
--   实测 57 行 character_stats 里 viewsCount <> 0 的有 0 行。
-- INTENT: 留着它的代价不是一列存储，而是让下一个人以为平台有浏览量数据。
--   将来真要做浏览量，正确的顺序是先实现写入方（埋点、防刷、聚合），
--   而不是先留一个空列等它被填上。
-- INVARIANT: 同表的 likesCount / chatsCount **不动** —— 它们有真实 increment 路径
--   （discovery.ts / turn-ledger.ts），likesCount 当前为 0 是冷启动，不是死字段。
ALTER TABLE public.character_stats DROP COLUMN IF EXISTS "viewsCount";

-- =====================================================================
-- §8 追加：把 @customer.invalid 的测试残留账号移出客户口径。
-- =====================================================================
-- INTENT: `CUSTOMER_METRIC_DATA_SCOPE` 只按 dataClass 过滤，所以任何被标成
--   'customer' 的账号都会进客户指标。实测开发库里 dataClass='customer' 的 47 个账号
--   有 42 个是测试残留，其中 17 个是 `zt-admin-*@customer.invalid`（集成测试的 prefix，
--   早期跑在开发库上留下的）。后台 Product Health 上那个显眼的 "Signups" 读的就是这个口径。
-- INVARIANT: 判据是 **`.invalid` 顶级域**（RFC 2606 保留，永不可解析，专供测试），
--   不是猜前缀 —— 真实用户不可能注册出这样的邮箱。这条比按 `zt-` 前缀匹配更安全：
--   前缀是团队约定，域名是标准保证。
-- 不删除这些账号：它们挂着角色、会话与账本，删除的级联面远大于收益；
--   重新归类就足以让它们退出客户口径，同时仍然可被识别为测试数据。
-- 判据只用**标准保证的测试标识**，不猜前缀：
--   · RFC 2606 保留顶级域 .invalid / .test（永不可解析，专供测试与文档）
--   · RFC 6762 的 .local（mDNS 链路本地，不是公网可注册域）
--   · 团队约定的 e2e 前缀（local part 以 e2e- 或 journey-e2e- 开头）
-- 刻意**不包含** codex.idream.*@gmail.com 那三个：gmail 是真实可注册域，
--   它们是人工创建的受控测试账号，重新归类需要人来确认，不该由一条 SQL 代劳。
UPDATE public.users
   SET "dataClass" = 'fixture'
 WHERE "dataClass" = 'customer'
   AND (email LIKE '%.invalid'
     OR email LIKE '%.test'
     OR email LIKE '%@test.local'
     OR email LIKE 'e2e-%'
     OR email LIKE 'journey-e2e-%');

-- =====================================================================
-- §9 追加：给缺失的结算关联补行，而不是删账本。
-- =====================================================================
-- INTENT: 4 条 zt-admin-* 夹具的账本条目有 generation_spend / refund，却没有对应的
--   generation_settlement_links 行，`generation_settlement_link_mismatch` 因此长期报红。
-- INVARIANT: dreamcoin_ledger 是 append-only 账本 —— 即便是夹具行，删账本在语义上
--   也是错的。缺的是关联，就补关联：kind 直接取 ledger 自己的 reason，
--   requestId 取 sourceId，两者本来就是这条关联的定义。
-- INVARIANT: ledgerEntryId 上有唯一约束，所以这条 INSERT 天然幂等，重跑不会重复插入。
INSERT INTO public.generation_settlement_links (id, "requestId", "ledgerEntryId", kind, "createdAt")
SELECT gen_random_uuid()::text, d."sourceId", d.id, d.reason, d."createdAt"
  FROM public.dreamcoin_ledger d
  JOIN public.generation_jobs j ON j.id = d."sourceId"
 WHERE d.reason IN ('generation_spend', 'refund')
   AND NOT EXISTS (
     SELECT 1 FROM public.generation_settlement_links l WHERE l."ledgerEntryId" = d.id
   );
