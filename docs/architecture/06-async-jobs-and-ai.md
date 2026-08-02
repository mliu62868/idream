# 06 · 异步任务与 AI 集成

更新日期：2026-08-01

> 2026-08-01 authority：Generation 的业务真相是 Request → Attempt → TransportExecution → Artifact → Delivery；BullMQ job 只承载 transport，不是业务 outcome authority。图片/视频 provider invocation 只存在于 `packages/gen`，Main 以同一事务创建 Attempt + dispatch Outbox，接收 immutable terminal record 并结算。Main↔Chat 业务事件只走 Outbox → HTTP durable ingest → Inbox ACK。

本文件落地 Redis + BullMQ 的生成 transport、服务内任务队列、HTTP durable event exchange 与 ADR-6（AI provider 抽象），以及生成/聊天的异步流水线与 dreamcoin 预留结算。Chat Service 拥有 chat domain DB 和内部队列；Image/Video 使用 Main 到 Gen 的任务队列，业务事件不以共享 Redis 作为跨服务接收凭证。队列清单对齐 `BackendFeatureSpec §7` 与 `docs/research/SERVICE_INTEGRATION.md`。

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

接口（`packages/main/src/server/jobs/queue.ts`；chat 的队列只服务 Chat 内部工作）：

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

**幂等**：每个 handler 必须可重入（如"生成已完成则跳过"、webhook 按 `provider_events` 去重、Ledger 按稳定 `idempotencyKey` replay/conflict）。

Generation 额外遵循：

- 每次真实 provider invocation 前由 Gen 向 Main 的内部 HTTP seam 报告 `GenerationTransportExecution`；Main 持久化该证据。同一业务 Attempt 内 transport retry 只递增 `transportAttemptNo`。
- 自动 transport retry 只允许 provider 声明 deterministic idempotency；ambiguous 且不可幂等的结果终止为 `unknown/non-replayable`。
- Main 在一个事务中创建业务 Attempt 与 dispatch Outbox；Outbox 重放使用 attempt 级确定性 BullMQ job id。
- 每个 immutable Attempt 独占 `gen/{requestId}/attempts/{attemptId}/` 输出前缀；图片不能把旧 Attempt 的已存在对象当作本次产物，视频不能覆盖仍被旧 terminal evidence 引用的对象。
- gen 先持久化带 checksum、outcome、artifact、provider 与 cost 的 immutable terminal record，再按 Attempt key 投递 Main-owned durable relay；Main 短时不可用只重试 relay row，relay admission 失败时只重投 record，不再次调用 provider。
- terminal record 覆盖 `succeeded / failed / blocked / unknown`；`blocked` 不压成 `failed`，不可重放的 ambiguous 视频结果保持 `unknown`。
- Request cancelled 后的晚到 artifact 只能 archive/suppress，不 delivery、不改变 cancelled、不重复 capture/refund。
- DreamcoinLedger 是 settlement authority；execution status 不承载 refunded 语义。

部署把 `attemptId / attemptNo` 设为必填前，必须先执行
`bun run --cwd packages/main check:generation-cutover`。该门禁只读检查活动 Request、immutable
dispatch Outbox，以及 Redis 中 `ai.image.generate`、`ai.video.generate`、
`app.generation.terminal.ingest`、`app.ai.finalize` 的
实际 in-flight Bull row 与所有 `pending / dispatched` terminal Outbox；每一行都必须绑定最新
Attempt、精确 pins、attempt 级 dedupe、确定性 Bull job id 与对应 immutable Outbox。任何 legacy
payload、缺失 Attempt/dispatch/terminal Outbox 都会以非零退出，门禁不会删除或重派队列。
活动 Request 的最新 queued/running Attempt 一旦已有 `terminalRecordRef`，还必须同时存在内容精确的
terminal Outbox 与非终态 exact finalize Bull row；Outbox 已 delivered 但 Bull row 缺失、failed 或
completed 属于 stranded finalization，必须先显式对账，不能因 pending Outbox 已归零而放行。合法
`unknown` Attempt 是例外：Request 会保持 active 等待运营对账；门禁改为验证 delivered exact Outbox、
`generation.attempt.unknown.v1` terminal event 与 `provider_outcome_unknown` Request event，并允许 finalize
Bull row 已 completed 或按保留策略移除。

`pm2:start:production`、`pm2:restart:production` 与 `pm2:reload:production` 的固定切换顺序是：

1. 在 Main、Gen 与 finalizer 仍在线时，全局 pause image/video/terminal-ingest/finalize 四条 BullMQ queue；
2. 等待所有 active handler 完成。Gen 可继续写 terminal record 并投递 durable relay；Main 将
   `pending / dispatched` terminal Outbox 投递到已经暂停的 finalize queue；
