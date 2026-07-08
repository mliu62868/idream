# P4: 聊天 Agent 生图能力（工具注册表 + 原生 Function-Calling + 护照注入） — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 聊天内"发张自拍/换个场景"端到端可用且身份一致：工具注册表替换单硬编码工具；原生 OpenAI function-calling 为主机制（JSON planner 兜底）；文本+图同回合；VisualPassport 身份注入聊天请求；运营可按档位/角色开关工具；角色能感知自己刚发的照片。

**Architecture:** chat→main→gen→finalizer→chat 的 outbox/inbox 事件链**完全不动**（spec §6.3；payload 均 `.passthrough()` 可加字段）。改动集中在 chat 服务的模型调用与生成回路、shared 契约的增量字段、main 的 payload 转发与 completed 事件补充、以及一条边界视图 SQL（护照与开关投影进 chat 可读视图）。

**Tech Stack:** packages/chat（Bun + zod + BullMQ + 独立 PG role）、packages/shared 契约、packages/main（event-consumer / service / local-pipeline / admin）、oMLX OpenAI 兼容端点（`tools` 支持已实测，见下）。

## 前置事实（已验证，实现者不必重验）

**oMLX 原生 FC 探测（2026-07-08，本机 :8061，Qwen3.6-35B-A3B 8bit，全部通过）：**
- `tools` + `chat_template_kwargs:{"enable_thinking":false}` → 标准 `tool_calls` 数组、合法 JSON 参数、`finish_reason:"tool_calls"`。
- **thinking 开启会破坏 FC**（推理泄进 content、无 tool_calls）→ 现有 OpenAIChatModel 请求体已带 `enable_thinking:false`（providers.ts:100-106），保持即可。
- 闲聊（"how was your day"）不误触发（finish=stop，无 tool_calls）。
- 回喂 `role:"tool"`（内容 `{"status":"generating","note":"…respond now…"}`）→ 模型输出贴脸中文/英文人设短语，**文本+图同回合的二段调用模式可行**。
- `stream:true` 下 delta 携带 `tool_calls`（index/id/name/arguments）。
- 服务启动：`/Users/kk/.omlx/bin/omlx serve --model-dir ~/.omlx/models --host 127.0.0.1 --port 8061 --api-key omlx`。

**结论（spec §8.3 P0 验证项落定）：原生 FC 为主机制；mock/pipeline 或 FC 失败时回退现有 JSON planner。**

## Global Constraints

- TypeScript strict, no `any`；named exports；2-space。
- **不改 Prisma schema、不改事件链拓扑**。唯一 SQL = 一个新边界视图文件（CREATE OR REPLACE VIEW，可重跑；测试库由 `packages/chat/test/provision.mjs` 自动应用，dev/prod 由用户执行）。
- **不丢功能铁律**：`image_tool_enabled` 一切默认 `true`（未配置=现状行为）；JSON planner 路径原样保留（mock/pipeline provider 与 FC 失败兜底）；`generate_image_async` 工具名与 attachment/outbox wire 形状不变。
- shared payload 改动只加**可选**字段（`.passthrough()` 之上补进 zod schema），跨包不破坏。
- chat 测试：`cd packages/chat && bun run test`（真 PG，provision.mjs 重建 + 边界 SQL）；main 测试同 P3（5433/idream_test）。每 task 结束跑 `bun run typecheck`。
- 分支 `feat/image-gen-p4-chat-agent`；conventional commits。

## 关键代码锚点（p4-scout 已核实）

