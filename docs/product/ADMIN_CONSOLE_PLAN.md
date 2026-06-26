# iDream 管理后台产品与实现方案

更新日期：2026-06-24

## 1. 文档目的

本文档定义 iDream 内部管理后台的产品范围、权限边界、核心模块、配置发布流程、数据模型建议和分期计划。它补齐 `BackendFeatureSpec.md` 里 “Admin/Ops” 只覆盖审核队列的问题，把管理后台升级为整个产品的控制面。

管理后台不是公开产品页，也不是 Prisma Studio 的替代入口。它负责让内部团队安全地管理用户、内容、生成、订阅、权益、配置、审核、运营和排障，同时保证所有高风险操作有权限、审计和回滚路径。

## 2. 设计原则

1. **后台是控制面，不是业务规则捷径**：后台调用同一套 service，不直接绕过 billing、safety、media、generation 等模块规则。
2. **所有写操作可审计**：记录 actor、role、action、target、before/after、reason、requestId、ip/userAgent 和时间。
3. **高风险操作可回滚或双人确认**：封号、人工退款、模型 profile 发布、批量下架、requeue dead-letter 等操作必须保留历史。
4. **硬政策不可关闭**：未成年、真实人物非同意、规避、年龄门槛等安全底线不能被后台配置禁用。
5. **密钥不进后台**：后台可以引用 provider/profile id，但不能展示或修改生产 token；密钥仍由 env/secret manager 管理。
6. **敏感内容最小可见**：默认隐藏明文 prompt、chat、私密 media；只有 support consent、法律流程或安全复核权限才能查看必要片段。
7. **配置版本化发布**：feature flag、价格、prompt template、model profile、preset seed 都有 draft/active/archived 状态和 rollback。

## 3. 角色与权限

| 角色 | 能力 | 禁止 |
| --- | --- | --- |
| `admin` | 全后台读写、配置发布、角色管理、审计查看 | 直接改密钥、绕过硬政策 |
| `moderator` | 审核队列、举报、内容下架、policy code、申诉处理 | 账单/ledger 调整、模型配置发布 |
| `support` | 用户查询、订阅/余额摘要、工单关联、有限的 job timeline | 查看完整敏感内容、人工退款、封号 |
| `ops` | 队列、provider、health、dead-letter、requeue、配置灰度 | 用户私密内容、billing adjustment |
| `analyst` | 只读看板、漏斗、导出脱敏指标 | 单用户敏感详情、写操作 |

### 3.1 P0 → P1 权限过渡方案（role → permission key）

后台 API 全程以 **permission key** 为鉴权单位，但 key 的来源分两期演进，业务代码无需改写：

- **P0**：只有 `User.role`（`admin` / `moderator` / `support` / `ops` / `analyst`）。权限来自一张**固定映射表**（role → permission keys，见 3.2），由 API 中间件在请求时把 role 解析成 key 集合。不存用户级 override，KISS。
- **P1**：可选的**用户级权限覆盖**（`AdminUserPermission`：`userId` + `grant`/`revoke` + permission key + reason + 审计）。最终 key 集合 = `roleKeys(role) ∪ granted − revoked`。仅 `admin` 可改，写 `AdminAuditLog`。

API 层统一用 `requirePermission(key)` 中间件，不在路由里散落 role 判断：

```ts
// SPEC: 解析当前 actor 的 permission key 集合并校验
// INTENT: P0 只看 role 映射；P1 叠加用户 override，业务无感知
// INVARIANTS: 硬政策 key（safety.hard_policy.*）任何 role 都无法获得
function resolvePermissions(actor): Set<PermKey> {
  const keys = ROLE_PERMISSIONS[actor.role];      // P0
  // P1: return applyOverrides(keys, actor.id);
  return keys;
}
function requirePermission(key: PermKey) {
  return (ctx) => {
    if (!resolvePermissions(ctx.actor).has(key)) throw new ForbiddenError(key);
  };
}
```

permission key 采用 `domain.resource.action` 命名，例如 `generation.config.write`、`billing.ledger.adjust`、`safety.review.write`、`audit.read`。

### 3.2 role → permission key 矩阵（P0 SSoT）

`ROLE_PERMISSIONS` 是 P0 权限的单一事实来源（建议放 `lib/admin/permissions.ts`）。`✓` = 拥有该 key。

