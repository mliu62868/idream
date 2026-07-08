# P5: 能力深化（editLastImage + 投放埋点 + traits 派生 + 双排水治理 + minors） — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 聊天内"把刚才那张改成雪山背景"端到端保脸（Qwen-Edit img2img 进聊天）；投放位曝光/点击（+Remix）进 metrics；traits 成为护照真源（identityPrompt 派生 + hash）；main/gen 双排水隐患治理；P3/P4 defer minors 清偿。

**Architecture:** 全程复用已建管线——gen 侧 `qwen-image-edit-img2img` 描述符 + ComfyUIBackend `/upload/image` + registry workflowKey 路由（P2 全建好）；main 侧 `controls.sourceImageAssetId` 读取器（`ai/reference-images.ts:27`）已存在等字段；事件埋点复用公开 `POST /api/v1/events/track` sink。净新增：chat 第二工具 + 分发注册表化、payload 一个可选字段、main 一处 controls 透传 + 一个 seed profile、两个前端埋点 handler + metrics 一条聚合腿、一个 assembler 函数。**零 DDL**（派生 hash 藏 `adapterRefs`，该字段恒 `{}` 且 admin select 刻意排除）。

**Tech Stack:** 同 P3/P4（packages/chat + shared + main + gen 描述符已就位；vitest 真 PG）。

## Global Constraints

- TypeScript strict, no `any`；named exports；2-space。
- **零 schema 变更、零新 SQL**（P5 不新增任何 db/sql 文件）。
- **不丢功能铁律**：`generate_image_async` 行为逐字节不变；edit 无源图时回退为普通生成（宁可出新图不可报错）；planner 路径继续三重兜底；main 的 IMAGE_PROVIDER 仍只认 mock|pipeline（保留 inline 测试排水与角色预览，见 Task 6 裁决）。
- shared payload 只加可选字段；跨包滚动部署安全。
- 测试：chat `bun run test`（真 PG provision）；main 相关套件（admin-console / event-consumer / image-generation-service）；每 task 收尾 `bun run typecheck`。
- 分支 `feat/image-gen-p5-deepening`；conventional commits。

## 关键代码锚点（p5-scout 已核实，实现者不必重扫）

| 锚点 | 位置 |
|------|------|
| edit 描述符（已建） | `packages/gen/workflows/qwen-image-edit-img2img.json`：modelId `qwen-image-edit`、workflowKey `qwen-image-edit-img2img`、image 槽 `source_image`→node8 LoadImage、prompt/width(832)/height(1216)/seed/steps(4) |
| gen 参考图链（已建） | `gen/src/backend/comfyui.ts:147-232`（bindReferenceImageSlots/uploadImage；**storageKey-only 会 throw :196**，hydrate 在 `gen/src/reference-images.ts:9-28` 先转 b64/url）；`backend-image-model.ts:141-147` 透传 referenceImages |
| main 源图读取器（已建） | `main/src/server/ai/reference-images.ts:27` 读 `controls.sourceImageAssetId` → role `source_image`(:110)；`service.ts:5607-5672` enqueue 时解析，`:5627` 由 `modelCapabilities.initImage` 门控，`:5726` capability 过滤 |
| **唯一断点** | `service.ts:1964-1966` `createChatImageGenerationJob` 重建 controls 只留 orientation，丢弃 payload.controls 其余字段；profile 选择 `:1761→:5849-5873` 落到最便宜 active（不认 edit） |
| payload 契约 | `shared/src/contracts/payloads.ts:141-165`（controls 是 `.passthrough()`；无 sourceImageAssetId 显式字段） |
| chat attachment | `packages/chat/prisma/schema.prisma:134-159`（mediaAssetId/status/kind；索引 `[sessionId,status]` 可支撑"最近完成图"查询）；completed 写回 `chat/src/inbox.ts:102-124` |
| 工具分发硬编码 | `chat/src/generate.ts:169-186` validateToolCall（**:181 cast**）、`:216` 硬编码工具名、`:452-478` 硬编码 event kind；planner `agent-tools.ts:81` z.literal、`:119` prompt |
| profile seed 模式 | `main/prisma/seed.ts` ~:753 `generationModelProfile.upsert`；现有 darkbeast img2img（comfyui、initImage true、disabled、无 workflowKey）可参考字段 |
| 埋点 sink（已建） | `POST /api/v1/events/track` → `service.ts:490` dispatch → `track():3968-3973`（eventSchema :248，接受匿名）；`trackEvent` helper `service.ts:6178-6191` |
| 投放唯一活面 | `components/ourdream/CommunityWorkspace.tsx:276-297`（campaign 卡，DTO 带 placement id，`service.ts:4542-4557`）；feed_card/homepage_strip 枚举存在但**无公开渲染面**（勿为它们造假埋点） |
| Remix 已有事件 | `service.ts:4318-4330` POST /feed/items/{id}/remix 已 fire `feed_item_remixed` |
| metrics 扩展点 | `admin/generation-metrics.ts` Promise.all 腿 `:30`、响应组装 `:133`；AnalyticsEvent `schema.prisma:898-909`（props Json → 聚合需 `$queryRaw` `props->>'placementId'`） |
| traits 派生现场 | `service.ts:1527-1566` characterVisualProfileCreateData（identityPrompt=buildCharacterIdentityPrompt :1609，traits=extractVisualTraitRecord :1636-1645，**adapterRefs 恒 {}** :1563）；admin 独立存储 `admin/characters/visual-profiles.ts:98-166`（select 排除 adapterRefs :46）；bootstrap `:1710-1737` |
| 双排水 | `main/src/processes/finalizer.ts:1-6,29-30`（默认 drain 全部 localAiQueueNames 含 ai.image.generate）；`local-pipeline.ts:27-34`；gen worker 消费同名 BullMQ 队列（`gen/src/image.ts:12`、pm2 `ecosystem.config.js:75`）；env `GEN_FINALIZER_QUEUES` 已存在未在 pm2 配置 |
| minors | `lib/generation-pricing.ts` 无单测；`admin/characters/pregen.ts:32-39` requireOfficialCharacter 名不副实（无 source 过滤，行为=Production Studio 同权限口径，**只改名不改行为**）；`chat/src/providers.ts:392-426` dup 字面量、`:298-311` accumulateToolCalls；`agent-tools.ts:199-201` ZH 正则吃 lowercase 文本 |

