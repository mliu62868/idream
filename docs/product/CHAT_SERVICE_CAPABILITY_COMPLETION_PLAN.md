# Chat Service 能力补全修复方案

更新日期：2026-06-27

## 实施进度（2026-06-27）

**Phase 1（P0 语义修复）已完成并通过测试**（chat 60 用例 + main 190 用例全绿，两包 typecheck 干净）：

- P0-A：chat 成为硬依赖——`dispatchV1` 对 `chat`/`messages` 始终走 BFF 代理，未配置 `CHAT_SERVICE_URL` 时返回结构化 `503 chat_unavailable`；env 注释已更新。
- P0-B：blocked 输入返回 `status="blocked"` + `streamUrl=null` + `safety`，BFF 映射为安全提示，Chat UI 不再开启空流。
- P0-C：免费额度改为每日 30 条（UTC day），`chat_usage` 按日粒度；402 文案 “Daily free message limit reached.”，UI 保留输入并给升级入口。
- P0-D：`resolvePolicy` 经 `CHAT_MODEL_FREE/PREMIUM/DELUXE` 别名映射真实模型并下发给 provider，`message.model` 落库。
- P0-E：no-memory 会话不写 `session.jsonl`、不派生长期记忆。
- P0-F：inbox `user.deleted` → 调用 `deleteAccount` 擦除（PG + 文件层）并发 `chat.account_erasure.completed`；主站 `deleteRequest` 投递 `user.deleted` 到 chat inbound 队列。
- P0-G：boundaries 与普通 memory 检索拆分；boundaries 每轮全量读取、读失败 fail-closed，不随 memory 超时降级。

**Phase 2/3（P1 产品化、probe、文档）已完成**：

- P1-A：Chat 管理 UI（`ChatHeaderControls/MessageActions/ChatSessionListDrawer/MemoryPanel/RelationshipBadge/MemoryToggle`）接入 regenerate/delete/归档/会话列表/记忆查看编辑删除/记忆开关/关系标签/重置关系。
- P1-B：relationship 状态注入模型 system prompt（定性 stage tone + summary，不暴露数值），并提供 reset。
- P1-C：记忆**合并入库**（dedup 同类同义、union 来源、取高置信）+ 分层**存储上限**（Free 30 / Deluxe 90 = 3×），boundary 单独文件不被普通偏好覆盖、不被淘汰；UI 不暴露 confidence。
- P1-D：Upgrade/Profile 具体 chat 权益文案。
- P1-E：Chat→Generate 深链（`?characterId=`）。
- probe：`probe-chat-service` 扩展 create/send/stream/get/no-memory/blocked 端到端 smoke。
- 文档：PRD 同步 blocked 发送响应。

仍待（运行栈相关）：§10.3 UI E2E 与 probe smoke 已写好，需完整运行栈（dev server + chat service + redis + pg）方可实跑。

## 1. 目标

本方案修复当前 Chat 产品承诺与实现之间的差距。

产品页已经承诺：

- long-memory roleplay。
- 公开或私有角色聊天。
- 探索、创建、聊天、生成之间不丢上下文。
- Premium unlimited messages/audio，Deluxe premium chat models + 3x chat memory。
- 用户可举报、删除、关闭记忆、删除账号。

当前代码状态是：Chat Service 后端骨架已经较完整，但主站 UI 只接入基础会话、发消息、SSE、举报；部分经济、隐私和模型权益语义还没有对齐。因此本方案不是重新拆服务，而是把 Chat 从“技术上可用”补齐成“产品上可信”。

## 2. 范围

### 本方案包含

- 修正权益、额度、模型、隐私、blocked 状态等 P0 语义问题。
- 把已经存在的 Chat Service 管理能力接入主站 UI。
- 补齐 Chat Service 缺少的产品能力：会话管理、记忆中心、关系状态、消息操作、导出/删除闭环。
- 增加能证明这些能力的服务级、BFF、UI E2E 和 launch probe。
- 同步现有文档中已经漂移的口径。

### 本方案不包含

