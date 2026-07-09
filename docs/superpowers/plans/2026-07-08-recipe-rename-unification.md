# Recipe Rename (three-name unification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement Task 1; Task 2 (dev cutover) is executed by the orchestrator directly. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Unify the `GenerationPromptTemplate` concept to a single name `recipe` end-to-end (schema + code + UI + admin API route), matching the shipped UI vocabulary「配方 / Prompt Recipes」.

**Architecture:** Renaming the Prisma model breaks typecheck across every typed reference at once, so the code rename is one atomic task validated against the fresh vitest test DB (which is rebuilt from `schema.prisma` each run, so it gets the new names automatically). The persistent dev DB (`idream` @ localhost:5433, real data) is migrated separately via a hand-written `ALTER … RENAME` cutover coordinated with a pm2 restart, because a live pm2 stack runs old code against it.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, Prisma 7 (Postgres), bun + turbo, vitest (node env, Postgres global-setup), pm2.

## Global Constraints

- **End-to-end name = `recipe`.** After this work no code identifier says `promptTemplate` / `templateKey` / `GenerationPromptTemplate` / `prompt-templates`.
- **Key string VALUES are unchanged** (spec §3b): rename the column `templateKey → recipeKey`, but the stored values (`"template_image_character_default"` etc.) stay — they are data referenced by string.
- **Never `prisma db push` for this** (it DROP+CREATEs a rename = data loss). Dev DB migration is the hand-written `ALTER … RENAME` in `db/sql/2026-07-08-recipe-rename.sql` ONLY.
- **Migration is metadata-only, `public` schema, data-preserving.** Dev DB has 4 recipe rows + 43 job refs that must survive.
- **Agent migrates DEV only** (per user override); PROD is a delivered SQL file. Agent does not touch prod.
- TypeScript strict, no `any`. Named exports. 2-space indent.
- **`ContentProductionBatch.recipeId / recipeVersion` already say recipe — do NOT touch them.**

## Canonical rename map

| Layer | From | To |
|---|---|---|
| Prisma model | `GenerationPromptTemplate` | `GenerationRecipe` |
| Prisma accessor | `prisma.generationPromptTemplate` (27 sites) | `prisma.generationRecipe` |
| Table (`@@map`) | `generation_prompt_templates` | `generation_recipes` |
| Business key col | `templateKey` | `recipeKey` |
| Job cols | `GenerationJob.promptTemplateId` / `promptTemplateVersion` | `recipeId` / `recipeVersion` |
| Job index | `@@index([promptTemplateId, promptTemplateVersion])` | `@@index([recipeId, recipeVersion])` |
| Recipe index | `@@index([templateKey, status])` | `@@index([recipeKey, status])` |
| UI type/form/handler | `TemplateDraft` / `defaultTemplateDraft` / `PromptTemplateDraftForm` / `createPromptTemplate` / `templateTableActions` / `configBusy:"template"` / `ConfigData.templates` | `RecipeDraft` / `defaultRecipeDraft` / `RecipeDraftForm` / `createRecipe` / `recipeTableActions` / `configBusy:"recipe"` / `ConfigData.recipes` |
| Untyped Row reads (UI) | `row.templateKey`, `row.promptTemplateId`, DataTable `columns:["…","templateKey",…]` | `recipeKey` / `recipeId` |
| Admin API route | `app/api/v1/admin/generation/prompt-templates/` + `apiGet("/api/v1/admin/generation/prompt-templates")` | `…/generation/recipes/` + `/generation/recipes` |
| UI display copy (i18n) | residual `"Prompt Template"` / `"提示词模板"` strings for THIS entity | `"Prompt Recipe"` / `"提示词配方"` (end-to-end per 完整实施) |

**Do NOT touch:** `ContentProductionBatch.recipeId/recipeVersion`; `resolveProductionRecipe` NAME (already recipe — only its internal `prisma.generationPromptTemplate` accessor changes); chat service (zero refs).

**Files in scope (13):** `packages/main/prisma/schema.prisma`, `packages/main/prisma/seed.ts`; server `src/server/modules/admin/content-ops.ts`, `…/admin/generation-metrics.ts`, `…/admin/service.ts`, `…/ourdream/service.ts`, `src/server/probe-product-config.ts`, `src/server/test/helpers.ts`, `src/server/modules/ourdream/admin-console.test.ts`; UI `src/components/admin/AdminConsoleClient.tsx`, `…/ContentOpsViews.tsx`, `…/CharacterPregenPanel.tsx`, `…/i18n.tsx`; plus the admin API route dir `src/app/api/v1/admin/generation/prompt-templates/**` (rename to `recipes`). New file: `db/sql/2026-07-08-recipe-rename.sql`.

---

## Task 1: Rename the concept to `recipe` (code + schema + SQL file)

One atomic mechanical rename. Validated entirely against the fresh test DB — **does not touch the dev DB**.

**Files:** all 13 above + create `db/sql/2026-07-08-recipe-rename.sql`.

