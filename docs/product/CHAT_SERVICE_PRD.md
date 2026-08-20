# Chat Service PRD 与主站只读协议

> 目标：定义独立 Chat Service 的产品能力、数据库边界、主站只读数据协议、记忆系统、关系状态、流式生成、合规控制和跨服务事件。本文取代旧的“主站落聊天数据 + chat worker 推理 + 主站 finalizer”模式。

## 1. 定位

Chat Service 不是一个简单 LLM proxy，也不是主站后台 worker。它是 AI 伴侣 / 角色扮演的产品权威，拥有聊天域数据库并通过单一 DSH runtime 执行每一轮；官方 igrep plugin 在 Chat 划定的 relationship workspace 内负责通用记忆的检索和写入生命周期。

新的核心边界：

- **Chat Service 拥有 chat domain**：会话、消息、消息版本、Soul/PreparedTurn、Scene/relationship/boundaries、workspace scope、聊天用量、流式事件、聊天审核轨迹、聊天 outbox 事件。
- **主站拥有 core domain**：用户账号、登录会话、角色创建与审核、公开角色目录、订阅/权益权威、年龄/身份验证权威、SEO、library 聚合和全站后台。
- **Chat Service 可以读主站 User 和角色表**：通过只读 DB role、view/read model 或只读副本读取必要字段，不能写主站权威表。
- **主站不参与 chat 热路径落库**：发消息、流式输出、上下文检索、记忆写入、relationship 更新都在 Chat Service 内完成。

关键边界：**主站是 user / character / billing / compliance 的权威源；Chat Service 是 session / message / relationship / workspace scope 的权威源；DSH 内的官方 igrep plugin 是通用记忆 lifecycle authority。** 两边可以共用 ID，不共享可变业务表写权限。

## 2. 产品目标

P0 目标：

- 角色能记住当前会话上下文。
- 角色能跨会话记住用户明确表达的偏好、基本事实、边界和共同经历。
- 用户刷新页面、断开 SSE、worker 重试后，不丢任务、不丢最终消息。
- 用户删除消息、关闭记忆、重置整段 relationship 或删除账号后，后续回复不再从相应 Chat authority 构建上下文。
- Premium/Deluxe 权益影响模型、最近消息窗口和速率限制；产品不在官方 plugin 之外另造自定义记忆容量或逐条管理层。
- Chat 热路径不依赖主站 API 同步调用。

P1 目标：

- 关系状态随互动稳定演进，例如熟悉度、信任、亲密语气、共同经历。
- 用户可在设置里开关记忆并重置整个 relationship；不提供官方 plugin 尚未支持的逐条 list/edit/delete。
- 每个 user/character relationship 使用独立 workspace，不建立跨角色的第二套全局记忆权威。
- 支持 incognito / no-memory chat。
- 支持 voice call、图片生成上下文、group chat 的记忆复用。

非目标：

- Chat Service 不写 `users`、`accounts`、`sessions`、`characters`、`subscriptions`、`age_verifications` 等主站权威表。
- Chat Service 不负责角色创建、公开发布、SEO 内容、公开目录排序和创作者后台。
- Chat Service 不直接处理支付 provider webhook。
- Chat Service 不读取密码哈希、OAuth token、账单详情等不需要的敏感字段。

## 3. 数据所有权

| 数据 | 权威归属 | Chat Service 权限 |
|------|----------|-------------------|
| User account / auth session | 主站/Auth | 只读必要字段或接收已签名用户上下文 |
| User profile display fields | 主站 | 只读 |
| User status / deletion status | 主站 | 只读，必须在热路径检查 |
| Character / girlfriend persona | 主站/角色系统 | 只读 |
| Character visibility / moderation status | 主站/角色系统 | 只读，必须在建会话和发消息时检查 |
| Entitlement / plan tier | 主站/Billing | 只读快照或只读 view |
| Age verification / eligibility | 主站/Compliance | 只读，必须在受限内容前检查 |
| Chat sessions | Chat Service | 读写权威 |
| Messages / message versions | Chat Service | 读写权威 |
| Chat usage / metering | Chat Service | 读写权威，向 billing/analytics 发事件 |
| Companion recall/write | DSH 内的官方 igrep plugin | Chat 定义 relationship scope、开关、私密隔离和整段重置，不解释或改写 item 格式 |
| igrep workspace/index | DSH sidecar | 普通 relationship 可持久化且可按 Chat transcript 重建；私密 turn 仅临时 workspace |
| Relationship state | Chat Service | 读写权威 |
| Chat moderation trace | Chat Service | 读写权威，同时可向主站 safety/admin 发事件 |
| Global safety policy | 主站/Safety | Chat 只读 policy snapshot 或调用独立 moderation provider |

