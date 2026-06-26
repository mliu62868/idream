# Chat Service PRD 与主站只读协议

> 目标：定义独立 Chat Service 的产品能力、数据库边界、主站只读数据协议、记忆系统、关系状态、流式生成、合规控制和跨服务事件。本文取代旧的“主站落聊天数据 + chat worker 推理 + 主站 finalizer”模式。

## 1. 定位

Chat Service 不是一个简单 LLM proxy，也不是主站后台 worker。它是 AI 伴侣 / 角色扮演的完整运行时，拥有聊天域数据库，负责让角色在多轮、多会话中保持一致、有记忆、有关系进展。

新的核心边界：

- **Chat Service 拥有 chat domain**：会话、消息、消息版本、长期记忆、关系状态、聊天用量、流式事件、聊天审核轨迹、聊天 outbox 事件。
- **主站拥有 core domain**：用户账号、登录会话、角色创建与审核、公开角色目录、订阅/权益权威、年龄/身份验证权威、SEO、library 聚合和全站后台。
- **Chat Service 可以读主站 User 和角色表**：通过只读 DB role、view/read model 或只读副本读取必要字段，不能写主站权威表。
- **主站不参与 chat 热路径落库**：发消息、流式输出、上下文检索、记忆写入、relationship 更新都在 Chat Service 内完成。

关键边界：**主站是 user / character / billing / compliance 的权威源；Chat Service 是 session / message / memory / relationship 的权威源。** 两边可以共用 ID，不共享可变业务表写权限。

## 2. 产品目标

P0 目标：

- 角色能记住当前会话上下文。
- 角色能跨会话记住用户明确表达的偏好、基本事实、边界和共同经历。
- 用户刷新页面、断开 SSE、worker 重试后，不丢任务、不丢最终消息。
- 用户删除消息、删除记忆、关闭记忆或删除账号后，后续回复不再使用对应内容。
- Premium/Deluxe 权益影响模型、上下文窗口、记忆深度和速率限制。
- Chat 热路径不依赖主站 API 同步调用。

P1 目标：

- 关系状态随互动稳定演进，例如熟悉度、信任、亲密语气、共同经历。
- 用户可在设置里查看、编辑、删除角色记住的内容。
- 支持每个角色独立记忆，也支持用户允许的全局偏好记忆。
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
| User-visible memories | Chat Service | 读写权威 |
| Runtime vector index | Chat Service | 可缓存，可重建 |
| Relationship state | Chat Service | 读写权威 |
| Chat moderation trace | Chat Service | 读写权威，同时可向主站 safety/admin 发事件 |
| Global safety policy | 主站/Safety | Chat 只读 policy snapshot 或调用独立 moderation provider |

这个边界避免三类问题：

- 主站不再成为 chat 热路径瓶颈。
- 用户聊天、记忆和关系状态有清晰的写入权威。
- Chat 可以独立扩展 memory retrieval、streaming、group chat 和 voice，而不复制主站用户/角色/支付逻辑。

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
  # companion_memories / relationship_states 已迁文件层（mem/*.md），不在 PG
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
  memory_multiplier,
  unlimited_messages,
  voice_enabled,
  updated_at
FROM billing.current_chat_entitlements;
```

Chat 用它决定：

- 模型 tier。
- 上下文窗口和记忆数量。
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
memory_summary
last_message_at
created_at
updated_at
deleted_at
```

说明：

- `user_id` 和 `character_id` 引用主站 ID，但在独立 DB 拓扑下不做跨库 FK。
- `memory_summary` 是当前会话滚动摘要，不是长期记忆替代品。

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

### 6.5 `chat.companion_memories`（已迁文件层，非 PG 表）

> **更新**：长期记忆改为**文件层权威**（`mem/{userId}/{charId}/memory.md`），不再是 PG 表。下方字段保留为**每条记忆的逻辑结构**（落在文件 front-matter）。技术落地见 `docs/architecture/14-chat-service-tech-design.md` §5。

```text
（逻辑字段，存于 memory.md front-matter）
user_id
character_id
session_id
scope                   global | character | session
type                    user_fact | preference | boundary | shared_event
text
confidence
status                  active | deleted
source_message_ids
created_at / updated_at / deleted_at
```