**Interfaces produced:** Prisma model `GenerationRecipe` (fields incl. `recipeKey`); `GenerationJob.recipeId/recipeVersion`; admin route `GET/POST /api/v1/admin/generation/recipes`; UI `RecipeDraft`, `RecipeDraftForm`, `createRecipe`.

- [ ] **Step 1: Rename in `schema.prisma`** — apply exactly:
  - `model GenerationPromptTemplate {` → `model GenerationRecipe {`
  - inside it: `templateKey   String` → `recipeKey   String`; `@@index([templateKey, status])` → `@@index([recipeKey, status])`; `@@map("generation_prompt_templates")` → `@@map("generation_recipes")`
  - in `model GenerationJob`: `promptTemplateId      String?` → `recipeId      String?`; `promptTemplateVersion Int?` → `recipeVersion Int?`; `@@index([promptTemplateId, promptTemplateVersion])` → `@@index([recipeId, recipeVersion])`
  - Confirm there is **no `@relation`** between GenerationJob and the recipe model (they are loose String refs — nothing else to change). Leave `ContentProductionBatch.recipeId/recipeVersion` untouched.

- [ ] **Step 2: Regenerate the client** — `cd packages/main && bun run db:generate` (= `prisma generate`). Expected: success, client now exposes `prisma.generationRecipe`, `recipeKey`, `job.recipeId`.

- [ ] **Step 3: Rename all typed-Prisma code** (server + seed + tests). In every scope file replace: `prisma.generationPromptTemplate` → `prisma.generationRecipe`; `.promptTemplateId` → `.recipeId`; `.promptTemplateVersion` → `.recipeVersion`; `templateKey` → `recipeKey` (field access + object keys, NOT the string VALUES); in `content-ops.ts` the batch build `recipeId: recipe.templateKey` → `recipeId: recipe.recipeKey`; keep `resolveProductionRecipe` name, fix its internal accessor + `OR: [{ id }, { templateKey }]` → `{ recipeKey }`. In `seed.ts` keep the `recipeKey:` VALUES as-is (`"template_image_character_default"`, …). Let `tsc` drive completeness.

- [ ] **Step 4: Rename the admin API route** — `git mv packages/main/src/app/api/v1/admin/generation/prompt-templates packages/main/src/app/api/v1/admin/generation/recipes`; inside the moved route file(s) fix Prisma access to `prisma.generationRecipe`. Update every client caller `apiGet("/api/v1/admin/generation/prompt-templates")` → `"/api/v1/admin/generation/recipes"` (in `AdminConsoleClient.tsx` `fetchGenerationConfig` and anywhere else) and any test that hits the path (`admin-console.test.ts`).

- [ ] **Step 5: Rename UI identifiers + untyped reads** — in `AdminConsoleClient.tsx`, `ContentOpsViews.tsx`, `CharacterPregenPanel.tsx`: `TemplateDraft`→`RecipeDraft`, `defaultTemplateDraft`→`defaultRecipeDraft`, `PromptTemplateDraftForm`→`RecipeDraftForm`, `createPromptTemplate`→`createRecipe`, `templateTableActions`→`recipeTableActions`, `configBusy: "template"`→`"recipe"`, `ConfigData.templates`→`ConfigData.recipes` (and its consumers, incl. `ConfigOverviewHeader` prop and the `PromptRecipesView`/`GenerationPresetsView` from last phase), untyped reads `row.templateKey`→`row.recipeKey`, `row.promptTemplateId`→`row.recipeId`, and DataTable `columns` arrays `"templateKey"`→`"recipeKey"`. Note `ContentOpsViews` already uses `recipeId`; only its `activeRecipes[0]?.templateKey` → `?.recipeKey`.

- [ ] **Step 6: Align residual UI display copy** (end-to-end per 完整实施) — in `i18n.tsx` update this entity's remaining display strings so nothing user-facing says "template" for it: e.g. key `"Create Prompt Template Draft"`→`"Create Prompt Recipe Draft"` (zh `"创建提示词配方草稿"`), `"Prompt Templates"`→`"Prompt Recipes"` (zh `"提示词配方"`), `"Prompt drafts"`→`"Recipe drafts"` (zh `"配方草稿"`) — and the matching `t("…")` call sites. Leave unrelated "template" strings (e.g. character-starter templates, model-profile scaffolds) untouched.

- [ ] **Step 7: Create `db/sql/2026-07-08-recipe-rename.sql`** with exactly (index names verified against dev DB):

```sql
-- Recipe rename (three-name unification). Metadata-only RENAMEs; data preserved. Run ONCE.
-- DEV: run by agent. PROD: run at deploy, BEFORE activating the new code.
BEGIN;
ALTER TABLE public.generation_prompt_templates RENAME TO generation_recipes;
ALTER TABLE public.generation_recipes RENAME COLUMN "templateKey" TO "recipeKey";
ALTER INDEX public.generation_prompt_templates_templateKey_status_idx
  RENAME TO generation_recipes_recipeKey_status_idx;
ALTER TABLE public.generation_jobs RENAME COLUMN "promptTemplateId" TO "recipeId";
ALTER TABLE public.generation_jobs RENAME COLUMN "promptTemplateVersion" TO "recipeVersion";
ALTER INDEX public.generation_jobs_promptTemplateId_promptTemplateVersion_idx
  RENAME TO generation_jobs_recipeId_recipeVersion_idx;
COMMIT;
```

