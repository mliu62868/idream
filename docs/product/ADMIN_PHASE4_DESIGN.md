# iDream 管理平台 Phase 4：增长运营（Growth Ops）

更新日期：2026-06-28

> 续 Phase 3。后台对「受控 beta + 公开上线核心」已完备。本期补最后一条可建的运营线——
> **增长运营面**（用户在 Phase 3 选项里跳过的 track 3，现「继续完成」）。
> 范围：**公告/banner** + **实验度量**。零迁移、零新权限 key。

## 0. 实施状态 — ✅ 全部落地并验证（2026-06-28）

- **公告**：`server/announcements/store.ts`（AppSetting 存储，零迁移）+ `admin/announcements.ts`（list/create/patch/delete，growth.promo.* 门控 + 审计）+ 公开 `GET /api/v1/announcements`（active+时间窗，main app）+ `AnnouncementBanner`（挂根 layout，可关闭）+ `AnnouncementsView`。
- **实验度量**：`admin/experiments.ts`（FeatureFlag + 自创建以来 signups/activation/paying 方向性指标，`analytics.export` 门控，诚实标注非随机分臂）+ `ExperimentsView`。
- **零新权限 key**（复用 `growth.promo.*` + `analytics.export`）、**零 DB 迁移**。
- **验证**：`typecheck` 0、`lint` 0、main vitest **27 文件/245 全绿**（新增公告 CRUD+公开读+时间窗+越权、实验度量门控测试）、`build` 全绿、浏览器 E2E **6/6**（新分区加载 + 公告写+公开读+越权）。
- **延后（infra/产品决策）**：真·邮件/推送广播、精确 A/B 随机分臂归因（需曝光埋点）、Voice 配置。

## 1. 现状与边界（先定，再实现）

侦察结论：仓库**无** Notification/Announcement/Campaign 模型、**无** email/推送 provider。故：

- **公告/banner** 用既定零迁移范式 `AppSetting`（与 Featured 同），并接公开读 + 站内 banner——这就是当前可落地的「站内广播」渠道。
- **真·邮件/推送广播**需要投递基建（provider + 队列 + 逐用户投递 + 退订）+ 渠道产品决策，**本期明确延后**（非缺口标记，是 infra 决策）。站内公告先满足「全站/分层通知」需求。
- **A/B 实验**：`FeatureFlag` 有 rollout/target 但**无逐用户曝光埋点**。故本期做**方向性实验度量**（只读），精确随机分臂归因（需 `experiment_exposed` 事件）**诚实标注延后**。
- **Voice 配置**：无对应功能，YAGNI 延后。

## 2. 权限（零新增，复用）

| 能力 | 读 | 写 |
|---|---|---|
| 公告 CRUD | `growth.promo.read` | `growth.promo.write`（admin only） |
| 实验度量（只读） | `analytics.export`（admin+analyst） | — |

公开 `GET /api/v1/announcements` 无需鉴权（仅回 active + 时间窗内，脱敏）。

## 3. Track A — 公告 / Banner（`AppSetting` key=`announcements`）

数据（AppSetting.value）：`{ items: [{ id, title, body, level: "info"|"promo"|"warning", active, startsAt?, endsAt?, href?, createdAt }] }`

### 后台 `/api/v1/admin/announcements`
| Method | Path | key | 确认 | 审计 |
|---|---|---|---|---|
| GET | `/admin/announcements` | `growth.promo.read` | — | — |
| POST | `/admin/announcements` | `growth.promo.write` | reason+typed | `growth.announcement.create` |
| PATCH | `/admin/announcements/:id` | `growth.promo.write` | reason+typed | `growth.announcement.update` |
| DELETE | `/admin/announcements/:id` | `growth.promo.write` | —（删除走 reason via body 可选） | `growth.announcement.delete` |

CRUD 操作 AppSetting 数组（按 id 增改删）；id 用 randomUUID。

### 公开读 + banner
- `GET /api/v1/announcements`（public）→ 仅 `active=true` 且 `now ∈ [startsAt, endsAt]`（缺省即恒显）。
- `AnnouncementBanner`（client）：拉取上述端点；空→`null`；可关闭（localStorage 记 dismissed id）；挂根 `layout.tsx`，全站可见。

## 4. Track B — 实验度量（只读）

### `GET /api/v1/admin/experiments`（`analytics.export`）
- 列 `FeatureFlag`（key/label/enabled/rolloutPercent/targetRoles/targetPlans/createdAt）。
- 每 flag 附**方向性指标**：自 flag `createdAt` 起窗口内的 signups / activatedUsers(≥1 job) / payingUsers，给运营看「实验期大盘走势」。
- **诚实标注**：非随机分臂归因；精确 A/B 需 `experiment_exposed` 逐用户曝光事件（延后）。

## 5. UI（self-fetch 视图，对齐既有范式）
- `AnnouncementsView`（nav「Announcements」）：列表 + 新建/编辑/启停/删除。
- `ExperimentsView`（nav「Experiments」）：flag 表 + 方向性指标 + 延后说明。

## 6. 守住边界
- 公开公告端点只读、只回 active+窗口内、不含任何用户私密数据。
- 不触碰内容审核/未成年硬底线/video/voice/safety gateway（既定）。

## 7. 验证
- service 单测（权限 403 + CRUD + 时间窗过滤 + 审计）。
- E2E 扩 admin-web：Announcements/Experiments section-load + 写/403。
- `typecheck`/`lint`/`vitest`/`build` 全绿；浏览器 E2E 须 PM2 重建后跑。
- **零 DB 迁移**。

## 8. 明确不做（YAGNI / infra / 既定）
真·邮件/推送广播（需投递基建 + 渠道决策）· 精确 A/B 随机分臂归因（需曝光埋点）· Voice 配置 · 内容审核深化 · video · safety gateway。