| 锚点 | 位置 |
|------|------|
| 单硬编码工具+planner | `packages/chat/src/agent-tools.ts`（工具名:6、args zod:8-13、正则门 `shouldPlanImageTool`:78-82 / `hasVisualRequestIntent`:143-149、planner 调用:36-48、prompt:50-76、解析:84-141、caption:96-100） |
| 生成回路（text XOR image） | `packages/chat/src/generate.ts`（planner 触发:85-96、**XOR 分支:98-117**、finalize 内 attachment+outbox:316-357、`buildConversationContext`:433-441、`buildModelMessages`:374-395） |
| ChatModel 接口（无 tools） | `packages/chat/src/providers.ts`（接口:21-34、OpenAIChatModel:66-185、请求体:100-106、SSE 只读 delta.content:130、`complete`:145-184、MockChatModel planner seam:56-58、`createProviders`:294-318） |
| 手动确认/重试二次触发 | `packages/chat/src/service.ts` `confirmImageAttachment`:525-600 |
| 事件契约 | `packages/shared/src/contracts/events.ts`:11,30-32；`payloads.ts` requested:141-161 / accepted:163-171 / completed:173-183 / failed:185-194（全 `.passthrough()`） |
| main 消费/建 job | `packages/main/src/processes/event-consumer.ts` `applyChatEvent`:42（requested:102-163）；`service.ts` `createChatImageGenerationJob`:1929-1965、`resolveGenerationVisualProfile`:1673-1695（**已支持 requestedId**）、身份注入 `buildImageGenerationPrompt`:2037-2038 |
| completed/failed 回执 | `packages/main/src/server/ai/local-pipeline.ts` `enqueueChatImageCompleted`:683-708、Failed:711-734 |
| 档位/权益进 chat | `packages/chat/src/context.ts`:41 → `policy.ts` `resolvePolicy`:37-61（snapshot 有 `voiceEnabled` 先例）、`modelForTier`:69-73 |
| 边界视图 SQL | `db/sql/02_core_views.sql`（`core.chat_character_view`:19、`billing.chat_entitlement_view`:46、voice_enabled 旗标:76 是镜像模板） |
| Character 可用字段 | `schema.prisma` Character：`advancedDetails Json`（per-character 开关落点，零 DDL） |
| 测试 seam | chat：`CHAT_MOCK_TOOL_PLAN_JSON`（providers.ts:56-58）、`generate-agent-tools.test.ts` fakePrisma、`test/web.test.ts:126-224` e2e + `consumeInbound`；main：`event-consumer.test.ts`:98-253、`image-generation-service.test.ts`:776-842（护照注入已验） |
| admin 角色子资源路由样板 | `packages/main/src/server/modules/admin/service.ts`:594-609（visibility/status/visual-profiles/pregen） |

---

### Task 1: ChatModel 接口支持 `tools`（providers.ts）

**Files:**
- Modify: `packages/chat/src/providers.ts`
- Test: `packages/chat/src/providers.test.ts`（若不存在则新建；先看 packages/chat 现有测试文件的命名/结构惯例）

**Interfaces:**
- Produces（后续 task 消费，签名以此为准）：

```ts
export type ChatToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema（由注册表的 zod 转出）
};

export type ChatToolCall = { id: string; name: string; arguments: string }; // arguments = raw JSON string

// ChatModel.stream 增加可选 tools；返回值增加 toolCalls（无工具调用时为 []）
// ChatModel 增加能力位 supportsTools: boolean（openai=true, mock=true, pipeline=false）
```

- [ ] **Step 1: 写失败测试（RED）**

先读 `packages/chat/src` 现有针对 OpenAIChatModel 的测试（grep `OpenAIChatModel` in `packages/chat/src/*.test.ts`；若无既有 SSE fake server 模式，用 `Bun.serve`/`http` 起本地 fake 按 SSE 逐行吐 chunk）。测试用例：