| permission key | admin | moderator | support | ops | analyst |
| --- | :-: | :-: | :-: | :-: | :-: |
| `dashboard.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `user.read` | ✓ | ✓ | ✓ | ✓ | |
| `user.status.write`（suspend/restore） | ✓ | | | | |
| `user.role.write` | ✓ | | | | |
| `content.read` | ✓ | ✓ | ✓ | | |
| `content.takedown.write` | ✓ | ✓ | | | |
| `generation.job.read` | ✓ | ✓ | ✓ | ✓ | |
| `generation.job.requeue` | ✓ | | | ✓ | |
| `generation.config.read` | ✓ | | | ✓ | |
| `generation.config.write`（含 publish/rollback） | ✓ | | | | |
| `safety.review.read` | ✓ | ✓ | | | |
| `safety.review.write`（审核决定/申诉） | ✓ | ✓ | | | |
| `billing.read` | ✓ | | ✓ | | |
| `billing.ledger.adjust`（`admin_adjust`） | ✓ | | | | |
| `config.feature_flag.write` | ✓ | | | ✓ | |
| `config.pricing.write`（改 `PricingRule`） | ✓ | | | | |
| `ops.queue.read` | ✓ | | | ✓ | |
| `ops.deadletter.write`（requeue/discard） | ✓ | | | ✓ | |
| `support.plaintext.view`（明文 prompt/chat，受 §13 流程门控） | ✓ | | ✓* | | |
| `audit.read` | ✓ | ✓ | ✓ | ✓ | |
| `analytics.export`（脱敏导出） | ✓ | | | | ✓ |

> `support.plaintext.view` 标 `*`：support 即便持有该 key，也**不等于**可随意查看明文，必须叠加 §13 的 legal hold / consent 门控（per-target、有时限、每次查看写审计）。**硬政策 key（如关闭年龄门、禁用未成年拦截）不存在于任何 role**，与 07 §3 一致，配置层无法触达。
>
> 改 `PricingRule` 走 `config.pricing.write`，且必须遵循 `ECONOMY_AND_PRICING.md` 的配置版本化 + 审计流程（draft → publish → 可 rollback，费率数值 SSoT 仍在 seed/`lib/constants.ts`，后台只做受审计的覆盖发布）。

## 4. 信息架构

侧边栏每个分区都标注上线期次，`P0` = 内部审核/排障/配置闭环必需，`P1` = 运营增强、社区治理、看板与导出。

```text
Admin
  ├─ Dashboard                         [P1]  (P0 只在首页给极简健康卡，不做完整看板)
  ├─ Users                             [P0]  用户查询/详情/状态/role
  ├─ Characters & Content              [P0]  审核入口、上下架（与 Trust & Safety 共用队列）
  ├─ Generation
  │   ├─ Jobs                          [P0]  job detail / events / provider error / refund
  │   ├─ Model Profiles                [P0]  发布/禁用/回滚
  │   ├─ Prompt Templates              [P0]  发布/回滚
  │   ├─ Presets                       [P0]  built-in preset（community preset 治理 = P1）
  │   ├─ Video (beta)                  [P0]  只读、标 disabled（见 §6.4）
  │   └─ Queue / Provider Health       [P1]  (dead-letter 操作台见 §12)
  ├─ Trust & Safety                    [P0]  举报队列、审核决定、blocked media、申诉
  ├─ Billing & Entitlements            [P0]  plan/subscription/entitlement/ledger 查询；adjust 见 §11
  ├─ Product Config                    [P0]  feature flags（pricing 改价 = P1 进配置版本化）
  ├─ Media & Gallery                   [P1]
  ├─ Feed & Community                  [P1]
  ├─ SEO / CMS                         [P1]
  ├─ Support                           [P1]  (明文查看 consent/legal hold 流程见 §13)
  ├─ Analytics                         [P1]  脱敏看板与导出
  └─ Audit Log                         [P0]  append-only 查询与筛选
