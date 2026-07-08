# P3: 角色预生图面板 + Metric 回路 + Batch 成本接 PricingRule — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 运营在 Official Characters 详情页一键为角色出「封面 / 主图 / Chat 包」预生图 Batch 并投放；生成成本从 0 stub 改为走 PricingRule；新增按 profile/recipe/workflow/来源/投放位 的 Metric 聚合端点 + 运营视图。

**Architecture:** 全部复用现有 ContentProductionBatch → GenerationJob → MediaAsset → MediaAssetPlacement 链路，**零 DDL**（不改 schema、不出 SQL）。预生图 = 带 pack 预设的 batch 创建包装端点 + 角色详情页面板；Metric = 按需 SQL/Prisma 聚合（GenerationJob 已有 profileId/promptTemplateId/sourceType 索引 + costDreamcoins + completedAt），不建 rollup 表——当前规模按需聚合即可，物化是将来性能问题出现后的优化。

**Tech Stack:** Next 16 App Router (dispatchAdmin segment router), Prisma 7 + Postgres, zod, vitest（真 PG 测试库 5433/idream_test，global-setup db-push）, shadcn 风格 admin 组件（selfFetch 模式）。

## Global Constraints

- TypeScript strict, no `any`；named exports；2-space；Tailwind utility classes。
- Admin API 一律 `actorWithPermission` + `ok()`/`Errors` envelope + 写操作 `writeAudit`（模仿 `content-ops.ts` 现有函数）。
- **零 schema 变更**：本阶段禁止改 `schema.prisma`、禁止新增 `db/sql/`。
- 测试数据一律 `P` 前缀（`admin-console.test.ts` 顶部的前缀常量），断言写成对并行测试免疫的不变式（勿断言全局聚合的精确值，只断言自己 P 前缀实体的行）。
- 提交信息 conventional commits；分支 `feat/image-gen-p3-pregen-metrics`（从 master 切出）。
- 每个 task 结束跑：`cd /Users/kk/code/idream && bun run typecheck`（如涉 UI 再加 `bun run lint`）；涉后端逻辑跑 `cd packages/main && bunx vitest run src/server/modules/ourdream/admin-console.test.ts`（需测试库 5433 在跑；global-setup 自动 db-push）。

## 关键代码锚点（实现者必读）

