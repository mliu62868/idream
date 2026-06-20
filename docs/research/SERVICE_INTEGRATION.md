# AI 服务对接设计 (Chat / Image / Video)

> 目标：定义 Chat、Image、Video 三类生成能力的服务边界和可靠通讯。Chat Service 现在是完整 chat domain 服务，拥有自己的聊天数据库能力，并只读主站 User / Character / Entitlement / Eligibility 数据。Image / Video 仍按“主站创建业务任务，AI worker 生成媒体，主站 finalizer 落库结算”的模式对接。
>
> Chat Service 的产品能力、数据库边界、主站只读 view 和跨服务事件见 `docs/product/CHAT_SERVICE_PRD.md`。本文只定义跨服务传输层、队列拓扑和落地约束。

## 0. 设计前提

主站已有能力：

- User/Auth、Character/Girlfriend、Billing/Entitlement、Compliance/Age Verification 是主站权威域。
- Image/Video generation 的业务状态仍在主站：`generation_jobs`、`media_assets`、dreamcoin ledger。
- Redis + BullMQ 用于可靠任务，Redis Stream 用于高频 token/event replay。

新的 Chat 集成边界：

- **Chat Service 拥有 chat domain DB**：`chat_sessions`、`messages`、`message_versions`、`chat_usage`、`companion_memories`、`relationship_states`、chat moderation、chat outbox。
- **Chat Service 只读主站 core 数据**：通过 DB view/read model 读取 user、character、entitlement、eligibility 必要字段。
- **主站不再作为 chat finalizer**：发消息、生成、输出审核、落 assistant、写 memory/relationship 都在 Chat Service 内完成。
- **主站只消费 Chat 事件**：用于 library 最近聊天、character stats、analytics、safety/admin 聚合。

Image/Video 集成边界保持：

- 主站负责鉴权、权益、计费预留、输入审核、GenerationJob 状态和媒体落库。
- AI worker 负责推理和写 blob。
- 结果通过 `app.ai.finalize` 回主站收敛。

## 1. 关键判断：Chat 热路径独立

| 能力 | 用户体验 | 热路径写库 | 可靠任务通道 | 实时展示通道 | 最终落库 |
|------|----------|------------|--------------|--------------|----------|
| chat | 边生成边显示 | Chat Service | Chat 内部 `chat.generate` | Chat SSE + Redis Stream | Chat DB |
| image | 提交后轮询结果 | 主站 | BullMQ `ai.image.generate` | 无，轮询主站 DB | 主站 `app.ai.finalize` |
| video | 提交后轮询结果 | 主站 | BullMQ `ai.video.generate` | 无，轮询主站 DB | 主站 `app.ai.finalize` |

不要让浏览器 SSE 直接等同于“任务执行”。SSE 连接可能断开，浏览器也可能刷新；chat message 必须已经写入 Chat DB，并且 generation job 必须已经进入可靠队列，才算被系统接收。

## 2. 服务拓扑

```text
Browser
  │
  ├─ public/product pages -> Main Site (Next.js)
  │
  └─ chat API/SSE -> API Gateway or Main BFF
                    │
                    ▼
                 Chat Service
                    │
                    ├─ read-only: core.chat_user_view
                    ├─ read-only: core.chat_character_view
                    ├─ read-only: billing.chat_entitlement_view
                    ├─ read-only: compliance.chat_user_eligibility_view
                    ├─ read/write: chat.* tables
                    └─ Redis Stream: chat:stream:<assistantMessageId>

Image/Video:

Browser -> Main Site -> BullMQ ai.image/video.generate -> AI worker -> Blob
                                                     └-> app.ai.finalize -> Main Site finalizer
```

主站 BFF 可以代理 Chat API，这样前端继续使用同源 cookie；但主站 BFF 不写 chat tables，不拼 prompt，不做 chat finalizer。

## 3. 数据权限

推荐同一 Postgres cluster 分 schema：

```text
core.users
core.characters
billing.entitlements
compliance.age_verifications

chat.chat_sessions
chat.messages
chat.message_versions
chat.chat_usage
chat.companion_memories
chat.relationship_states
chat.chat_moderation_events
chat.chat_outbox_events
```

Chat Service DB role：

```text
SELECT on core.chat_user_view
SELECT on core.chat_character_view
SELECT on billing.chat_entitlement_view
SELECT on compliance.chat_user_eligibility_view
SELECT/INSERT/UPDATE/DELETE on chat.*
NO INSERT/UPDATE/DELETE on core.*, billing.*, compliance.*
```

这个设计允许 Chat 读取主站 User 和角色权威数据，同时避免双写用户、角色、支付、年龄验证状态。