---

### Task 1: chat 工具分发注册表化（tool-#2 前置修缮 + chat minors）

**Files:**
- Modify: `packages/chat/src/generate.ts`（:169-186、:216、:452-478）
- Modify: `packages/chat/src/agent-tools.ts`（AgentTool 类型收紧 + ZH 正则 + planner 泛化）
- Modify: `packages/chat/src/providers.ts`（dup 字面量抽公共 + accumulateToolCalls id/name keep-first 防御）
- Test: `packages/chat/src/{agent-tools,generate-agent-tools,providers}.test.ts`（增量；既有用例是行为不变的 oracle，禁改禁删）

**Interfaces:**
- Produces（Task 2 消费）：

```ts
// agent-tools.ts —— AgentTool 泛型化，argsSchema 携带输出类型
export type AgentToolCallPlan =
  | { tool: "generate_image_async"; args: GenerateImageAsyncArgs }
  | { tool: "edit_last_image"; args: EditLastImageArgs }; // Task 2 加第二臂；本 task 先定义单臂 union
// generate.ts —— validateToolCall 返回 AgentToolCallPlan（判别联合替代 cast），
// imageToolCall.name = plan.tool（不再硬编码），outbox 构造按 plan.tool 分支（本 task 仍只有一臂，结构先立起来）
```

- [ ] **Step 1: RED** —— 新增单测：validateToolCall 对 registry 内工具返回判别联合（tool 字段=rawCall.name）；对未知名/坏参返回 null 不 throw；`hasVisualRequestIntent("发张照片")` 与 `("SEND ME A SELFIE")` 语义不变且 ZH 正则改吃**原始文本**（新增大小写混合 CJK+EN 用例）；providers：accumulateToolCalls 同 index 二次出现 id 不覆盖首个（keep-first）。
- [ ] **Step 2: 确认失败** `cd packages/chat && bunx vitest run src/agent-tools.test.ts src/generate-agent-tools.test.ts src/providers.test.ts`
- [ ] **Step 3: 实现** —— 行为等价重构：AgentTool 增 `parseCall(rawArgs: unknown): AgentToolCallPlan | null` 由各工具自带（zod safeParse + 判别 tag）；generate.ts 删 :181 cast、:216 用 plan.tool、:452-478 抽 `buildImageRequestFromPlan(plan, …)`（单臂 switch，default exhaustive check）；agent-tools.ts ZH 正则改在原始文本上测；providers.ts 抽 `openAICompatibleConfig()` 公共字面量 + keep-first merge。
- [ ] **Step 4: 全绿** `cd packages/chat && bun run test && cd /Users/kk/code/idream && bun run typecheck`
- [ ] **Step 5: Commit** `git commit -m "refactor(chat): registry-generic tool dispatch (discriminated plan union) + chat minors"`