这个边界避免三类问题：

- 主站不再成为 chat 热路径瓶颈。
- 用户聊天、relationship 与 companion workspace 有清晰且不重叠的写入权威。
- Chat 可以独立扩展 streaming、group chat 和 voice，而不复制主站用户/角色/支付逻辑或 official plugin 的 memory lifecycle。

## 4. 数据库拓扑

推荐生产拓扑：

```text
Postgres cluster
  core.users
  core.characters
  billing.entitlements
  compliance.age_verifications

  chat.chat_sessions
  chat.messages
  chat.message_versions
  chat.chat_usage
  chat.chat_moderation_events
  chat.chat_outbox_events
  chat.chat_inbox_events            # Main→Chat 入站事件
  # Scene / relationship / boundaries 由 Chat 文件投影持有；通用记忆只在 DSH/igrep workspace
  # chat_stream_events: P0 仅 Redis Stream，DB replay 表可选
```

Chat Service 使用专用 DB role：

```text
GRANT SELECT ON core.chat_user_view TO chat_service;
GRANT SELECT ON core.chat_character_view TO chat_service;
GRANT SELECT ON billing.chat_entitlement_view TO chat_service;
GRANT SELECT ON compliance.chat_user_eligibility_view TO chat_service;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA chat TO chat_service;
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core FROM chat_service;
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA billing FROM chat_service;
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA compliance FROM chat_service;
```

如果以后 Chat Service 使用独立数据库，则用 CDC、logical replication 或事件同步生成同名 read model。协议保持不变：Chat 只读 user/character/entitlement/eligibility，Chat 自己写聊天域。

## 5. 主站只读 View

不要让 Chat Service 直接读完整 `users` / `characters` 表。提供最小字段 view。

### 5.1 `core.chat_user_view`

```sql
SELECT
  id AS user_id,
  display_name,
  locale,
  status,
  deleted_at,
  updated_at
FROM core.users;
```

Chat 只需要判断：

- 用户是否存在。
- 用户是否 suspended/deleted。
- 显示名、语言和基础偏好。

### 5.2 `core.chat_character_view`

```sql
SELECT
  c.id AS character_id,
  c.creator_id,
  c.name,
  c.age,
  c.description,
  c.system_prompt,
  c.relationship,
  c.visibility,
  c.status,
  c.voice_id,
  c.updated_at
FROM core.characters c;
```

tags 可以通过 view 聚合为 JSON，也可以用 `core.chat_character_tags_view`：

```sql
SELECT
  character_id,
  json_agg(slug ORDER BY slug) AS tags
FROM core.character_tags_for_chat
GROUP BY character_id;
```

Chat 建会话和发消息时必须检查：

- `age >= 18`
- `status IN ('approved')`，或者角色归当前用户且允许私聊
- `visibility` 对当前用户可读

### 5.3 `billing.chat_entitlement_view`

```sql
SELECT
  user_id,
  model_tier,
  memory_multiplier,              -- 历史/预留字段，Phase 6 不映射为自研 memory cap
  unlimited_messages,
  voice_enabled,
  updated_at
FROM billing.current_chat_entitlements;
```

Chat 用它决定：

- 模型 tier。
- 上下文窗口；`memory_multiplier` 当前不改变 official igrep 行为。
- 免费消息额度是否生效。
- voice/group chat 等功能门。

### 5.4 `compliance.chat_user_eligibility_view`

```sql
SELECT
  user_id,
  age_gate_accepted,
  age_verified,
  jurisdiction,
  restricted_reason,
  updated_at
FROM compliance.current_chat_eligibility;
```

Chat 用它决定能否进入成人角色聊天、是否需要阻断或重定向。

## 6. Chat Service 权威表

### 6.1 `chat.chat_sessions`

```text
id
user_id
character_id
title
status                  active | archived | deleted
memory_enabled
memory_summary          # 历史可空 drain 字段；不进入运行时上下文或公共投影
last_message_at
created_at
updated_at
deleted_at
```

