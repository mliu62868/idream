# iDream 管理平台 Phase 2 能力补全：设计方案

更新日期：2026-06-28

## 0. 实施状态（2026-06-28 已落地并验证）

本期 7 项（F1–F8）**全部落地并通过验证**，3 个 dormant model（`AdminSavedView` / `AppSetting` / `AdminActionRequest`）已接通：

- F1 Saved Views（owner-scoped、不入审计）、F2 内容/角色目录治理（visibility/status，reason+typed、审计）、F3 Featured 策展（`AppSetting=feed.featured`，公开 `feed()` 读路径优先置顶——见 `ourdream/service.ts:2073`）、F4 Redeem code/Referral（codeHash 存储、明文不入库/不回显/不入审计）、F5 双人审批（`requestedById≠approvedById`、approver 须持 `permissionKey`、状态单向）、F6 Chat 运营面（chat 服务 `/internal/admin/*` 经 `INTERNAL_TOKEN` 代理、脱敏不回明文、不可达降级 `configured:false`）。
- 权限矩阵新增/接通 6 个 key（`content.read`/`content.takedown.write`/`growth.promo.read`/`growth.promo.write`/`chat.ops.read`/`admin.approval.review`），SSoT 在 `permissions.ts`。
- UI：`AdminConsoleClient.tsx` 新增 Content/Promo/Approvals/Chat Ops 分区（`packages/admin` 经 `@/*→../main/src/*` 复用同一控制台）。

**验证证据**：`bun run lint`/`typecheck`/`build` 全绿（5 包）；service-level 集成测试覆盖各 handler 权限门控 + 落库 + 审计（`admin-console.test.ts`，main 200 测试全绿）；chat 73 测试全绿。
**F8 浏览器级写操作/越权 E2E**：按 §5（ADMIN_CAPABILITY_COMPLETION_PLAN §5）既定决策——本机 dev 栈对 E2E baseline 不健康，写操作/403 的浏览器级用例暂以 service 集成测试等价覆盖，待 dev 栈恢复后补浏览器级断言（环境阻断，非实现缺口）。

## 1. 文档目的

`ADMIN_CAPABILITY_COMPLETION_PLAN.md` 收敛了「受控 beta 经营」的 Tier 0/1 最小控制面（定价/退款对账/dead-letter/分析/反滥用/Provider 看板均已落地）。本文是**下一阶段（Phase 2）的落地设计**：基于一次对真实代码的复审，修正过时状态，并以接口优先方式定义 7 项仍缺的管理能力。

## 2. 复审修正（文档曾落后于代码）

复审发现两处「文档说缺、其实已落地」，先正本清源：

| 项 | 旧状态（规划文档） | 真实代码状态 |
| --- | --- | --- |
| 用户级权限覆盖 `AdminUserPermission` | 「model 有，未接」 | ✅ **已完整接通**：`effective-permissions.ts` 请求期应用 grant/revoke，`service.ts` 有 `listUserPermissions`/`setUserPermission`，审计 `admin.permission.grant|revoke|clear` 齐全 |
| Provider/成本/容量看板 | 「无」 | ✅ **已落地**：`providerOps()`（service.ts）+ dispatch + UI「Provider Health」分区 |

**真正 dormant（仅 test 清理引用、0 生产引用）的 model = 4 个**：`AdminActionRequest`（双人审批）、`AdminSavedView`、`AppSetting`、`GenerationProviderRoute`。本期接通前三个；`GenerationProviderRoute`（provider 路由权重）属内部自动调度，受控 beta YAGNI，继续 dormant。

## 3. 本期范围（7 项）

| # | 能力 | 价值 | dormant 接通 |
| --- | --- | --- | --- |
| F1 | Saved Views | 运营效率：保存审核/排障筛选 | `AdminSavedView` |
| F2 | Content/Character 目录治理 | 主动浏览/下架/改可见性（现仅被动举报） | — |
| F3 | Featured 策展 + feed 读路径 | 运营可控首页/feed 曝光 | `AppSetting` |
| F4 | Redeem code / Referral 运营面 | 发码、停用、薅取排查（后端已有，缺入口） | — |
| F5 | 双人审批 | 改价/封号/大额 adjust 的资金护栏 | `AdminActionRequest` |
| F6 | Chat 运营面 | 核心功能的运维盲区（独立服务，admin 完全看不到） | — |
| F7 + F8 | 新 UI 分区 + 写操作/越权 E2E | 控制面行为锁死 | — |