---

### Task 2: `edit_last_image` 工具（chat 端 + payload 契约）

**Files:**
- Modify: `packages/chat/src/agent-tools.ts`（注册第二工具）
- Modify: `packages/chat/src/generate.ts`（edit 臂：查最近完成图 → controls 带 sourceImageAssetId；无源图回退 generate）
- Modify: `packages/chat/src/service.ts`（confirmImageAttachment 重试保留 sourceImageAssetId——它从 attachment.metadata 重发 controls，确认字段随行）
- Modify: `packages/shared/src/contracts/payloads.ts`（requested.controls 增可选 `sourceImageAssetId: z.string().optional()`）
- Test: `packages/chat/src/agent-tools.test.ts`、`generate-agent-tools.test.ts`、`test/web.test.ts` 增量

**Interfaces:**
- Consumes: Task 1 的 AgentToolCallPlan（第二臂激活）。
- Produces:

```ts
export const EDIT_LAST_IMAGE_TOOL = "edit_last_image";
export const editLastImageArgsSchema = z.object({
  instruction: z.string().trim().min(4).max(1200), // 编辑指令，如 "change the background to snowy mountains"
  caption: z.string().trim().max(300).optional(),
});
// intentHints：/(改|换|变成|把.*(照片|图)|背景换|重新?p)/ 类 ZH + EN (edit|change|redo|make it|turn it into)+(photo|picture|image|background|that)
// toChatTool(): description 明确 "Edit the LAST photo you sent…keep the person's face and identity"
```

- 行为契约：
  1. edit 臂触发 → 查 `messageAttachment` `where {sessionId, kind:"generated_image", status:"completed", mediaAssetId:{not:null}} orderBy createdAt desc take 1`；
  2. 命中 → imageToolCall = {tool:"edit_last_image", prompt=instruction, sourceImageAssetId=attachment.mediaAssetId}；outbox controls 带 `sourceImageAssetId`，metadata.trigger `"agent_fc"`/planner 值不变，metadata 另存 `editSourceAssetId`（供重试）；
  3. **无源图 → 降级为 generate_image_async 语义**（prompt=instruction，无 sourceImageAssetId），warn 日志，不报错——宁出新图；
  4. promptHint 传 instruction；caption 兜底链与 generate 工具一致。
- planner 兜底同样能选该工具（Task 1 的注册表驱动 planner prompt 自动带上；planner 输出 tool 名经同一 parseCall）。

- [ ] **Step 1: RED** —— web.test.ts：先走一轮完整生成到 completed（复用 P4 验收 seam），再发「把刚才那张照片改成雪山背景」+ `CHAT_MOCK_TOOL_CALLS_JSON` 返回 edit_last_image → 断言新 attachment + outbox payload `controls.sourceImageAssetId === 第一张的 mediaAssetId`、promptHint=instruction；无历史图会话发同样消息 → outbox 无 sourceImageAssetId（降级生成）；generate-agent-tools.test.ts 单测两臂分发。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 全绿**（chat 全套 + typecheck）
- [ ] **Step 5: Commit** `git commit -m "feat(chat): edit_last_image tool — img2img on last delivered photo with graceful fallback"`

---

### Task 3: main 侧 edit 路由 + seed edit profile

**Files:**
- Modify: `packages/main/src/server/modules/ourdream/service.ts`（createChatImageGenerationJob :1948-1989）
- Modify: `packages/main/prisma/seed.ts`（新 profile upsert）
- Test: `packages/main/src/processes/event-consumer.test.ts` 增量