```

P0 最小必建集合（与 §5 收敛一致）：**Moderation Queue、User Lookup、Generation Job Detail、Generation Config（profiles/templates/presets）、Audit Log、Feature Flags**。Dashboard 完整看板、dead-letter 操作 UI、community preset 治理、Analytics 导出等归 P1。

## 5. P0 后台模块

| 模块 | P0 能力 | 关键约束 |
| --- | --- | --- |
| Dashboard | 生成成功率、队列积压、blocked/failed、付费转化、举报积压、错误率 | 只展示聚合指标 |
| Users | 按 email/id 查用户，查看状态、role、plan、entitlements、age gate、ledger 摘要 | 不直接覆盖余额 |
| Characters | 审核、上下架、标签、可见性、创建者、举报入口 | 公开内容必须有审核状态 |
| Generation Jobs | job detail、events、profile、prompt template version、provider error、ledger/refund、assets | 默认隐藏明文 prompt |
| Model Profiles | 管理生成档位、runner、模型名、尺寸、steps、sampler、cost、entitlement、enabled | 版本化发布，支持回滚 |
| Prompt Templates | 管理 character/freeplay 模板、negative base、preset 拼接顺序、style block | 版本化，旧 job 保留版本 |
| Presets | built-in background/pose/outfit、prompt fragment、分类、Premium gate、安全标签 | user/community preset P1 进入审核 |
| Trust & Safety | 举报队列、审核决定、blocked media、申诉、policy code | 硬政策不可关闭 |
| Billing | plans、subscriptions、checkout/webhook、entitlements、ledger 查询 | adjustment 只能写 ledger |
| Product Config | feature flags、价格表、entitlement gates、视频 beta、image edit 开关 | 变更需要审计 |
| Ops | queue health、dead-letter、requeue、暂停 profile、provider error rate | 高风险操作要 reason |
| Audit Log | 所有后台写操作查询、筛选、导出 | append-only |

P0 实施时先收敛到六个必需模块：

1. Dashboard：生成、队列、审核、支付的健康概览。
2. Generation Jobs：排查失败、退款、blocked、partial success 和用户投诉。
3. Generation Config：发布/禁用/回滚 model profile、prompt template、built-in preset。
4. Moderation Queue：处理举报、blocked media、角色下架和申诉入口。
5. Users/Billing：查询用户、plan、entitlement、ledger 和订阅状态。
6. Audit Log：审计后台写操作。

SEO/CMS、Feed/Community 管理、Analyst 高级导出、双人审批和 saved views 可以放到 Public Launch 或 V1.1，除非上线前合规流程强制要求。

## 6. 图片生成配置控制面

图片生成后台是 P0 的重点，因为它直接影响成本、安全和用户体验。

### 6.1 Model Profile

`GenerationModelProfile` 建议字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定 profile id，例如 `profile_image_default_v1` |
| `label` | 前台展示名 |
| `mode` | `image` / `video` |
| `runner` | `pipeline` / `sd_cpp` / `mlx` / `comfyui` / `external` |
| `pipelineModel` | Pipeline 内部模型名或别名 |
| `defaultWidth` / `defaultHeight` | 默认尺寸 |
| `allowedOrientations` | 前台可选比例 |
| `steps` / `sampler` / `cfgScale` | 推理参数 |
| `negativeTemplateId` | 默认 negative prompt 模板 |
| `costMultiplier` | 价格乘数 |
| `requiredEntitlement` | 例如 `premium_models` |
| `maxCount` | 单次生成数量上限 |
| `concurrencyLimit` | 该 profile worker 并发上限 |
| `enabled` | 是否可用 |
| `rolloutPercent` | 灰度比例 |
| `version` | 发布版本 |
| `status` | `draft` / `active` / `archived` |

P0 生产默认 runner 建议是 `sd_cpp`，但这个值只存在于 Pipeline Service 内部或 admin profile 中。主站和 `packages/gen` 只看到 `profileId`，仍通过 Pipeline HTTP API 调用。

### 6.2 Prompt Template

`GenerationPromptTemplate` 管理：

- character 模式：角色身份、外观约束、pose、outfit、background、style、quality block。
- Freeplay 模式：通用成人合规约束、用户 prompt、style、preset fragment。
- negative prompt：全局 negative base、profile-specific negative、用户 negative prompt 拼接规则。
- safety hints：不暴露给前端，只给 moderation/pipeline 排障。
- 版本：每个 job 固化 `promptTemplateId` 和 `promptTemplateVersion`。

模板发布流程：

```text
draft
  -> dry_run against sample matrix
  -> review
  -> active
  -> rollback to previous active
  -> archived