- 重做角色创建器或生成器完整视觉设计。
- 真实公开上线 provider 接入：Safety Gateway、Go.cam、BTCPay、R2/S3、Sentry 仍按 `REMAINING_WORK_EXECUTION_PLAN.md` 的 2026-06-26 决策延后。
- Group chat 的完整多角色编排。
- 大规模分布式 Chat FS 扩容。当前仍接受 `chat` 单实例本地文件层约束。

## 3. 当前诊断

### 3.1 已经具备的基础能力

Chat Service 已经支持：

- BFF 签名与主站反代。
- 只读 view 复查 user、character、entitlement、eligibility。
- 创建、列表、读取、删除/归档会话。
- 发消息：事务写 user message + assistant placeholder，入队生成。
- Redis Stream SSE。
- regenerate。
- no-memory 开关。
- memories list/edit/delete。
- relationships list/get/patch/delete。
- 输入/输出 moderation 轨迹。
- chat usage。
- chat outbox / inbox。
- stuck generation reconcile。
- 文件层 memory / relationship / session jsonl。

### 3.2 关键缺口

| 优先级 | 缺口 | 风险 |
| --- | --- | --- |
| P0 | 主站 UI 没有 regenerate、delete、archive、memory、relationship、no-memory 入口 | 后端能力存在但用户无法使用，产品承诺无法兑现 |
| P0 | blocked 输入仍返回 streamUrl，前端会表现成“回复失败” | 安全拦截被误解为系统故障 |
| P0 | free quota 文档为“每日 30 条”，代码为“每月 50 条” | 经济模型与产品口径冲突 |
| P0 | policy 算出 free/premium/deluxe model，但 provider 实际使用单一 env model | Deluxe “premium chat models” 可能是假权益 |
| P0 | no-memory 会话仍写 `session.jsonl` | “不记忆/隐身”语义不完整 |
| P0 | `user.deleted` inbox 目前主要归档 session，不保证执行 Chat 域删除 | 账号删除不能证明聊天域清理完成 |
| P0 | `CHAT_SERVICE_URL` 注释仍说 unset 走 monolith，但实际 chat handler 已移除 | 运维误配会导致 Chat API 404/不可用 |
| P1 | relationship 被写入但未注入上下文，也没有产品展示 | 关系进展对用户体感弱 |
| P1 | memory 派生仍是启发式正则 | “长期记忆”质量不足 |
| P1 | Upgrade 页面没有清楚表达 chat 权益 | Premium/Deluxe 价值不清晰 |
| P1 | 测试只覆盖基础收发与历史保留 | 缺少对核心差异化能力的回归保护 |

## 4. 修复原则

1. **先修语义，再修体验。** 额度、隐私、模型、blocked 状态必须先对齐，否则 UI 越完整越容易放大错误承诺。
2. **Chat Service 是聊天域权威。** 主站只负责认证、BFF、角色/用户/权益权威、聚合投影和页面体验，不重新写 chat domain。
3. **用户控制必须有可验证效果。** 删除消息、删除记忆、关闭记忆、删除账号都必须落到权威层，而不是只从 UI 隐藏。
4. **边界记忆优先于普通记忆。** 记忆降级可以丢共同经历，不可丢用户边界。
5. **权益必须可观测、可测试、可解释。** Premium/Deluxe 的模型、上下文窗口、记忆深度、额度都要有服务端 enforcement 和 UI 文案。
6. **所有跨服务副作用走事件。** 最近聊天、usage、safety、memory/relationship 更新都走 outbox/inbox 或投影，不走同步热路径。

## 5. 目标产品能力

### 5.1 Chat 主界面

用户在 `/chat/:sessionId` 应看到：

- 角色名称、头像、关系阶段标签。
- 记忆状态：Memory on / No-memory。
- 会话操作：返回 Explore、会话列表、归档/删除、重命名。
- 消息操作：Regenerate、Delete、Report。
- blocked/quota/provider failure 的明确状态文案。
- 从当前角色进入 Generate 的入口。

P0 不做复杂编辑器。P1 再做“编辑上一条消息”。

### 5.2 会话列表

入口：