每条长期记忆必须有来源（`source_message_ids` 回链 PG message）。不能从被拦截、已删除、no-memory 会话中的内容生成长期记忆——派生时 `canMemorize` 回查 PG message 状态。

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

记忆分四类：

| 类型 | 示例 | 默认 scope | 说明 |
|------|------|------------|------|
| `user_fact` | 用户喜欢被叫某个昵称 | user/character | 稳定事实 |
| `preference` | 喜欢慢热、轻松语气 | user/character | 交互偏好 |
| `boundary` | 不想聊某类话题 | user/global | 高优先级，不应被覆盖 |
| `shared_event` | 上次一起讨论过旅行设定 | session/character | 共同经历或剧情节点 |

允许写入长期记忆：

- 用户明确表达稳定偏好。
- 用户明确给出个人设定、称呼、互动边界。
- 多次重复出现且置信度足够高的互动偏好。
- 与角色有关的共同剧情节点。

禁止写入长期记忆：

- 审核 blocked 的输入或输出。
- 用户删除过的消息。
- `mode=no_memory` 会话内容。
- 敏感身份信息，除非产品明确需要且用户明确提供。
- 模型自行猜测的用户事实。
- 低置信度情绪判断，例如“用户一定喜欢 X”。

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

### 7.4 Session Summary

`chat_sessions.memory_summary` 是当前会话滚动摘要，用于减少 token 成本。

- session summary：当前会话内剧情/上下文压缩。
- long-term memory：跨会话偏好、事实、边界和关系事件。
- relationship state：用户和角色之间的长期互动状态。

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

GET    /api/v1/chat/memories
PATCH  /api/v1/chat/memories/:id
DELETE /api/v1/chat/memories/:id
POST   /api/v1/chat/sessions/:id/no-memory

GET    /api/v1/chat/relationships
GET    /api/v1/chat/relationships/:characterId
PATCH  /api/v1/chat/relationships/:characterId
DELETE /api/v1/chat/relationships/:characterId
```

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
       - insert assistant placeholder(status=generating)
       - update session.last_message_at
  8. 入 Chat 内部队列 `chat.generate`，返回 assistantMessageId + streamUrl。
  9. Chat worker 构建上下文：
       - recent messages
       - session summary
       - companion memories
       - relationship state
       - character persona from read-only view
       - entitlement policy
 10. 调模型并写 Redis Stream token。
 11. 输出审核。
 12. DB transaction（只账本，强一致）:
       - update assistant message
       - create selected message_version
       - increment chat_usage
       - update memory_summary           # 会话滚动摘要，留 PG
       - insert moderation events
       - insert outbox events
 13. 写 session.jsonl（chat.generate 进程内 append）。
 14. enqueue chat.memory.extract：异步派生长期记忆/关系，写**文件层**（mem/*.md），
     **不进上面的 PG 事务**（最终一致；companion_memories / relationship_states 已迁文件）。
 15. SSE done，outbox 异步投递主站 analytics/safety/library。
```

> **更新**：长期记忆与关系状态已迁文件层（§6.5/§6.6），故移出 finalize 事务，改由异步 `chat.memory.extract` 写文件。finalize 事务只保留账本（messages/usage/moderation/outbox + 会话滚动摘要）。详见 `docs/architecture/14-chat-service-tech-design.md` §3/§5。

浏览器断线重连时带 `Last-Event-ID`，Chat 从 Redis Stream 继续读。如果 token stream 已过期，前端退化为拉取 `GET /api/v1/chat/sessions/:id` 中已落库的消息。

## 10. 内部队列

Chat Service 内部可以使用 BullMQ + Redis，但这些队列不是主站到 worker 的跨服务协议。

```text
chat.generate            生成 assistant 回复 + 落账本 + 写 session.jsonl
chat.moderation.deep     深度审核补偿
chat.memory.extract      读 session.jsonl + 回查 PG 状态，派生记忆/关系写文件层
chat.memory.rebuild      重建 memory index（igrep）
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
memory-rebuild:<userId>:<characterId>:<version>
outbox:<eventId>
```

## 11. 跨服务事件

### 11.1 主站到 Chat

主站权威状态变化时，发事件给 Chat，用于缓存失效、会话阻断或删除。

