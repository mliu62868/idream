# Admin 后台：引导式导航（渐进披露 + 带路首页）

- 日期：2026-07-09
- 范围：降低后台认知负荷 —— 侧边栏渐进披露 + Dashboard 变引导式首页。**纯表现层，零 DB / 零 API。**
- 关联：承接 2026-07-08 IA 重构（角色/生成/图片 三段流水线）；把 `ADMIN_CONSOLE_PLAN.md` 已定义的分层装回 UI。
- 状态：已实现 (表现层)

## 1. 问题（第一性原理）
后台把 34 项、8 组拍成**等权菜单**：运营一进来面对全部 label、没有引导 → 不知从哪下手、易混乱（用户原话："label 太多 / 引导不够"）。
但 `docs/product/ADMIN_CONSOLE_PLAN.md` **早已分层**：侧边栏每分区标 `P0`(日常必需)/`P1`(增强)（line 92）；`工作流/后端/model-imports` 明确是"隐藏工程诊断，不作为默认运营入口"（line 127/182）；定义了核心日常面 Dashboard/审核/官方角色/Trust&Safety（section 5）。**实现时把分层压平了**——这就是根因，不是设计缺失。

修法 = 让 UI 重新体现 plan 已有的分层。用户两个说法（引导不够 / label 太多）是同一根的两面，对应两个杠杆，一起做。

## 2. 杠杆 1 — 侧边栏渐进披露

**常驻（6 项，任务化命名，永远可见）：** 总览 · **审核** · 官方角色 · 图片生产 · 精选 · 客服工单

**折叠组（默认收起，点开才见；展开状态存 localStorage）：**
- 角色配置：角色起始模板 · 标签
- 生成配置：模型配置 · 提示词配方 · 预设
- 图片：图片库 · 铺位 · CMS·SEO
- 业务：用户 · 账单 · 定价 · 推广 · 公告
- 洞察：分析 · 洞察 · 实验 · 风险
- **工程诊断**：工作流 · 后端 · 供应商健康 · 任务与事故 · 死信 · 指标（plan 明说的"隐藏工程诊断"，视觉可再弱化）
- 系统：合规 · 审批 · 审计

默认可见：**34 项平铺 → 6 常驻 + 7 折叠组头**。

**「审核」= 一个入口，2 tab**：`角色审核`(复用 `ReviewQueueView`) + `举报`(复用 `ModerationView`)。新建薄壳 `ReviewCenterView`，自取数（`/api/v1/admin/moderation/queue`），仿 `ImageProductionView`。若 Moderation 取数耦合过重，退化为「审核队列 + 举报」两个常驻 pin（daily 变 7，仍远优于 34）。

## 3. 杠杆 2 — Dashboard 变「带路首页」
现 Dashboard 是一堆 metrics。改为三段：
- **需要你处理的**（注意力）：待审提交 N · 失败/blocked 任务 N · 待处理举报 N · 待处理工单 N —— 每个点进对应屏。数据复用现有 `DashboardData`（已含 generation.failed/blocked、moderation.openReports）+ 客户端从 review-queue / support 列表端点计数（**零新 API**）。
- **常用任务**（意图入口）：`[上架新角色]`→官方角色创建 · `[生产一批图]`→图片生产 · `[去审核]`→审核。就是 Link 卡片。
- **健康概览**：现有 metric 网格缩小放下方。

进来先看"有什么需要我 + 我想干什么"，不是冷扫 34 个 label。

## 4. 触点（约 3-4 文件 · 0 DB / 0 API）
- `nav-config.ts`：给 nav 加 `tier`（`daily` | 折叠组名）结构；导出常驻集 + 折叠组定义。SSoT 不变，仍是四处同步的源。
- `AdminConsoleClient.tsx`：侧边栏渲染改为「常驻区 + 可折叠组」（加折叠 state + localStorage）；重建 `DashboardView`（注意力 + 任务卡 + metrics）；给「审核」加 section 路由。
- 新建 `ReviewCenterView.tsx`（2-tab 薄壳，复用 ReviewQueueView + ModerationView）。
- 复用现有端点，无 schema/API 改动。

## 5. 验收
- [ ] 默认侧边栏 = 6 常驻 + 7 折叠组头（不再 34 平铺）；折叠组点开可见全部现有屏，**无功能丢失**；展开状态持久。
- [ ] 工程诊断组默认折叠（体现 plan 的"隐藏工程诊断"）。
- [ ] 「审核」一个入口能到 角色审核 + 举报。
- [ ] Dashboard 首屏 = 注意力面板（4 个可点计数）+ 任务卡 + 健康 metrics。
- [ ] `bun run typecheck` + `bun run lint` 绿；点一遍常驻 + 折叠组，无白屏、无 console 错误。
- [ ] `git grep` 确认 schema.prisma 与 `/api/**` 无改动。

## 6. 后续（本次不做）
- 角色分权（role → 可见 nav）：与本次正交，plan 里 role→permission 矩阵已定；日常渐进披露先解决"混乱"，分权日后可叠。