- 左侧 Chat nav。
- My AI recent tab。
- Chat 页面 mobile drawer。

能力：

- 查看最近 50 个非 deleted session。
- 继续会话。
- 归档。
- 删除。
- 空态引导 Explore / Create。

### 5.3 记忆中心

入口：

- Chat header 的 Memory 菜单。
- Profile 的 Privacy / Memory 区块。

能力：

- 查看当前角色记住的内容。
- 查看全局 boundaries。
- 编辑记忆文本。
- 删除单条记忆。
- 当前会话关闭/打开长期记忆。
- 说明 no-memory 的真实含义：不读长期记忆、不写新长期记忆、不写长期 agent trace；普通消息历史仍保存在当前会话，除非删除会话。

### 5.4 关系状态

P0：

- 在 Chat header 或角色详情中低调展示定性标签：初识、熟识、亲近、亲密。
- 不展示数值、进度条、升级倒计时。

P1：

- relationship summary 注入模型上下文。
- 用户可 reset relationship。
- 长时间不互动的回落作为后台策略，不做负面通知。

### 5.5 权益体验

Upgrade、Profile、Chat blocked/quota 状态必须表达：

- Free：有限文字消息，基础模型，基础记忆。
- Premium：unlimited messages/audio，更长上下文，生成高级控制。
- Deluxe：premium chat model，3x chat memory，更高速率，更深上下文。

不要只写 “account-wide benefits”。

## 6. P0 修复计划

### P0-A：Chat Service 成为显式硬依赖

问题：

- `CHAT_SERVICE_URL` 注释仍说 unset 走 monolith，但 monolith chat handler 已清理。

修改：

- 主站 env 注释改为：非 test/dev smoke 下 Chat 必须配置 `CHAT_SERVICE_URL`。
- `dispatchV1` 对 `resource === "chat" || resource === "messages"` 且未配置 `CHAT_SERVICE_URL` 时返回 `503 chat_unavailable`，不要落到 “API route not found”。
- launch readiness 增加 hard check：内部 demo / controlled beta 只要 Chat nav 暴露，就必须通过 chat service probe。
- README / runbook 写清 `CHAT_SERVICE_URL=http://127.0.0.1:3100` 与共享 `CHAT_BFF_SIGNING_SECRET`。

验收：

- 未配置 Chat Service 时 `/api/v1/chat/sessions` 返回结构化 503。
- 配置后 BFF signed request 200，unsigned request 401。

### P0-B：blocked 输入的用户体验和协议

问题：

- 输入 moderation blocked 时后端不会 enqueue，但仍创建 blocked assistant 并返回 streamUrl；前端会等空流。

目标协议：

```json
{
  "userMessageId": "msg_user",
  "assistantMessageId": "msg_assistant",
  "status": "blocked",
  "safety": {
    "layer": "input",
    "policyCode": "age_under_18"
  },
  "streamUrl": null
}
```

修改：

- `sendMessage` blocked 时返回 `status=blocked`，不返回 streamUrl。
- BFF adapter 映射为 `{ userMessage, assistant: { status:"blocked", content:"I can’t help with that request." } }`。
- Chat UI 检测 `assistant.status === "blocked"`，显示安全提示，不启动 EventSource。
- 输出 moderation blocked 时 SSE 发送 `error` 或 `done` 后，GET session 中 assistant status 为 blocked，UI 显示安全提示。

验收：

- blocked 输入不会出现 “Reply failed to load”。
- moderation event 和 report/admin 队列仍有记录。

### P0-C：额度口径统一

问题：

- `ECONOMY_AND_PRICING.md` 写 Free 每日 30 条，代码常量是每月 50 条。

决策：

- 采用产品经济文档口径：Free 每日 30 条。
- Paid entitlement `unlimited_messages=true` 短路消息条数限制，但仍记录 usage analytics。

修改：