```text
user.updated
user.suspended
user.deleted
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
chat.memory.updated
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
- 关闭记忆后，`memory_enabled=false`，不检索长期记忆，不写新长期记忆。
- 删除记忆后，memory hard-delete 或 crypto-erasure，并重建 runtime index。

P1 控制：

- 账号导出包含 Chat Service 的 messages、memories、relationship snapshots。
- 账号删除由主站发 `user.deleted`，Chat 执行聊天域删除/匿名化，并回传 `chat.account_erasure.completed`。

删除不能只从检索结果中过滤，必须清理可检索索引、摘要缓存和 source linkage。

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
7. 断言 `mem/*.md`（记忆/关系文件）符合规则，且未从 blocked/no-memory 派生。
8. 删除 message/memory/session，确认后续 context 不再包含被删除内容（PG 行 + 文件 + session.jsonl 都清）。

主站集成测试：

1. 主站创建/更新 user、character、entitlement、eligibility。
2. Chat 从只读 view 读取最新状态。
3. Chat 完成消息后发 outbox event。
4. 主站消费 `chat.message.completed`，更新 library/stats/analytics。
5. 主站下架 character 后，Chat 阻断新消息。
6. 主站删除 user 后，Chat 执行聊天域删除并回传完成事件。

## 15. 实施路线

1. 从现有主站 Prisma schema 中拆出 chat domain 表的目标 schema：`chat_sessions`、`messages`、`message_versions`、`chat_usage`（`companion_memories` / `relationship_states` **改文件层，不入 PG**）。
2. 新增 `chat_moderation_events`、`chat_outbox_events`、`chat_inbox_events`；建文件层目录（sessions/ + mem/，直接 fs，读写集中在 `chat-fs.ts`）。
3. 定义主站只读 views：`chat_user_view`、`chat_character_view`、`chat_entitlement_view`、`chat_user_eligibility_view`。
4. 建立 Chat Service DB role：主站权威 schema 只读，chat schema 读写。
5. 把 `POST /chat/sessions/:id/messages` 的权威落库迁移到 Chat Service。
6. finalize 事务只落账本；memory/relationship 改异步 `chat.memory.extract` 写文件层（不进事务）。
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

### 16.2 记忆降级的 UI 反馈（信任不变量）

当记忆检索超时、igrep 不可用或文件读出错时，热路径**静默退化为"仅 recent messages"**继续生成（见 `14-chat-service-tech-design.md` §5 热路径降级）。这对伴侣产品是一个**隐藏的信任风险**：角色会显得"突然忘了我"或"性格变了"。产品口径：

- **语气/事实记忆**：**静默降级，不向用户报错、不显示"记忆暂不可用"横幅**。理由：弹一个技术错误反而打破沉浸感、放大"她坏了"的感受；偶发一轮回复不够"记得"，远比一个错误提示温和。降级是临时的，下一轮恢复即可。

- **边界（boundary）是硬不变量，永不降级**：用户设定的边界（不想聊的话题、禁忌、安全相关约束）**必须每轮全量注入，绝不受检索超时/索引不可用影响**。工程上 `boundaries` 文件与普通记忆走不同路径（全量注入 + 进程内缓存，见 `14` §5），即使其余记忆检索全部超时，边界仍然在场。

  > **产品不变量（写死，不可降级）**：宁可这一轮"显得没那么记得共同经历"，**也绝不**因为降级而**越过一条已知边界**。越界是严重信任与合规事故，遗忘细节只是体验瑕疵。两者优先级不对等。

- **可观测但不打扰**：降级事件记内部指标（降级率是 SLO 信号），但**不**作为面向用户的提示。若降级率持续偏高（角色长期"失忆"），属于工程告警范畴，不是 UI 文案能补偿的——要修的是检索可用性。

### 16.3 `chat_memory_multiplier` 各档默认值与单位映射

`chat_memory_multiplier` 来自 entitlement（数值 SSoT 在 `ECONOMY_AND_PRICING.md` §2.2：Free/Premium=1，Deluxe=3）。本节定义这个倍数**乘的是什么**，并给出各档具体档位。

- **倍数作用对象**：同时缩放两件事——
  1. **每个 (user, character) 的长期记忆上限**（`max_stored_memories`，超出按 recency+confidence 淘汰最弱的）；
  2. **每轮检索注入的 top-K 结构化记忆条数**（`retrieved_top_K`，`user_fact`/`preference`/`shared_event` 合计）。
- **不缩放**：`boundaries`（永远全量注入，与档位无关——见 §16.2）；会话内 recent messages 窗口由 `max_context_messages` 独立控制。

具体映射表（**baseline = multiplier 1**；数值为**可调运营参数**，最终以 policy resolver 配置为准，不写死在判定逻辑）：

| 档位 | multiplier | `max_stored_memories`（每角色长期记忆上限） | `retrieved_top_K`（每轮注入结构化记忆条数） | `max_context_messages`（recent 窗口） |
|------|-----------|---------------------------------------------|---------------------------------------------|----------------------------------------|
| Free | 1（基线） | 100 | 8 | 20 |
| Premium | 1（基线） | 100 | 8 | 40 |
| Deluxe | 3 | 300 | 24 | 60 |

说明：

- **"3×" 同时放大"记得多少"（stored）和"每轮唤起多少"（top-K）**——这才是 Deluxe "更懂你、记得更久" 的体感来源，而不仅是存得多但唤不起来。
- Free 与 Premium 的 `chat_memory_multiplier` **同为 1**（记忆深度不是 Premium 的卖点；Premium 的卖点是 unlimited messages / 生成权益，见 ECONOMY §2）。Premium 相对 Free 仅 `max_context_messages` 更大（更长会话连贯性），记忆档位一致。
- `max_context_messages` 不直接乘 `chat_memory_multiplier`，是 policy resolver 里与档位关联的独立参数，列在此表只为给出完整的"记忆/上下文预算"全景。
- 表中所有数字标记为 **tunable**：进 policy resolver 配置（`14` §3 `resolvePolicy`），可随成本/效果 A/B 调整，不进代码常量。

### 16.4 消息编辑/删除对记忆的影响

- **删除消息 / 被审核拦截的消息**：**永不**成为长期记忆。这是既定设计——派生时 `canMemorize` 回查 PG message 的 `status`/`safety_status`（§7.2、§12、`14` §5），blocked/deleted 一律拒绝。已删消息若曾被派生过记忆，按 §12 隐私删除连带清理（记忆 source linkage 回链该 message）。

- **编辑历史消息**：编辑一条**已经派生过记忆**的旧消息，**不会**回溯重写已派生的长期记忆（产品决策）。

  > **理由（KISS / YAGNI）**：记忆是从对话**流**蒸馏的产物，一条旧消息可能已与其他消息合并、消化进关系叙事或滚动摘要，做"精确回溯撤销并重算"既复杂又易错（要追溯哪些记忆受这条消息影响、部分回滚、重建索引），收益极低。伴侣场景里编辑旧消息极少见，且新的互动会自然覆盖旧倾向。

  产品承诺改为：**编辑只影响该消息之后的对话与未来派生**——编辑后的内容会随后续互动正常进入记忆候选；用户若要清除某条已记住的内容，走**显式的记忆删除入口**（§12 / `GET·PATCH·DELETE /api/v1/chat/memories`），这是直接、可验证、用户可控的路径，而非依赖编辑消息这种隐式副作用。

  - **edge case**：编辑**尚未派生**的近期消息（派生水位线之上，见 `14` §9 D3），派生本就读最新文本，自然用编辑后的版本——无需特殊处理。

### 16.5 语音计费口径

语音通话计费**不在本服务定义**，以 `ECONOMY_AND_PRICING.md` §1.1 为准（按实际通话分钟计费、向上取整到分钟）。Chat Service 侧只负责：

- **入口门控**：语音能力由 `billing.chat_entitlement_view.voice_enabled` 决定（§5.3）；未开通则不提供语音入口。
- **用量上报**：语音会话结束后，通过 outbox 上报通话时长事件，由主站 billing 按 ECONOMY 费率结算 dreamcoin（与文字消息 0 币不同，语音是付费生成类目）。
- **职责边界**：费率数值、扣费时点、退款规则一律不在本文重述，避免与 ECONOMY 漂移（group chat / voice 的完整设计属 P1，见 §2 与 `14` §7 P0 范围外）。
