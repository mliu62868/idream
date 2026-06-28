# iDream 管理平台能力补全规划

更新日期：2026-06-27

## 1. 文档目的

`ADMIN_CONSOLE_PLAN.md` 定义了管理后台的**目标范围**，当前代码已落地约 80%（P0 骨架质量很高）。本文档是一份**面向落地的缺口补全规划**：基于对真实代码的审计，列出「还差什么、为什么差、按什么顺序补」。

**当前里程碑目标**：撑住**受控 beta 经营**（小范围真实用户、真实付费），不是公开上线。补全优先级因此以「真实用户跑起来不出**资金事故 / 运维失控 / 决策盲飞**」为标尺。

**范围裁剪**：内容安全 / Trust & Safety 深化（主动扫描、申诉 SLA、CSAM/未成年上报工作流）**由运营侧自行处理，不在本规划内**。本文档只覆盖资金侧滥用（薅币、支付欺诈）。

## 2. 现状基线（已落地，生产级）

- RBAC：`requirePermission(key)` 全程鉴权，25 个 permission key、6 角色矩阵（`packages/main/src/server/admin/permissions.ts`）。
- 审计：`AdminAuditLog` append-only，19 类写操作全部留痕，敏感字段脱敏（`service.ts:writeAudit`）。
- 已实现模块：Dashboard、Users（查询/封禁/角色）、审核队列+决定、生成 Jobs（详情/requeue/discard）、Model Profile + Prompt Template（版本化 publish/rollback）、内置 Preset CRUD、Feature Flags、Billing Ledger + adjustment、Support 明文查看（consent/legal hold）。
- **定价消费侧已活**：`generationCost`（`service.ts:2859`）已从 `PricingRule(status=active)` 读价，缺的仅是写入/发布控制面（见 §4.1）。

## 3. 缺口总览与分期

| 能力 | 现状 | 层级 | 期次 |
| --- | --- | --- | --- |
| 定价管理（PricingRule 控制面） | ✅ **已落地**（§4.1，2026-06-27） | 🔴 Tier 0 | P-beta-1 |
| 退款 / 订阅 / 资金对账运营流 | ✅ **已落地**（§4.2，2026-06-27） | 🔴 Tier 0 | P-beta-1 |
| Dead-letter / Queue 运营 UI | ✅ **已落地**（§4.3，2026-06-27） | 🔴 Tier 0 | P-beta-1 |
| 资金侧反滥用（薅币/支付欺诈基础） | ✅ **已落地**（§5，2026-06-28） | 🟠 Tier 1 | P-beta-2 |
| Analytics / BI（漏斗·转化·币经济·Top 事件） | ✅ **已落地**（§5，2026-06-28） | 🟠 Tier 1 | P-beta-2 |
| Provider / 成本 / 容量看板 | 无 | 🟠 Tier 1 | P-beta-2 |
| admin 写操作 + 权限拦截 E2E | **仅页面 smoke** | 🟠 Tier 1（质量） | P-beta-2 |
| 双人审批（AdminActionRequest） | model 有，未接 | 🟡 Tier 2 | V1.1 |
| 用户级权限覆盖（AdminUserPermission） | model 有，未接 | 🟡 Tier 2 | V1.1 |
| Saved Views（AdminSavedView） | model 有，未接 | 🟡 Tier 2 | V1.1 |
| Community/Feed 治理、CMS/公告、A/B 实验度量 | 无 | 🟡 Tier 2 | V1.1 |
| Voice 配置控制面 | 无 | 🟡 Tier 2 | 语音上线时 |
| 内容安全深化 | — | — | **运营自处理，不在本规划** |

## 4. Tier 0 详细方案（P-beta-1，本期重点）

### 4.1 定价管理控制面（PricingRule）— ✅ 已落地（2026-06-27）

**为什么**：这是一个 dreamcoin 计费、成本=GPU 的产品。改价、做活动、调成本乘数是经营命脉。落地前**消费侧已读 `PricingRule`，但没有任何后台能创建/发布/回滚它**——改价仍要改 seed/代码，无版本、无审计、无回滚。

**落地内容**：service 层 5 个 handler（list/create/patch/publish/rollback）+ dispatch + Zod 校验 + 审计（`config.pricing.create|update|publish|rollback`）；admin 控制台新增 Pricing 分区（draft 表单 + 发布/回滚操作）；集成测试覆盖权限门控、发布归档、回滚、单一 active per mode 不变量、审计；admin E2E 纳入 Pricing 分区。代码见 `packages/main/src/server/modules/admin/service.ts`、`packages/main/src/components/admin/AdminConsoleClient.tsx`、`packages/main/src/server/modules/ourdream/admin-console.test.ts`。

