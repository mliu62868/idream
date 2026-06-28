# iDream 管理平台 Phase 3：CMS/SEO · 合规运营 · 生成质量与团队流程

更新日期：2026-06-28

> 续 Phase 2 控制面 + 角色管理（均已落地，详见 `ADMIN_CONSOLE_PLAN.md` 与代码 `packages/main/src/server/modules/admin/`）。Phase 2 + 角色管理把「受控 beta 经营」控制面补齐。
> 本期补**走向公开上线**的三块短板（用户点名 1+2+4）：**CMS/SEO 内容管理**、**合规运营（GDPR DSAR + 年龄验证复核）**、**生成质量与团队流程**。
> 范围外（用户未选）：增长运营面（公告/通知/A-B）暂不做。

## 0. 实施状态 — ✅ 全部落地并验证（2026-06-28）

- **T1 CMS/SEO**：`admin/cms.ts`（list/get/create/patch/publish RoutePage）+ 公开 `[...slug]` 混合 override（`server/cms/published-route.ts` 经 `unstable_cache` 60s ISR + `CmsRenderer`，DB 不可达/无发布行→静态 fallback）。UI `CmsView`。
- **T2 合规**：`admin/compliance.ts`（DSAR 脱敏导出、复用 P0-F 擦除流幂等、年龄验证 override）。UI `ComplianceView`。
- **T4 生成质量+流程**：`admin/generation-health.ts`（profile 健康度聚合 + dry-run 写 dryRunSummary）；`admin/analytics-extra.ts`（CSV 导出 + D1/D7 留存 cohort）；双人审批硬门控 `enforceApproval`（flag `dual_approval_enforced`，挂 pricing publish + 大额 ledger adjust，consumed 一次性）。UI `InsightsView`。
- **权限**：新增 `content.cms.write` / `compliance.read` / `compliance.write`（SSoT `permissions.ts`）。
- **零 DB 迁移**（全部复用既有表/字段）。
- **验证**：`typecheck` 0、`lint` 0、main vitest **27 文件/243 全绿**（新增 Phase 3 集成测试覆盖各端点权限门控+落库+审计+双人审批不变量）、`build` 全绿、浏览器 E2E **5/5**（打真实 PM2 栈，含新分区加载 + CMS 写 + 合规/analytics 越权门控）。
- **运维提示**：浏览器 E2E 须 `turbo build --force` 重建 + `pm2 restart main-web admin-web` 后跑（PM2 跑 standalone 构建）。

## 1. 设计原则与零迁移策略

沿用既有范式：`requirePermission(key)` 门控、`reason+typed` 高危确认、`AdminAuditLog` 全写留痕脱敏、`/api/v1/admin/*` + `dispatchAdmin`。

**尽量零 schema 迁移**：
- CMS 复用既有 `RoutePage` 表（path/template/title/description/canonical/contentStatus/body）——**无新表**。
- 合规复用 `User`（status/deletedAt）+ `AgeVerification`（status override）+ 既有擦除流（`MAIN_TO_CHAT_QUEUE` userDeleted）——**无新表**，按需操作 + 审计。
- 生成健康度从 `GenerationJob` 只读聚合；dry-run 写既有 `GenerationModelProfile.dryRunSummary(Json)`——**无新表**。
- 双人审批硬门控复用 `AdminActionRequest`（加一个 `consumed` 语义：用 `status=consumed` 表示已执行，**无新列**）。
- analytics 导出/留存从核心表 + `AnalyticsEvent` 只读计算——**无新表**。

> 故本期**不需要用户执行任何 DB 迁移**。

## 2. 权限矩阵增量（SSoT：`permissions.ts`）

| key | admin | moderator | support | ops | analyst | 用于 |
|---|:-:|:-:|:-:|:-:|:-:|---|
| `content.cms.write`（新） | ✓ | ✓ | | | | T1 CMS 写/发布（读用 `content.read`） |
| `compliance.read`（新） | ✓ | | ✓ | | | T2 DSAR/年龄验证读 |
| `compliance.write`（新） | ✓ | | | | | T2 擦除/导出/年龄 override（admin only，高危） |

T4 全部复用现有 key：`generation.config.read/write`（健康度/dry-run）、既有高危 key（双人审批门控）、`analytics.export`（导出/留存）。

## 3. Track 1 — CMS / SEO 内容管理

**背景**：公开 SEO 页当前由 `src/lib/ourdream-data.ts` 静态数据 + `generateStaticParams` 静态生成，`RoutePage` 表未驱动渲染。真正的 CMS 需让公开读路径**混合 override**：DB 有已发布行则用 DB，否则 fallback 静态。

### 3.1 后台 CRUD（`/api/v1/admin/cms/...`）
| Method | Path | key | 确认 | 审计 |
|---|---|---|---|---|
| GET | `/admin/cms/pages?status=&q=` | `content.read` | — | — |
| GET | `/admin/cms/pages/:path*` | `content.read` | — | — |
| POST | `/admin/cms/pages` | `content.cms.write` | reason+typed | `cms.page.create` |
| PATCH | `/admin/cms/pages` (body 带 path) | `content.cms.write` | reason+typed | `cms.page.update` |
| POST | `/admin/cms/pages/publish` (body: path, contentStatus) | `content.cms.write` | reason+typed | `cms.page.publish` |

> path 含 `/`，作为 query/body 字段传递（不放 URL 段），避免路由歧义。

字段：`path`（唯一）、`template`、`title`、`description`、`canonical`、`contentStatus`（`template|draft|published`）、`body`（Json：`{ heading, sections: [{ heading, paragraphs: string[] }], cta?: {label,href} }`）。