- `FREE_MONTHLY_MESSAGES` 改为 `FREE_DAILY_MESSAGES = 30`。
- `currentUsage` 改用 UTC day period。
- `finalize` 的 `chat_usage` period_start/period_end 同步改为 day period，或新增 `period_kind`。P0 推荐直接日粒度，避免 schema 扩张。
- 错误码保持 `quota_exceeded`，message 改为 “Daily free message limit reached.”
- Chat UI 收到 402 时展示升级入口，并保留用户输入。

验收：

- 第 31 条免费消息返回 402。
- Premium 用户不受 30 条限制。
- Profile/Upgrade 文案与 economy 一致。

### P0-D：Deluxe/Premium 模型权益真实生效

问题：

- `resolvePolicy` 返回 `model`，但 provider 调用使用单一 `CHAT_MODEL_NAME`。

修改：

- `ChatModel.stream` input 增加 `model?: string`。
- `processGenerate` 调用 provider 时传 `context.policy.model`。
- 增加 model alias 映射：

```env
CHAT_MODEL_FREE=Qwen3.5-0.8B-8bit
CHAT_MODEL_PREMIUM=Qwen3.5-4B-MLX-4bit
CHAT_MODEL_DELUXE=Qwen3.5-14B-MLX-4bit
```

- `resolvePolicy` 返回实际 provider model key，或者返回 tier model alias 后由 provider map 到真实 model。P0 推荐在 policy resolver 中集中映射，避免 provider 知道产品 tier。
- `message.model` 写入实际使用的 model。
- Upgrade 页面列出 Deluxe premium model。

验收：

- Free / Premium / Deluxe 发消息后 `messages.model` 不同或至少 Deluxe 使用明确 plus model。
- provider test 断言 request body 的 `model` 来自 policy，而不是固定 env。

### P0-E：no-memory / incognito 语义修复

问题：

- `memory_enabled=false` 不派生长期记忆，但仍写 `session.jsonl`。

产品语义：

- No-memory 会话不读取长期记忆。
- No-memory 会话不写新长期记忆。
- No-memory 会话不写长期 agent trace；如必须为故障排查保留，应为短 TTL ephemeral 且不可用于记忆派生。P0 推荐不写。
- PG messages 仍作为当前会话历史存在，用户可删除会话清理。

修改：

- `processGenerate` 在 `session.memoryEnabled === false` 时跳过 `appendLine(sessionLog)`。
- `chat.memory.extract` 保持 no-memory gate。
- `deleteSession` 继续删除 session files，兼容旧数据。
- Chat UI memory toggle 文案清楚说明。

验收：

- no-memory 会话发消息后没有 `sessions/{user}/{session}.jsonl`。
- 不生成 `memory.md` / `relationship.md` 更新。
- 后续开启 memory 后只从开启后的消息派生。

### P0-F：账号删除执行 Chat 域擦除

问题：

- `deleteAccount` 已存在，但 inbox 处理 `user.deleted` 只归档 active sessions，不能证明文件层和 chat rows 被清理。

修改：

- `consumeInbound(user.deleted)` 调用 Chat 域擦除 workflow。
- 擦除 workflow：
  - 删除/匿名化 chat_sessions/messages/message_versions/chat_usage。
  - 删除 `sessions/{userId}/`。
  - 删除 `mem/{userId}/`。
  - 写 `chat.account_erasure.completed` outbox。
- 主站 account deletion 不只标记 user，还要通过 main outbox 投递 `user.deleted` 并等待/记录完成事件。
- Admin/Profile 显示删除请求状态。

验收：

- 触发账号删除后 Chat Service 文件层为空。
- 主站收到 `chat.account_erasure.completed`。
- 后续 BFF 请求被 eligibility view 阻断。

### P0-G：边界记忆不可降级

问题：

- 当前 `retrieveMemories` 返回 boundaries + memories，但 `context.ts` 外层 timeout fallback 会把 boundaries 也降级为空。

修改：

- 将 boundaries 读取和普通 memories 检索拆开。
- boundaries 每轮全量读取，使用短缓存和明确失败告警。
- 普通 memories 可超时降级为空或 recency。
- 如果 boundaries 文件读取失败：P0 推荐 fail closed，生成 blocked/failed，并写内部告警；不要冒险越界。

验收：