说明：

- `user_id` 和 `character_id` 引用主站 ID，但在独立 DB 拓扑下不做跨库 FK。
- `memory_summary` 只为既有 schema/历史行保留；Phase 6 不再读写它，也不把它投影给产品端。

### 6.2 `chat.messages`

```text
id
session_id
role                    user | assistant | system | tool
content
model
status                  pending | blocked | generating | moderating_output | sent | failed | deleted
token_count
safety_status           unknown | passed | flagged | blocked
created_at
updated_at
deleted_at
```

### 6.3 `chat.message_versions`

```text
id
message_id
content
model
selected
created_at
```

用于 regenerate、编辑候选和审计。重生成新增 version，不覆盖历史。

### 6.4 `chat.chat_usage`

```text
id
user_id
session_id
messages_used
period_start
period_end
created_at
updated_at
```

Chat Service 本地判定免费消息额度；每次成功 assistant reply 后写 usage，并通过 outbox 发 `chat.usage.incremented` 给主站 analytics/billing。

### 6.5 DSH/igrep relationship workspace

通用记忆没有 iDream 自定义 item 表或 `memory.md` 权威。官方 igrep plugin 在 DSH sidecar 内拥有 wake/search/ingest 生命周期；Chat 只提供不可绕过的产品边界：

- `memory_enabled=true`：按 `(user_id, character_id)` 使用唯一持久 workspace。
- 已迁移 relationship 复用已存在的 canonical workspace/proof；历史 marker 仅用于迁移审计，不是新请求 admission gate。
- 没有 workspace/proof 的 relationship 是合法的新关系，由 sidecar 原生初始化为空 workspace，绝不读取旧 `memory.md`。
- `memory_enabled=false`：使用临时 workspace，不写 canonical index/proof。
- Chat terminal commit ACK 后才允许本轮进入 plugin ingest；失败或结果不明保持可审计的 `unknown`，不得猜测成功。
- 官方 plugin 没有逐条 list/edit/delete seam，因此产品只提供记忆开关和 whole-relationship reset，不建立第二套 item authority。

### 6.6 `chat.relationship_states`（已迁文件层，非 PG 表）

> **更新**：关系状态改为**文件层权威**（`mem/{userId}/{charId}/relationship.md`），不再是 PG 表。下方字段保留为逻辑结构（文件 front-matter + 叙事 summary）。

```text
（逻辑字段，存于 relationship.md）
user_id
character_id
stage                   new | familiar | close | committed
summary
signals                 JSON
boundaries              JSON
version
created_at / updated_at
```

这些数值不是直接暴露给用户的游戏化指标，主要用于模型语气、上下文选择和关系连续性。**用户可见性的产品口径见 §16.1。**

### 6.7 `chat.chat_stream_events`

```text
id
assistant_message_id
stream_id
seq
type                    start | delta | done | error
payload
created_at
expires_at
```

Redis Stream 是实时通道；DB 表是可选的短期 replay / 审计补偿。生产可以只保留 Redis Stream + 最终 message，但如果需要强 replay，可落这张表。

### 6.8 `chat.chat_moderation_events`

```text
id
target_type             message | memory | session
target_id
layer                   input | output | memory
status                  passed | flagged | blocked
policy_code
confidence
details
created_at
```

Chat 自己保留聊天审核轨迹；高优先级事件通过 outbox 同步给主站 safety/admin。

### 6.9 `chat.chat_outbox_events`

```text
id
event_type
aggregate_type
aggregate_id
payload
status                  pending | delivered | failed
attempts
next_run_at
created_at
delivered_at
```

所有跨服务副作用走 outbox，避免“DB 已提交但事件没发”。

### 6.10 P1 预留表

```text
chat.conversation_participants
chat.voice_call_sessions
chat.memory_embeddings
chat.chat_inbox_events
```

## 7. 核心概念

### 7.1 Persona

角色设定由主站角色系统提供，Chat 只读：

```jsonc
{
  "characterId": "char_123",
  "name": "Sarah",
  "age": 24,
  "relationship": "girlfriend",
  "description": "...",
  "systemPrompt": "...",
  "tags": ["romance", "slow-burn"],
  "visibility": "public",
  "status": "approved"
}
```