```ts
// 1) stream 传 tools 时请求体包含 tools 数组
// 2) SSE delta 携带 tool_calls（分片：先 {index:0,id,function:{name}}，再 {index:0,function:{arguments:"{\"scene\""}}，再补齐)
//    → 返回的 toolCalls 拼接完整：[{id:"call_1", name:"generate_image_async", arguments:'{"scene":"beach"}'}]
// 3) 无 tool_calls 的普通流 → toolCalls === []
// 4) MockChatModel: 设 CHAT_MOCK_TOOL_CALLS_JSON='[{"id":"m1","name":"generate_image_async","arguments":"{\"prompt\":\"selfie at beach, smiling\"}"}]'
//    → stream 返回该 toolCalls；未设时 toolCalls === []
// 5) supportsTools: openai/mock true；pipeline false
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/kk/code/idream/packages/chat && bunx vitest run src/providers.test.ts`
Expected: FAIL（接口无 tools/toolCalls）。

- [ ] **Step 3: 实现**

`providers.ts` 改动要点（保持现有 stream 事件/回调形态不变，只增量）：
1. `ChatModel` 接口：`stream(input: {…现有字段…, tools?: ChatToolDefinition[]})`；返回结构体增加 `toolCalls: ChatToolCall[]`；接口加 `readonly supportsTools: boolean`。
2. `OpenAIChatModel`：body 有 `tools` 时附 `tools: tools.map(t => ({type:"function", function:{name:t.name, description:t.description, parameters:t.parameters}}))`；SSE 循环里累积 `choices[0].delta.tool_calls`（按 `index` 聚合：id/name 取首个非空，arguments 字符串拼接）；流结束后随现有结果返回。`complete()` 不动。
3. `MockChatModel`：`supportsTools = true`；stream 读 `process.env.CHAT_MOCK_TOOL_CALLS_JSON`（JSON 数组，解析失败按无工具处理并 `console.warn`→按项目日志惯例）。
4. `PipelineChatModel`（若存在）`supportsTools = false`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/kk/code/idream/packages/chat && bunx vitest run src/providers.test.ts && bun run typecheck`（在仓库根跑 typecheck）
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/chat/src/providers.ts packages/chat/src/providers.test.ts
git commit -m "feat(chat): ChatModel tools param + streaming tool_calls accumulation + mock seam"
```

---

### Task 2: 工具注册表（agent-tools.ts 重构）

**Files:**
- Modify: `packages/chat/src/agent-tools.ts`
- Test: `packages/chat/src/agent-tools.test.ts`（既有，增量）

**Interfaces:**
- Consumes: Task 1 的 `ChatToolDefinition`。
- Produces:

```ts
export type AgentTool = {
  name: string;                       // wire 名，保持 "generate_image_async"
  description: string;                // FC/planner 共用的能力描述
  intentHints: RegExp[];              // 正则预门（planner 路径用；FC 路径不需要）
  argsSchema: z.ZodType<…>;           // 现有 generateImageAsyncArgsSchema 原样迁入
  toChatTool(): ChatToolDefinition;   // zod → JSON Schema（手写 schema 字面量即可，勿引新依赖）
};
export const AGENT_TOOL_REGISTRY: AgentTool[];
export function findAgentTool(name: string): AgentTool | undefined;
export function registryChatTools(): ChatToolDefinition[];
```

- [ ] **Step 1: 写失败测试（RED）**

