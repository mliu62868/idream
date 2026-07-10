# Admin 运营 UX 重设计 — 设计 (Spec)

- **Date:** 2026-07-10
- **Status:** Approved (brainstorming) → ready for writing-plans
- **Scope:** presentation-layer only（纯前端，不动 API / Prisma / worker）
- **Owner:** admin console
- **设计语言:** /minimalist-ui（浅色暖白编辑部风），偏离项见 §5

## 1. 背景与问题

后台现状（`packages/main/src/components/admin/`，`AdminConsoleClient.tsx` 7739 行 +
一批自取数视图，`packages/admin` 为薄壳）对运营不直观：

1. **浏览与创建混在一屏**：`OfficialCharactersView`、`TemplatesView` 等内容页都是
   "创建/编辑表单堆在列表表格上方"的单页（沿 PromoView 语汇复制而来）。运营想浏览时
   被表单挡路，想创建时在列表噪音里填表；编辑是表格里挤一行输入框。
2. **视觉实体用纯文字表格管理**：角色、图片资产本质是视觉内容，后台却看不到图。
3. **暗色高密度工程风**：黑底白细框、密表格、满屏边框，是工程调试面板的气质，
   不是运营工作台；且样式全是 `bg-[rgb(18,18,18)]` 这类硬编码任意值，没有 token 层。
4. **写操作仪式繁重**：处处要求"输入内部 ID 确认"，普通操作和破坏性操作同一套重仪式。

昨天的「生成」组重构（spec: `2026-07-09-admin-generation-group-redesign-design.md`）已经
验证了「共享原语 + 薄页面」策略（OperatorFlow / ReadonlyOpsView / FailureReason /
EngineeringDetails），但只覆盖生成组，且仍是暗色语汇。

## 2. 目标 / 非目标

**目标**
- 全后台换成浅色暖白编辑部风（token 一处定义，全后台继承）。
- 内容资产页拆成「列表 / 详情 / 新建」路由级三件套，浏览与创建彻底分开。
- 视觉实体（角色、图片）用卡片/图片网格浏览，直接看图。
- 写操作确认降噪：普通写操作只要 reason，破坏性操作才要名称确认；不再敲内部 ID。
- 运营面全中文；每页一句话用途文案。

**非目标（明确不做）**
- 不动 API / Prisma schema / worker / 审计契约（reason≥3 保留）。
- 不做 RBAC。
- 不改 Model Profiles（generation/config）的 OperatorFlow 动线（昨天刚上线，只换皮）。
- 不动侧栏 IA 结构（daily + 折叠组保留，只换视觉）。
- 不碰既定延后项（safety-gateway、video、`MODERATION_PROVIDER=mock`）。

## 3. 关键决策（brainstorming 已拍板）

| # | 决策 | 取舍 |
|---|---|---|
| D1 | 视觉方向 = **全面转浅色编辑部风**（非暗色微调） | 运营后台与 C 端暗色产品彻底区分；换皮必须全后台一次到位（共享壳，明暗混搭不可接受） |
| D2 | 页面形态 = **路由级三件套**：列表页 → 详情页（查看+就地编辑+动作）→ 新建页（/new） | 三个 URL 可深链可后退，心智最清晰；否决了同屏左右栏与抽屉方案 |
| D3 | 范围 = **全换皮 + 内容页先重构**；其余页面换皮保结构，后续快跟 | 否决了"一次重构所有页面"（风险集中）与"只动点名页面"（明暗混搭） |
| D4 | 实现 = **token 层 + 共享页面原语 + 薄页面** | 延续昨天已验证的 SSoT 策略；否决了全面引入 shadcn（观感距离远、与现有惯用法割裂）与"先纯换色后重构"（每文件碰两次） |

## 4. 设计系统

### 4.1 Token 层

新文件，机制：**CSS 变量定义在 admin 根节点 class 上**（`AdminConsoleClient` 根元素），
页面经 Tailwind 任意值引用（如 `bg-[var(--ad-surface)]`）。不用全局 `@theme`——
避免污染同仓 C 端暗色产品的样式空间。

| Token | 值 | 用途 |
|---|---|---|
| 画布 | `#F7F6F3` 暖白 | 页面底色 |
| 表面 | `#FFFFFF` | 卡片 / 表单 / 侧栏 |
| 文字主 / 次 | `#111111` / `#787774` | 正文 line-height 1.6 |
| 边框 | `#EAEAEA` 1px | 唯一边框语汇；圆角 8px 卡片 / 6px 按钮 |
| 状态·成功 | 淡绿 `#EDF3EC` / 字 `#346538` | 已上线 |
| 状态·等待 | 淡黄 `#FBF3DB` / 字 `#956400` | 草稿 / 待审 |
| 状态·失败 | 淡红 `#FDEBEC` / 字 `#9F2F2D` | **只给真错误**，告别满屏红 |
| 状态·进行 | 淡蓝 `#E1F3FE` / 字 `#1F6C9F` | 进行中 / 信息 |
| 主按钮 | `#111` 底白字 | hover `#333`，无阴影 |
| 阴影 | 几乎无 | hover 仅 `0 2px 8px rgba(0,0,0,0.04)` |

排版：中文 UI 靠字号 + 字重 + 留白拉层级；ID / 数字 / 代码一律 mono；区块间距放大，
留白优先于密度。

### 4.2 共享页面原语（新目录 `packages/main/src/components/admin/ui/`）

刻意少且小，每个原语一个文件：