**明确不做（YAGNI / 既定决策）**：CMS/SEO/公告、通知广播、A/B 实验度量、Voice 配置（无对应功能）、内容审核深化（归运营）、video（恒 mock，V1.1）、`GenerationProviderRoute` 控制面。

## 4. 权限矩阵增量（SSoT：`permissions.ts`）

复用已声明但未使用的 `content.read` / `content.takedown.write`；新增 4 个 key。

| permission key | admin | moderator | support | ops | analyst | 用于 |
| --- | :-: | :-: | :-: | :-: | :-: | --- |
| `content.read`（已声明，接通） | ✓ | ✓ | ✓ | | | F2 目录读、F3 featured 读 |
| `content.takedown.write`（已声明，接通） | ✓ | ✓ | | | | F2 改可见性/状态、F3 featured 写 |
| `growth.promo.read`（新） | ✓ | | ✓ | | ✓ | F4 redeem/referral 读 |
| `growth.promo.write`（新） | ✓ | | | | | F4 redeem 发码/停用 |
| `chat.ops.read`（新） | ✓ | ✓ | ✓ | ✓ | | F6 chat 运营读 |
| `admin.approval.review`（新） | ✓ | | | | | F5 审批高危请求 |

Saved Views（F1）owner-scoped、属个人 UI 偏好，**不引入新 key**，以 `dashboard.read`（所有 admin 角色都有）门控并按 `ownerId` 隔离；个人偏好类写操作**不入审计**（与「纯读不入审计、状态变更入审计」一致——saved view 无跨用户/安全影响）。

## 5. 接口设计（`/api/v1/admin/*`，沿用 `requirePermission(key)` + `reason+typed` 确认）

### F1 Saved Views — owner-scoped
| Method | Path | key | 说明 |
| --- | --- | --- | --- |
| GET | `/admin/saved-views?scope=` | `dashboard.read` | 列当前 actor 在该 scope 的视图 |
| POST | `/admin/saved-views` | `dashboard.read` | 创建 `{scope,label,filters}` |
| DELETE | `/admin/saved-views/:id` | `dashboard.read` | 删除本人视图（非本人 404） |

### F2 Content/Character 目录治理
| Method | Path | key | 确认 | 审计 action |
| --- | --- | --- | --- | --- |
| GET | `/admin/content/characters?search=&status=&visibility=&creatorId=&sort=` | `content.read` | — | — |
| GET | `/admin/content/characters/:id` | `content.read` | — | — |
| POST | `/admin/content/characters/:id/visibility` | `content.takedown.write` | reason+typed | `content.visibility.write` |
| POST | `/admin/content/characters/:id/status` | `content.takedown.write` | reason+typed | `content.status.write` |

> 与既有 moderation 决定正交：moderation 处理「举报→决定」，本治理处理「主动巡查目录→改可见性/状态」。两者都写 `Character.status/visibility`，公开 feed/community 读路径本就按 `visibility=public & status=approved` 过滤，下架即时生效。

### F3 Featured 策展（`AppSetting` key=`feed.featured`）
| Method | Path | key | 确认 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/admin/content/featured` | `content.read` | — | 读 featured 角色 id 列表（解析为角色摘要） |
| PUT | `/admin/content/featured` | `content.takedown.write` | reason+typed | 覆盖写 `{characterIds:[]}`（≤24，去重，须 public+approved），审计 `content.featured.write` |

公开 `feed` 读路径：先取 featured 中仍 public+approved 的角色置顶，再补常规 chatsCount 排序，去重 take 20。

### F4 Redeem code / Referral
| Method | Path | key | 确认 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/admin/promo/redeem-codes` | `growth.promo.read` | — | 列码（含兑换计数，不回明文码） |
| POST | `/admin/promo/redeem-codes` | `growth.promo.write` | reason+typed | 创建 `{code,reward,maxRedemptions?,expiresAt?}`，存 `codeHash`，审计 `promo.redeem_code.create`（不写明文码） |
| POST | `/admin/promo/redeem-codes/:id/disable` | `growth.promo.write` | reason+typed | 置 `status=disabled`，审计 `promo.redeem_code.disable` |
| GET | `/admin/promo/referrals?inviterId=&status=` | `growth.promo.read` | — | referral 运营查询（薅取信号在 risk 分区） |

