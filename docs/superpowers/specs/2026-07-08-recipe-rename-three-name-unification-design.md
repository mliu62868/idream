# 数据模型精简 ②：三名归一 → `recipe`（端到端）

- 日期：2026-07-08
- 范围：`GenerationPromptTemplate` 这一个概念的**命名统一**（schema + 代码 + UI + admin API 路由），端到端叫 `recipe`
- 关联：`docs/product/...` §9 延后项之一；承接上一期后台 IA 重构（UI 已落地「提示词配方 / Prompt Recipes」）
- 状态：设计已确认，待写实现计划

## 已确认的决策（2026-07-08）
- **(a) API 路由一起改**：`/api/v1/admin/generation/prompt-templates` → `/generation/recipes`（端到端一致）。
- **(b) key 的字符串值保持不动**：只改列名 `templateKey → recipeKey`，`"template_image_character_default"` 等**值原样保留**（值是数据、被 job 按字符串引用；改值=数据迁移+破坏引用，风险不成比例）。
- **(c) 迁移由本代理执行（用户指令覆盖默认规则）**：本代理在**本地 dev 库**（`idream` @ localhost:5433，public schema）执行 `ALTER … RENAME` **并协调本地 pm2 切换**（见 §4）。**prod 生产库不碰**——代理无 prod 凭据；prod 那条 SQL 产出成文件（`db/sql/2026-07-08-recipe-rename.sql`）供用户部署时执行。

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

## 4. 迁移机制（关键，防丢数据 + 不打断本地服务）

**绝不 `prisma db push`** —— 它对 rename 会 DROP 旧列 + CREATE 新列 = **丢数据**（dev 库现有 4 条 recipe + 43 条 job 引用会没）。迁移一律走**手写 `ALTER TABLE … RENAME`**（元数据操作，保留全部数据）。

**最终 SQL**（索引名已按 dev 库实测确认，schema 限定 `public`，避免误伤并存的 `codex_admin_console_*` 残留 schema）：

```sql
-- db/sql/2026-07-08-recipe-rename.sql  —— 只跑一次。dev 由代理执行；prod 由用户部署时执行。
BEGIN;
ALTER TABLE public.generation_prompt_templates RENAME TO generation_recipes;
ALTER TABLE public.generation_recipes RENAME COLUMN "templateKey" TO "recipeKey";
-- 索引名是 camelCase、Prisma 建时加了引号 → 这里必须双引号；不加引号 Postgres 会折叠成小写而报 "does not exist"
ALTER INDEX public."generation_prompt_templates_templateKey_status_idx"
  RENAME TO "generation_recipes_recipeKey_status_idx";
ALTER TABLE public.generation_jobs RENAME COLUMN "promptTemplateId" TO "recipeId";
ALTER TABLE public.generation_jobs RENAME COLUMN "promptTemplateVersion" TO "recipeVersion";
ALTER INDEX public."generation_jobs_promptTemplateId_promptTemplateVersion_idx"
  RENAME TO "generation_jobs_recipeId_recipeVersion_idx";
-- ContentProductionBatch 已是 recipeId/recipeVersion，无需改
COMMIT;
```

> 迁移执行记录（dev，2026-07-08）：首跑因索引名未加引号失败并**整事务回滚**（零数据损失），加引号后重跑成功；`generation_recipes` + `recipeKey` + 对齐索引就位，4 条 recipe / 43 条 job 引用无损；build→SQL→`pm2 restart main-web/admin-web/gen-finalizer/main-event-consumer` 完成，全栈 online、无列错误。**PROD 用户执行时请直接用本（已加引号）版本。**

**本地 dev 切换顺序（代理执行，防止运行中的 pm2 旧代码打在改名后的库上报错）**——本机 pm2 全栈在线（main-web/admin-web/gen-image/gen-finalizer/main-event-consumer 都连 dev 库）：
1. 代码 + schema 改完，先 `bun run build`（含 `prisma generate`；只产出 `.next`/新 client，不影响运行中的进程）。
2. 紧接着 **跑上面的 SQL**（psql 连 dev 库 public）。
3. **立即 `pm2 restart`** 受影响进程（main-web / admin-web / gen-image / gen-finalizer / main-event-consumer；chat 是独立库，不受影响），让它们加载新构建 + 新 client，与改名后的库一致。
4. 健康检查（pm2 online、`/health`、开一遍 admin 生成/配方页无报错）。
- SQL→restart 之间有几秒窗口，dev 无真实流量 → 实际零影响；build 在前保证 restart 能秒起新码。
- **PROD**：同一条 SQL 交付成文件；用户部署时"先跑 SQL、再上新码"（非零停机需加兼容层，本项目按 dev 阶段处理）。

**测试 DB 全自动**：vitest `global-setup` 每次从 `schema.prisma` **全新建 public schema**（直接就是 recipe 列名），所以代码 + 测试的正确性验证**不依赖也不触碰 dev 库**——先在测试库把代码跑绿，再对 dev 库做上面的切换。

## 5. 验证 / 验收
- [ ] `schema.prisma` 里再无 `GenerationPromptTemplate` / `promptTemplateId` / `templateKey`；`prisma generate` 后 client 全 recipe 名。
- [ ] `git grep -nE "promptTemplateId|promptTemplateVersion|generationPromptTemplate|PromptTemplateDraftForm|prompt-templates"` 在 `packages/main/src` 命中为 0（UI 显示文案除外，那些本就是「配方」）。
- [ ] `bun run typecheck` + `bun run lint` 通过（TS strict + Prisma 生成类型兜底改名）。
- [ ] `admin-console.test.ts`（已覆盖 production / recipe / metrics / pregen 路径）改完全绿；vitest 从新 schema 建库跑通。
- [ ] admin API：旧 `/generation/prompt-templates` 已改为 `/generation/recipes`，前端调用端同步；相关 e2e/集成断言更新。
- [ ] 交付 `db/sql/2026-07-08-recipe-rename.sql`（含索引名对齐），文档写清 DEV=代理执行 / PROD=用户部署执行。
- [ ] **dev 切换完成（代理）**：dev 库已跑 RENAME —— `to_regclass('public.generation_recipes')` 非空、`generation_prompt_templates` 为空；4 条 recipe / 43 条 job 引用**数据无损**；`bun run build` 已出新码，`pm2 restart` 后受影响进程全 **online**、admin 配方/生成页 + 生成链路可用无报错。

## 6. 风险 / 回滚
- **数据风险低**：RENAME 是元数据操作，数据不动；反向 `ALTER … RENAME` 即回滚。
- **主要风险 = 漏改引用** → typecheck + 现有集成测试兜底；API 路由 URL 是字符串（typecheck 不兜），靠命中该端点的测试覆盖。
- **一致性窗口**：代码与 DB 列名必须一致。dev 由代理按 §4 顺序 build→SQL→`pm2 restart` 一气呵成（几秒窗口、dev 无流量）；prod 由用户"先 SQL 后上码"。非零停机滚动部署才需兼容层，本项目 dev 阶段不需。
- **代理不碰 prod**：仅操作本地 dev 库与本地 pm2；prod SQL 交付成文件。

## 7. 后续（本次不做）
- §9 其它三项各自单独立项：`MediaAsset.characterId` 权威收敛、negative prompt 三源归一、`CharacterTemplate↔官方角色` 合并（后者是产品决策）。
- 可选：把 key 的字符串**值**也 recipe 化（`template_* → recipe_*`）——需数据迁移 + 更新所有按字符串的引用，单独评估。