3. 只有四条 queue 都已确认 paused、active row 为 0、terminal Outbox 为 0 后，才先停止
   `main-web / admin-web / chat / main-event-consumer / admin-command-worker`，再停止
   `gen-image / gen-video / gen-finalizer`，其中 finalizer 最后；
4. 以 `pm2 jlist` 确认非 voice 进程为 `stopped / errored / absent`，执行只读 authority gate；
5. PM2 action 返回 0 后仍保持 queue paused；有限时轮询 `pm2 jlist`，要求 ecosystem
   的期望实例数全部 `online`，再验证 Main/Admin HTTP、Chat `/healthz`、Fish `/health`
   与 Gen `preflight`（ComfyUI model refs + `ffprobe`/`ffmpeg`）；全部通过后才显式
   resume 四条 queue。

pause/drain、stop、静止确认、门禁、PM2 action、运行态 readiness 或 resume 任一步失败，都不会开放生成队列；resume
部分失败还会 best-effort 把四条 queue 全部重新 pause。发布方应先 drain 或显式对账异常 Request，
worker 不会从可变 Job 字段猜测或补造执行身份。

## 4. 队列清单与 handler

| queue | producer | handler 职责 | 幂等键 |
| --- | --- | --- | --- |
| `moderation.input` | chat/creator/generation | 高危内容拦截（在调模型/provider 前） | target |
| `chat.generate` | Chat Service API | 拼 prompt → ChatModel 流 → Redis Stream token → Chat DB 落 assistant/usage/memory/relationship/outbox | assistantMessageId |
| `chat.memory.extract` | Chat worker | 从已通过审核的消息抽取长期记忆候选并写 Chat DB | assistantMessageId |
| `chat.memory.rebuild` | Chat reconciler / 删除补偿 | 从 Chat 权威 memory/message 状态重建运行时 memory index | userId+characterId+version |
| `chat.outbox.deliver` | Chat DB outbox | HTTP 投递 Main durable ingest；Main receipt commit ACK 后才标 delivered | eventId |
| `ai.image.generate` | Main generation/Character Preview dispatch Outbox | Gen Image backend → BlobStore → immutable terminal record → durable relay admission | attemptId |
| `ai.video.generate` | Main generation dispatch Outbox | Gen Video backend → BlobStore → immutable terminal record → durable relay admission | attemptId |
| `app.generation.terminal.ingest` | Gen Image/Video | 独立重试 terminal ingest；gen-finalizer 调用 Main idempotent ingest authority | attemptId |
| `app.ai.finalize` | Main terminal-record Outbox | Main 投影 terminal record → Artifact/Delivery/settlement | attemptId |
| `moderation.output` | model workers | 释放或拦截生成产物/消息 | target |
| `age.verification.webhook` | 验证 provider | 幂等更新 `age_verifications` 状态 | providerEventId |
| `billing.webhook` | 支付 provider | 同步订阅/权益/ledger | providerEventId |
| `reward.ledger` | referral/redeem/signup | 恰好一次发奖（dreamcoin/entitlement） | sourceId |
| `report.triage` | reports API | 按类别定优先级、未成年即时隐藏 | reportId |
| `analytics.events` | 各 API（或直接 after 落表） | 落库/外发，fire-and-forget | — |
| `chat.summarize` | Chat worker | 压缩旧消息进 Chat DB `memorySummary` | sessionId+watermark |
| `media.cleanup` | media delete | 删对象存储 bytes | assetId |

> moderation.input 可"同步快路径 + 异步深检"：发消息时同步跑一个低延迟分类（拦明显高危），深度检测（哈希匹配等）在 worker 补。CSAM 检测**必须**在产物释放前完成（07 §3）。

## 5. AI Provider 抽象与 owner

全部接口化，dev 有 mock（确定性假数据），prod 注入真实实现。每类 provider 由使用它的服务持有：ChatModel 属于 Chat，Image/Video backend 属于 Gen，Voice/Moderation 等由各自现有服务持有；Main 不创建图片/视频 provider。