## 4. Chat 对接：Chat API + Chat DB + Redis Stream

### 4.1 API 拓扑

```text
浏览器
  ├─ POST /api/v1/chat/sessions
  ├─ POST /api/v1/chat/sessions/:id/messages
  └─ GET  /api/v1/chat/streams/:assistantMessageId

Chat Service:
  1. 验证 BFF/internal auth context
  2. 从只读 views 复查 user / eligibility / entitlement / character
  3. 写 Chat DB: user message + assistant placeholder
  4. 入 Chat 内部队列: chat.generate
  5. 返回 { userMessageId, assistantMessageId, streamUrl }
  6. Chat worker 生成 token，写 Redis Stream
  7. 输出审核
  8. 写 assistant message/version/usage/memory/relationship
  9. outbox 发事件给主站
```

### 4.2 Chat 内部 `chat.generate` payload

Chat worker 可以读 Chat DB，所以内部队列 payload 用 ID 即可：

```jsonc
{
  "version": 1,
  "requestId": "uuid",
  "sessionId": "chat_session_id",
  "userMessageId": "message_id",
  "assistantMessageId": "message_id",
  "streamKey": "chat:stream:<assistantMessageId>"
}
```

worker 运行时读取：

- `chat.messages` 最近窗口。
- `chat.chat_sessions.memory_summary`。
- `chat.companion_memories`。
- `chat.relationship_states`。
- `core.chat_character_view` persona。
- `billing.chat_entitlement_view` model tier / memory multiplier。
- `compliance.chat_user_eligibility_view` age eligibility。

### 4.3 Redis Stream token event

```jsonc
{ "type": "start", "attempt": 1 }
{ "type": "delta", "attempt": 1, "seq": 12, "delta": " there" }
{ "type": "done", "attempt": 1, "usage": { "promptTokens": 120, "completionTokens": 42 } }
{ "type": "error", "attempt": 1, "code": "model_overloaded", "retryable": true }
```

Chat Service SSE route 将 Redis Stream 转成浏览器 SSE：

```text
id: 1700000000000-12
event: delta
data: {"delta":" there","seq":12}
```

浏览器断线重连时带 `Last-Event-ID`，Chat 从该 ID 之后继续 `XREAD`。如果 token stream 已过期，前端退化为拉取 `/api/v1/chat/sessions/:id` 中已落库的消息。

### 4.4 Chat 完成后的事务

Chat worker 在输出审核通过后，在 Chat DB 中做一个幂等 transaction：

```text
update messages set content=?, status='sent', model=?, token_count=?
insert message_versions(selected=true)
update chat_sessions set last_message_at=?, memory_summary=?
upsert chat_usage
upsert companion_memories
upsert relationship_states
insert chat_moderation_events
insert chat_outbox_events
```

重复执行必须安全：如果 assistant message 已经是 `sent` / `blocked`，只允许幂等返回，不重复增加 usage，不重复写 selected version。

### 4.5 Chat outbox events

Chat 完成后向主站投递事件，而不是通过主站 finalizer 落库：

```jsonc
{
  "eventId": "evt_123",
  "type": "chat.message.completed",
  "occurredAt": "2026-06-18T00:00:00.000Z",
  "payload": {
    "userId": "user_123",
    "characterId": "char_123",
    "sessionId": "sess_123",
    "messageId": "msg_assistant",
    "promptTokens": 120,
    "completionTokens": 42,
    "model": "chat-premium-v1"
  }
}
```

主站消费者用 `eventId` 幂等处理：

- 更新 character stats 的 chat count。
- 更新 library 最近聊天读模型。
- 落 analytics event。
- 对 `chat.safety.flagged` 进入 safety/admin 队列。

## 5. 主站到 Chat 的事件

主站权威状态变化后投递事件给 Chat，用于缓存失效和补偿。

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

Chat 不把这些事件当作唯一权威来源；权威读取仍来自只读 view。事件的主要作用是低延迟失效缓存、触发 runtime index rebuild、阻断 active sessions。

用户删除账号：

```text
Main Site -> user.deleted -> Chat
Chat:
  1. 标记/删除该 user 的 chat_sessions/messages/memories/relationships
  2. 删除 runtime vector index 和 stream cache
  3. outbox: chat.account_erasure.completed
```

角色下架：

```text
Main Site -> character.removed -> Chat
Chat:
  1. 阻止新消息
  2. 可选归档相关 active sessions
  3. 清理 persona cache
```

## 6. Image / Video 对接：BullMQ 任务 + Blob + Main Finalize

### 6.1 拓扑