在 agent-tools.test.ts 增量：注册表含且仅含 `generate_image_async`；`findAgentTool` 命中/未命中；`toChatTool().parameters` 是含 prompt/caption/orientation/outputCount 的合法 JSON Schema（required=["prompt"]）；`hasVisualRequestIntent` 语义不变（现有用例不许改）；planner prompt 由注册表驱动后输出与现有等价（工具名/参数说明仍在 prompt 里）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/kk/code/idream/packages/chat && bunx vitest run src/agent-tools.test.ts`

- [ ] **Step 3: 实现**

重构为注册表驱动，**行为等价**：`GENERATE_IMAGE_ASYNC_TOOL` 常量、`generateImageAsyncArgsSchema`、caption 逻辑保留导出（generate.ts / service.ts 现有 import 不破坏）；`hasVisualRequestIntent` 改为遍历 `AGENT_TOOL_REGISTRY` 的 `intentHints`（现有 EN 词对 + ZH 正则原样迁入 generate_image 工具的 intentHints）；`buildToolPlannerMessages` 从注册表生成工具清单段落。JSON Schema 手写字面量：

```ts
toChatTool: () => ({
  name: GENERATE_IMAGE_ASYNC_TOOL,
  description:
    "Generate and send a photo of yourself to the user. Use whenever the user asks for a picture, selfie, or to see you or a scene.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Concrete visual description of the photo (12-1200 chars), English preferred" },
      caption: { type: "string", description: "Short in-character message to accompany the photo" },
      orientation: { type: "string", enum: ["4:5", "1:1", "16:9"] },
      outputCount: { type: "integer", minimum: 1, maximum: 4 },
    },
    required: ["prompt"],
  },
}),
```

- [ ] **Step 4: 全量 chat 测试**

Run: `cd /Users/kk/code/idream/packages/chat && bun run test && cd /Users/kk/code/idream && bun run typecheck`
Expected: 全绿（尤其 generate-agent-tools.test.ts 与 web.test.ts 不受重构影响）。

- [ ] **Step 5: Commit**

```bash
git add packages/chat/src/agent-tools.ts packages/chat/src/agent-tools.test.ts
git commit -m "feat(chat): agent tool registry (registry-driven planner prompt + intent gate, wire-compatible)"
```

---

### Task 3: FC 优先生成回路 + 文本图同回合（generate.ts）

**Files:**
- Modify: `packages/chat/src/generate.ts`
- Test: `packages/chat/src/generate-agent-tools.test.ts`（增量）

**Interfaces:**
- Consumes: Task 1 `tools`/`toolCalls`/`supportsTools`；Task 2 注册表。
- Produces: 行为契约（Task 7 验收依赖）：
  1. `providers.chat.supportsTools === true` 且 policy 允许（Task 4 引入 `policy.imageToolEnabled`，本 task 先以 `true` 占位常量 `IMAGE_TOOL_POLICY_PLACEHOLDER`，Task 4 替换）→ 主流式调用即带 `registryChatTools()`，**不再走 planner**。
  2. 模型返回 toolCalls：用 `findAgentTool(name)` 校验 + `argsSchema.safeParse(JSON.parse(arguments))`；非法（未知名/坏 JSON/校验失败）→ 忽略工具调用、仅保留已流出的文本（记 warn 日志），**不 throw**。
  3. 合法 toolCall：已流出的 prose 保留为消息文本；若 prose 为空 → 二段调用：向 messages 追加 assistant(tool_calls) + `role:"tool"`（content `{"status":"generating","note":"The photo is being generated and will be delivered shortly. Respond to the user now with a short in-character message accompanying the incoming photo."}`），用 `providers.chat.complete()` 拿短语并作为消息文本流出（stream 事件形态与现状 caption 流一致）；complete 失败 → 回退 args.caption → 回退现有 `imageToolCaption`。
  4. finalize 内 attachment + `chat.image.requested` outbox 代码（generate.ts:316-357）**原样复用**——FC 与 planner 两路产出同构的 `imageToolCall`。metadata.trigger 区分 `"agent_fc"` / `"agent_tool_call"`（后者是现状 planner 值，保持）。
  5. `supportsTools === false`（pipeline）或 FC 主调用抛错 → 现状 planner 路径原样执行（regex 门 + 二次 complete）。
- **消除 XOR**：generate.ts:98-117 的互斥分支改为——FC 路径下 prose 与 imageToolCall 共存于同一条 assistant 消息。

- [ ] **Step 1: 写失败测试（RED）**

`generate-agent-tools.test.ts` 增量（沿用其 vi.mock + fakePrisma 模式）：

```ts
// A) mock provider + CHAT_MOCK_TOOL_CALLS_JSON 设置 → streamMock 被调用一次且带 tools 参数；
//    产出的 assistant 消息文本非空（来自 mock 流 prose 或 caption 兜底）且 attachment 创建 + outbox 有 chat.image.requested
//    （对照现状测试 :179 断言 streamMock 不被调 —— FC 路径下反转）
// B) CHAT_MOCK_TOOL_CALLS_JSON 含未知工具名 → 无 attachment、无 outbox、消息为普通文本、不 throw
// C) CHAT_MOCK_TOOL_CALLS_JSON 未设 + 正则命中 + CHAT_MOCK_TOOL_PLAN_JSON 设置 planner 结果，且 mock 声明 supportsTools=false（新增 env seam CHAT_MOCK_SUPPORTS_TOOLS=false）
//    → planner 路径照旧（现有断言复用）
```

（Mock 的 `supportsTools` 需要可配置：Task 1 的 MockChatModel 若未含 `CHAT_MOCK_SUPPORTS_TOOLS` seam，本 task 顺手加上，归入本 task diff。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/kk/code/idream/packages/chat && bunx vitest run src/generate-agent-tools.test.ts`

