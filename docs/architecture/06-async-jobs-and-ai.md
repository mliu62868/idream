# 06 · 异步任务与 AI 集成

更新日期：2026-06-28

本文件落地 Redis + BullMQ 跨服务任务总线与 ADR-6（AI provider 抽象），以及生成/聊天的异步流水线与 dreamcoin 预留结算。Chat Service 拥有 chat domain DB 和内部队列；Image/Video 仍使用主站到 AI worker 的跨服务队列。队列清单对齐 `BackendFeatureSpec §7` 与 `docs/research/SERVICE_INTEGRATION.md`。

## 1. 为什么异步

同步 HTTP 路径**禁止**调 AI / 做重 IO（01 §8）。聊天生成在 Chat Service 内部入队；图/视频生成、审核、webhook、奖励发放、摘要等也必须异步化。好处：serverless 不超时、可重试、可观测、可限并发、可控成本。

## 2. 队列模型（BullMQ + Redis）

任务不再把主站 Prisma `jobs` 表当跨服务队列。Image/Video 由主站和 AI worker 通过 BullMQ queue 交换可靠任务；Chat 使用 Chat Service 内部 BullMQ/Redis 队列，Redis Stream 保存 chat token log。

```
waiting ──worker──▶ active ──ok──▶ completed
   ▲                   │
   │                   └─fail&可重试─▶ delayed/waiting (attempts + backoff)
   └───────────────────────────────────────────────────
                       └─超过 attempts──▶ failed（死信，留证 + 告警）
```

接口（`packages/main/src/server/jobs/queue.ts`；chat 侧对称在 `packages/chat/src/queue.ts`）：

```ts
export interface JobQueue {
  enqueue(queue: QueueName, payload: unknown, opts?: { dedupeKey?: string; priority?: number; delayMs?: number }): Promise<string>;
  processNext(queue: QueueName, workerId: string, handler: Handler): Promise<ProcessResult>;
  getByDedupeKey(queue: QueueName, dedupeKey: string): Promise<JobSnapshot | null>;
}
```

底层用 `bullmq` 的 `Queue` / `Worker` + `ioredis`，`dedupeKey` → 确定性 `jobId` 实现入队去重。

## 3. Worker 进程与拓扑

**worker 是常驻进程**（pm2，见 `ecosystem.config.js` / 10）——不是 serverless Cron 拉取，也不再用 DB 行 `claim()`：

- `gen-image` / `gen-video`（`packages/gen`）消费 `ai.image.generate` / `ai.video.generate`。
- `chat`（`packages/chat`）单进程内含 API + chat worker，消费 chat.* 队列。
- `gen-finalizer` / `main-event-consumer`（`packages/main`）做主站侧回写与跨服务事件消费。

每个 BullMQ `Worker` 从其队列拉 job → 按 queue 分发到 handler → 由 BullMQ 标记 completed/failed（失败按 `attempts` + backoff 重排，超限进 failed 死信）。并发安全由 BullMQ + Redis 原子操作保证，**无需 `SELECT ... FOR UPDATE SKIP LOCKED`**。

**幂等**：每个 handler 必须可重入（如"生成已完成则跳过"、webhook 按 `provider_events` 去重、ledger 按 `sourceId` 去重）。

## 4. 队列清单与 handler