- 模拟普通 memory retrieval timeout，boundaries 仍注入 prompt。
- 模拟 boundaries 文件读取失败，服务不生成越界回复。

## 7. P1 产品化计划

### P1-A：Chat UI 接入已有管理 API

新增组件：

- `ChatHeaderControls`
- `ChatSessionListDrawer`
- `MessageActions`
- `MemoryPanel`
- `RelationshipBadge`

接入 API：

- `GET /api/v1/chat/sessions`
- `POST /api/v1/chat/sessions/:id/archive`
- `DELETE /api/v1/chat/sessions/:id`
- `DELETE /api/v1/messages/:id`
- `POST /api/v1/messages/:id/regenerate`
- `POST /api/v1/chat/sessions/:id/memory`
- `GET/PATCH/DELETE /api/v1/chat/memories`
- `GET/PATCH/DELETE /api/v1/chat/relationships/:characterId`

注意：

- 管理端点目前 BFF 多数是 raw passthrough。前端要么按 raw 协议消费，要么把 BFF adapter 扩成统一 `{ ok, data }`。推荐 P1-A 统一 BFF envelope，降低前端分支。

验收：

- 用户可以在 UI 中 regenerate 最近 assistant 消息。
- 用户可以删除消息，刷新后不再出现。
- 用户可以关闭当前会话记忆。
- 用户可以查看/删除一条记忆。
- 用户可以打开会话列表并继续旧会话。

### P1-B：Relationship 注入上下文与展示

修改：

- `buildContext` 读取 `relationship.md`。
- `BuiltContext` 增加 `relationshipState`。
- system prompt 注入定性关系状态和 summary。
- Chat header 展示阶段标签：初识/熟识/亲近/亲密。
- Profile/Memory center 提供 reset relationship。

验收：

- 多轮互动后 relationship stage 更新。
- 后续回复 prompt 中包含 relationship summary。
- Reset 后 stage 回到初识。

### P1-C：记忆质量升级

当前 heuristic 只能识别少数句式。升级路径：

1. 候选派生：
   - 使用小模型或 igrep derive，从最近 turn/session jsonl 中抽取候选。
   - 输出 JSON schema：type、scope、text、confidence、source_message_ids。
2. 守卫：
   - `canMemorize` 回查 PG 状态。
   - sensitive / blocked / deleted / no-memory 拒绝。
3. 合并：
   - 同类记忆去重。
   - 新高置信覆盖旧低置信。
   - boundary 不被普通 preference 覆盖。
4. 上限：
   - Free/Premium baseline。
   - Deluxe 3x stored + retrieved top-K。
5. 可解释：
   - Memory UI 展示“来自最近对话”即可，不暴露内部 confidence。

验收：

- 同一偏好多次出现不会无限追加重复行。
- 删除 source message 后派生记忆被删除。
- Deluxe top-K 大于 Free。

### P1-D：Upgrade / Profile 文案与权益展示

修改：

- Upgrade plan cards 显示：
  - Free: limited daily messages, basic model, base memory。
  - Premium: unlimited messages/audio, longer context, generation controls。
  - Deluxe: premium chat model, 3x memory, higher rate limit。
- Profile 显示当前 chat entitlement：
  - daily messages remaining for Free。
  - unlimited messages for Premium/Deluxe。
  - memory tier。
  - model tier。
- Chat quota modal 链到 Upgrade，并解释不会丢当前输入。

验收：

- 免费用户超额时看到升级入口。
- Deluxe 用户能在 Profile 看到 3x memory / premium model。

### P1-E：Chat 与 Generate 联动

修改：

- Chat header 增加 Generate 入口：`/generate?characterId=...`。
- Generate 读取 query characterId 并默认选中角色。
- 可选：从当前聊天中生成图片时带最近会话摘要作为 prompt suggestion，但不自动提交。

验收：

- 从 Chat 点 Generate 后角色选择器预选当前角色。
- 不泄露 no-memory 会话内容到 Generate prompt。

## 8. P2 / 后续增强