### F5 双人审批（`AdminActionRequest`）
| Method | Path | key | 确认 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/admin/approvals?status=pending` | `admin.approval.review` | — | 待审列表 |
| POST | `/admin/approvals` | （持目标 action 的 key） | reason+typed | 发起请求 `{permissionKey,action,targetType,targetId,payload,reason}` |
| POST | `/admin/approvals/:id/approve` | `admin.approval.review` | reason+typed | 审批 |
| POST | `/admin/approvals/:id/reject` | `admin.approval.review` | reason+typed | 驳回 |

**不变量**：`requestedById ≠ approvedById`；审批人须持 `permissionKey`（请求里声明的目标 key）；状态机 `pending→approved|rejected|canceled` 单向；requester 与 approver 各写一条审计（`admin.approval.request` / `.approve` / `.reject`）。本期审批通过即**记录授权凭据**（approved 的 request id），真正执行仍走对应业务端点（执行端点在受控 beta 不强制校验凭据，先把「请求—复核」留痕闭环；强制门控留 V1.1）。

### F6 Chat 运营面（跨服务，尊重 DB 边界）
chat 服务（`packages/chat`）新增**内部 admin 只读 API**，以 `INTERNAL_TOKEN` 头鉴权（非 BFF 用户签名）：
- `GET /internal/admin/overview` → 活跃/归档会话数、近 24h 消息数、blocked 消息数、当日额度用户分布摘要
- `GET /internal/admin/sessions?userId=&limit=` → 会话列表（id/user/character/status/lastMessageAt/消息数，**不回明文 content**）
- `GET /internal/admin/moderation-events?limit=` → 近期 chat 审核事件（layer/status/policyCode/confidence，脱敏）

main 侧 admin dispatch 代理（`chat.ops.read`）：`GET /admin/chat/{overview,sessions,moderation-events}` → 透传到 `CHAT_SERVICE_URL` + `INTERNAL_TOKEN`；chat 服务不可达时回结构化 503（与既有 chat BFF 降级一致）。**默认不回明文聊天**（明文仍走 §13 consent/legal hold，本期不开聊天明文）。

### F7 UI / F8 E2E
- UI：`AdminConsoleClient.tsx` 增 Content、Featured、Promo、Approvals、Chat Ops 分区（nav + loadSection + view）。
- E2E：在 `admin-web.e2e.ts` 增**写操作**（封号、profile publish、moderation 决定、改价、dead-letter requeue、内容下架）与**越权 403**（低权角色访问越权端点）用例，覆盖新分区加载。

## 6. 验收

- 新端点全部 `requirePermission(key)` 鉴权，越权角色 403（service 单测 + E2E 双覆盖）。
- 所有状态变更/敏感动作入 `AdminAuditLog`（saved view 个人偏好除外，已说明）。
- 接通 3 个 dormant model（`AdminSavedView`/`AppSetting`/`AdminActionRequest`）。
- Chat 运营面尊重服务/DB 边界（经内部 API + 代理，不直连 chat DB），默认不回明文。
- 双人审批不变量（`requested_by≠approved_by`、approver 持 key、状态单向）有测试。
- `npm run check`（lint + typecheck + build）+ 相关 vitest 全绿。

## 7. 相关文档
- [ADMIN_CONSOLE_PLAN.md](./ADMIN_CONSOLE_PLAN.md) · [ADMIN_CAPABILITY_COMPLETION_PLAN.md](./ADMIN_CAPABILITY_COMPLETION_PLAN.md) · [ECONOMY_AND_PRICING.md](./ECONOMY_AND_PRICING.md)