| 锚点 | 位置 |
|------|------|
| Batch 创建（成本 0 stub） | `packages/main/src/server/modules/admin/content-ops.ts:183-320`（`createProductionBatch`；`estimatedCostDreamcoins: 0` 在 :242，job `costDreamcoins: 0` 在 :274） |
| item 重生成（同样 0 stub） | `content-ops.ts:460` 附近 `regenerateProductionItem` |
| 用户侧计价（要抽取的实现） | `packages/main/src/server/modules/ourdream/service.ts:5820` `generationCost(mode, outputCount, multiplier)` |
| profile/recipe 解析 | `content-ops.ts:889` `resolveProductionProfile`（profileId 必填）、`:904` `resolveProductionRecipe`（recipeId 可选，按 useCase 兜底） |
| 投放发布→角色头像/主图直写 | `content-ops.ts:1200` `syncPlacementTarget`（character_avatar/hero → `Character.imageAssetId`） |
| admin segment 路由注册 | `packages/main/src/server/modules/admin/service.ts:594-609`（content/characters 子资源；`visual-profiles` 是现成样板）；generation/* 注册模式参考 P2 的 backends/workflows |
| 面板 UI 挂载点 | `packages/main/src/components/admin/OfficialCharactersView.tsx:482`（`<VisualPassportPanel characterId={editingId} />` 之后） |
| UI selfFetch 样板 | `packages/main/src/components/admin/VisualPassportPanel.tsx`（P2 出品，复制其 fetch/error/loading 模式） |
| 集成测试样板 | `packages/main/src/server/modules/ourdream/admin-console.test.ts:1386-1500`（production batch 全链测试：`setupActor`/`createCharacter`/profile+recipe seed/`api()` dev-auth/`runQueuedGenerationJobs(12)` mock 排水） |
| 权限字符串 | 读=`content.asset.read`，建 batch=`content.production.write`，审=`content.asset.review`，投放=`content.placement.write`，generation 配置读=`generation.config.read`（generation-catalog.ts:19） |
| GenerationJob 可聚合字段 | `schema.prisma`：profileId/profileVersion、promptTemplateId、sourceType、status、costDreamcoins、createdAt/completedAt，均有对应索引 |

---

### Task 1: 抽取共享计价 helper，Batch/Job 成本接 PricingRule

**Files:**
- Create: `packages/main/src/server/lib/generation-pricing.ts`
- Modify: `packages/main/src/server/modules/ourdream/service.ts:5820-5827`（`generationCost` 改薄壳）
- Modify: `packages/main/src/server/modules/admin/content-ops.ts`（`createProductionBatch` :226-304、`regenerateProductionItem` :460 附近）
- Test: `packages/main/src/server/modules/ourdream/admin-console.test.ts:1386`（更新既有断言 + 补成本断言）

**Interfaces:**
- Produces: `generationCostDreamcoins(mode: "image" | "video", outputCount: number, multiplier?: number): Promise<number>` — 后续 task（pregen 端点）复用。

- [ ] **Step 1: 更新既有测试为失败态（RED）**

在 `admin-console.test.ts` 的 `"runs content production batches through asset review and placement history"` 测试里，profile/recipe seed 之后加 PricingRule seed，并把成本断言从 0 改为不变式：

```ts
// seed（放在 generationPromptTemplate.create 之后）：
await prisma.pricingRule.create({
  data: {
    id: `${P}image-pricing-v1`,
    ruleKey: `${P}image_pricing`,
    label: "Image pricing",
    mode: "image",
    baseCost: 7,
    multiplier: 1,
    status: "active",
    version: 1,
    effectiveFrom: new Date(),
    publishedAt: new Date(),
  },
});
```

断言改为（替换原 `estimatedCostDreamcoins: 0` 与 `costDreamcoins: 0`）：

```ts
expect(created.data.batch).toMatchObject({
  title: `${P}production-batch`,
  totalItems: 2,
  status: "queued",
});
// 成本不变式：每个 job 成本>0 且 batch 估价 = 各 item job 成本之和
// （不断言精确值：并行测试可能创建更新的 active image PricingRule）
expect(jobs[0].costDreamcoins).toBeGreaterThan(0);
expect(jobs[1].costDreamcoins).toBe(jobs[0].costDreamcoins);
expect(created.data.batch.estimatedCostDreamcoins).toBe(
  jobs[0].costDreamcoins + jobs[1].costDreamcoins,
);
```

注意 `jobs[0]` 原有 `toMatchObject` 里的 `costDreamcoins: 0` 也要删掉。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/kk/code/idream/packages/main && bunx vitest run src/server/modules/ourdream/admin-console.test.ts -t "production batches"`
Expected: FAIL —— `costDreamcoins` 仍为 0，`toBeGreaterThan(0)` 不成立。

- [ ] **Step 3: 写共享计价 helper**

创建 `packages/main/src/server/lib/generation-pricing.ts`：

```ts
// SPEC: 生成计价单一实现（SSoT）：取 mode 的最新 active PricingRule
//       （effectiveFrom desc, version desc），cost = ceil(base * outputCount * multiplier)。
// INVARIANTS: 无 active 规则时用内置兜底（image=5 / video=100），与用户侧历史行为一致。
// EXAMPLE: 规则 baseCost=7 时 generationCostDreamcoins("image", 2, 1) → 14
import { prisma } from "@/server/lib/db";

const FALLBACK_BASE_COST: Record<"image" | "video", number> = { image: 5, video: 100 };

export async function generationCostDreamcoins(
  mode: "image" | "video",
  outputCount: number,
  multiplier = 1,
): Promise<number> {
  const pricing = await prisma.pricingRule.findFirst({
    where: { mode, status: "active" },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
  });
  const base = pricing?.baseCost ?? FALLBACK_BASE_COST[mode];
  return Math.ceil(base * outputCount * multiplier);
}
```

- [ ] **Step 4: ourdream/service.ts 的 `generationCost` 改薄壳**

`service.ts:5820` 整个函数体替换为委托（保留函数名，调用点零改动）：

```ts
async function generationCost(mode: "image" | "video", outputCount: number, multiplier = 1) {
  return generationCostDreamcoins(mode, outputCount, multiplier);
}
```

文件顶部 import 区加：`import { generationCostDreamcoins } from "@/server/lib/generation-pricing";`

- [ ] **Step 5: content-ops.ts 接成本**

`createProductionBatch` 在 `prisma.$transaction` 之前（:226 前）算单价：

```ts
const perItemCostDreamcoins = await generationCostDreamcoins(
  "image",
  1,
  profile.costMultiplier ?? 1,
);
```

事务内：batch `estimatedCostDreamcoins: perItemCostDreamcoins * body.count`（替换 :242 的 0）；job `costDreamcoins: perItemCostDreamcoins`（替换 :274 的 0）。

`regenerateProductionItem` 同样处理：解析 profile 后算 `perItemCostDreamcoins`，新 job 用它，且事务内给 batch 追加估价：

```ts
await tx.contentProductionBatch.update({
  where: { id: item.batchId },
  data: { estimatedCostDreamcoins: { increment: perItemCostDreamcoins } },
});
```

（若该函数现有结构里 batch 更新已有别的字段，合并进同一次 update。）文件顶部加同样的 import。注意：**运营 batch 不扣任何钱包**——成本只是记账口径，现状没有扣款逻辑，保持。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd /Users/kk/code/idream/packages/main && bunx vitest run src/server/modules/ourdream/admin-console.test.ts`
Expected: 全部 PASS（含既有 66 用例；若其它用例断言了 `estimatedCostDreamcoins: 0`，用 grep 找齐一并改成不变式断言）。

Run: `cd /Users/kk/code/idream && bun run typecheck`
Expected: 6/6 PASS

- [ ] **Step 7: Commit**

```bash
git add packages/main/src/server/lib/generation-pricing.ts packages/main/src/server/modules/ourdream/service.ts packages/main/src/server/modules/admin/content-ops.ts packages/main/src/server/modules/ourdream/admin-console.test.ts
git commit -m "feat(admin): wire content production batch cost to PricingRule via shared pricing helper"
```

---

### Task 2: 预生图 pack 端点 `content/characters/{id}/pregen`

**Files:**
- Modify: `packages/main/src/server/modules/admin/content-ops.ts`（抽取可复用核心 `createProductionBatchCore`）
- Create: `packages/main/src/server/modules/admin/characters/pregen.ts`
- Modify: `packages/main/src/server/modules/admin/service.ts:594-609`（注册两条路由）
- Test: `packages/main/src/server/modules/ourdream/admin-console.test.ts`（新增 pregen 用例）

**Interfaces:**
- Consumes: Task 1 的 `generationCostDreamcoins`（经由 core 间接消费，pregen 不直接算价）。
- Produces:
  - `createProductionBatchCore(actor: { id: string }, input: ProductionBatchCreateInput): Promise<Response>`（content-ops.ts 导出；`ProductionBatchCreateInput = z.infer<typeof productionBatchCreateSchema>` 一并导出）
  - `createCharacterPregenBatch(request: Request, characterId: string): Promise<Response>`
  - `listCharacterPregenBatches(request: Request, characterId: string): Promise<Response>`
  - API 形状：`POST admin/content/characters/{id}/pregen` body `{ pack: "cover"|"hero"|"chat", profileId?, recipeId?, count?, brief?, reason? }` → 202 `{ batch }`（与 production/batches 同 DTO）；`GET` → 200 `{ items: batchDTO[], placements: {slot,status,mediaAssetId}[] }`

- [ ] **Step 1: 写失败测试（RED）**

`admin-console.test.ts` 新增用例（同 describe 下，模仿 :1386 用例的 seed 方式；profile/recipe seed 用新的 P 前缀 id 避免撞已有用例）：

```ts
it("creates per-character pregen packs and lists them", async () => {
  const admin = await setupActor("admin", "character-pregen");
  const support = await setupActor("support", "character-pregen");
  const character = await createCharacter({
    id: `${P}pregen-character`,
    creatorId: admin,
    name: "Pregen Character",
    visibility: "public",
    status: "approved",
  });
  await prisma.generationModelProfile.create({
    data: {
      id: `${P}pregen-profile-v1`,
      profileKey: `${P}pregen-profile`,
      label: "Pregen profile",
      mode: "image",
      runner: "pipeline",
      pipelineModel: "mock-image",
      allowedOrientations: ["4:5"],
      defaultWidth: 768,
      defaultHeight: 1024,
      version: 1,
      status: "active",
      dryRunSummary: { sampleCount: 1 },
      publishedAt: new Date(),
    },
  });
  await prisma.generationPromptTemplate.create({
    data: {
      id: `${P}pregen-recipe-v1`,
      templateKey: `${P}pregen-recipe`,
      label: "Pregen recipe",
      mode: "image",
      useCase: "character",
      body: "Pregen recipe body.",
      negativeBase: "low quality",
      presetOrder: [],
      safetyHints: {},
      sampleMatrix: [],
      version: 1,
      status: "active",
      dryRunSummary: { sampleCount: 1 },
      publishedAt: new Date(),
    },
  });

  const forbidden = await api("POST", `admin/content/characters/${character.id}/pregen`, {
    userId: support,
    role: "support",
    body: { pack: "cover", profileId: `${P}pregen-profile` },
  });
  expectError(forbidden, 403);

  const badPack = await api("POST", `admin/content/characters/${character.id}/pregen`, {
    userId: admin,
    role: "admin",
    body: { pack: "poster", profileId: `${P}pregen-profile` },
  });
  expectError(badPack, 400);

  const cover = await api("POST", `admin/content/characters/${character.id}/pregen`, {
    userId: admin,
    role: "admin",
    body: { pack: "cover", profileId: `${P}pregen-profile`, reason: "pregen cover pack" },
  });
  expectOk(cover, 202);
  expect(cover.data.batch).toMatchObject({
    purpose: "character_cover",
    targetType: "character",
    targetId: character.id,
    totalItems: 4,
    status: "queued",
  });
  expect(cover.data.batch.estimatedCostDreamcoins).toBeGreaterThan(0);

  const chat = await api("POST", `admin/content/characters/${character.id}/pregen`, {
    userId: admin,
    role: "admin",
    body: { pack: "chat", profileId: `${P}pregen-profile`, count: 2, reason: "pregen chat pack" },
  });
  expectOk(chat, 202);
  expect(chat.data.batch).toMatchObject({ purpose: "character_chat", totalItems: 2 });

  const listed = await api("GET", `admin/content/characters/${character.id}/pregen`, {
    userId: admin,
    role: "admin",
  });
  expectOk(listed);
  const batchIds = listed.data.items.map((batch: { id: string }) => batch.id);
  expect(batchIds).toContain(cover.data.batch.id);
  expect(batchIds).toContain(chat.data.batch.id);

  const missing = await api("POST", `admin/content/characters/${P}nope/pregen`, {
    userId: admin,
    role: "admin",
    body: { pack: "cover", profileId: `${P}pregen-profile` },
  });
  expectError(missing, 400);
});
```

（`createCharacter`、`setupActor`、`api`、`expectOk`、`expectError` 均为该文件既有 helper，签名以文件内实际为准。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/kk/code/idream/packages/main && bunx vitest run src/server/modules/ourdream/admin-console.test.ts -t "pregen"`
Expected: FAIL —— 路由不存在（404）。

- [ ] **Step 3: 从 createProductionBatch 抽取 core**

`content-ops.ts`：把 `createProductionBatch` 的函数体（:186 起，`actorWithPermission`+`jsonBody` 解析之后的全部逻辑，含事务、入队、audit、返回 202）搬进新导出函数：

```ts
export type ProductionBatchCreateInput = z.infer<typeof productionBatchCreateSchema>;

export async function createProductionBatchCore(
  actor: { id: string },
  body: ProductionBatchCreateInput,
): Promise<Response> {
  // …原 createProductionBatch 中 body 解析之后的全部逻辑，原样搬入…
}

export async function createProductionBatch(request: Request) {
  const actor = await actorWithPermission(request, "content.production.write");
  const body = productionBatchCreateSchema.parse(await jsonBody(request));
  return createProductionBatchCore(actor, body);
}
```

纯搬移不改逻辑（audit 里若用了 request 相关字段，把所需值作为参数传入或保留在 wrapper 中——以现有代码为准，保证行为等价）。

- [ ] **Step 4: 写 pregen 模块**

创建 `packages/main/src/server/modules/admin/characters/pregen.ts`：

```ts
// SPEC: per-character 预生图 pack：cover(封面×4→character_cover)、hero(主图×4→character_hero)、
//       chat(聊天包×8→character_chat)。POST 包一层默认值后委托 createProductionBatchCore；
//       GET 列该角色全部 production batch + 现有 character_avatar/hero 投放。
// INVARIANTS: 不新增任何生成链路——一切走既有 Batch→Job→Asset→Placement。
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, jsonBody } from "@/server/modules/admin/service";
import {
  createProductionBatchCore,
  type ProductionBatchCreateInput,
} from "@/server/modules/admin/content-ops";

const PREGEN_PACKS = {
  cover: { purpose: "character_cover", count: 4 },
  hero: { purpose: "character_hero", count: 4 },
  chat: { purpose: "character_chat", count: 8 },
} as const;

const pregenCreateSchema = z.object({
  pack: z.enum(["cover", "hero", "chat"]),
  profileId: z.string().trim().min(1).max(180).optional(),
  recipeId: z.string().trim().min(1).max(180).optional(),
  count: z.number().int().min(1).max(24).optional(),
  brief: z.string().trim().max(2_000).optional(),
  reason: z.string().trim().max(2_000).optional(),
});

async function requireOfficialCharacter(characterId: string) {
  const character = await prisma.character.findFirst({
    where: { id: characterId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!character) throw Errors.badRequest("Pregen target character not found");
  return character;
}

async function resolveDefaultProfileKey() {
  const profile = await prisma.generationModelProfile.findFirst({
    where: { mode: "image", status: "active", enabled: true },
    orderBy: [{ costMultiplier: "asc" }, { version: "desc" }],
  });
  if (!profile) throw Errors.badRequest("Pregen requires an active image profile");
  return profile.profileKey;
}

export async function createCharacterPregenBatch(request: Request, characterId: string) {
  const actor = await actorWithPermission(request, "content.production.write");
  const body = pregenCreateSchema.parse(await jsonBody(request));
  const character = await requireOfficialCharacter(characterId);
  const pack = PREGEN_PACKS[body.pack];
  const input: ProductionBatchCreateInput = {
    title: `${character.name} ${body.pack} pack`,
    purpose: pack.purpose,
    targetType: "character",
    targetId: character.id,
    profileId: body.profileId ?? (await resolveDefaultProfileKey()),
    recipeId: body.recipeId,
    presetIds: [],
    orientation: undefined,
    count: body.count ?? pack.count,
    brief: body.brief,
    reason: body.reason,
  };
  return createProductionBatchCore(actor, input);
}

export async function listCharacterPregenBatches(request: Request, characterId: string) {
  await actorWithPermission(request, "content.asset.read");
  const character = await requireOfficialCharacter(characterId);
  const [batches, placements] = await Promise.all([
    prisma.contentProductionBatch.findMany({
      where: { targetType: "character", targetId: character.id },
      include: { items: { orderBy: { itemIndex: "asc" } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.mediaAssetPlacement.findMany({
      where: {
        targetType: "character",
        targetId: character.id,
        slot: { in: ["character_avatar", "character_hero"] },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  return ok({
    items: batches.map(pregenBatchDTO),
    placements: placements.map((placement) => ({
      id: placement.id,
      slot: placement.slot,
      status: placement.status,
      mediaAssetId: placement.mediaAssetId,
      publishedAt: placement.publishedAt,
    })),
  });
}
```

注意：
- `pregenBatchDTO` — 优先复用 content-ops.ts 里现成的 `productionBatchDTO`（若未导出则导出之，函数名以现有代码为准，:180 附近 `batches.map(productionBatchDTO)` 可见），不要重写 DTO。
- zod 的 `pregenCreateSchema` 字段与 `productionBatchCreateSchema`（content-ops.ts:59）语义对齐；`ProductionBatchCreateInput` 若因 `.default()` 导致类型不匹配（如 `presetIds` 非可选），按类型错误提示补齐字面量。
- 若 `createProductionBatchCore` 的 audit 需要 request 参数，签名相应调整——以 Task 2 Step 3 抽取时的实际签名为准。

- [ ] **Step 5: 注册路由**

`service.ts` 在 `content/characters` 块（:594-609）的 `visual-profiles` 两行之后加：

```ts
if (action && child === "pregen" && method === "GET") {
  return listCharacterPregenBatches(request, action);
}
if (action && child === "pregen" && method === "POST") {
  return createCharacterPregenBatch(request, action);
}
```

顶部 import 区（:46 附近 visual-profiles import 旁）加：

```ts
import {
  createCharacterPregenBatch,
  listCharacterPregenBatches,
} from "./characters/pregen";
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd /Users/kk/code/idream/packages/main && bunx vitest run src/server/modules/ourdream/admin-console.test.ts`
Expected: 全部 PASS（新用例 + 既有全部）。

Run: `cd /Users/kk/code/idream && bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/main/src/server/modules/admin/characters/pregen.ts packages/main/src/server/modules/admin/content-ops.ts packages/main/src/server/modules/admin/service.ts packages/main/src/server/modules/ourdream/admin-console.test.ts
git commit -m "feat(admin): per-character pregen pack endpoint (cover/hero/chat) reusing production batch core"
```

---

### Task 3: Metric 聚合端点 `generation/metrics`

**Files:**
- Create: `packages/main/src/server/modules/admin/generation-metrics.ts`
- Modify: `packages/main/src/server/modules/admin/service.ts`（generation 资源块注册，参考 P2 backends/workflows 的注册行）
- Test: `packages/main/src/server/modules/ourdream/admin-console.test.ts`（新增 metrics 用例）

**Interfaces:**
- Produces: `generationMetrics(request: Request): Promise<Response>`；API `GET admin/generation/metrics?days=7`（days ∈ [1,90]，默认 7）→ 200：

```ts
{
  windowDays: number,
  profiles: Array<{
    profileId: string; profileVersion: number | null;
    label: string | null; workflowKey: string | null;
    total: number; completed: number; failed: number; blocked: number;
    costDreamcoins: number; avgDurationMs: number | null;
  }>,
  recipes: Array<{ recipeId: string; total: number; completed: number; failed: number; costDreamcoins: number }>,
  sources: Array<{ sourceType: string; total: number; completed: number; failed: number; costDreamcoins: number }>,
  placements: Array<{ slot: string; status: string; count: number }>,
}
```

- [ ] **Step 1: 写失败测试（RED）**

```ts
it("aggregates generation metrics by profile, recipe, source and placements", async () => {
  const admin = await setupActor("admin", "generation-metrics");
  const support = await setupActor("support", "generation-metrics");
  const profileId = `${P}metrics-profile`;
  const recipeId = `${P}metrics-recipe`;
  const base = {
    userId: admin,
    mode: "image",
    controls: {},
    presetIds: [],
    profileId,
    profileVersion: 1,
    promptTemplateId: recipeId,
    promptTemplateVersion: 1,
    sourceType: "content_production_item",
  } as const;
  await prisma.generationJob.create({
    data: {
      ...base,
      id: `${P}metrics-job-1`,
      sourceId: `${P}metrics-src-1`,
      status: "completed",
      costDreamcoins: 7,
      completedAt: new Date(),
    },
  });
  await prisma.generationJob.create({
    data: {
      ...base,
      id: `${P}metrics-job-2`,
      sourceId: `${P}metrics-src-2`,
      status: "failed",
      costDreamcoins: 7,
    },
  });

  const forbidden = await api("GET", "admin/generation/metrics", {
    userId: support,
    role: "support",
  });
  expectError(forbidden, 403);

  const metrics = await api("GET", "admin/generation/metrics?days=7", {
    userId: admin,
    role: "admin",
  });
  expectOk(metrics);
  const profileRow = metrics.data.profiles.find(
    (row: { profileId: string }) => row.profileId === profileId,
  );
  expect(profileRow).toMatchObject({
    total: 2,
    completed: 1,
    failed: 1,
    costDreamcoins: 14,
  });
  expect(profileRow.avgDurationMs).toBeGreaterThanOrEqual(0);
  const recipeRow = metrics.data.recipes.find(
    (row: { recipeId: string }) => row.recipeId === recipeId,
  );
  expect(recipeRow).toMatchObject({ total: 2, completed: 1, failed: 1 });
  const sourceRow = metrics.data.sources.find(
    (row: { sourceType: string }) => row.sourceType === "content_production_item",
  );
  expect(sourceRow.total).toBeGreaterThanOrEqual(2);
});
```

（`generationJob.create` 必填字段以 schema 为准：`controls`/`presetIds` 是 Json 必填；`@@unique([sourceType, sourceId])` 要求 sourceId 唯一——上面已用 P 前缀区分。support 403 依赖 `generation.config.read` 不在 support 角色权限内，与 P2 backends 测试同门。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/kk/code/idream/packages/main && bunx vitest run src/server/modules/ourdream/admin-console.test.ts -t "generation metrics"`
Expected: FAIL（404 路由不存在）。

- [ ] **Step 3: 实现聚合模块**

创建 `packages/main/src/server/modules/admin/generation-metrics.ts`：

```ts
// SPEC: 生成 Metric 回路（spec §2.1 Metric）：按 profile/recipe/source/placement 聚合
//       近 N 天 GenerationJob 表现（量/成败/成本/平均时长）与投放位状态分布。
// INTENT: 零 DDL——当前规模按需聚合足够；物化 rollup 表留给将来性能需要。
// INVARIANTS: 只读；generation.config.read 门；days ∈ [1,90] 默认 7。
import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/service";

const CONFIG_READ = "generation.config.read" as const;

type StatusBuckets = { total: number; completed: number; failed: number; blocked: number };

function emptyBuckets(): StatusBuckets {
  return { total: 0, completed: 0, failed: 0, blocked: 0 };
}

function bucketFor(status: string, buckets: StatusBuckets, count: number) {
  buckets.total += count;
  if (status === "completed") buckets.completed += count;
  else if (status === "failed") buckets.failed += count;
  else if (status === "blocked") buckets.blocked += count;
}

export async function generationMetrics(request: Request) {
  await actorWithPermission(request, CONFIG_READ);
  const url = new URL(request.url);
  const daysRaw = Number.parseInt(url.searchParams.get("days") ?? "7", 10);
  const windowDays = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, daysRaw)) : 7;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [byProfile, byRecipe, bySource, placementRows, durations] = await Promise.all([
    prisma.generationJob.groupBy({
      by: ["profileId", "profileVersion", "status"],
      where: { createdAt: { gte: since }, profileId: { not: null } },
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.generationJob.groupBy({
      by: ["promptTemplateId", "status"],
      where: { createdAt: { gte: since }, promptTemplateId: { not: null } },
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.generationJob.groupBy({
      by: ["sourceType", "status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.mediaAssetPlacement.groupBy({
      by: ["slot", "status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ profileId: string; avgMs: number | null }>>`
      SELECT "profileId", AVG(EXTRACT(EPOCH FROM ("completedAt" - "createdAt")) * 1000) AS "avgMs"
      FROM "generation_jobs"
      WHERE "createdAt" >= ${since} AND "completedAt" IS NOT NULL AND "profileId" IS NOT NULL
      GROUP BY "profileId"
    `,
  ]);

  const avgByProfile = new Map(durations.map((row) => [row.profileId, row.avgMs]));

  const profileMap = new Map<
    string,
    StatusBuckets & { profileId: string; profileVersion: number | null; costDreamcoins: number }
  >();
  for (const row of byProfile) {
    if (!row.profileId) continue;
    const key = `${row.profileId}@${row.profileVersion ?? 0}`;
    const entry =
      profileMap.get(key) ??
      { ...emptyBuckets(), profileId: row.profileId, profileVersion: row.profileVersion, costDreamcoins: 0 };
    bucketFor(row.status, entry, row._count._all);
    entry.costDreamcoins += row._sum.costDreamcoins ?? 0;
    profileMap.set(key, entry);
  }

  const profileKeys = [...new Set([...profileMap.values()].map((entry) => entry.profileId))];
  const profileRecords = await prisma.generationModelProfile.findMany({
    where: { profileKey: { in: profileKeys } },
    orderBy: { version: "desc" },
    select: { profileKey: true, label: true, workflowKey: true },
  });
  const profileMeta = new Map<string, { label: string; workflowKey: string | null }>();
  for (const record of profileRecords) {
    if (!profileMeta.has(record.profileKey)) {
      profileMeta.set(record.profileKey, {
        label: record.label,
        workflowKey: record.workflowKey,
      });
    }
  }

  const recipeMap = new Map<string, StatusBuckets & { recipeId: string; costDreamcoins: number }>();
  for (const row of byRecipe) {
    if (!row.promptTemplateId) continue;
    const entry =
      recipeMap.get(row.promptTemplateId) ??
      { ...emptyBuckets(), recipeId: row.promptTemplateId, costDreamcoins: 0 };
    bucketFor(row.status, entry, row._count._all);
    entry.costDreamcoins += row._sum.costDreamcoins ?? 0;
    recipeMap.set(row.promptTemplateId, entry);
  }

  const sourceMap = new Map<string, StatusBuckets & { sourceType: string; costDreamcoins: number }>();
  for (const row of bySource) {
    const entry =
      sourceMap.get(row.sourceType) ??
      { ...emptyBuckets(), sourceType: row.sourceType, costDreamcoins: 0 };
    bucketFor(row.status, entry, row._count._all);
    entry.costDreamcoins += row._sum.costDreamcoins ?? 0;
    sourceMap.set(row.sourceType, entry);
  }

  return ok({
    windowDays,
    profiles: [...profileMap.values()]
      .map((entry) => ({
        ...entry,
        label: profileMeta.get(entry.profileId)?.label ?? null,
        workflowKey: profileMeta.get(entry.profileId)?.workflowKey ?? null,
        avgDurationMs: avgByProfile.get(entry.profileId) ?? null,
      }))
      .sort((a, b) => b.total - a.total),
    recipes: [...recipeMap.values()].sort((a, b) => b.total - a.total),
    sources: [...sourceMap.values()].sort((a, b) => b.total - a.total),
    placements: placementRows.map((row) => ({
      slot: row.slot,
      status: row.status,
      count: row._count._all,
    })),
  });
}
```

（`$queryRaw` 的 AVG 返回 Postgres numeric，Prisma 反序列化可能是 `Decimal`/string——若类型报错，用 `AVG(...)::float8` 强转。`profileId: { not: null }` 的 groupBy 类型若报错，改为查询后过滤。）

- [ ] **Step 4: 注册路由**

`service.ts` 里找到 P2 注册 `generation` 资源 backends/workflows 的块，同格式加：

```ts
if (resource === "generation" && id === "metrics" && !action && method === "GET") {
  return generationMetrics(request);
}
```

import：`import { generationMetrics } from "./generation-metrics";`

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /Users/kk/code/idream/packages/main && bunx vitest run src/server/modules/ourdream/admin-console.test.ts`
Expected: 全部 PASS。

Run: `cd /Users/kk/code/idream && bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/main/src/server/modules/admin/generation-metrics.ts packages/main/src/server/modules/admin/service.ts packages/main/src/server/modules/ourdream/admin-console.test.ts
git commit -m "feat(admin): generation metrics aggregation endpoint (profile/recipe/source/placement rollup)"
```

---

### Task 4: 角色预生图面板 UI（CharacterPregenPanel）

**Files:**
- Create: `packages/main/src/components/admin/CharacterPregenPanel.tsx`
- Modify: `packages/main/src/components/admin/OfficialCharactersView.tsx:482`（VisualPassportPanel 之后挂载）

**Interfaces:**
- Consumes: Task 2 API（`GET/POST admin/content/characters/{id}/pregen`）；既有审批 API `POST admin/content/production/items/{itemId}/approve|reject`（body 需 `reason`+`confirmation`，见 content-ops.ts `itemReviewSchema` :73）；既有投放 API `POST admin/content/placements` + `PATCH admin/content/placements/{id}`（status→published 触发 syncPlacementTarget 直写角色头像/主图）。
- Produces: `export function CharacterPregenPanel({ characterId }: { characterId: string })`。

- [ ] **Step 1: 通读样板**

Read `packages/main/src/components/admin/VisualPassportPanel.tsx` 全文——**完全照抄**其 selfFetch（fetch 包装、错误态、loading 态、i18n `t()`、按钮/输入样式类名），保持 admin 界面一致性。

- [ ] **Step 2: 实现面板**

`CharacterPregenPanel.tsx` 功能块（结构模仿 VisualPassportPanel 的 section 布局）：

1. **Pack 触发行**：三个按钮「生成封面包(×4) / 生成主图包(×4) / 生成 Chat 包(×8)」→ `POST admin/content/characters/{characterId}/pregen`，body `{ pack, reason: "pregen from character panel" }`；成功后刷新列表。请求期间按钮 disabled + spinner。
2. **Batch 列表**：`GET .../pregen` → 渲染每个 batch：title、purpose、status、`completedItems/totalItems`、`estimatedCostDreamcoins`；展开显示 items（状态 chip：queued/generated/approved/rejected/published/failed）。
3. **Item 审批**：对 `generated` 状态的 item 提供「通过 / 驳回」按钮 → `POST admin/content/production/items/{item.id}/approve|reject`，body `{ reason: "pregen review", confirmation: "confirm" }`（confirmation 具体要求读 content-ops.ts `approveProductionItem` 实现，若要求特定 token 以代码为准）。
4. **投放**：对 `approved` 且有 `mediaAssetId` 的 item，按 batch purpose 给出投放按钮（character_cover→slot `character_avatar`，character_hero→slot `character_hero`；chat 包不投放）→ `POST admin/content/placements` body `{ mediaAssetId, slot, targetType: "character", targetId: characterId, reason: "pregen publish" }`，成功后 `PATCH admin/content/placements/{id}` body `{ status: "published", reason: "pregen publish", confirmation: … }`（字段要求以 content-ops.ts `createPlacement`/`patchPlacement` zod schema 为准，先读代码再写调用）。
5. **已投放状态行**：用 GET 返回的 `placements` 显示当前 avatar/hero 投放状态。

类型全部手写 interface（响应 DTO 字段与 Task 2 返回一致），no `any`。

- [ ] **Step 3: 挂载**

`OfficialCharactersView.tsx:482` 后加一行：

```tsx
<CharacterPregenPanel characterId={editingId} />
```

顶部 import：`import { CharacterPregenPanel } from "@/components/admin/CharacterPregenPanel";`

- [ ] **Step 4: 验证**

Run: `cd /Users/kk/code/idream && bun run typecheck && bun run lint`
Expected: PASS（本仓库 admin 视图无组件级单测惯例，API 行为已被 Task 2 集成测试覆盖；面板行为在 Task 6 live 走查验证）。

- [ ] **Step 5: Commit**

```bash
git add packages/main/src/components/admin/CharacterPregenPanel.tsx packages/main/src/components/admin/OfficialCharactersView.tsx
git commit -m "feat(admin): character pregen panel (pack buttons, batch review, one-click placement)"
```

---

### Task 5: Generation Metrics 运营视图

**Files:**
- Create: `packages/main/src/components/admin/GenerationMetricsView.tsx`
- Modify: AdminConsoleClient 导航注册（P2 曾为 BackendsView/WorkflowsView 走过同一组 touch points——`grep -rn "BackendsView" packages/main/src` 找到全部注册点，逐一镜像）

**Interfaces:**
- Consumes: Task 3 API `GET admin/generation/metrics?days={7|30}`。
- Produces: `export function GenerationMetricsView()`，admin 导航 Generation Ops 组内新条目「Metrics」。

- [ ] **Step 1: 找齐注册点**

Run: `grep -rn "BackendsView" /Users/kk/code/idream/packages/main/src --include="*.tsx" --include="*.ts"`
把每个出现处（导航项、路由 switch、图标、权限映射等）记为本 task 的镜像清单。

- [ ] **Step 2: 实现视图**

`GenerationMetricsView.tsx`（selfFetch 模式同 BackendsView）：
- 顶部窗口切换（7 天 / 30 天）→ 重新 fetch。
- 四个 section 表格：**Profiles**（label/profileId@version/workflowKey/total/completed/failed/blocked/cost/avgDurationMs——avgDurationMs 显示为 `x.x s`）、**Recipes**、**Sources**、**Placements**（slot × status × count）。
- 空态文案「窗口内无生成记录」。
- 失败率>20% 的行加红色文本类（`text-red-300`，与现有 admin 视图一致）。

- [ ] **Step 3: 注册导航**

按 Step 1 清单在 AdminConsoleClient 各 touch point 加「Metrics」项（Lucide 图标用 `BarChart3`），路由 key `generation-metrics`，权限门与 backends 相同（`generation.config.read`）。

- [ ] **Step 4: 验证**

Run: `cd /Users/kk/code/idream && bun run typecheck && bun run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/main/src/components/admin/GenerationMetricsView.tsx <AdminConsoleClient 涉及文件>
git commit -m "feat(admin): generation metrics ops view (profiles/recipes/sources/placements)"
```

---

### Task 6: 端到端验收 + 文档收尾

**Files:**
- Modify: `packages/main/src/server/modules/ourdream/admin-console.test.ts`（验收集成用例：pregen→审→投放→角色头像更新闭环）
- Modify: `docs/superpowers/specs/2026-07-07-image-generation-redesign-design.md`（§7 P3 行标 ✅ + 一行落地摘要）
- Modify: `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`（实现状态 SSoT，补 P3 条目）

**Interfaces:** 无新接口；这是验收闭环。

- [ ] **Step 1: 写验收集成测试（spec §7 P3 验证标准的机器化）**

新增用例：pregen cover pack（count 1）→ `runQueuedGenerationJobs` 排水 → item 变 generated → approve → 建 placement + publish → 断言 `prisma.character.findUnique(...).imageAssetId === item.mediaAssetId` 且 item 状态 `published`。seed 方式同 Task 2 用例；approve/placement 调用的 body 以 content-ops.ts zod schema 为准。

```ts
it("pregen cover pack publishes to character avatar end to end", async () => {
  // seed admin/character/profile/recipe（P 前缀，同 Task 2 用例模式）
  // POST pregen { pack: "cover", count: 1 } → expectOk 202
  // await runQueuedGenerationJobs(6)
  // GET pregen → item.status === "generated"，取 item.id / mediaAssetId
  // POST admin/content/production/items/{id}/approve { reason, confirmation }
  // POST admin/content/placements { mediaAssetId, slot: "character_avatar", targetType: "character", targetId, reason }
  // PATCH admin/content/placements/{placementId} { status: "published", reason, confirmation }
  // 断言 character.imageAssetId === mediaAssetId；item.status === "published"
});
```

（骨架内每步换成真实调用——GET pregen 响应里 item 的 asset 字段名以 Task 2 DTO 实际输出为准。）

- [ ] **Step 2: 全量 gates**

Run:
```bash
cd /Users/kk/code/idream/packages/main && bunx vitest run src/server/modules/ourdream/admin-console.test.ts
cd /Users/kk/code/idream && bun run check   # lint + typecheck + build
```
Expected: 全绿。

- [ ] **Step 3: Live API 走查（真服务冒烟）**

起 main（APP_ENV=test 指向 idream_test，dev-auth 头，模式同 P2 live 走查），curl 冒烟：

```bash
curl -fsS -H "x-idream-user-id: <admin-id>" -H "x-idream-role: admin" \
  "http://localhost:3000/api/admin/generation/metrics?days=7"
curl -fsS -H "x-idream-user-id: <admin-id>" -H "x-idream-role: admin" \
  "http://localhost:3000/api/admin/content/characters/<char-id>/pregen"
```
Expected: 两端点 200 + envelope 正确；无权限头 → 401/403。（admin API 前缀路径以现有 dispatchAdmin 挂载的真实路由为准，P2 走查用过的 base path 照搬。）

- [ ] **Step 4: 文档更新**

- spec §7 表 P3 行 → `**P3 角色预生图 + Metric** ✅`，内容列补一句落地摘要（pregen packs 端点+面板；metrics 聚合端点+视图；成本接 PricingRule；零 DDL）。
- `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md` 对应章节补 P3 条目。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(admin): P3 acceptance test + docs (pregen loop end-to-end, spec P3 done)"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §7 P3 三件事——per-character 预生图面板→Batch（Task 2+4）、Metric rollup（Task 3+5）、Batch 成本接 PricingRule（Task 1）；验证标准「一键为官方角色出封面/chat 包并投放」= Task 6 Step 1 验收测试 + Step 3 live 冒烟。spec §2.1 Metric 提到的「点击/转化/Remix」维度**刻意不做**：当前无点击/转化事件源（投放位无曝光埋点），做了就是假数据——YAGNI，Metric 先覆盖有真实数据的维度（量/成败/成本/时长/投放状态），事件源落地后再扩列。
- **零 DDL 决策**：Batch/Item/Placement/PricingRule 模型现状已满足全部需求；Metric 用按需聚合替代物化 rollup 表（GenerationJob 三个维度均有索引，窗口 ≤90 天）。避免了一次用户手工 SQL 部署依赖。
- **类型一致性**：`createProductionBatchCore(actor, input)` 在 Task 2 Step 3 定义、Step 4 消费；`generationCostDreamcoins` Task 1 定义、content-ops 消费；面板消费的 API 形状与 Task 2/3 的 Produces 块一致。
- **占位符扫描**：Task 6 Step 1 的测试骨架有意留为注释步骤（每步的真实 API 与字段以既有 zod schema 为准，实现者先读 content-ops.ts 再落笔）——所引 schema 均给出了行号锚点。