Chat 可以把 persona 转成内部 prompt，但不能修改权威角色设定。角色编辑、下架、审核状态变化由主站发事件或通过 view 的 `updated_at` 被 Chat 感知。

### 7.2 Memory

通用记忆由官方 igrep plugin 解释，Chat 不复制它的类型、候选抽取、容量、淘汰或检索排序。Chat 保留四条第一性边界：

- 普通 turn 只能访问当前 user/character 的唯一持久 relationship workspace。
- no-memory/private turn 只能访问本次 attempt 的临时 workspace，且不得产生 canonical memory/proof。
- Scene、relationship state 与 boundaries 是 Chat 权威的独立 PreparedTurn 输入；尤其 boundaries 不依赖 igrep 检索。
- 只有 Chat terminal commit ACK 后才允许 official plugin ingest；blocked、failed、deleted 或未提交内容不能由 Chat 主动送入记忆。

### 7.3 Relationship State

关系状态是用户与某个角色之间的长期互动状态：

```jsonc
{
  "userId": "user_123",
  "characterId": "char_123",
  "stage": "familiar",
  "summary": "They have a playful, supportive dynamic.",
  "signals": {
    "familiarity": 42,
    "trust": 31,
    "warmth": 55
  },
  "boundaries": ["..."],
  "version": 7
}
```

### 7.4 PreparedTurn context

每轮上下文由 Chat 构建一次不可变 PreparedTurn：已发布 Soul、recent messages、Scene、relationship、boundaries、已发布知识和 entitlement policy。通用记忆由 DSH 内的 igrep plugin 在对应 workspace 召回；历史 `chat_sessions.memory_summary` 不再进入上下文。

## 8. API 边界

### 8.1 Browser 到 Chat

推荐入口：

```text
Browser -> API Gateway / 主站 BFF -> Chat Service
```

主站/BFF 可以验证 session cookie，并向 Chat 传递已签名的内部用户上下文：

```http
X-Internal-User-Id: user_123
X-Internal-Auth-Time: 2026-06-18T00:00:00.000Z
X-Internal-Signature: ...
```

Chat Service 仍必须用只读 view 复查：

- user status 是否 active。
- age eligibility 是否满足。
- entitlement 是否允许当前能力。
- character 是否可读。

不要只信任 BFF header。

### 8.2 Chat API

P0 API：

```text
POST   /api/v1/chat/sessions
GET    /api/v1/chat/sessions
GET    /api/v1/chat/sessions/:id
DELETE /api/v1/chat/sessions/:id

POST   /api/v1/chat/sessions/:id/messages
GET    /api/v1/chat/streams/:assistantMessageId
POST   /api/v1/messages/:id/regenerate
DELETE /api/v1/messages/:id

POST   /api/v1/chat/sessions/:id/memory
POST   /api/v1/chat/sessions/:id/no-memory

GET    /api/v1/chat/relationships
GET    /api/v1/chat/relationships/:characterId
PATCH  /api/v1/chat/relationships/:characterId
DELETE /api/v1/chat/relationships/:characterId
```

`/api/v1/chat/memories` 及其 item route 不存在。relationship `DELETE` 是唯一的通用记忆清除能力：同一 durable mutation 同时删除 Chat relationship 投影并 purge 对应 DSH workspace。

主站产品页可以直接代理这些 API，或者前端按环境配置调用 Chat Service 域名。

## 9. 发消息流程