```text
浏览器 -> 主站 POST /api/v1/generation/jobs
主站：
  1. 鉴权 / Premium 门 / 输入审核
  2. 预估价格并 reserve dreamcoin
  3. 写 GenerationJob(status=queued)
  4. add BullMQ job: ai.image.generate 或 ai.video.generate
  5. 返回 { jobId }，前端轮询 /api/v1/generation/jobs/:id

image/video worker：
  1. consume BullMQ job
  2. 调模型
  3. 写共享 blob bucket
  4. add BullMQ job: app.ai.finalize(generation.completed)

主站 finalizer：
  1. consume app.ai.finalize
  2. 输出审核
  3. 写 MediaAsset
  4. 更新 GenerationJob(completed/failed/blocked)
  5. settle/refund dreamcoin
```

### 6.2 `ai.image.generate` payload

payload 自包含，worker 不回查主站 DB：

```jsonc
{
  "version": 1,
  "kind": "image",
  "requestId": "uuid",
  "generationJobId": "generation_job_id",
  "userId": "user_id",
  "characterId": "character_id",
  "prompt": "...",
  "negativePrompt": "...",
  "controls": {},
  "presetIds": [],
  "orientation": "portrait",
  "count": 2,
  "seed": "generation_job_id",
  "model": "sdxl",
  "outputPrefix": "gen/generation_job_id/"
}
```

### 6.3 `ai.video.generate` payload

```jsonc
{
  "version": 1,
  "kind": "video",
  "requestId": "uuid",
  "generationJobId": "generation_job_id",
  "userId": "user_id",
  "characterId": "character_id",
  "prompt": "...",
  "negativePrompt": "...",
  "controls": {},
  "seconds": 4,
  "seed": "generation_job_id",
  "model": "video-default",
  "outputPrefix": "gen/generation_job_id/"
}
```

### 6.4 `app.ai.finalize` generation completed payload

```jsonc
{
  "version": 1,
  "kind": "generation.completed",
  "requestId": "uuid",
  "generationJobId": "generation_job_id",
  "mode": "image",
  "assets": [
    {
      "key": "gen/generation_job_id/0.webp",
      "width": 1024,
      "height": 1024,
      "contentType": "image/webp"
    }
  ],
  "usage": { "gpuSeconds": 8.3, "model": "sdxl" }
}
```

失败终态：

```jsonc
{
  "version": 1,
  "kind": "generation.failed",
  "requestId": "uuid",
  "generationJobId": "generation_job_id",
  "mode": "image",
  "error": {
    "code": "model_overloaded",
    "message": "Provider overloaded",
    "retryable": false
  }
}
```

retryable 错误优先让 BullMQ 自动重试；到达最大 attempts 后，由 worker failed hook 或主站 reconciler 把终态失败投递到 `app.ai.finalize`，用于退款和 DB 状态收敛。

## 7. 资产交接

AI 服务自己把媒体字节写入共享 blob bucket，只通过 finalize payload 回传 `key`。

```text
AI worker -> BlobStore putPrivate(key, bytes)
AI worker -> app.ai.finalize { assets: [{ key, width, height }] }
主站 -> signGetUrl(key) 给浏览器展示/下载
```

主站不经手媒体字节，避免大文件穿过 Next.js API route。

## 8. 幂等、失败与恢复

### 8.1 幂等键

| 对象 | 稳定 ID |
|------|---------|
| Chat internal generate job | `chat-generate:<assistantMessageId>` |
| Chat outbox event | `chat-outbox:<eventId>` |
| image/video generate job | `generation:<generationJobId>` |
| generation finalize job | `generation-finalize:<generationJobId>:<state>` |

Chat DB 更新必须按 business id 幂等：已 `sent` 的 assistant 不重复计 usage；已 selected 的 message version 不重复创建；同一个 outbox event 不重复投递。

### 8.2 Chat 失败处理

- Chat worker 进程崩溃：BullMQ stalled/retry 机制重新投递。
- provider retryable 失败且尚未写出 delta：worker throw，让 BullMQ 按 attempts/backoff 重试。
- 已写出 delta 后 provider 失败：写 `error` event，assistant message 标记 `failed` 或保存 partial policy，避免前端收到重复文本。
- 输出审核 blocked：assistant message 标记 `blocked`，写 moderation event，不写长期 memory。
- Redis Stream token 丢失或过期：不影响最终消息落库；前端刷新后从 Chat DB 获取最终状态。

### 8.3 Image/Video 失败处理

- worker 进程崩溃：BullMQ stalled/retry。
- provider retryable 失败：worker throw 触发 retry。
- provider non-retryable 失败：投递 `app.ai.finalize(generation.failed)`，主站退款并标记 failed/blocked。
- 主站 finalizer 崩溃：`app.ai.finalize` 自己也是 BullMQ job，会重试。