**Interfaces:**
- Consumes: payload `controls.sourceImageAssetId`（Task 2）。
- Produces:
  - seed profile：`profileKey "chat-image-edit"`、label "Chat Image Edit (Qwen-Edit)"、mode image、runner `comfyui`、`pipelineModel "qwen-image-edit"`、`workflowKey "qwen-image-edit-img2img"`、`capabilities` 含 `initImage:true`、defaultWidth 832 / defaultHeight 1216、allowedOrientations `["4:5"]`、status active、enabled true、`costMultiplier` 取略高于 default（如 1.5，编辑更贵）。字段形状照抄 seed.ts ~:753 现有 upsert（darkbeast img2img 是最近参照）。
  - `createChatImageGenerationJob`：payload.controls 里有 `sourceImageAssetId` 时——(a) controls 透传该字段（修 :1964-1966 只留 orientation 的重建：显式白名单 `{orientation, sourceImageAssetId}`，**不要**盲 spread 全部 passthrough）；(b) profile 选择改为 `selectGenerationProfile("image", "chat-image-edit")`（fallback 语义天然存在：该 profile 缺失/禁用时 selectGenerationProfile 落回最便宜 active——此时 job 无 initImage 能力，`:5726` 会滤掉 source_image，退化为普通生成，链路不断）。无 sourceImageAssetId 时行为逐字节不变。
  - 验证点：源图 asset 归属校验——`ai/reference-images.ts` 的 asset 解析是否校验 asset 存在/可读（读现场确认）；payload 来自 chat 服务（可信侧）但仍需确认坏 assetId 不炸 job：解析失败应降级无参考图而非 fail（读 `imageReferenceInputsForGenerationJob` 现有容错，若 throw 则包一层 warn+skip）。
- [ ] **Step 1: RED** —— event-consumer.test.ts：seed edit profile（测试内显式 create，不依赖 seed.ts）+ 一个 MediaAsset；requested payload controls 带 sourceImageAssetId → 断言 job.profileId="chat-image-edit"、job.model="qwen-image-edit-img2img"（workflowKey 路由）、controls.sourceImageAssetId 落库；不带时 → 现行为断言不变（已有用例守护）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 全绿**：`bunx vitest run src/processes/event-consumer.test.ts src/server/modules/ourdream/image-generation-service.test.ts` + typecheck。
- [ ] **Step 5: Commit** `git commit -m "feat(main): route chat edit requests to qwen-image-edit profile with source image passthrough"`

---

### Task 4: 投放位曝光/点击埋点 + metrics 补维度（含 Remix）

**Files:**
- Modify: `packages/main/src/components/ourdream/CommunityWorkspace.tsx`（campaign 卡 :276-297）
- Modify: `packages/main/src/server/modules/admin/generation-metrics.ts`（:30 加聚合腿、:133 组装）
- Modify: `packages/main/src/components/admin/GenerationMetricsView.tsx`（placements 表补列 + Remix 行）
- Test: `packages/main/src/server/modules/ourdream/admin-console.test.ts` 增量（metrics 聚合断言）

**Interfaces:**
- 事件名（写死为常量导出）：`placement_impression` / `placement_click`，props `{placementId, slot}`；客户端经既有 `POST /api/v1/events/track`。
- 曝光：campaign 卡挂 IntersectionObserver（threshold 0.5，每卡每次挂载只发一次——`useRef` 去重）；点击：Link onClick 同步 fire-and-forget（`navigator.sendBeacon` 或 fetch keepalive，不阻塞导航）。
- metrics 响应新增：

```ts
placementEngagement: Array<{ slot: string; placementId: string | null; impressions: number; clicks: number }>,
remix: { total: number }  // feed_item_remixed 事件窗口计数（已有事件源，纯聚合）
```

聚合用 `$queryRaw`（props 是 Json）：

```sql
SELECT props->>'slot' AS slot, props->>'placementId' AS "placementId",
       count(*) FILTER (WHERE name='placement_impression') AS impressions,
       count(*) FILTER (WHERE name='placement_click') AS clicks
FROM "analytics_events"
WHERE name IN ('placement_impression','placement_click') AND "createdAt" >= ${since}
GROUP BY 1,2
```

（表名以 schema `@@map` 为准；count 转 number 记得 `::int`。）**刻意不做**：feed_card/homepage_strip 等无公开渲染面的槽位不造埋点（诚实数据）；点击转化归因（订阅/开聊）留下一期。
- [ ] **Step 1: RED** —— admin-console.test.ts：直接 `prisma.analyticsEvent.create` seed 曝光/点击/remix 事件（P 前缀 placementId）→ GET metrics 断言 placementEngagement 行与 remix.total（只断言自己 P 前缀行/`>=`）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**（服务端腿 + 前端 handler + 视图列）→ **Step 4: 全绿** + `bun run lint`。
- [ ] **Step 5: Commit** `git commit -m "feat(metrics): placement impression/click instrumentation + remix rollup in generation metrics"`

