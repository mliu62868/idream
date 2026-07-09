# 数据模型精简 ②：三名归一 → `recipe`（端到端）

- 日期：2026-07-08
- 范围：`GenerationPromptTemplate` 这一个概念的**命名统一**（schema + 代码 + UI + admin API 路由），端到端叫 `recipe`
- 关联：`docs/product/...` §9 延后项之一；承接上一期后台 IA 重构（UI 已落地「提示词配方 / Prompt Recipes」）
- 状态：设计已确认，待写实现计划

## 已确认的两个决策（2026-07-08）
- **(a) API 路由一起改**：`/api/v1/admin/generation/prompt-templates` → `/generation/recipes`（端到端一致）。
- **(b) key 的字符串值保持不动**：只改列名 `templateKey → recipeKey`，`"template_image_character_default"` 等**值原样保留**（值是数据、被 job 按字符串引用；改值=数据迁移+破坏引用，风险不成比例）。

---

## 1. 问题

一个概念（生成用的提示词配方）在数据层有**三个名字**：
- 表 `GenerationPromptTemplate`（`generation_prompt_templates`）、业务键 `templateKey`；
- `GenerationJob.promptTemplateId / promptTemplateVersion`；
- `ContentProductionBatch.recipeId / recipeVersion`（+ `resolveProductionRecipe()`）。

代码里还有主动的"名字翻译"（如 `generation-metrics.ts`：`const recipeId = row.promptTemplateId`），是持续的困惑源。上一期 UI 已统一显示为「配方 / Prompt Recipes」。本项把**整条链统一到 `recipe`**，与 UI 端到端一致。

grep 确认：**chat 服务零引用**（跨服务安全），无 `prisma/migrations` 目录（main 用 `db push` + 手写边界 SQL）。

## 2. 目标：全改成 `recipe`（重命名映射）

| 现在 | 改成 | 层 |
|---|---|---|
| model `GenerationPromptTemplate` | `GenerationRecipe` | Prisma model |
| table `generation_prompt_templates` | `generation_recipes` | DB（`@@map`）|
| col `templateKey` | `recipeKey` | DB 列 |
| `GenerationJob.promptTemplateId / promptTemplateVersion` | `recipeId / recipeVersion` | DB 列（`generation_jobs`）|
| `ContentProductionBatch.recipeId / recipeVersion` | **已是 recipe，不动** | — |
| `prisma.generationPromptTemplate`（27 处 accessor） | `prisma.generationRecipe` | 代码 |
| `@@index([templateKey, status])` / `@@index([promptTemplateId, promptTemplateVersion])` | 对应 recipe 字段 | schema index |
| UI `PromptTemplateDraftForm` / `TemplateDraft` / `defaultTemplateDraft` / `createPromptTemplate` / `templateTableActions` / `ConfigData.templates` / `configBusy:"template"` | `RecipeDraftForm` / `RecipeDraft` / `defaultRecipeDraft` / `createRecipe` / `recipeTableActions` / `ConfigData.recipes` / `configBusy:"recipe"` | `components/admin` |
| admin API 路由 `/generation/prompt-templates` | `/generation/recipes` | route dir + 所有 `apiGet(...)` 调用端 |

**触点：约 13 个文件** — `schema.prisma`、`seed.ts`、server（`content-ops.ts`、`generation-metrics.ts`、`admin/service.ts`、`ourdream/service.ts`、`probe-product-config.ts`、`test/helpers.ts`、`admin-console.test.ts`）、admin UI（`AdminConsoleClient.tsx`、`ContentOpsViews.tsx`、`CharacterPregenPanel.tsx`、`i18n.tsx`）、API route。

## 3. 明确不动（scope 边界）
- **key 的字符串值不改**（见决策 b）。列 `templateKey` 改名为 `recipeKey`，但其中存的值（`template_*`）照旧——避免破坏 job 里按字符串的引用（`resolveProductionRecipe` 支持 `OR:[{id},{recipeKey}]`）。
- **UI 显示文案不改**（上一期已是「配方 / Prompt Recipes / 提示词配方」，本项只统一代码标识符去匹配它）。
- **chat 服务不动**（零引用）。
- §9 其它三项（`MediaAsset.characterId`、negative prompt 三源、`CharacterTemplate↔官方角色`）**不碰**。