### 8.4 Reconciler

Chat Service reconciler：

- 扫描长时间 `generating` 的 assistant messages。
- 对照 BullMQ job / Redis Stream 状态。
- 对 exhausted failed jobs 标记 failed。
- 对已完成但 outbox 未投递的事件重投。

主站 generation reconciler：

- 扫描长时间 `queued/running` 的 generation jobs。
- 对照 BullMQ job 状态。
- 对 exhausted failed jobs 投递 finalize failed。
- 对 orphan completed queue jobs 做补偿落库。

## 9. 安全边界

- 浏览器永不直连 AI worker、Redis、Blob 写接口。
- Chat Service 可以读主站 User 和角色数据，但只能读最小字段 view。
- Chat Service 不写 `core.*`、`billing.*`、`compliance.*` 权威表。
- 主站 BFF header 必须签名、短 TTL、防重放。
- Chat 在热路径复查 user status、age eligibility、entitlement、character status。
- Worker 写 blob 的对象默认 private；只有主站能签发读取 URL。
- Redis 访问使用私网/VPC、TLS、ACL；不同环境使用不同 prefix。

## 10. 契约与测试

### 10.1 Schema 契约

Chat Service 与主站共享或生成以下 schema：

```text
ChatUserView
ChatCharacterView
ChatEntitlementView
ChatEligibilityView
ChatOutboxEvent
ChatStreamEvent
ImageGeneratePayload
VideoGeneratePayload
GenerationFinalizePayload
```

### 10.2 Chat 独立测试

1. 启动 Chat DB + Redis。
2. 准备只读 view fixtures。
3. 调 `POST /api/v1/chat/sessions/:id/messages`。
4. fake model 写 Redis Stream token。
5. 断言 Chat DB 中 assistant message、version、usage、memory、relationship 已更新。
6. 断言 outbox 中有 `chat.message.completed`。
7. 删除 message/memory/session 后，断言后续 context 不含被删除材料。

### 10.3 主站集成测试

1. 主站更新 user/character/entitlement/eligibility。
2. Chat 通过 read view 或事件看到变化。
3. Chat 完成消息后投递 outbox。
4. 主站消费 outbox，更新 library/stats/analytics/safety。
5. 主站下架 character 后，Chat 阻断新消息。

### 10.4 Image/Video 集成测试

1. 调 `/api/v1/generation/jobs`。
2. fake worker 消费 `ai.image.generate` 并投递 `app.ai.finalize`。
3. 主站 finalizer 落库。
4. 轮询 `/api/v1/generation/jobs/:id`，断言 completed + assets。

## 11. 配置与部署

```env
# Main Site
CHAT_SERVICE_URL=https://chat.internal
CHAT_BFF_SIGNING_SECRET=...
IMAGE_PROVIDER=pipeline
VIDEO_PROVIDER=pipeline
REDIS_URL=redis://...
BULLMQ_PREFIX=idream:prod

# Chat Service
DATABASE_URL=postgres://...
CHAT_REDIS_URL=redis://...
CHAT_BFF_SIGNING_SECRET=...
CHAT_MODEL_PROVIDER=pipeline
CHAT_MODEL_API_URL=...
CHAT_MODEL_API_TOKEN=...

# Image/Video workers
REDIS_URL=redis://...
BULLMQ_PREFIX=idream:prod
BLOB_*=...
```

部署形态：

- 主站 web：处理公开页、角色、billing、generation、library，以及可选 Chat BFF proxy。
- Chat Service web：处理 chat API 和 SSE。
- Chat Service worker：消费 `chat.generate`、memory、outbox、cleanup。
- 主站 generation finalizer worker：消费 `app.ai.finalize`，负责 image/video 审核、落库、计费收敛。
- image worker：消费 `ai.image.generate`，写 blob。
- video worker：消费 `ai.video.generate`，写 blob。

## 12. 落地路径

1. 定义 Chat Service 只读 view schema 和 Chat outbox event schema。
2. 建立 DB role：Chat 对主站权威 schema 只读，对 chat schema 读写。
3. 把 chat tables 从主站模块边界迁移到 Chat Service ownership。
4. 主站 `POST /chat/*` 改为代理/调用 Chat Service。
5. Chat Service 实现 send message、SSE、memory、relationship、usage 的完整闭环。
6. 主站消费 Chat outbox，更新 library/stats/analytics/safety。
7. 保留 image/video 的 `ai.image/video.generate -> app.ai.finalize` 路径。
8. 删除旧的 `ai.chat.generate -> app.ai.finalize(chat.completed)` 跨服务路径。
9. 增加 reconciler、队列仪表盘和权限审计。