### 3.2 公开读路径 override（安全 fallback）
- `[...slug]/page.tsx` 与 `generateMetadata`：先 `prisma.routePage.findUnique({ path, contentStatus: 'published' })`；命中 → 用 DB 的 title/description/canonical（metadata）+ `CmsRenderer`（从 body 渲染）；未命中 → 现有静态 `getOurdreamRoute` + `OurdreamRoutePage`。
- `generateStaticParams` 保留（静态页照常预渲染）；被 DB override 或纯 DB 新页走动态 SSR（SEO 友好）。
- **不破坏现有页**：无 published RoutePage 行时行为完全不变。

**验收**：admin 改某 path 的 title/description 并 publish → 该页 metadata 即时变（无需发版）；新建一个不在静态集合里的 path 并 publish → 该 path 可访问并渲染 DB 内容。

## 4. Track 2 — 合规运营（GDPR DSAR + 年龄验证）

### 4.1 DSAR 数据导出 + 账号擦除（`/api/v1/admin/compliance/...`）
| Method | Path | key | 确认 | 审计 |
|---|---|---|---|---|
| GET | `/admin/compliance/users/:id/export` | `compliance.read` | — | `compliance.export`（记 targetId，不记内容） |
| POST | `/admin/compliance/users/:id/erase` | `compliance.write` | reason+typed | `compliance.erase` |

- 导出：聚合该用户的 profile/subscriptions/ledger/jobs/characters/reports 等**结构化**数据为 JSON（敏感明文 prompt/chat 不含——明文仍走 §13 consent/legal hold）。
- 擦除：复用 `deleteRequest` 流（置 `status=deleted`+`deletedAt`、删 session、入队 chat 擦除 `userDeleted`），但针对 **target 用户** + 强制 reason+typed + 审计；幂等（已 deleted 直接幂等返回）。

### 4.2 年龄验证复核队列
| Method | Path | key | 确认 | 审计 |
|---|---|---|---|---|
| GET | `/admin/compliance/age-verifications?status=&userId=` | `compliance.read` | — | — |
| POST | `/admin/compliance/age-verifications/:id/override` | `compliance.write` | reason+typed | `compliance.age_override` |

- override：人工把 `AgeVerification.status` 置 `verified|failed`（+ `verifiedAt`），用于 webhook 失败/申诉的人工兜底。**不绕过未成年硬底线**（仅处理成年验证的人工裁决）。

## 5. Track 4 — 生成质量与团队流程

### 5.1 Profile/Template 健康度 + dry-run（`generation.config.*`）
| Method | Path | key | 说明 |
|---|---|---|---|
| GET | `/admin/generation/model-profiles/:id/health` | `generation.config.read` | 从 `GenerationJob`(该 profileId) 聚合：total/completed/failed/blocked/successRate、p50/p95 延迟、refundRate（按窗口，默认 30 天） |
| POST | `/admin/generation/model-profiles/:id/dry-run` | `generation.config.write` | 对样本矩阵（角色/freeplay/各比例）跑 mock 校验，结果写 `dryRunSummary`，审计 `generation.profile.dry_run` |

发布前 UI 展示健康度 + dryRunSummary，作为人工发布的依据（对齐 `ADMIN_CONSOLE_PLAN §6.2`）。

### 5.2 双人审批硬门控（复用 `AdminActionRequest`）
- 高危执行端点（**pricing publish**、**ledger adjust 超阈值**）在执行前，若 feature flag `dual_approval_enforced` 开启，则**强制**要求存在一条 `status=approved` 且 `action`+`targetId` 匹配的 `AdminActionRequest`；执行成功后把它置 `status=consumed`（一次性，防重放）。
- flag 关闭（受控 beta 默认）→ 行为不变（仅留痕，不强制），保持向后兼容。
- 不变量测试：无凭据→403；有凭据→放行且置 consumed；同凭据二次执行→拒绝。

### 5.3 Analytics 导出 + 留存 cohort（`analytics.export`）
| Method | Path | key | 说明 |
|---|---|---|---|
| GET | `/admin/analytics/export?from=&to=` | `analytics.export` | 返回 CSV（content-type text/csv）：漏斗/币经济/Top 事件的脱敏聚合 |
| GET | `/admin/analytics/retention?weeks=` | `analytics.export` | 按注册日 cohort 的次日(D1)/7日(D7)留存（基于 signup + 后续活跃事件） |

## 6. UI（`AdminConsoleClient.tsx`）
- 新分区：**CMS**（页面列表 + 编辑/发布表单）、**Compliance**（用户搜索 → 导出/擦除 + 年龄验证队列）。
- Generation Config：profile 行加「Health / Dry-run」入口。
- Analytics：加「Export CSV」按钮 + 留存表。

## 7. 守住的硬底线
- DSAR 导出**不含**敏感明文（prompt/chat）；明文仍走 consent/legal hold。
- 年龄 override 不触碰未成年拦截（mock provider 的 underage/csam 与 age≥18 不变）。
- 擦除走既有 P0-F 跨服务流（chat 擦除 at-least-once 幂等）。

## 8. 验证
- 每能力 service 单测（权限 403 + 落库 + 审计 + 不变量）。
- E2E 扩 admin-web：新分区 section-load + 写操作 + 越权 403。
- `typecheck`/`lint`/`vitest`(连接池 cap 已生效)/`build` 全绿；浏览器 E2E 须 PM2 重建后跑。
- **零 DB 迁移**。

## 9. 明确不做（YAGNI / 既定）
增长运营面（公告/banner/通知/A-B，用户本期未选）· body 级富静态页改造（CMS 用简单渲染器,富静态页保留）· 内容审核深化 · video · voice。