```text
Browser
  -> POST /api/v1/chat/sessions/:id/messages

Chat Service:
  1. 验证内部用户上下文，得到 userId。
  2. 读取 chat_user_view、chat_user_eligibility_view、chat_entitlement_view。
  3. 读取 chat_character_view，校验角色可读、成人、未下架。
  4. 校验 session 属于 userId 和 characterId。
  5. 检查 chat_usage / entitlement / rate limit。
  6. 输入审核。
  7. DB transaction:
       - insert user message
       - insert assistant placeholder(status=pending, reply_to_message_id=userMessageId)
       - reserve quota/rate capacity under user+session transaction locks
       - update session.last_message_at
  8. 入 Chat 内部队列 `chat.generate`，返回 `{ userMessageId, assistantMessageId, streamUrl, status }`；
     若 commit 后入队暂时失败，reconciler 从 pending placeholder 补投。
     - 正常：`status="generating"`，`streamUrl` 指向 SSE。
     - 输入被审核拦截（P0-B）：**不入队、不返回 streamUrl**，返回
       `{ status:"blocked", streamUrl:null, safety:{ layer:"input", policyCode } }`；
       前端据此原地展示安全提示，不开启空的 EventSource。
  9. Chat worker 将 placeholder 转为 generating、刷新 generation lease，并构建不可变 PreparedTurn：
       - released Soul + character authority
       - recent messages
       - Scene / relationship / boundaries
       - released knowledge + entitlement policy
       - relationship workspace scope（普通持久、private 临时）
 10. 单一路径调用 DSH AgentLoop；官方 igrep plugin 在同一 loop 内完成 wake/search，worker 写 Redis Stream token。
 11. 输出审核。
 12. DB transaction（只账本，强一致）:
       - update assistant message
       - create selected message_version
       - increment chat_usage
       - insert moderation events
       - insert outbox events
 13. terminal commit ACK 后发送 SSE done，并允许 official igrep plugin ingest 本轮；终端 trace 只记录 content-free attempt/call/outcome/effect 身份。
 14. enqueue `chat.memory.extract`：该历史 wire name 的任务现在只从权威 turn 派生 Scene/relationship 投影，
     不抽取通用记忆、不写 summary、不调用旧 importer；`memory_extracted_attempt` 仅作为该投影的 durable 水位。
 15. outbox 异步投递主站 analytics/safety/library。
```

> Phase 6 只有 DSH/igrep 通用记忆 authority。Chat finalize 事务保留 messages/usage/moderation/outbox 账本；Scene/relationship 是 Chat 文件投影，通用记忆的 ingest 受 terminal commit ACK gate 约束。

浏览器断线重连时带 `Last-Event-ID`，Chat 从 Redis Stream 继续读。如果 token stream 已过期，前端退化为拉取 `GET /api/v1/chat/sessions/:id` 中已落库的消息。

## 10. 内部队列

Chat Service 内部可以使用 BullMQ + Redis，但这些队列不是主站到 worker 的跨服务协议。

```text
chat.generate            DSH AgentLoop 生成 assistant 回复 + 落账本
chat.moderation.deep     深度审核补偿
chat.memory.extract      历史 wire name：按 reply_to_message_id 读取 PG 权威 turn，只派生 Scene/relationship
chat.outbox.deliver      投递 Chat→Main 跨服务事件
chat.inbox.consume       消费 Main→Chat 入站事件（chat_inbox_events）
chat.maintain            session.jsonl 滚动/压缩/TTL + 清理过期 stream
```

`chat.generate` payload 可以是 ID-based，因为 Chat worker 能读 Chat DB：

```jsonc
{
  "version": 1,
  "requestId": "uuid",
  "sessionId": "sess_123",
  "userMessageId": "msg_user",
  "assistantMessageId": "msg_assistant",
  "streamKey": "chat:stream:msg_assistant"
}
```

幂等键：

```text
chat-generate:<assistantMessageId>
outbox:<eventId>
```

## 11. 跨服务事件

### 11.1 主站到 Chat

主站权威状态变化时，发事件给 Chat，用于缓存失效、会话阻断或删除。

```text
user.updated
user.suspended
user.account_deletion.requested.v2
character.updated
character.removed
character.visibility_changed
entitlement.updated
age_eligibility.updated
policy.updated
```

如果 Chat 直接读 DB view，事件不是读取权威数据的唯一来源，但仍用于低延迟缓存失效和补偿任务。

### 11.2 Chat 到主站

Chat 通过 outbox 发事件给主站：

```text
chat.session.created
chat.message.created
chat.message.completed
chat.message.blocked
chat.session.deleted
chat.relationship.updated
chat.usage.incremented
chat.safety.flagged
```

主站用这些事件更新：

- library 最近聊天聚合。
- character stats 的 chat count。
- analytics funnel。
- safety/admin 全站队列。
- billing/quota 报表。

事件必须至少一次投递，消费者必须按 event id 幂等。

## 12. 用户控制与隐私

P0 控制：