---

### Task 5: traits=真源，identityPrompt 版本化派生 + hash（零 DDL）

**Files:**
- Create: `packages/main/src/server/modules/ourdream/identity-assembler.ts`
- Modify: `packages/main/src/server/modules/ourdream/service.ts`（characterVisualProfileCreateData :1527-1566 接 assembler）
- Modify: `packages/main/src/server/modules/admin/characters/visual-profiles.ts`（identityPrompt 转可选；缺省时由 traits 派生；显式给出时标记 manual）
- Test: 新 `identity-assembler.test.ts` + `admin-console.test.ts` / `image-generation-service.test.ts` 增量

**Interfaces:**

```ts
// identity-assembler.ts
// SPEC: traits 是唯一真源；identityPrompt 是版本化派生缓存（spec §2.2.1）。
// INVARIANTS: 同 traits + 同 ASSEMBLER_VERSION → 同 prompt 同 hash（纯函数）；hash=FNV-1a hex。
export const IDENTITY_ASSEMBLER_VERSION = 1;
export type IdentityTraits = {
  face: Record<string, string>; hair: Record<string, string>; body: Record<string, string>;
  signature: Record<string, string>; style: Record<string, string>;
};
export function assembleIdentityPrompt(traits: IdentityTraits): { identityPrompt: string; traitsHash: string };
export function traitsHashOf(traits: IdentityTraits): string;
```

- 存储（零 DDL）：`adapterRefs` 从恒 `{}` 改为 `{ identity: { traitsHash, assemblerVersion, source: "derived" | "manual" } }`——该字段 admin select 刻意排除（:46），运行时读取处 grep `adapterRefs` 确认无人依赖"恒空对象"再动手。
- 行为：
  1. `characterVisualProfileCreateData`（bootstrap/用户向导路径）：先 extract traits（现逻辑），identityPrompt 改由 `assembleIdentityPrompt(traits)` 生成（**保序拼装现 buildCharacterIdentityPrompt 的语义**——把 :1609-1634 的拼装规则搬进 assembler 成 v1，输出务必与现输出等价，用既有护照注入测试作 oracle）；adapterRefs 写 derived 标记。
  2. admin create（visual-profiles.ts）：schema `identityPrompt` 转 `optional`；有 traits 无 identityPrompt → 派生 + `source:"derived"`；显式 identityPrompt → 原样存 + `source:"manual"`（运营意志优先，不强制重派生——**修正漂移的机制是标记而非禁止**）；响应 DTO 增只读 `identitySource` 字段供 UI 显示"派生/手写"。
  3. 一致性自检：`derived` 且 `traitsHashOf(current traits) !== stored hash` → 该 profile 的 GET 列表响应标 `identityStale: true`（纯计算，不写库）；VisualPassportPanel 显示提示徽标（小改）。
- [ ] **Step 1: RED**（assembler 纯函数单测：确定性/hash 稳定/与 buildCharacterIdentityPrompt 现输出等价的金样例；admin 可选 identityPrompt 两分支；stale 标记）→ **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 全绿**（admin-console + image-generation-service 护照用例 + typecheck + lint）。
- [ ] **Step 5: Commit** `git commit -m "feat(main): traits as identity SoT — versioned assembler + derived-cache hash in adapterRefs"`

---

### Task 6: 双排水治理 + legacy 路径裁决落档

**Files:**
- Modify: `ecosystem.config.js`（finalizer 进程 env 加 `GEN_FINALIZER_QUEUES=app.ai.finalize`）
- Modify: `packages/main/src/server/launch-readiness.ts`（新探针：GEN split 拓扑下 finalizer 若未收窄队列 → warn/fail）
- Modify: `packages/main/src/server/providers/index.ts`（assertMockProvidersConfigured 注释落档裁决：main 只认 mock|pipeline 是**设计内**——inline 路径服务测试排水+角色预览，prod 生图由 gen worker 经 GEN_IMAGE_PROVIDER=backend 承担；删除歧义 TODO）
- Modify: `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`（记录裁决）
- Test: launch-readiness 既有测试模式增量（grep launch-readiness 测试文件）