- 消息编辑：只影响编辑后的未来对话，不回溯重写已派生记忆。
- 语音消息 / voice call：
  - text chat 0 dreamcoin。
  - TTS/audio message entitlement gate。
  - voice call 按 `ECONOMY_AND_PRICING.md` 计费。
  - voice transcript 可选择是否进入记忆。
- Group chat：
  - conversation_participants。
  - 多 persona prompt orchestration。
  - group memory 与单角色 memory 分层。
- DB replay stream：
  - P0 Redis Stream + final PG message 足够。
  - 未来如需强 replay，补 `chat_stream_events` 短 TTL 表。

## 9. 数据与 API 变更清单

### 9.1 API 响应调整

`POST /api/v1/chat/sessions/:id/messages`

新增字段：

```ts
type SendMessageResponse = {
  userMessageId: string;
  assistantMessageId: string;
  streamUrl: string | null;
  status: "generating" | "blocked";
  safety?: {
    layer: "input" | "output";
    policyCode?: string;
  };
};
```

`GET /api/v1/chat/sessions/:id`

应包含：

```ts
type SessionResponse = {
  session: {
    id: string;
    title: string | null;
    characterId: string;
    memoryEnabled: boolean;
    memorySummary: string | null;
  };
  messages: Message[];
  relationship?: {
    stage: "new" | "familiar" | "close" | "committed";
    summary?: string;
  };
};
```

### 9.2 Provider contract

```ts
interface ChatModel {
  stream(input: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    characterName?: string;
  }): AsyncIterable<ChatChunk>;
}
```

### 9.3 Usage period

P0 推荐将 chat usage 改为日粒度：

- `period_start = UTC day start`
- `period_end = next UTC day`
- unique key 仍可用 `user_id + period_start`

如果后续需要同时日/月统计，再新增 `period_kind`，不要在 P0 扩 schema。

## 10. 测试计划

### 10.1 Chat Service 单元/集成测试

新增或补齐：

- `sendMessage`：
  - happy path 写 user + assistant placeholder。
  - blocked input 返回 no streamUrl。
  - quota exceeded 返回 402。
  - inactive user / removed character / underage character 被拒绝。
- `processGenerate`：
  - provider chunks 写 Redis Stream。
  - finalize 幂等，不重复 usage。
  - output blocked 写 moderation/outbox。
  - no-memory 不写 session jsonl，不 enqueue memory extract。
  - policy model 传给 provider。
- `regenerate`：
  - attempt 增加。
  - selected message_version 翻转。
  - dedupe key 包含 attempt。
- `privacy`：
  - deleteMessage 清派生 memory。
  - deleteSession 清 jsonl。
  - deleteAccount 清 PG + sessions + mem。
- `inbox`：
  - user.deleted 调用 account erasure。
  - character.removed 阻断 active sessions。
- `context`：
  - normal memories 超时可降级。
  - boundaries 不随普通 memory timeout 丢失。
  - relationship 注入。

### 10.2 BFF 测试

- 未登录返回 401。
- 未配置 service 返回 503。
- blocked send response 被正确 envelope。
- regenerate/delete/memory/relationship endpoint envelope 一致。
- 不转发 cookie。
- HMAC 覆盖 body，tamper body 被 Chat Service 拒绝。

### 10.3 UI E2E

- Chat happy path：开始聊天、收流、刷新历史保留。
- Blocked input：展示安全提示。
- Quota：免费用户超额出现升级 CTA，输入保留。
- Regenerate：assistant 内容更新，历史仍一致。
- Delete message：刷新后不出现，记忆 source 清理。
- Memory panel：关闭记忆后发消息，不新增 memory。
- Relationship badge：多轮后阶段显示。
- Session list：继续、归档、删除。
- Generate link：从 chat 带 characterId 进入 generate。

### 10.4 Launch probe

扩展 `probe-chat-service`：

- healthz。
- signed list sessions。
- unsigned 401。
- create session。
- send message。
- stream receives start/delta/done。
- GET session sees assistant sent。
- no-memory smoke。
- blocked moderation smoke when mock/safety provider supports test term。

## 11. 文档同步计划

需要同步的文档：