- [ ] **Step 3: 实现**（按上方行为契约 1-5）

- [ ] **Step 4: 全量验证**

Run: `cd /Users/kk/code/idream/packages/chat && bun run test && cd /Users/kk/code/idream && bun run typecheck`
Expected: 全绿（web.test.ts 用 mock provider——注意其现有用例依赖 planner seam：确认 `CHAT_MOCK_TOOL_CALLS_JSON` 未设时 FC 路径产出空 toolCalls 后正则门 + planner 兜底仍触发，即 FC 空结果 ≠ 终止工具流程；这是行为契约 5 的自然推论，测试必须覆盖）。

- [ ] **Step 5: Commit**

```bash
git add packages/chat/src/generate.ts packages/chat/src/generate-agent-tools.test.ts packages/chat/src/providers.ts
git commit -m "feat(chat): native function-calling image tool path with text+image same turn (planner fallback intact)"
```

---

### Task 4: 护照注入 + 工具开关投影（边界 SQL + context/policy + payload 透传）

**Files:**
- Create: `db/sql/2026-07-08-chat-visual-passport-and-tool-flags.sql`
- Modify: `packages/chat/src/context.ts`、`packages/chat/src/policy.ts`、`packages/chat/src/generate.ts`（system prompt + payload）、`packages/chat/src/agent-tools.ts`（planner prompt 身份行）
- Modify: `packages/shared/src/contracts/payloads.ts`（requested 增可选字段）
- Modify: `packages/main/src/processes/event-consumer.ts` + `packages/main/src/server/modules/ourdream/service.ts`（createChatImageGenerationJob 透传 visualProfileId）
- Modify: `packages/chat/test/provision.mjs`（若其按文件清单应用 SQL，把新文件加进去；若按目录 glob 则无需改——先读实现）
- Test: `packages/chat/test/web.test.ts` 增量 + `packages/main/src/processes/event-consumer.test.ts` 增量

**Interfaces:**
- Produces:
  - SQL：`core.chat_character_view` 增列 `visual_profile_id TEXT?`、`visual_profile_version INT?`、`identity_prompt TEXT?`、`image_tool_enabled BOOLEAN`（`COALESCE((c."advancedDetails"->>'imageToolEnabled')::boolean, true)`）；`billing.chat_entitlement_view` 增 `image_tool_enabled`（`COALESCE((t.m->>'image_tool_enabled')::boolean, true)`，镜像 :76 的 voice_enabled 写法）。护照列 LEFT JOIN `public.character_visual_profiles vp ON vp."characterId"=c.id AND vp.status='active'`（P2 起 active 唯一：铸新版即归档旧版）。
  - chat policy：`PolicySnapshot` + `ResolvedPolicy` 增 `imageToolEnabled: boolean`（= 档位旗标 AND 角色旗标）；Task 3 的占位常量替换为 `policy.imageToolEnabled`。
  - system prompt（`buildModelMessages`）：有 `identity_prompt` 时追加一行 `Your appearance (keep consistent when sending photos): {identityPrompt 截断 400 字符}`；planner prompt 同样注入。
  - `ChatImageRequestedPayload` 增可选 `visualProfileId?: string`、`visualProfileVersion?: number`（zod `.optional()`）；chat 侧发 outbox 时带上（generate.ts:336-351 与 service.ts confirmImageAttachment:557-578 两个 producer 都要）；main `createChatImageGenerationJob` 把 `payload.visualProfileId` 传给现有 `resolveGenerationVisualProfile(character, requestedId)` 路径（读 :1929-1965 找 profile 解析处接线）。