- 删除聊天消息后，后续上下文不再使用该消息。
- 删除会话后，不在普通 chat context 中出现。
- 关闭记忆后，`memory_enabled=false`，后续 attempt 使用临时 workspace，不读写 canonical relationship workspace。
- 重置 relationship 后，Chat relationship 投影和对应 DSH workspace 作为同一 durable intent 被清除；不提供逐条 memory 删除。

P1 控制：

- 账号导出包含 Chat Service 的 messages、Scene/relationship/boundaries snapshots；官方 plugin 无逐条枚举 seam，不能伪造 item 导出。
- 账号删除由主站通过专属 capability route 发 `user.account_deletion.requested.v2`，Chat 执行聊天域删除/匿名化，并回传带精确 request event id 的 `chat.account_erasure.completed`；`user.deleted` 仅保留消费历史已持久化事件。

整段重置和账号删除不能只从检索结果中过滤，必须 purge 对应 workspace，并清理 Chat 文件投影和 source linkage。

## 13. 安全与合规

- Chat 不写主站 user/character/billing/compliance 表。
- Chat 只读最小字段 view，不读取 password hash、OAuth token、支付详情。
- Chat 在发消息热路径复查 user status、age eligibility、entitlement、character status。
- Chat 不把 blocked content 写入长期记忆。
- Chat 不把其他用户、其他角色、其他私有会话的记忆混入当前上下文。
- Public character creator 不可读取用户与该角色的私聊内容或记忆。
- 高风险审核命中通过 outbox 同步到主站 safety/admin。
- 所有内部 BFF header 必须签名并有短 TTL。

## 14. 测试

Chat Service 独立测试：

1. 启动 Chat DB 和 Redis。
2. 准备只读 view fixture：user、character、entitlement、eligibility。
3. 调 `POST /chat/sessions` 创建会话。
4. 调 `POST /chat/sessions/:id/messages`。
5. fake LLM 输出 token，断言 Redis Stream start/delta/done。
6. 断言 `messages`、`message_versions`、`chat_usage` 已落库。
7. 断言已有已迁移 workspace 被复用、全新 relationship 原生初始化为空、private turn 不产生 canonical workspace/proof。
8. 关闭记忆和 whole-relationship reset 后，确认 workspace scope 与 Chat relationship/boundaries 权威符合预期；`/memories` item API 必须 404。

主站集成测试：

1. 主站创建/更新 user、character、entitlement、eligibility。
2. Chat 从只读 view 读取最新状态。
3. Chat 完成消息后发 outbox event。
4. 主站消费 `chat.message.completed`，更新 library/stats/analytics。
5. 主站下架 character 后，Chat 阻断新消息。
6. 主站删除 user 后，Chat 执行聊天域删除并回传完成事件。

## 15. 实施路线

1. 从现有主站 Prisma schema 中拆出 chat domain 表的目标 schema：`chat_sessions`、`messages`、`message_versions`、`chat_usage`；通用记忆不建 iDream item 表。
2. 新增 `chat_moderation_events`、`chat_outbox_events`、`chat_inbox_events`；Chat 文件投影只承载 Scene/relationship/boundaries。
3. 定义主站只读 views：`chat_user_view`、`chat_character_view`、`chat_entitlement_view`、`chat_user_eligibility_view`。
4. 建立 Chat Service DB role：主站权威 schema 只读，chat schema 读写。
5. 把 `POST /chat/sessions/:id/messages` 的权威落库迁移到 Chat Service。
6. finalize 事务只落账本；Chat terminal ACK 后才开放 official igrep ingest，Scene/relationship 由异步投影维护。
7. 主站改为调用/代理 Chat API，不再写 chat tables。
8. 用 outbox 同步 `chat.message.completed`、`chat.usage.incremented`、`chat.safety.flagged`。
9. 增加账号删除、角色下架、权益变更的主站到 Chat 事件。
10. 删除旧的主站 `ai.chat.generate -> app.ai.finalize(chat.completed)` 跨服务路径；保留 image/video finalize 路径。

## 16. 记忆与关系的产品语义（补充）

> 本节补齐 §7（记忆/关系）和 §12（用户控制）中**留白或模糊的产品决策**。这里只定 *产品语义*（用户看到什么、感受到什么、平台承诺什么），不改任何工程实现；落地参考 `docs/architecture/14-chat-service-tech-design.md`。

### 16.1 关系进展的用户可见性