```
// SPEC: 复用 Model Profile 已验证的 draft→active→archived 版本化发布范式
// INTENT: 接通已存在的 PricingRule model，不新造机制；与 generationCost 读路径对齐
// INVARIANTS: 同一 (ruleKey, mode) 同一时刻至多一个 active；发布即归档前一 active，可回滚
// EXAMPLE: image baseCost 5→4 走 draft→publish，审计记 before/after 费率 + reason + version
```

数据模型（已存在，无需迁移）：`PricingRule { ruleKey, label, mode, baseCost, multiplier, status, version, effectiveFrom, publishedAt, archivedAt }`。

新增 API（permission `config.pricing.write`，矩阵 §3.2 已定义、admin only）：

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/admin/pricing/rules` | 列表（按 mode/status 过滤），`billing.read` 或 `config.pricing.write` 可读 |
| `POST` | `/api/v1/admin/pricing/rules` | 创建 draft |
| `PATCH` | `/api/v1/admin/pricing/rules/:id` | 编辑 draft |
| `POST` | `/api/v1/admin/pricing/rules/:id/publish` | 发布新 active，归档前一版本（reason+typed） |
| `POST` | `/api/v1/admin/pricing/rules/:id/rollback` | 回滚到前一 archived（reason+typed） |

实现复用：直接套 `model-profiles` 的 publish/rollback service 逻辑（同一 draft/active/archived 状态机），审计 action 用 §14 已规划的 `config.pricing.publish`。UI 进 `Product Config` 分区下的 Pricing tab。

**验收**：改价只能经 publish 落库；`generationCost` 立即按新 active 计价；审计含 before/after 费率、version、reason；可一键 rollback。

### 4.2 退款 / 订阅 / 资金对账运营流 — ✅ 已落地（2026-06-27）

**为什么**：受控 beta 一旦有真实付费，客服会立刻遇到「订阅没生效 / 多扣币 / 要退款 / 对不上账」。落地前只有单点 `billing/adjustments`，没有订阅维度视图，也没有对账闭环。

**落地内容**（不追求完整支付争议系统）：

- **订阅运营视图** `GET /api/v1/admin/billing/subscriptions`（`billing.read`）：按 user/status 查 `Subscription`，回 plan/provider/status/currentPeriodEnd/cancelAtPeriodEnd，定位「付了钱没权益」。
- **对账只读报表** `GET /api/v1/admin/billing/reconciliation`（`billing.read`）：按时间窗（默认近 30 天）对 `DreamcoinLedger` 分 reason 聚合（totalDelta + count）+ 活跃订阅数 + 净额。**只读不写**，数与 ledger 求和一致。
- **退款复用既有能力**：生成失败退款走 `discardGenerationJob`（幂等 `sourceId=jobId`，§4.3 批量也幂等）；订阅级退款走 `billing.ledger.adjust`（带关联 id + reason 进审计），不自建退款网关。
- UI：Billing 分区新增对账 metrics + by-reason 表 + 订阅表（在既有 ledger/adjust 之上）。
- 测试：订阅列表权限门控 + plan/status 回显；对账分 reason 聚合 + 活跃订阅计数。admin E2E 的 Billing 证据升级为 `Subscriptions`。

**验收**：能按用户查订阅状态并解释权益；ledger adjust 带关联 id + reason 进审计（已具备）；对账报表数与 ledger 求和一致。

### 4.3 Dead-letter / Queue 运营 UI — ✅ 已落地（2026-06-27）

**为什么**：`requeue` / `discard` 单条 API 已存在且测试覆盖，但**没有 UI**，且 discard 在 UI 完全没入口——生产排障靠手敲 curl，受控 beta 期不可持续。

**落地内容**：
- **列表** `GET /api/v1/admin/generation/dead-letter`（`ops.queue.read`）：列出 failed/blocked job，附 `ledgerState`（reserved/refunded，防重复退），支持 errorCode/status 过滤。
- **单条操作**：UI 行内 Requeue（failed）/ Discard（failed|blocked），直接复用既有单条 API + 既有审计。
- **批量操作**：`POST .../dead-letter/requeue`、`.../dead-letter/discard`（reason+typed，jobIds≤100），各记**一条**审计（`targetType=generation_job_batch`，after 带 requeued/discarded/refunded/skipped 子项列表）；退款幂等（已 refund 的 job 跳过/不二次退）。
- UI 新增 `Generation → Dead-letter` 分区：多选 + 批量操作条 + 行内操作。**单条 handler 零改动**（不碰已验证的资金路径）。
- 测试：列表权限门控 + refund 状态、批量 requeue（跳过 refunded/missing）、批量 discard（幂等退款 + 单条审计）；admin E2E 纳入 Dead-letter 分区。
- 代码见 `packages/main/src/server/modules/admin/service.ts`、`AdminConsoleClient.tsx`、`admin-console.test.ts`。

**未做（明确延后，受控 beta 低价值）**：provider error 详情抽屉、provider health 看板。流量起来后再补。

## 5. Tier 1（P-beta-2，beta 稳定后）

- ✅ **Analytics / BI**（2026-06-28 已落地）：接通 `analytics.export`——`GET /api/v1/admin/analytics/overview`（admin+analyst，只读）返回活动漏斗（注册→激活→付费 + 转化率）、生成状态分布、币经济（发放/消耗/净额 + 分 reason）、Top 事件。数据源 = 核心表 + `AnalyticsEvent`，默认窗口近 30 天。UI 新增 Analytics 分区（metrics + 经济表 + 事件表）。测试覆盖权限门控 + 漏斗/经济聚合；admin E2E 纳入。代码见 `admin/service.ts` `analyticsOverview`、`AdminConsoleClient.tsx` `AnalyticsView`。**未做（延后）**：次日/7日留存（需按天 cohort，避免 raw SQL，待真实流量再补）、单均毛利的精确成本归集。
- ✅ **资金侧反滥用基础**（2026-06-28 已落地）：`GET /api/v1/admin/risk/abuse`（`billing.read`，只读）三类告警——多账号设备聚类（同 `anonymousId` 的 signup 事件挂 ≥2 账号）、Referral 薅取（inviter ≥3 邀请）、异常 admin_adjust（按 user 聚合调整次数/总额）。UI 新增 Risk & Abuse 分区；处置仍走既有封禁/adjust。**非完备**：清 cookie/无痕可绕过 anonymousId 聚类；无 IP/支付指纹（signup 未采集 IP，待接真实支付/风控再补）。代码见 `admin/service.ts` `abuseOverview`、`AdminConsoleClient.tsx` `RiskView`。
- **Provider / 成本 / 容量看板**：GPU/provider 花费、成功率、p95 延迟、单均成本，挂在 Dashboard 或独立 Ops 看板。
- **admin E2E 补全**：现有 `admin-web.e2e.ts` 仅页面 smoke。补封禁/发布/审核决定/改价/越权 403 的写操作 + 权限拦截用例，锁死控制面行为。

## 6. Tier 2 概要（V1.1，团队规模化）

接通三张已建未用的 model：双人审批 `AdminActionRequest`（`requested_by ≠ approved_by`）、用户级权限覆盖 `AdminUserPermission`、`AdminSavedView`；以及 Community/Feed 治理、CMS/公告、A/B 实验度量、Voice 配置控制面。详见 `ADMIN_CONSOLE_PLAN §11 Phase 4`。

## 7. 落地顺序与进度

1. ✅ **定价管理（§4.1）** —— 复用 model-profile 范式，经营价值最高。
2. ✅ **Dead-letter UI（§4.3）** —— 接既有 API + 批量，解锁运维自助。
3. ✅ **退款/订阅/对账（§4.2）** —— 客服上线前的资金兜底。

**Tier 0 三项已全部落地（2026-06-27），「受控 beta 经营」最小控制面就绪。** 下一步进 Tier 1（§5）：资金侧反滥用基础、Analytics/BI、Provider/成本看板、admin 写操作 E2E 补全。

每项均遵循项目验证链：service 单测 + admin E2E，typecheck/lint/build 全绿方算完成。

## 8. 相关文档

- [ADMIN_CONSOLE_PLAN.md](./ADMIN_CONSOLE_PLAN.md) —— 管理后台总范围与权限/审计/合规设计
- [ECONOMY_AND_PRICING.md](./ECONOMY_AND_PRICING.md) —— dreamcoin 费率与配置版本化流程
- [CURRENT_FUNCTIONAL_COVERAGE.md](./CURRENT_FUNCTIONAL_COVERAGE.md) —— 当前功能覆盖与 beta 口径
- [../architecture/08-billing-and-entitlements.md](../architecture/08-billing-and-entitlements.md)