- [ ] **Step 1: 写 SQL 并本地验证可重跑**

写 SQL 文件（头注释注明：CREATE OR REPLACE、可重跑、dev/prod 由用户执行、测试库 provision 自动应用、**部署顺序无硬依赖**——旧 chat 代码不读新列，新 chat 代码读列缺失时（未执行 SQL）会在启动/查询时报列不存在，故 **SQL 先行**）。
Run: `psql "postgresql://postgres:postgres@localhost:5433/idream_test" -v ON_ERROR_STOP=1 -f db/sql/2026-07-08-chat-visual-passport-and-tool-flags.sql`（连跑两遍验证幂等；测试库 provision 会重建，此步只为快速验证语法）
Expected: 两遍均成功。

- [ ] **Step 2: 写失败测试（RED）**

- `web.test.ts` 增量：seed 一个带 active CharacterVisualProfile 的角色（直接 insert main 表，identityPrompt 含独特 token 如 `P4-IDENTITY-TOKEN`）→ 发触发图片的消息（mock FC seam）→ 断言 outbox `chat.image.requested` payload 携带 `visualProfileId`/`visualProfileVersion`；断言发给模型的 system prompt 含 `P4-IDENTITY-TOKEN`（web.test 若无法直捣 system prompt，则在 generate 单测层断言 `buildModelMessages` 输出——以现有测试可达性为准，二选一，报告说明）。
- 开关：把角色 `advancedDetails` 设 `{"imageToolEnabled": false}` → 同样的触发消息**不**产生 attachment/outbox（FC tools 不传、planner 门短路），普通文本正常。
- `event-consumer.test.ts` 增量：requested payload 带 `visualProfileId` → 建出的 GenerationJob `visualProfileId` 等于它（沿用该文件现有 fixture 模式）。

- [ ] **Step 3: 跑测试确认失败**

Run: `cd /Users/kk/code/idream/packages/chat && bun run test`（新用例 FAIL）；`cd /Users/kk/code/idream/packages/main && bunx vitest run src/processes/event-consumer.test.ts`（新用例 FAIL）

- [ ] **Step 4: 实现**（SQL 已就绪 → chat view 类型/读取 → policy 合成 → prompt 注入 → payload 透传 → main 接线）

- [ ] **Step 5: 全量验证**

Run: `cd /Users/kk/code/idream/packages/chat && bun run test && cd /Users/kk/code/idream/packages/main && bunx vitest run src/processes/event-consumer.test.ts src/server/modules/ourdream/image-generation-service.test.ts && cd /Users/kk/code/idream && bun run typecheck`
Expected: 全绿（image-generation-service.test.ts 的既有护照注入用例守住 main 侧不回归）。

- [ ] **Step 6: Commit**

```bash
git add db/sql/2026-07-08-chat-visual-passport-and-tool-flags.sql packages/chat packages/shared packages/main
git commit -m "feat(chat): visual passport injection + image tool flags via boundary views; payload carries visualProfileId"
```

---

### Task 5: Agent 结果感知（completed 带摘要 → 聊天上下文）