**裁决（终审 defer 项闭环，不删代码）：** PipelineImageModel/inline drain 保留（tests `runQueuedGenerationJobs`、非拆分 dev、char preview :188 依赖）；风险点只在 prod 双排水——pm2 finalizer 默认 drain `ai.image.generate`，与 gen-image worker 抢队列。修法 = 配置收窄 + readiness 探针防回归。
- [ ] **Step 1: RED**（readiness 探针用例：GEN_FINALIZER_QUEUES 未设且 pm2 拓扑含 gen worker 场景的检查逻辑——按 launch-readiness 现有 check 的可测模式写）→ **Step 2: 实现** → **Step 3: 全绿** → **Step 4: Commit** `git commit -m "fix(ops): scope finalizer queues under gen-split topology + document inline path verdict"`

---

### Task 7: minors 清偿

**Files:**
- Create: `packages/main/src/server/lib/generation-pricing.test.ts`（active 规则/兜底/multiplier/ceil 四用例，P 前缀 ruleKey + 不变式断言）
- Modify: `packages/main/src/server/modules/admin/characters/pregen.ts`（`requireOfficialCharacter` → `requirePregenTargetCharacter`，注释注明与 Production Studio 同口径接受任意未删角色）
- Test: 上述单测 + 既有 admin-console pregen 用例守行为

- [ ] **Step 1: RED**（pricing 单测先行）→ **Step 2: 实现** → **Step 3: 全绿**（main 套件 + typecheck）→ **Step 4: Commit** `git commit -m "chore: pricing unit tests + pregen resolver rename (deferred minors)"`

---

### Task 8: 端到端验收 + live 走查 + 文档

**Files:**
- Modify: `packages/chat/test/web.test.ts`（P5 验收场景）
- Modify: spec §7 P5 行 ✅ + `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`

- [ ] **Step 1: 验收集成测试** —— 单条连续场景：生成一张 → completed → 「把刚才那张改成雪山背景」→ edit 工具 → outbox controls.sourceImageAssetId=上一张 asset → （main 侧由 event-consumer 用例覆盖 edit profile 路由，chat e2e 到 outbox 为止）→ 断言降级分支（新会话直接说改图 → 无 sourceImageAssetId）。
- [ ] **Step 2: 全量 gates** —— chat 全套 + main（admin-console/event-consumer/image-generation-service）+ `bun run check`。
- [ ] **Step 3: live 走查（尽力而为，诚实记录）** —— oMLX FC 真模型触发 edit 工具（`curl` 带两工具注册表问「把刚才的照片换成雪山背景」→ 应选 edit_last_image）；**可选加分**：ComfyUI(:8188) + gen worker 起来跑一张真 img2img（qwen bf16 53G，注意勿与其他大模型并载——OOM 教训）；受阻则记录障碍。
- [ ] **Step 4: 文档 + Commit** `git commit -m "feat: P5 acceptance e2e + docs (edit-in-chat loop, spec P5 done)"`

---

## Self-Review 记录

- **范围对 spec §7 P5 行**：edit 工具（T1-T3+T8）、埋点+metrics（T4）、traits 派生（T5）、legacy 治理（T6）、minors（T7，另有 chat 侧 minors 并入 T1）。视频不做（V1.1 既定）。
- **验证标准逐条**：「改成雪山背景端到端保脸」= T8 验收（协议层）+ live 可选真图；「metrics 可见曝光/点击」= T4 断言 + 视图列；「traits 编辑后自动重派生 + hash 一致」= T5 派生分支 + stale 标记。
- **刻意不做**：无渲染面槽位的假埋点；点击→订阅转化归因；PipelineImageModel 删除（依赖清单在 T6 裁决）；identityPrompt 强制重派生（manual override 保留运营意志）。
- **类型一致性**：AgentToolCallPlan 判别联合 T1 定义、T2 加臂、generate.ts 分支 exhaustive；sourceImageAssetId 名称贯穿 chat controls → shared schema → main 白名单透传 → ai/reference-images.ts 既有读取器（字段名 `:27` 已定，勿改名）。
- **回退安全**：edit profile 缺失 → 普通生成（capability 过滤自然退化）；无源图 → 降级生成；旧 main + 新 chat（或反向）→ 可选字段互容。