- [ ] **Step 8: Verify (gates) — against the fresh test DB, NOT dev**
  - `cd packages/main && bun run typecheck` → clean (catches every typed rename miss).
  - `cd packages/main && bun run lint` → clean.
  - `cd packages/main && bunx vitest run src/server/modules/ourdream/admin-console.test.ts src/server/modules/admin` → the admin/production/recipe/metrics/pregen suites pass against the schema-fresh test DB (proves the renamed code + fresh recipe-named schema are consistent).
  - Residual-identifier grep must be empty (display copy in i18n allowed only where intentionally left):
    `cd packages/main && grep -rnE "generationPromptTemplate|promptTemplateId|promptTemplateVersion|GenerationPromptTemplate|generation_prompt_templates|prompt-templates|PromptTemplateDraftForm|templateTableActions|createPromptTemplate" src | grep -v "i18n.tsx"` → no output.
    `grep -rn "templateKey" src` → no output (all → recipeKey).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(gen): unify GenerationPromptTemplate → recipe end-to-end (schema+code+UI+API); dev migration SQL"
```

---

## Task 2: Dev cutover — migrate the dev DB and restart the stack (ORCHESTRATOR)

Executed by the orchestrator directly (touches the shared running environment; needs health judgment). Prereq: Task 1 committed and green.

- [ ] **Step 1: Pre-flight snapshot** — record current dev state:
  `DBURL=$(grep '^DATABASE_URL=' packages/main/.env | cut -d= -f2- | tr -d '"'); psql "$DBURL" -Atc "SELECT to_regclass('public.generation_prompt_templates'), (SELECT count(*) FROM generation_prompt_templates), (SELECT count(*) FROM generation_jobs WHERE \"promptTemplateId\" IS NOT NULL);"` → expect `generation_prompt_templates | 4 | 43`. Also `pm2 jlist` — confirm main-web/admin-web/gen-image/gen-finalizer/main-event-consumer online.

- [ ] **Step 2: Build new code (no live impact)** — `cd packages/main && bun run build`. Expected: success (includes `db:generate` + `next build` + standalone prepare). Running pm2 processes keep serving old code from memory; `.next` output is staged for restart.

- [ ] **Step 3: Run the migration on the dev DB** — `psql "$DBURL" -v ON_ERROR_STOP=1 -f db/sql/2026-07-08-recipe-rename.sql`. Expect `COMMIT`. Then verify rename + data survival:
  `psql "$DBURL" -Atc "SELECT to_regclass('public.generation_recipes'), to_regclass('public.generation_prompt_templates'), (SELECT count(*) FROM generation_recipes), (SELECT count(*) FROM generation_jobs WHERE \"recipeId\" IS NOT NULL);"` → expect `generation_recipes | (null) | 4 | 43`.

- [ ] **Step 4: Restart the affected stack onto new code** — `pm2 restart main-web admin-web gen-image gen-finalizer main-event-consumer` (chat is a separate DB — leave it). Wait for online.

- [ ] **Step 5: Health check** — `pm2 jlist` all target procs `online` with fresh uptime, 0 crash-restarts. Probe the app: `curl -fsS localhost:3000/... ` health if available; and exercise the renamed surface — open admin `/admin/generation/recipes` (recipe list loads), `/admin/generation/config` (Model Profiles), and confirm no errors in `pm2 logs main-web --lines 40 --nostream` referencing `recipeId`/`generation_recipes`. If any proc crash-loops on a missing column, STOP and report (do not mask).

- [ ] **Step 6: Report** — summarize dev migration result, data counts preserved, pm2 health, and remind: `db/sql/2026-07-08-recipe-rename.sql` must be run on PROD (by the user) before the new code goes live there.

---

## Self-Review

**Spec coverage:** §2 rename map → Task 1 Steps 1-6 (+ canonical map). §3 scope (values unchanged, ContentProductionBatch/chat untouched) → Global Constraints + Step 3/7 notes. §4 migration (never db push, exact SQL, pm2 cutover) → Task 1 Step 7 + Task 2. §5 acceptance → Task 1 Step 8 + Task 2 Steps 3/5. §6 risk (consistency window) → Task 2 build-before-SQL-before-restart ordering.

**Placeholder scan:** none — schema diff is exact, SQL is final (real index names), verification commands are concrete.

**Type consistency:** `GenerationRecipe`, `recipeKey`, `recipeId`/`recipeVersion`, `RecipeDraft`/`RecipeDraftForm`/`createRecipe`/`recipeTableActions`/`ConfigData.recipes` used consistently across Steps 1-6 and the rename map. Route `/generation/recipes` consistent between Step 4 and callers.