```

dry-run 样本至少覆盖：角色模式、Freeplay、各比例、premium negative prompt、blocked prompt、空 preset、多个 preset 组合。

发布前还应记录质量评分：

| 指标 | 用途 |
| --- | --- |
| success rate | 是否可发布 |
| median / p95 latency | 是否会破坏等待体验 |
| blocked rate | 是否误触发安全策略 |
| refund rate | 是否带来资金和客服压力 |
| like/download rate | 发布后衡量满意度 |

任何 profile 或 template 的发布都必须保留 previous active，可一键 rollback。

### 6.3 Preset Governance

P0 只开放 admin 管理 built-in preset：

| 类型 | 示例 | 规则 |
| --- | --- | --- |
| background | room, beach, studio | prompt fragment + category + safety tags |
| pose | portrait, standing, seated | 和比例/model profile 兼容 |
| outfit | casual, formal, fantasy | 可按 entitlement gate |
| mode | dreamy, vivid | 实际映射到 prompt template/profile 参数 |

P1 再开放 user/community preset，但必须经过审核、举报、下架和创作者归属流程。

### 6.4 视频生成的后台归属（P0：可见但禁用）

视频生成在产品层仍是 stub（feature flag OFF；费率已在 `ECONOMY_AND_PRICING §1.1` 定义为 100 币/个，但 flag OFF 时 `POST /generation/jobs` 对 video 直接 402/403，不创建 job、不扣费，见 `IMAGE_GENERATION_SERVICE_PLAN §6.9`）。后台对视频的处理：

- **配置可见**：`GenerationModelProfile.mode = video` 的档位在 Generation Config 中**可读可编辑 draft**，但 UI 顶部固定标 `beta / disabled` 徽章，且 publish 按钮禁用（受 `config.feature_flag` 门控）。让团队可以提前准备配置，不影响线上。
- **无在线队列**：P0 **不**展示视频的 live job 队列 / dead-letter（没有真实流量）。Generation Jobs 列表按 `mode` 过滤，默认只显示 image；视频 tab 留位但显示空态「video 生成未启用」。
- **开关单一入口**：视频整体启停由 `feature_flag: video_gen` 控制，与计划权益 `Plan.features.video_gen` 联动；后台改 flag 走 §10 高危确认（含 reason + 审计），不在 profile 层各自开关，避免漂移。

> 一句话：**P0 视频在后台是“看得见、改得了草稿、发不出去、没队列”**。等 feature 真正启用时，复用同一套 profile/template/job/dead-letter UI，无需新建模块。

## 7. 数据模型建议

这些表可以逐步加入 Prisma schema。P0 如需加速，也可先用 `AppConfig` + typed JSON，但长期应拆成一等模型。

| 模型 | 用途 |
| --- | --- |
| `AdminAuditLog` | 后台写操作审计，append-only |
| `AdminActionRequest` | 高风险操作的双人确认或审批 |
| `FeatureFlag` | feature flag、灰度、角色/plan/user 定向 |
| `AppSetting` | 小型产品配置，如帮助入口、默认 CTA、运营开关 |
| `GenerationModelProfile` | 生成模型档位和 runner 参数 |
| `GenerationPromptTemplate` | prompt 编译模板版本 |
| `GenerationProviderRoute` | profile 到 Pipeline endpoint / runner 的路由 |
| `PricingRule` | dreamcoin 成本、count/model/orientation 乘数（改价走配置版本化 + 审计，见 `ECONOMY_AND_PRICING`） |
| `AdminSavedView` | 后台筛选器保存，例如审核队列视图 |
| `AdminUserPermission` | P1 用户级 permission 覆盖（grant/revoke + reason） |
| `SupportConsentGrant` | 用户授权 support 查看明文的 per-target 时限授权（§13） |
| `LegalHold` | 法律保全范围（targetType/Id + 案件号 + 批准人，§13） |

`AdminAuditLog` 最小字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 审计记录 ID |
| `actorId` | 操作者 |
| `actorRole` | 操作时 role |
| `action` | 例如 `generation.profile.publish` |
| `targetType` / `targetId` | 目标 |
| `reason` | 人工输入原因 |
| `before` / `after` | JSON diff 或快照（**不得写入明文 prompt/chat/媒体内容**；只记 targetId + 操作元数据，否则审计本身成为绕过 §13 的明文后门） |
| `requestId` | 请求链路 |
| `ipHash` / `userAgent` | 脱敏环境 |
| `createdAt` | 时间 |

## 8. API Surface

后台 API 用 `/api/v1/admin/*`，每个端点用 §3.1 的 `requirePermission(key)` 鉴权（不用粗粒度 `requireAdmin`）。下表 `permission key` 列就是该端点的鉴权 key，由 §3.2 矩阵决定哪些 role 能调，并与 `BackendFeatureSpec §5.10` 的 role 列一致。

| Method | Path | permission key | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/admin/dashboard` | `dashboard.read` | 聚合关键指标 |
| `GET` | `/api/v1/admin/users` | `user.read` | 用户搜索 |
| `GET` | `/api/v1/admin/users/:id` | `user.read` | 用户详情 |
| `POST` | `/api/v1/admin/users/:id/status` | `user.status.write` | suspend/restore，写审计 |
| `POST` | `/api/v1/admin/users/:id/role` | `user.role.write` | role 变更（P1），写审计（`BackendFeatureSpec §5.10` 暂未列此端点，落地时需补进契约 SSoT） |
| `GET` | `/api/v1/admin/generation/jobs` | `generation.job.read` | 生成任务列表 |
| `GET` | `/api/v1/admin/generation/jobs/:id` | `generation.job.read` | job timeline、ledger、assets、provider error |
| `POST` | `/api/v1/admin/generation/jobs/:id/requeue` | `generation.job.requeue` | dead-letter/retry 管理，需 reason（批量见 §12） |
| `POST` | `/api/v1/admin/generation/jobs/:id/discard` | `ops.deadletter.write` | 弃单（P1），可触发幂等退款，写审计 |
| `GET` | `/api/v1/admin/generation/model-profiles` | `generation.config.read` | 模型 profile 列表 |
| `POST` | `/api/v1/admin/generation/model-profiles` | `generation.config.write` | 创建 draft |
| `PATCH` | `/api/v1/admin/generation/model-profiles/:id` | `generation.config.write` | 编辑 draft / 禁用（`enabled=false`，见 §10） |
| `POST` | `/api/v1/admin/generation/model-profiles/:id/publish` | `generation.config.write` | 发布新 active 版本 |
| `POST` | `/api/v1/admin/generation/model-profiles/:id/rollback` | `generation.config.write` | 回滚 |
| `GET` | `/api/v1/admin/generation/prompt-templates` | `generation.config.read` | 模板列表 |
| `POST` | `/api/v1/admin/generation/prompt-templates` | `generation.config.write` | 创建 draft |
| `PATCH` | `/api/v1/admin/generation/prompt-templates/:id` | `generation.config.write` | 编辑 draft |
| `POST` | `/api/v1/admin/generation/prompt-templates/:id/publish` | `generation.config.write` | 发布模板 |
| `POST` | `/api/v1/admin/generation/prompt-templates/:id/rollback` | `generation.config.write` | 回滚模板 |
| `GET` | `/api/v1/admin/moderation/queue` | `safety.review.read` | 审核队列 |
| `POST` | `/api/v1/admin/moderation/:id/decision` | `safety.review.write` | 审核决定 / 申诉处理 |
| `GET` | `/api/v1/admin/billing/ledger` | `billing.read` | ledger 查询 |
| `POST` | `/api/v1/admin/billing/adjustments` | `billing.ledger.adjust` | 人工补偿，写 ledger |
| `GET` | `/api/v1/admin/feature-flags` | `ops.queue.read` | 开关列表（读；admin+ops，与 §3.2 一致） |
| `PATCH` | `/api/v1/admin/feature-flags/:key` | `config.feature_flag.write` | 更新开关 |
| `GET` | `/api/v1/admin/audit-log` | `audit.read` | 审计查询 |

## 9. 前端实现建议

后台可以放在主 Next app 内的 `/admin` 路由，但必须是动态、鉴权、无 SEO 索引。

P0 页面：

- `/admin`：dashboard。
- `/admin/generation/jobs`：生成任务列表 + detail drawer。
- `/admin/generation/config`：model profiles、prompt templates、presets。
- `/admin/moderation`：审核队列。
- `/admin/users`：用户搜索和详情。
- `/admin/billing`：订阅、ledger、webhook。
- `/admin/audit-log`：审计记录。

设计上应偏运营工具：密度高、表格清晰、筛选/排序/批量操作稳定。不要做营销式大卡片页面。

## 10. 高危操作二次确认

高危操作必须在写入前经过额外确认，且把确认信息写进 `AdminAuditLog`。确认强度分三级：

- **confirm**：弹窗二次确认（不可误触），无需输入。
- **typed**：要求**键入指定字符串**（如目标 id 或 `PUBLISH` / `ROLLBACK`），防止手滑。
- **reason+typed**：键入确认串 **且** 必填 reason（自由文本，进审计）。

| 操作 | API | 确认类型 | 审计必填字段 |
| --- | --- | --- | --- |
| 发布 model profile / prompt template | `.../publish` | reason+typed | `action`、`targetId`、`version`、`before/after`、`reason`、dry-run 引用 |
| 回滚 model profile / prompt template | `.../rollback` | reason+typed | `action`、`targetId`、`fromVersion`、`toVersion`、`reason` |
| 暂停 / 禁用 profile | `PATCH .../model-profiles/:id` (`enabled=false`) | reason+typed | `targetId`、`reason`、受影响 in-flight job 数 |
| 改价（`PricingRule` 发布） | `config.pricing.write` | reason+typed | `before/after` 费率、`reason`、生效版本（走 `ECONOMY_AND_PRICING` 版本化） |
| 内容下架 / takedown | `.../moderation/:id/decision` | reason+typed | `targetType/Id`、`policyCode`、`reason` |
| 用户封号 / 恢复 | `.../users/:id/status` | reason+typed | `targetId`、`fromStatus/toStatus`、`reason` |
| role 变更 | `.../users/:id/role`（P1） | reason+typed | `targetId`、`fromRole/toRole`、`reason` |
| ledger 人工调整（`admin_adjust`） | `.../billing/adjustments` | reason+typed | `targetUserId`、`delta`、`reason`、关联工单/争议 id |
| dead-letter requeue（单/批） | `.../jobs/:id/requeue` | confirm（单）/ reason+typed（批） | `targetId(s)`、`reason`（批量必填）、provider error 摘要 |
| dead-letter discard | `.../jobs/:id/discard`（P1） | reason+typed | `targetId`、`reason`、是否触发退款 |
| 查看明文 prompt/chat | `support.plaintext.view` | reason+typed | `targetType/Id`、`reason`、`ticketId`/`legalHoldId`（见 §13） |
| 切换硬政策相关 flag | — | **禁止**（不可关闭，07 §3） | — |

> 单条非破坏性操作（如 requeue 单个 job）可只用 `confirm`；批量、资金、发布、封号一律 `reason+typed`。前端通过一张 `confirmationPolicy` 配置表驱动弹窗，避免每个按钮各写一套。

## 11. 分期计划

分期与 §4 上线期次的映射：**P0 = Phase 1 + Phase 2**（§4/§5 的六个必需模块，含生成配置发布/回滚），**P1 = Phase 3 + Phase 4**（运营增强、社区治理、双人审批、consent/legal hold、脱敏导出）。Phase ≠ P1，不要因 profile/template 落在 Phase 2 就误判为非 P0。

### Phase 1：内部审核与排障闭环

- 保留现有 `admin/moderation` API。
- 增加 admin layout 和权限门。
- 增加用户查询、generation job detail、audit log。
- 所有后台写操作进入 `AdminAuditLog`。
- 支持 partial success、refund、blocked、failed 的 job timeline 查看。

### Phase 2：生成配置中心

- 增加 `GenerationModelProfile`。
- 增加 `GenerationPromptTemplate`。
- `generation/config` 从 active profile/template 读取。
- Pipeline payload 固化 profile/template version。
- 支持 publish、rollback、disable profile。
- 增加 dry-run sample matrix 和 profile health metrics。

### Phase 3：产品配置与运营

- Feature flags、pricing rules、entitlement gates 后台化。
- Billing/ledger adjustment 审计化。
- Preset library 完整管理（含 community preset 治理）。
- Queue/dead-letter 操作台（§12）。

### Phase 4：安全与团队流程

- 高危操作二次确认（§10）从 P0 的 confirm/typed 升级到可选双人审批（`AdminActionRequest`）。双人审批不变量：`requested_by ≠ approved_by`，审批人须持该操作对应 permission key，requester/approver 各写一条审计。
- support consent / legal hold 流程落地（§13）。
- 脱敏导出和审计报表。
- 用户级 permission override（§3.1 P1），细化 Moderator/Support/Ops/Analyst。

## 12. Dead-letter requeue 操作台（P1）

后台 requeue API 已存在（`POST /api/v1/admin/generation/jobs/:id/requeue`），但缺前端运营流。本节定义 ops UI（归 `Generation → Queue / Provider Health` 下，权限 `ops.deadletter.write`）。因涉及真实流量调度与退款，整体标 **P1**；P0 期间运维仍可直接调 API 应急。

**列表视图**：展示进入 dead-letter（重试耗尽 / 不可恢复）的 job。

| 列 | 说明 |
| --- | --- |
| `jobId` / `userId` | 任务与归属用户 |
| `profileId` / `mode` | 生成档位（P0 只 image，video 见 §6.4 无队列） |
| `failedAt` / `attempts` | 最后失败时间、已重试次数 |
| `providerErrorCode` | provider 返回的错误码（脱敏，不展示密钥/原始 payload 敏感段） |
| `ledgerState` | 预留是否已退（`reserved` / `refunded`），防重复退 |

**详情抽屉**：provider error 全文（脱敏）、事件 timeline、关联 ledger 条目、prompt 默认隐藏（明文需走 §13）。

**操作**：

- **Requeue（单）**：`confirm`，重新入队同一 profile/template version。幂等——若 ledger 已 refund 则**先冲正补扣**或拒绝（不可凭空多产出）。
- **Requeue（批量）**：选中多条或按 `providerErrorCode` 过滤批量重入队，`reason+typed`，写一条审计含 `targetIds` 数组与命中条件。
- **Discard（弃单）**：`reason+typed`。标记永久放弃；若仍 `reserved` 则触发 `refund`（reason=`refund`，幂等 `sourceId=jobId`，对齐 `ECONOMY_AND_PRICING §1.3`），写审计。

所有 requeue/discard 写 `AdminAuditLog`，含 provider error 摘要、操作前后 job 状态。批量操作记录为单条审计 + 子项列表，便于回溯。

## 13. 明文 prompt/chat 查看：consent / legal hold 流程

默认 support **不能**看明文 prompt、chat、私密 media（07 §6 聊天私密、敏感最小可见）。`support.plaintext.view` 只是“具备能力”，真正放行需叠加下面的门控；**每一次明文查看都产生一条 `AdminAuditLog`**（不是每个会话一条，是每次 view 一条）。

例外只有两条合法路径：

1. **用户同意工单（support consent）**
   - 触发：用户在工单中**显式授权** support 查看其特定内容以排障（如「我的图生成异常，授权你们看这条 prompt」）。
   - 范围：**per-target、有时限**（默认 72h）、只读、最小必要片段；授权记录存 `SupportConsentGrant`（`userId` + `ticketId` + `scope` + `expiresAt`）。
   - 审批：support 自身即可在已授权工单内查看，无需二次审批；但越权范围需 admin 批。

2. **法律保全（legal hold）**
   - 触发：法务/执法请求、滥用调查（07 §6 法律留证）。涉未成年素材的取证/上报由合规/法务侧独立处理，不在本设计范围。
   - 审批：由 `admin`（或合规负责人）创建 `LegalHold`（`targetType/Id` + 案件号 + 理由 + 批准人 + `status` + `createdBy` + `releasedBy`/`releasedAt`），support/moderator 才能在该 hold 范围内查看。
   - 生命周期：legal hold **不自动过期**（与 consent 的 72h 不同），只能由 `admin`/合规负责人**显式解除**（写 `releasedBy`/`releasedAt` + reason，留审计）；解除前一直有效。
   - 留存：legal hold 命中的证据**按法律保留，不随删号清除**（07 §6）；即便 hold 已解除，已留存证据的清除仍按法律流程，不在本后台一键删除。

查看动作的强制规则（confirm 类型 = `reason+typed`，见 §10）：

| 项 | 要求 |
| --- | --- |
| 谁能看 | 持 `support.plaintext.view` 且命中有效 `SupportConsentGrant` 或 `LegalHold` |
| 谁批准 | consent = 用户授权（工单内）；legal hold = admin/合规 |
| 每次查看记录 | `action=support.plaintext.view`、`targetType/Id`、`reason`、`ticketId` 或 `legalHoldId`、`actorId`、`createdAt` |
| 范围与时效 | per-target、到期自动失效；无 grant/hold 一律 403 |
| 不可见项 | 密钥、其他用户内容、超出授权范围的会话 |

> 这样把“能力”（permission key）与“正当性”（consent/legal hold + 时效 + 审计）解耦：即使 admin，也应优先走有案底的 hold，使每次明文接触都可追溯、可向用户与监管交代。

## 14. 写操作审计覆盖确认

本文新定义的所有 WRITE 操作均落 `AdminAuditLog`（append-only，§7 字段），无遗漏：

| 操作 | `action`（示例） | 审计 |
| --- | --- | --- |
| profile/template publish·rollback·disable | `generation.profile.publish` 等 | ✓ |
| 改价发布 | `config.pricing.publish` | ✓（含 before/after 费率） |
| takedown / 审核决定 | `safety.review.decision` | ✓ |
| 封号 / 恢复 | `user.status.write` | ✓ |
| role 变更（P1） | `user.role.write` | ✓ |
| ledger 调整 | `billing.ledger.adjust` | ✓ |
| dead-letter requeue / discard | `ops.deadletter.requeue` / `.discard` | ✓（批量记 targetIds） |
| 明文查看 | `support.plaintext.view` | ✓（每次一条，带 ticket/hold id） |
| P1 用户权限 override | `admin.permission.grant` / `.revoke` | ✓ |
| feature flag 变更 | `config.feature_flag.write` | ✓ |

> 唯一不进审计的是纯读路径（`*.read`、`dashboard.read`、`analytics.export` 仅记导出动作而非内容）。原则：**任何改变状态或接触敏感明文的动作都留痕**。

## 15. 验收标准

P0 完成必须满足：

- 后台 API/页面以 `requirePermission(key)` 鉴权；无对应 permission key 的 role 一律 403（role→key 映射见 §3.2）。
- 管理员可以查看单个 generation job 的状态、profile、provider error、ledger/refund、media 和事件 timeline。
- 管理员可以发布/禁用/回滚模型 profile 和 prompt template。
- `generation/config` 只返回 active 且用户 entitlement 允许的 profile。
- 所有后台写操作有审计记录。
- dreamcoin adjustment 只通过 ledger 追加实现。
- 硬安全政策不能被 feature flag 或配置关闭。
- 审核队列可以处理举报、blocked media、角色下架和申诉入口。
- model profile / prompt template 发布前有 dry-run 或人工确认记录，发布后可回滚。
- support 默认不能查看明文敏感 prompt/chat，必须走 support consent、法律流程或安全复核权限；每次明文查看产生一条带 reason + ticket/hold id 的审计（§13）。
- 高危操作（发布/回滚/封号/改价/ledger 调整/明文查看）均经 §10 二次确认，确认信息进审计。
- 视频在后台仅可见且标 disabled，无 live 队列，整启停由单一 feature flag 控制（§6.4）。

## 16. 相关文档

- [IMAGE_GENERATION_SERVICE_PLAN.md](./IMAGE_GENERATION_SERVICE_PLAN.md)
- [ECONOMY_AND_PRICING.md](./ECONOMY_AND_PRICING.md)
- [BackendFeatureSpec.md](./BackendFeatureSpec.md)
- [ProductFeatureMap.md](./ProductFeatureMap.md)
- [../architecture/07-security-and-compliance.md](../architecture/07-security-and-compliance.md)
- [../architecture/05-module-design.md](../architecture/05-module-design.md)
- [../architecture/06-async-jobs-and-ai.md](../architecture/06-async-jobs-and-ai.md)
- [../architecture/10-operations.md](../architecture/10-operations.md)
