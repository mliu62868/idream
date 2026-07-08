# Admin 后台信息架构重构 — 角色 / 生成 / 图片 三段流水线

- 日期：2026-07-08
- 范围：**仅后台表现层**（信息架构 + 术语），**零 DB 迁移、零 API 变更**
- 状态：设计已确认，待写实现计划

---

## 1. 问题（第一性原理诊断）

管理后台围绕「图片生成模版 / 角色模版 / 图片」感觉很乱。乱的根源**不是功能多**，而是两件事：

**① 一词多义。** 后台里「模板(template)」至少指 4 样东西、「档案(profile)」指 2 样，还有个「recipe」是其中一样的第三个名字：

| 词 | 实际指的东西 | DB / 组件 | 现在藏在哪 |
|---|---|---|---|
| 模板 | 角色创建预填 | `CharacterTemplate` | Content Ops → Templates |
| 模板 | 提示词配方 | `GenerationPromptTemplate` | Generation Ops → Profiles 的一个 tab |
| 模板 | 模型脚手架 | `modelProfileTemplates`（代码级） | 同上 tab 里 |
| 模板 | 负面提示词 | `GenerationModelProfile.negativeTemplateId` | 游离字符串 |
| profile | 角色视觉身份 | `CharacterVisualProfile` | 挂在 Job 上 / 藏在角色编辑页 |
| profile | 模型引擎配置 | `GenerationModelProfile` | 也挂在同一个 Job 上 |
| recipe | = 提示词配方 | `ContentProductionBatch.recipeId` → `GenerationPromptTemplate` | 批量生产代码里 |

两个「模板」在侧边栏还共用同一个图标（`SlidersHorizontal`）。

**② 一条流水线被切碎散落。** 「造角色 → 渲染图 → 铺到页面」本是一条线，却被拆到 **Generation Ops / Content Ops 两个分组**，外加一个**藏在「官方角色」编辑页里、没有独立入口的 Pregen 面板**。图片本身散在 3 个地方（Asset Library、Production Studio、Pregen 面板）；而排在图片堆里的「Review Queue」审的其实是**角色提交、不是图片**。

## 2. 第一性原理模型

整条内容链上，本质只有 **3 个正交的「配置」 + 1 个产物**：

| 问题 | 本质（每份的粒度） | DB |
|---|---|---|
| 长什么样？ | **角色视觉身份**（每角色一份） | `CharacterVisualProfile` |
| 怎么写提示词？ | **提示词配方**（每用途一份） | `GenerationPromptTemplate` |
| 用哪个引擎渲染？ | **模型档案**（每管线一份） | `GenerationModelProfile` + workflow + provider |
| 产出 | **图片** → 铺到位置 | `MediaAsset` → `MediaAssetPlacement` |

外加一个**跟渲染无关**的「角色创建模板」(`CharacterTemplate`)：它和「官方角色」其实是同一类东西（一堆预填的角色属性），只是一个当成品发布、一个当起点复制。这是"模板"一词最容易撞车的根子 —— 本次**只在 UI 上把它改名区隔**，不合并（合并属于数据模型层，本次不做）。

## 3. 范围与非目标

**做（表现层）：**
- 重排信息架构：把 Generation Ops + Content Ops 两组，重组为 **角色 / 生成 / 图片** 三段流水线。
- 统一术语：改 UI 文案 + i18n，消解「模板/profile/recipe」一词多义。
- 把埋在 tab 里的入口（提示词配方、预设）提为一级；把散落的图片入口（Production + Pregen）合一。

**不做（明确排除）：**
- **零数据库迁移**：`CharacterTemplate` / `GenerationPromptTemplate` / `GenerationModelProfile` / `CharacterVisualProfile` 等 DB 字段名、表名**一律不动**。重命名只发生在 UI 文案层。
- **零 API 变更**：所有 `/api/v1/admin/**` 端点、请求/响应结构不变，复用现有组件的数据流。
- 不合并「角色创建模板 ↔ 官方角色」、不做 template/recipe/promptTemplate 的**数据层**三名归一（留作后续「精简数据模型」阶段）。
- 不动其余 4 个 nav 分组：Trust Ops / Business Ops / Insights / System，以及 Overview。

## 4. 目标信息架构

只重排 Generation Ops + Content Ops → 三段流水线。**迁移映射（保证不丢任何现有页面）：**

| 新分组 | 新条目（section id 复用现有） | 来自现在的（现 section id） |
|---|---|---|
| **① 角色 Characters** | 官方角色（编辑页内含「视觉身份」tab） | Official Characters (`content/official`) |
| | 角色起始模板 | Templates (`content/templates`) |
| | 角色审核队列 | Review Queue (`content/review-queue`) |
| | 标签 | Tags (`content/tags`) |
| **② 生成 Generation** | 模型档案 | Profiles & Rollout (`generation/config`)，只留 drafts/published/feature-flags |
| | 提示词配方 | ← `generation/config` 的 `templates` tab **提为一级**（新 section）|
| | 预设 | ← `generation/config` 的 `settings` tab 内 presets 表 **提为一级**（新 section）|
| | 工作流 | Workflows (`generation/workflows`) |
| | 后端 | Backends (`generation/backends`) |
| | 供应商健康 | Provider Health (`ops/providers`) |
| | 任务与事故 | Jobs & Incidents (`generation/jobs`) |
| | 死信 | Dead-letter (`generation/dead-letter`) |
| | 指标 | Metrics (`generation/metrics`) |
| **③ 图片 Media** | 图片生产 | Production Studio (`content/production`) **＋** Pregen 面板 **合一**（新壳） |
| | 图片库 | Asset Library (`content/assets`) |
| | 铺位 | Placements (`content/placements`) |
| | 精选 | Content / Featured (`content`) |
| | CMS·SEO | CMS/SEO (`cms`) |