| queue | producer | handler 职责 | 幂等键 |
| --- | --- | --- | --- |
| `moderation.input` | chat/creator/generation | 高危内容拦截（在调模型/provider 前） | target |
| `chat.generate` | Chat Service API | 拼 prompt → ChatModel 流 → Redis Stream token → Chat DB 落 assistant/usage/memory/relationship/outbox | assistantMessageId |
| `chat.memory.extract` | Chat worker | 从已通过审核的消息抽取长期记忆候选并写 Chat DB | assistantMessageId |
| `chat.memory.rebuild` | Chat reconciler / 删除补偿 | 从 Chat 权威 memory/message 状态重建运行时 memory index | userId+characterId+version |
| `chat.outbox.deliver` | Chat DB outbox | 向主站投递 chat.message.completed、chat.usage.incremented、chat.safety.flagged 等事件 | eventId |
| `ai.image.generate` | generation API | ImageModel → BlobStore → 投递 finalize | generationJobId |
| `ai.video.generate` | generation API（P1） | 同上，VideoModel | generationJobId |
| `app.ai.finalize` | image/video AI workers | 输出审核 → 落库 media/generation/ledger | generationJobId |
| `moderation.output` | model workers | 释放或拦截生成产物/消息 | target |
| `character.preview` | creator API | 生成草稿预览图 | draftId+rev |
| `age.verification.webhook` | 验证 provider | 幂等更新 `age_verifications` 状态 | providerEventId |
| `billing.webhook` | 支付 provider | 同步订阅/权益/ledger | providerEventId |
| `reward.ledger` | referral/redeem/signup | 恰好一次发奖（dreamcoin/entitlement） | sourceId |
| `report.triage` | reports API | 按类别定优先级、未成年即时隐藏 | reportId |
| `analytics.events` | 各 API（或直接 after 落表） | 落库/外发，fire-and-forget | — |
| `chat.summarize` | Chat worker | 压缩旧消息进 Chat DB `memorySummary` | sessionId+watermark |
| `media.cleanup` | media delete | 删对象存储 bytes | assetId |

> moderation.input 可"同步快路径 + 异步深检"：发消息时同步跑一个低延迟分类（拦明显高危），深度检测（哈希匹配等）在 worker 补。CSAM 检测**必须**在产物释放前完成（07 §3）。

## 5. AI Provider 抽象层（`src/server/providers/`）

全部接口化，dev 有 mock（确定性假数据），prod 注入真实实现 —— 生成类（chat/image/video/voice）统一指向**内部自托管开源模型流水线 API**（OpenAI 兼容，ADR-6）。

```ts
// providers/chat/types.ts
export interface ChatModel {
  stream(input: {
    system: string; memory?: string;
    messages: { role: "user"|"assistant"; content: string }[];
    model?: string; maxTokens?: number;
  }): AsyncIterable<{ delta: string; done?: boolean; tokens?: number }>;
}

// providers/image/types.ts
export interface ImageModel {
  generate(input: { prompt: string; negativePrompt?: string; controls: Record<string,unknown>;
    orientation?: string; count: number; }): Promise<{ assets: { bytes: Blob; meta: object }[]; cost: number }>;
}

// providers/video/types.ts —— 同构（P1）
// providers/voice/types.ts
export interface Voice { synthesize(input: { text: string; voiceId: string }): Promise<{ bytes: Blob; seconds: number }>; }

// providers/moderation/types.ts —— 安全关键
export interface Moderation {
  checkText(text: string, kind: "input"|"output"): Promise<ModerationResult>;
  checkImage(bytes: Blob): Promise<ModerationResult>;   // 含 CSAM 哈希匹配 + 分类
}
export type ModerationResult = {
  decision: "passed"|"flagged"|"blocked";
  policyCode?: string;       // 见 07 §4
  confidence?: number;
  details?: unknown;
};
```

**provider 注册**（`providers/index.ts`）：按 env 选择实现，统一加超时/重试/熔断/日志。生成（chat/image/video/voice）统一对接**内部自托管开源模型流水线 API**（`PIPELINE_API_URL`+`PIPELINE_API_TOKEN`，OpenAI 兼容，模型名/profile 参数化）。`packages/gen` 不直接加载 MLX 或 `stable-diffusion.cpp`；Pipeline Service 内部再按后台发布的 model profile 选择 runner。P0 图片生产 runner 优先 `stable-diffusion.cpp`，MLX 只作为 Apple Silicon 本地实验 runner。**审核（moderation）保持独立**：通用安全分类可同流水线，但 CSAM 哈希匹配 + NCMEC 上报是独立服务、独立密钥（07 §3）。

```ts
export const providers = {
  chat:       process.env.NODE_ENV === "test" ? mockChat   : makeChat(env),
  image:      isMock ? mockImage  : makeImage(env),
  video:      isMock ? mockVideo  : makeVideo(env),
  voice:      isMock ? mockVoice  : makeVoice(env),
  moderation: isMock ? mockMod    : makeModeration(env),   // 即便 mock 也保留未成年硬规则
  payment:    makePayment(env),
  blob:       makeBlob(env),
  ageVerify:  makeAgeVerify(env),
};
```

## 6. 生成流水线（图片，端到端）