| 原语 | 职责 |
|---|---|
| `PageHeader` | 页名 + **一句话用途（必填）** + 主动作按钮 |
| `FilterBar` | 搜索 + 下拉筛选组 |
| `CardGrid` / `EntityCard` | 视觉实体卡片网格（头像/缩略图 + 状态 pill） |
| `DataTable` | 编辑部风表格：宽松行高、仅底边分隔线 |
| `StatusPill` | pastel 状态（映射到 4.1 四色） |
| `FormPage` | 全屏表单骨架：← 返回 + 分组区块 + 底部固定操作条 |
| `DetailPage` | ← 返回 + 标题区（名字/状态/主动作）+ 分区内容 |
| `ConfirmDialog` | 写操作统一确认（见 §6 降噪规则） |
| `EmptyState` | 空态引导（文案 + 行动按钮），不是一行灰字 |

既有生成组原语 `OperatorFlow` / `FailureReason` / `EngineeringDetails` / `ReadonlyOpsView`
保留动线，换 token 皮。

## 5. 与 /minimalist-ui 技能条文的偏离（项目约定优先）

1. **图标保留 Lucide**（技能建议 Phosphor；AGENTS.md 约定 Lucide，全量换库是纯 churn）。
2. **不用衬线大标题**（技能面向英文编辑部风；中文后台用字重层级替代，中文衬线在后台观感差）。

## 6. 信息架构与路由

### 6.1 路由扩展（纯客户端）

`normalizeSection`（`nav-config.ts`）升级为 `parseAdminPath`：

```
/admin/content/official        → { sectionId: "content/official", view: "list" }
/admin/content/official/new    → { sectionId: "content/official", view: "new" }
/admin/content/official/<id>   → { sectionId: "content/official", view: "detail", id }
未知路径                        → dashboard（不变式保留）
```

侧栏高亮按 `sectionId`；深链 / 后退可用；nav-config 既有不变式
（daily+folded 覆盖所有 id 恰好一次）不动。

### 6.2 本轮上三件套的页面

| 页面 | 列表形态 | 备注 |
|---|---|---|
| 官方角色 `content/official` | 卡片网格（头像+状态） | **样板间，先做** |
| 角色模板 `content/templates` | 卡片网格 | |
| Prompt Recipes `generation/recipes` | 表格 | 详情含配方内容 + 试运行入口 |
| Presets `generation/presets` | 表格 | |
| 图片库 `content/assets` | 图片网格 | 「新建」= 上传流程 |
| Placements `content/placements` | 表格 + 缩略图 | |
| Tags `content/tags` | 列表 + **内联新建（例外）** | 仅 2 字段，独立新建页反而重（KISS） |

### 6.3 只换皮不重构

Model Profiles（`generation/config`）、Dashboard、审核队列、Moderation、
用户 / 计费 / 定价 / Promo / 公告、运维 / 工程页、其余全部。

## 7. 运营动线（官方角色为样板，其余内容页复制此模式）

**列表页** — 回答「有什么、什么状态、怎么找到」：
- `PageHeader`（用途文案 + 「+ 新建角色」）+ `FilterBar`（搜索 + 性别/风格/状态）
- 卡片：头像、名字、风格·年龄、参考图数、状态 pill；点卡片进详情
- 空态：`EmptyState`（"还没有官方角色，从新建开始" + 按钮）

**详情页** — 回答「它现在怎么样、我能对它做什么」：
- `← 返回` + 名字 + 状态 pill + 主动作区（编辑资料 / 上线 / 下线）
- 分区：基本资料、描述与标签、参考图（直接展示图片）、生成记录入口
- 工程字段（visualProfile JSON、内部 ID）一律折进 `EngineeringDetails`，默认不见
- **编辑 = 详情页就地切换为可编辑表单（同一 URL）**，不再是表格里挤输入框

**新建页** — 回答「我要填什么、还差什么」：
- 全屏专注表单，分组：基本信息 → 外貌与风格 → 描述与标签 → 提交
- AI 辅助显眼位置：一句话灵感 → 自动填充表单
- 校验就地提示（必填、年龄≥18 等）；底部固定操作条（原因 + 创建）
- 成功后跳转新角色详情页

**写操作确认降噪（全后台统一规则）**：
- 普通写操作：`ConfirmDialog` = 动作摘要 + 原因输入（后端 reason≥3 契约不变）
- 破坏性操作（删除/下线）：额外输入**名称**确认——不再敲内部 ID
- 成功轻提示；失败走 `FailureReason` 人话字典

**文案**：运营面全中文，i18n zh 表补齐（延续"运营面不漏英文"规则）。

## 8. 验证

- **单测**：`parseAdminPath`（list/new/detail/未知回退）、nav-config 不变式同步、
  i18n 覆盖测试扩展到新原语与新页面文案。
- **L1/L2**：`bun run check`（lint + typecheck + build）全绿。
- **浏览器冒烟**：Chrome 实机走 列表→筛选→详情→编辑→保存→新建→上线 全动线，
  截图核对设计语言；注意已知坑（SSR hydration/localStorage 读放 useEffect、
  dev server / pm2 重启后再验）。

## 9. 分批合入（writing-plans 细化）

1. **P1** token 层 + 页面原语 + 全后台换皮（壳 + 机械类名替换）
2. **P2** 官方角色三件套（样板间）
3. **P3** 其余六个内容页复制样板
4. **P4** i18n 补齐 + 浏览器冒烟扫尾

每批 `bun run check` 全绿才进下一批。