③ 组内部即一条小流水线：**生产 → 入库 → 铺位 → 精选 → SEO 页**，是"图片/内容最终露出"的地方，故精选/CMS 归此。

**视觉身份**（`CharacterVisualProfile` / 原 `VisualPassportPanel`）是"每角色一份"，本应是角色的子视图，**保持内嵌在官方角色编辑页**，只把 tab 名统一为「视觉身份」；不做成顶级列表。

## 5. 术语重命名（**只改 UI 文案 + i18n；DB 字段名不动**）

| 现 UI 名 | 新 UI 名 | 理由 |
|---|---|---|
| Templates / 模板（角色） | **角色起始模板** | 点明"造角色的起点"，从此不和别的"模板"撞 |
| Prompt Templates / Recipes | **提示词配方** | 一物三名 → 统一叫"配方" |
| Profiles & Rollout | **模型档案** | 去掉和"视觉身份"撞车的 "profile" |
| Visual Passport | **视觉身份** | 和"模型档案"彻底分家，中文直指"长什么样" |
| Review Queue | **角色审核队列** | 点明审的是角色提交、不是图片 |

group headers（Generation Ops / Content Ops 等）现在只有英文，本次顺带补齐三段新分组的中文：角色 / 生成 / 图片。

## 6. 三个结构性动作（都是搬挂载点，无新业务逻辑）

1. **图片生产合一** — 新建薄壳 `ImageProductionView`，两个 tab：
   - 「通用批量」= 现 `ProductionStudioView`（`ContentOpsViews.tsx:188`）
   - 「为角色生成」= 现 `CharacterPregenPanel`（`CharacterPregenPanel.tsx`）
   二者底层同为 `ContentProductionBatch` API，仅 `purpose/targetType` 不同。Pregen 从此有独立入口；官方角色编辑页保留一个"快捷跳转到图片生产"的入口即可（不再是唯一入口）。

2. **配方 / 预设 提为一级** — 把 `ConfigView`（`AdminConsoleClient.tsx:3103`，`ConfigTab = "drafts"|"published"|"templates"|"settings"`）的：
   - `templates` tab 内容（`PromptTemplateDraftForm` + Prompt Recipes 表）抽出为独立页 **提示词配方**；
   - `settings` tab 内的 presets 表抽出为独立页 **预设**。
   `模型档案` 本体只留 `drafts` / `published`（+ feature flags 仍留 settings）。复用现有子组件，**不重写逻辑**。

3. **视觉身份 tab 更名** — 官方角色编辑页里的 `VisualPassportPanel` tab 名统一为「视觉身份」。

4. **角色审核队列** — relabel（点明审角色）+ 归入「角色」组。

## 7. 落地面（改哪些文件 · 0 DB / 0 API）

全部位于 `packages/main/src/components/admin/`（admin 包只是薄壳，复用 main 源码）：

- `AdminConsoleClient.tsx`
  - 重写 `navItems`(625–658) 的分组、顺序、图标（角色组与生成组不再共用 `SlidersHorizontal`）。
  - `sectionDataFor()` + 渲染 switch 增加 3 个新 section：`提示词配方` / `预设` / `图片生产`，指向复用的既有组件。
  - `ConfigView`(3103) 拆分：templates/settings 两 tab 的渲染抽为可独立挂载的子视图（薄 wrapper 复用其中子组件）。
- `i18n.tsx` — 更新条目 label + 补齐三段新分组 group header 的中文。
- 新建 `ImageProductionView.tsx` — 薄壳组合 `ProductionStudioView` + `CharacterPregenPanel`。
- 图标：从 `lucide` 另取两个区分角色/生成两组。

## 8. 验收标准

- [ ] 侧边栏本域只剩三组：**角色 / 生成 / 图片**，其余 4 组不变。
- [ ] 现有每个页面都能在新 IA 里找到（对照 §4 迁移表逐条点开可达），**无功能丢失**。
- [ ] 「提示词配方」「预设」是**一级入口**，不再需要先进「模型档案」再切 tab。
- [ ] 「图片生产」一个入口里能同时做「通用批量」和「为角色生成」；Pregen 不再只能从角色编辑页钻入。
- [ ] 全站搜不到旧撞名 UI 文案：`Prompt Recipes`/`Profiles & Rollout`/`Visual Passport`/角色「Templates」等，均已按 §5 改名；两个「模板」不再同图标。
- [ ] `bun run typecheck` + `bun run lint` 通过；admin 后台可正常起、三组页面均可打开。
- [ ] `git grep` 确认 schema.prisma 与 `/api/v1/admin/**` 无改动（表现层承诺）。

## 9. 后续（本次不做，登记备忘）

- 数据模型精简阶段：`CharacterTemplate ↔ 官方角色` 是否合并；`template/recipe/promptTemplate` 数据层三名归一；`MediaAsset.characterId`(游离列) 与 `Character.imageAssetId`(FK) 的双绑定收敛；negative prompt 三源归一。这些需迁移 SQL（用户执行），单独立项。