关系信号（`familiarity` / `trust` / `warmth`）和 `signals` JSON **永远不直接暴露给用户**——它们是模型语气与上下文选择的内部输入，不是游戏化分数。但伴侣产品需要让用户**感知到关系在前进**，否则长期互动缺乏正反馈。折中方案：

- **暴露**：一个**柔性、定性的关系阶段标签**，映射自 `relationship_states.stage`：

  | `stage` | 用户可见标签 | 语气基调 |
  |---------|--------------|----------|
  | `new` | 初识 | 礼貌、好奇、试探 |
  | `familiar` | 熟识 | 自然、放松、有共同话题 |
  | `close` | 亲近 | 主动、温暖、记得细节 |
  | `committed` | 亲密 | 默契、专属感、长期承诺语气 |

  标签**可选展示**（如角色资料卡或会话头部一个低调的小字/小徽标），**默认克制、不弹窗、不庆祝动画**，用户可在设置里隐藏。

- **不暴露**：任何数字（familiarity=42）、任何进度条/百分比/经验值、任何"距离下一阶段还差 X"的提示、任何把关系量化为可刷分的机制。

- **设计意图**：让用户"感觉到"关系在加深（定性标签 + 语气演进），而**不**把伴侣关系做成可被刷分、可被攀比、可制造焦虑的数值游戏。阶段跃迁应平滑、由真实互动驱动，**绝不**用"再聊 N 句就升级"诱导消费。

- **阶段降级**：长期不互动时阶段可缓慢回落（产品决策：回落比晋升慢得多，且无任何负面通知——避免制造愧疚感）。回落阈值为**可调运营参数**。

### 16.2 记忆错误与边界（信任不变量）

igrep 是 DSH loop 内的官方工具，不存在 native 或自研 retrieval fallback。tool timeout/error 必须保留 call identity 与 content-free outcome；执行结果不明时保持 `unknown`，不得伪装成召回成功或静默切到第二套 memory authority。

- **边界（boundary）是硬不变量，永不依赖召回**：用户设定的边界必须每轮从 Chat 权威全量注入 PreparedTurn，不受 igrep 超时或 workspace 状态影响。

  > **产品不变量（写死，不可降级）**：宁可这一轮"显得没那么记得共同经历"，**也绝不**因为降级而**越过一条已知边界**。越界是严重信任与合规事故，遗忘细节只是体验瑕疵。两者优先级不对等。

- **可观测且不伪装成功**：igrep error/timeout/unknown 进入内部 trace 与指标；产品按 terminal error 语义展示失败和重试，不生成一个看似成功的无记忆 fallback reply。

### 16.3 Entitlement 与 official memory

Phase 6 不把 `chat_memory_multiplier` 映射成 iDream 自研的 item 上限、top-K 或淘汰规则，因为官方 igrep 没有这个受支持的产品 seam。entitlement 仍可决定模型与 recent-message context；只有在官方 plugin 提供稳定、可测试的配置契约后，才能把记忆档位重新纳入产品承诺。

### 16.4 消息编辑/删除对记忆的影响

- blocked/failed turn 不会越过 Chat terminal commit ACK gate 进入 official plugin ingest。
- 编辑或删除历史消息会改变 Chat transcript、后续 PreparedTurn 和 whole-relationship rebuild 的 canonical input。
- 官方 plugin 当前没有按 source message 精确撤销单个 item 的 seam，因此产品不承诺 item 级回溯删除。需要确保通用记忆完全清除时，用户执行 whole-relationship reset；这会 purge workspace 并清除 relationship 投影。

### 16.5 语音计费口径

语音通话计费**不在本服务定义**，以 `ECONOMY_AND_PRICING.md` §1.1 为准（按实际通话分钟计费、向上取整到分钟）。Chat Service 侧只负责：

- **入口门控**：语音能力由 `billing.chat_entitlement_view.voice_enabled` 决定（§5.3）；未开通则不提供语音入口。
- **用量上报**：语音会话结束后，通过 outbox 上报通话时长事件，由主站 billing 按 ECONOMY 费率结算 dreamcoin（与文字消息 0 币不同，语音是付费生成类目）。
- **职责边界**：费率数值、扣费时点、退款规则一律不在本文重述，避免与 ECONOMY 漂移（group chat / voice 的完整设计属 P1，见 §2 与 `14` §7 P0 范围外）。