```ts
// providers/chat/types.ts
export interface ChatModel {
  stream(input: {
    system: string; memory?: string;
    messages: { role: "user"|"assistant"; content: string }[];
    model?: string; maxTokens?: number;
  }): AsyncIterable<{ delta: string; done?: boolean; tokens?: number }>;
}

// packages/gen/src/backend/types.ts
export interface GenBackend {
  generate(input: GenerationInput): Promise<GenerationOutput>;
}

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

**provider 注册**：Chat/Voice/Moderation 等按所属服务的 env 选择实现，统一加超时、重试、熔断和日志。图片/视频生产只由独立 `packages/gen` worker 的 workflow-native `GenBackend` seam 承担；Main 不注册、不调用图片/视频 provider。`GenerationModelProfile.workflowKey ?? pipelineModel` 选择 descriptor，descriptor 再选择 `comfyui`、`sdcpp` 或可选的 `drawthings` adapter。Node worker 本身不加载模型权重：ComfyUI 走原生 HTTP，sd.cpp 与 Draw Things 分别启动受超时约束的 `sd-cli` / `draw-things-cli`。**审核（moderation）保持独立**。

不建立跨服务 `providers` 总注册表；服务只装配自己真正调用的 adapter。

## 6. 生成流水线（图片，端到端）

```
POST /generation/jobs
  │ Main transaction:
  │  1) 校验 mode/character|Freeplay/controls (Zod)
  │  2) Premium 门: requireEntitlement(custom_prompt / video_gen ...)
  │  3) 估价 cost = price(mode, count, model)
  │  4) dreamcoin RESERVE（事务: 校验余额 >= cost，写 ledger delta=-cost reason=generation_spend(reserved)）
  │  5) 同事务落 Request + Attempt + dispatch Outbox；worker 按 attemptId 幂等入 Gen queue
  ▼ 返回 202 {jobId/requestId/attemptId}
Gen worker:
  1) claim transport work，并向 Main 记录 running TransportExecution
  2) moderation.input(prompt+controls)；阻断时产出 blocked terminal record
  3) GenBackend.generate(...)；只在明确可重试且 provider 支持确定幂等时重试
  4) moderation.output + artifact verification + BlobStore.putPrivate(bytes)；生产 LTX
     视频必须先由 ffprobe 读取实测 envelope、ffmpeg 完整解码，并匹配
     768×1152 / 4s / 25fps / audio
  5) 先持久化 immutable terminal record，再以 Attempt key 投递到 Main-owned durable relay
Main finalizer:
  1) 消费独立 terminal relay，按 attemptId + terminal-record hash durable ingest；相同 replay，冲突 fail closed
  2) 同事务写 TransportExecution/Artifact/Delivery/finalize outbox
  3) 通过 `postDreamcoinEntry` SETTLE/REFUND；同一业务 intent 不重复扣退
  4) Main 短时不可用只重试 relay row；relay admission 中断时 Gen 回读并重投同一 terminal record，不再调用 provider
  5) exhausted relay/finalize 按 cursor 分页逐行校验；毒行隔离，合法 failed row 可在 paused/cold-start 后重驱动
  6) exhausted source 只有精确 Blob terminal record 才能重驱动；无 Blob 或身份不匹配时 fail closed
```

价格表（`generation_jobs.costDreamcoins`）由 `lib/pricing.ts` 单点定义（SSoT）：按 mode × model × count × orientation。失败原因码与可重试性写入 `errorCode`（GN-11）。

### 6.1 Voice clip 请求与用量权威

Voice 播放是同步用户路径，但不能把 `MediaAsset` 当请求或计量 authority：

- `VoiceClipRequest(userId, messageId)` 是单飞与重放边界；持久 lease 防止刷新、并发点击或网络丢响应导致重复调用 TTS provider。
- provider 调用携带稳定 `requestId / attemptNo / idempotencyKey`；失败或 lease 过期后才 append 下一 attempt。
- `VoiceUsageFact(requestId, attemptNo)` 是 append-only 用量与成本事实；分钟余额只从该表聚合，删除或替换音频素材不会返还已消费分钟。
- `prewarm` 与 `play` 共享同一合成请求指纹：预热成功后点击播放直接重放同一素材；预热不得自动花 Dreamcoin。
- `MediaAsset` 只承载可播放产物；审核、删除与缓存升级不能改写历史 usage fact。

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
3. 每个 jobId 的净额必须收敛（要么扣成功、要么全额退）。worker 重入时通过 `postDreamcoinEntry` 的稳定 `idempotencyKey` 去重，避免重复扣/退。
4. 奖励（signup/referral/redeem）经 `reward.ledger` 队列恰好一次。

## 9. 可靠性与可观测

- BullMQ 队列状态即仪表盘：failed 数告警；各 queue 积压量（waiting/active）、平均处理时长进 metrics（10）。
- 重试退避：BullMQ `attempts` + 指数 backoff（封顶）。
- 死信留证：failed job 的 `failedReason` + payload 由 BullMQ 保留，便于人工重放（admin 提供 requeue）。
- 超时：worker handler 各自设软超时；provider 调用必须有超时，防止 worker 卡死。
- 跨服务投递：main ↔ chat 经 sender Outbox → HTTP durable ingest → receiver Inbox ACK；BullMQ 只唤醒 receiver 已持久化的 receipt，不构成跨服务交付成功。
- 陈旧 generation 只负责恢复精确 dispatch 或隔离为 `unknown`：reconciler 在同一事务锁定并重读 Job、Attempt、Transport 与 terminal evidence；没有 provider invocation 证据时重投原 immutable Outbox，有模糊执行证据时保持资金预留并等待 operator 对账，不凭 Job 超时自动退款。