**Files:**
- Modify: `packages/shared/src/contracts/payloads.ts`（completed 增可选 `summary?: string`）
- Modify: `packages/main/src/server/ai/local-pipeline.ts`（`enqueueChatImageCompleted` :683-708 组 payload 时带 `summary` = job.prompt 或 sourceMeta.promptHint 截断 200 字符）
- Modify: `packages/chat/src` inbox 消费处（completed 落 attachment 时把 summary 存进 `messageAttachment.metadata.summary`——先 grep chat 侧 `chat.image.completed` 消费点）+ `generate.ts` `buildModelMessages`/`buildConversationContext`：最近 N(=6) 条消息里 assistant 消息若带 completed image attachment，注入一行 `[You sent a photo: {summary}]` 进模型消息（作为该 assistant 消息内容的后缀行，不新增消息条目）。
- Test: `packages/chat/test/web.test.ts` 增量（completed 回执带 summary → 下一轮 buildModelMessages/上下文含 `[You sent a photo:`）+ main 侧 `image-generation-service.test.ts` 或 local-pipeline 相关测试断言 completed payload 含 summary（找现有 enqueueChatImageCompleted 的测试点，沿用）。

**Interfaces:**
- Consumes: Task 4 之前的事件链原样。
- Produces: `ChatImageCompletedPayload.summary?: string`；聊天上下文的照片感知行格式 `[You sent a photo: …]`（Task 7 验收断言此字符串）。

- [ ] **Step 1: RED**（两侧新断言先失败） → **Step 2: 实现** → **Step 3: 全量绿**

Run: `cd /Users/kk/code/idream/packages/chat && bun run test && cd /Users/kk/code/idream/packages/main && bunx vitest run src/server/modules/ourdream/image-generation-service.test.ts src/processes/event-consumer.test.ts && cd /Users/kk/code/idream && bun run typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/shared packages/main packages/chat
git commit -m "feat(chat): agent awareness of delivered photos (completed summary → context line)"
```

---

### Task 6: 运营开关 admin surface（per-character toggle）

**Files:**
- Modify: `packages/main/src/server/modules/admin/characters/`（新文件 `chat-tools.ts` 或并入既有 characters 模块——看目录现状选最小方案）
- Modify: `packages/main/src/server/modules/admin/service.ts`（`content/characters/{id}/chat-tools` POST 注册，紧邻 pregen 行）
- Modify: `packages/main/src/components/admin/OfficialCharactersView.tsx`（编辑区一个开关行：「聊天生图工具」toggle，调上述端点后刷新）
- Test: `packages/main/src/server/modules/ourdream/admin-console.test.ts` 增量

**Interfaces:**
- Produces: `POST admin/content/characters/{id}/chat-tools` body `{ imageToolEnabled: boolean, reason: string(≥3) }`，permission `content.production.write`，效果 = merge `Character.advancedDetails.imageToolEnabled`（immutable merge：读现有 advancedDetails object spread 后 update），写 `writeAudit`；GET 不需要（角色详情已带 advancedDetails 或由视图消费）。
- 档位开关无需新 UI：`image_tool_enabled` 权益旗标走既有 plan entitlements 机制（运营在既有 plan/entitlement 管理面配 `image_tool_enabled=false` 即可），在 docs 里写清楚即可。

- [ ] **Step 1: RED**（admin-console.test.ts：403 for support；POST false → DB `advancedDetails.imageToolEnabled === false` 且原有 advancedDetails 键保留；POST true 翻回）→ **Step 2: 实现** → **Step 3: 绿 + typecheck + lint** → **Step 4: Commit**

```bash
git commit -m "feat(admin): per-character chat image tool toggle (advancedDetails flag + audit)"
```

---

### Task 7: 端到端验收 + live 走查 + 文档