```
POST /generation/jobs
  │ service:
  │  1) 校验 mode/character|Freeplay/controls (Zod)
  │  2) Premium 门: requireEntitlement(custom_prompt / video_gen ...)
  │  3) 估价 cost = price(mode, count, model)
  │  4) dreamcoin RESERVE（事务: 校验余额 >= cost，写 ledger delta=-cost reason=generation_spend(reserved)）
  │  5) 落 GenerationJob(queued, costDreamcoins=cost) + enqueue('generation.image', {jobId})
  ▼ 返回 202 {jobId}
worker generation.image:
  1) job→running
  2) moderation.input(prompt+controls) ── blocked → REFUND + job=blocked + moderation_event
  3) ImageModel.generate(...) ── provider 失败 → 可重试; 超限 → REFUND + job=failed(errorCode)
  4) moderation.output(每张图: CSAM/未成年/深伪/禁内容) ── 命中 → 丢弃该图 + REFUND 对应份额 + 留证
  5) BlobStore.putPrivate(bytes) → 落 MediaAsset(private, safetyStatus=passed)
  6) SETTLE（确认扣费；若部分失败按份额 refund）→ job=completed(completedAt)
  7) after: events.track('generation_completed')；revalidate library
```

价格表（`generation_jobs.costDreamcoins`）由 `lib/pricing.ts` 单点定义（SSoT）：按 mode × model × count × orientation。失败原因码与可重试性写入 `errorCode`（GN-11）。

## 7. 聊天流水线（流式）

见 01 §4.2、05 §4 与 `docs/product/CHAT_SERVICE_PRD.md`。Chat Service 自己拥有热路径写库和内部 worker。

```text
POST /chat/sessions/:id/messages
  │ Chat Service:
  │  1) 验证 BFF/internal user context
  │  2) 只读主站 views: user / eligibility / entitlement / character
  │  3) 检查 owner、角色状态、年龄/身份、quota、rate limit
  │  4) moderation.input(content)
  │  5) transaction:
  │       insert user message
  │       insert assistant placeholder(status=generating)
  │       update session.lastMessageAt
  │  6) enqueue('chat.generate', {sessionId,userMessageId,assistantMessageId,streamKey})
  ▼ 返回 {assistantMessageId, streamUrl}

worker chat.generate:
  1) 读取 recent messages + memorySummary + companionMemories + relationshipState
  2) 读取 character persona / entitlement / eligibility view
  3) ChatModel.stream(...)
  4) 写 Redis Stream start/delta/done/error
  5) moderation.output(full text)
  6) transaction:
       update assistant message + message_versions(selected)
       increment chat_usage
       update memorySummary
       apply companionMemories
       apply relationshipStates
       insert chat_moderation_events
       insert chat_outbox_events
  7) enqueue('chat.outbox.deliver')
```

额度：免费用户按 Chat DB `chat_usage` 限；`unlimited_messages` entitlement view 跳过；模型能力按 plan（Deluxe = premium models + 3x memory）。Chat 发送 `chat.usage.incremented` 给主站 analytics/billing 报表，但主站不参与每条消息的落库。

## 8. dreamcoin 预留/结算不变量（与 08 一致）

1. **余额 = SUM(ledger.delta)**，绝不就地覆盖（01 §8、03、08 §4）。
2. 生成前 **reserve**（负 delta，reason 标 reserved/source=jobId）；成功 **settle**（确认），失败/拦截 **refund**（反向正 delta，source=jobId）。
3. 每个 jobId 的净额必须收敛（要么扣成功、要么全额退）。worker 重入时按 `sourceId` 去重，避免重复扣/退。
4. 奖励（signup/referral/redeem）经 `reward.ledger` 队列恰好一次。

## 9. 可靠性与可观测

- BullMQ 队列状态即仪表盘：failed 数告警；各 queue 积压量（waiting/active）、平均处理时长进 metrics（10）。
- 重试退避：BullMQ `attempts` + 指数 backoff（封顶）。
- 死信留证：failed job 的 `failedReason` + payload 由 BullMQ 保留，便于人工重放（admin 提供 requeue）。
- 超时：worker handler 各自设软超时；provider 调用必须有超时，防止 worker 卡死。
- 跨服务投递：main ↔ chat 经 outbox/inbox 事件表 + 共享 Redis，要求两边 `BULLMQ_PREFIX` + `REDIS_URL` 一致。