## 4. 迁移机制（关键，防丢数据）

**绝不 `prisma db push`** —— 它对 rename 会 DROP 旧列 + CREATE 新列 = **丢数据**。迁移一律走**手写 `ALTER TABLE … RENAME`**（元数据操作，保留全部数据），由**用户在 dev/prod 各执行一次**。

产出文件：`db/sql/2026-07-08-recipe-rename.sql`，核心语句：

```sql
BEGIN;
-- 实体：表 + 业务键列（值不变，仅列名）
ALTER TABLE "generation_prompt_templates" RENAME TO "generation_recipes";
ALTER TABLE "generation_recipes" RENAME COLUMN "templateKey" TO "recipeKey";
-- GenerationJob 引用列
ALTER TABLE "generation_jobs" RENAME COLUMN "promptTemplateId" TO "recipeId";
ALTER TABLE "generation_jobs" RENAME COLUMN "promptTemplateVersion" TO "recipeVersion";
-- ContentProductionBatch 已是 recipeId/recipeVersion，无需改
COMMIT;
```

- **索引名对齐**：RENAME 后旧索引仍可用，但索引**名字**还带旧前缀（如 `generation_prompt_templates_templateKey_status_idx`）。为让将来 `db push`/introspection 不误判，SQL 里追加 `ALTER INDEX … RENAME TO …` 对齐 Prisma 默认命名（`generation_recipes_recipeKey_status_idx`、`generation_jobs_recipeId_recipeVersion_idx`）。**实现阶段需先 `\d` 查实际索引名**再定稿 SQL（名字由历史 `db push` 生成，以实际为准）。
- **顺序**：DEV → 你先跑 SQL、再切新代码（新代码查 `recipeId`，此时列已改好）；PROD → 部署前先跑 SQL，再上新代码。
- **测试 DB 你无需手动**：vitest `global-setup` 每次从 `schema.prisma` **全新建 public schema**（直接就是 recipe 列名），因此测试自动验证"代码 ↔ schema 一致"，不依赖任何手工 SQL。

## 5. 验证 / 验收
- [ ] `schema.prisma` 里再无 `GenerationPromptTemplate` / `promptTemplateId` / `templateKey`；`prisma generate` 后 client 全 recipe 名。
- [ ] `git grep -nE "promptTemplateId|promptTemplateVersion|generationPromptTemplate|PromptTemplateDraftForm|prompt-templates"` 在 `packages/main/src` 命中为 0（UI 显示文案除外，那些本就是「配方」）。
- [ ] `bun run typecheck` + `bun run lint` 通过（TS strict + Prisma 生成类型兜底改名）。
- [ ] `admin-console.test.ts`（已覆盖 production / recipe / metrics / pregen 路径）改完全绿；vitest 从新 schema 建库跑通。
- [ ] admin API：旧 `/generation/prompt-templates` 已改为 `/generation/recipes`，前端调用端同步；相关 e2e/集成断言更新。
- [ ] 交付 `db/sql/2026-07-08-recipe-rename.sql`（含索引名对齐），文档写清 DEV/PROD 执行顺序。

## 6. 风险 / 回滚
- **数据风险低**：RENAME 是元数据操作，数据不动；反向 `ALTER … RENAME` 即回滚。
- **主要风险 = 漏改引用** → typecheck + 现有集成测试兜底；API 路由 URL 是字符串（typecheck 不兜），靠命中该端点的测试覆盖。
- **部署窗口**：代码与 DB 列名必须一致——严格"SQL 先行、代码后动"。非零停机滚动部署下需先加兼容层；本项目 dev 阶段"跑 SQL→重启"即可，无需兼容层。

## 7. 后续（本次不做）
- §9 其它三项各自单独立项：`MediaAsset.characterId` 权威收敛、negative prompt 三源归一、`CharacterTemplate↔官方角色` 合并（后者是产品决策）。
- 可选：把 key 的字符串**值**也 recipe 化（`template_* → recipe_*`）——需数据迁移 + 更新所有按字符串的引用，单独评估。