**Files:**
- Modify: `packages/chat/test/web.test.ts`（验收用例）
- Modify: `docs/superpowers/specs/2026-07-07-image-generation-redesign-design.md`（§7 P4 行 ✅ + §8.3 标注 FC 探测已过）
- Modify: `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`（P4 条目）

- [ ] **Step 1: 验收集成测试（spec §7 P4 验证标准机器化）**

web.test.ts 新用例，全链走 mock seam：带护照角色 → 用户发「发张自拍」→ FC mock 返回 tool_calls → 断言同一条 assistant 消息**既有文本又有 attachment**（text+image 同回合）+ outbox requested 带 visualProfileId + prompt 含身份 token → `consumeInbound` 模拟 accepted/completed(带 summary) → attachment completed → 用户再发「换个场景，去雪山」→ 再次 FC 触发新 attachment，且本轮模型消息上下文含 `[You sent a photo:`（结果感知）。

- [ ] **Step 2: 全量 gates**

Run:
```bash
cd /Users/kk/code/idream/packages/chat && bun run test
cd /Users/kk/code/idream/packages/main && bunx vitest run src/server/modules/ourdream/admin-console.test.ts src/processes/event-consumer.test.ts src/server/modules/ourdream/image-generation-service.test.ts
cd /Users/kk/code/idream && bun run check
```

- [ ] **Step 3: Live 走查（真模型 + 真服务）**

1. oMLX 已在 :8061（启动命令见「前置事实」）。`bun run launch:probe:chat` 冒烟真模型。
2. 起 chat 服务（真 PG + CHAT_MODEL_PROVIDER=openai）向 BFF/chat API 发「发张自拍」：断言响应流含文本 + attachment(requesting) + outbox 记录（main/gen 不必真跑图——完整跑图属可选加分：若 ComfyUI(:8188) 与 gen worker 可起，则走通全链拿真图并记录耗时；不可行则记录障碍，mock 链验收已覆盖协议正确性）。
3. 结果记入报告 + 文档。

- [ ] **Step 4: 文档更新 + Commit**

```bash
git add -A && git commit -m "feat(chat): P4 acceptance e2e + docs (chat agent image loop, spec P4 done)"
```

---

## Self-Review 记录

- **Spec §6 覆盖**：6.1 注册表=Task 2 + 开关（档位 Task 4 / 角色 Task 6）；6.2.2 FC 优先+planner 兜底+正则门保留=Task 1+3；6.2.3 文本图同回合=Task 3；6.2.4 结果感知=Task 5；6.2.5 护照注入前移=Task 4；6.3 链路不动=全程约束。验证标准「发张自拍/换个场景端到端+一致性」=Task 7 Step 1（机器化）+ Step 3（真模型）。
- **刻意不做（YAGNI）**：`editLastImage`（Qwen-Edit img2img 聊天工具）——「换个场景」用 generate_image 新场景 + 护照一致性即可满足验收；注册表结构已为其留位，等真实需求。MCP/skill 机制按 spec §8.3 裁决不用。traits→identityPrompt 派生链修正（spec §2.2.1）不在 P4 ——那是护照对象自身的重构，注入用现成 identityPrompt 字段即可。
- **不丢功能核对**：planner 全路径保留（provider 不支持 tools / FC 空结果 / FC 异常三重兜底）；开关全默认 true；工具 wire 名与 attachment 元数据形状不变（trigger 新增值不删旧值）；confirmImageAttachment 重试路径在 Task 4 一并携带 visualProfileId。
- **类型一致性**：`ChatToolDefinition/ChatToolCall`（T1）→ `toChatTool/registryChatTools`（T2）→ generate.ts 消费（T3）；`imageToolEnabled` 贯穿 SQL 列名（snake）→ snapshot（camel）→ policy（T4）→ admin 写入端（T6）。
- **SQL 唯一且幂等**：一个文件、CREATE OR REPLACE、无表结构变更；测试库自动带上，dev/prod 用户执行（或本会话特权放行时由我执行）。