- `docs/product/ECONOMY_AND_PRICING.md`
  - 确认 Free 每日 30 条，代码按日粒度实现。
- `docs/product/CHAT_SERVICE_PRD.md`
  - 补充 blocked send response。
  - 补充 no-memory 不写长期 agent trace。
  - 补充 account erasure event flow。
- `docs/architecture/14-chat-service-tech-design.md`
  - 更新 P0/P1 已完成状态与仍待产品化项。
  - 明确 boundaries 不可降级。
- `PLAN.md`
  - 保持“服务拆分完成”，但链接本能力补全计划，避免误读成产品能力全完成。
- `docs/product/BackendFeatureSpec.md`
  - 去掉或标注旧的 `companion_memories` / `relationship_states` PG 表描述，改为文件层权威。
- `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`
  - 更新 Chat 覆盖不只“基础可用”，而是列出本计划完成后的能力。

## 12. 实施顺序

### Phase 1：语义修复

1. Chat service hard dependency / 503。
2. blocked send 协议与 UI。
3. free daily quota。
4. policy model 传给 provider。
5. no-memory 不写 session jsonl。
6. user.deleted 执行 Chat account erasure。
7. boundaries 不降级。

完成标准：

- Chat Service 单元/集成测试覆盖以上 7 项。
- `bun run --filter @idream/chat test`
- `bun run --filter @idream/main test:unit -- src/server/bff/chat-proxy.test.ts`

### Phase 2：产品 UI 接入

1. Chat header controls。
2. Message actions。
3. Session list drawer。
4. Memory panel。
5. Relationship badge。
6. Upgrade/Profile chat entitlement 文案。
7. Generate link。

完成标准：

- Chat UI E2E 覆盖。
- 移动端 390px 无遮挡。
- blocked/quota/no-memory 状态可见且可恢复。

### Phase 3：记忆质量与测试加固

1. relationship 注入 prompt。
2. semantic memory extraction / consolidation。
3. tier-based memory caps。
4. account export UI/API 接入。
5. expanded chat-service probe。

完成标准：

- 记忆跨会话可证明。
- 删除/关闭记忆可证明。
- Deluxe 3x memory 可证明。
- pipeline probe 和 chat E2E 通过。

## 13. 成功指标

### 产品指标

- Chat start success rate。
- First assistant response success rate。
- Stream recovery success rate。
- Regenerate usage rate。
- Memory panel usage / deletion rate。
- Quota-to-upgrade click rate。
- Report submission rate and safety action latency。

### 工程指标

- Chat generation timeout rate。
- Memory retrieval degradation rate。
- Boundary read failure count。
- Stuck `generating` reconciled count。
- Outbox pending/failed count。
- Account erasure completion latency。

### 体验指标

- 用户刷新后历史保留。
- blocked 状态不再被用户误解为系统失败。
- Free/Premium/Deluxe 权益在 UI 和服务端行为一致。
- No-memory 的实际存储行为与文案一致。

## 14. 最终验收清单

- [ ] `/api/v1/chat/*` 未配置 service 时结构化 503。
- [ ] signed BFF 可用，unsigned 401。
- [ ] Free 每日 30 条限制生效。
- [ ] Premium unlimited messages 生效。
- [ ] Deluxe 使用 premium chat model。
- [ ] blocked input 显示安全提示，无空流等待。
- [ ] no-memory 不读长期记忆、不写新长期记忆、不写长期 session jsonl。
- [ ] boundaries 在普通 memory timeout 时仍注入。
- [ ] 删除消息会清 source-linked memory。
- [ ] 删除账号会清 Chat PG + file layer，并发完成事件。
- [ ] UI 可 regenerate / delete / report message。
- [ ] UI 可 list/archive/delete sessions。
- [ ] UI 可查看/编辑/删除 memories。
- [ ] UI 可 reset relationship。
- [ ] Upgrade/Profile 清楚展示 chat 权益。
- [ ] Chat → Generate 带当前 character。
- [ ] Chat service probe 覆盖 create/send/stream/get/no-memory/blocked。
- [ ] 相关文档口径同步完成。

