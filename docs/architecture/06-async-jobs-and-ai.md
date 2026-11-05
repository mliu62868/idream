# 06 · 异步任务与 AI 执行

更新日期：2026-11-05

## 1. 两种执行模型

iDream 不把所有慢任务塞进同一队列：

- **Chat AgentRun**：Main 已提交产品 Turn 后，以有界 HTTP 调用 Chat；Chat 流式执行并把终态 CAS 回 Main。它不是 BullMQ job。
- **Durable jobs**：生成、terminal finalizer、webhook 和后台处理使用 Main/Gen 的 BullMQ 与数据库终态协议。

这样既保留 Chat token 流，也让真正需要离线重试和计费结算的生成任务拥有 durable authority。

## 2. 队列清单

| queue / carrier | producer | consumer | 幂等身份 |
| --- | --- | --- | --- |
| `ai.image.generate` | Main Generation dispatch | Gen image worker | `attemptId` |
| `ai.video.generate` | Main Generation dispatch | Gen video worker | `attemptId` |
| `app.generation.terminal.ingest` | Gen terminal relay | Main ingest/finalizer | `attemptId` |
| `app.ai.finalize` | Main terminal outbox | Main finalizer | `attemptId` |
| `billing.webhook` | payment ingress | Main billing worker | provider event id |
| `age.verification.webhook` | verification ingress | Main compliance worker | provider event id |
| `reward.ledger` | product reward intent | Main ledger worker | source id |
| `report.triage` | report API | Main trust worker | report id |
| Main durable outbox | Main authority transaction | target service HTTP ingest | event id |
| `generation.blob_cleanup.requested.v1` outbox | Main terminal ingest | Main event-consumer 独立 cleanup lane | `attemptId` |

Chat 没有 `chat.generate`、`chat.memory.extract` 或 `chat.outbox.deliver` queue。

## 3. Chat AgentRun

```text
Main transaction commits Turn
  -> Main signs execution + authority snapshot
  -> Chat atomically creates AgentRun
  -> Pi emits model/tool events
  -> Chat streams transient tokens through Redis/SSE
  -> Chat persists immutable pending proposal.json
  -> Chat posts terminal candidate to Main
  -> Main exact-attempt CAS + usage commit
  -> durable ACK
  -> Chat emits done and cleans accepted successful trace
Main committed Turn -> durable memory projection -> Chat prepare/promote
```

重连从 Redis/AgentRun events 恢复传输，但产品完成状态必须重新向 Main 查询。相同 idempotency key 对已终态 Turn 只返回当前产品结果，不重启模型。Main ACK 未确定时保留精确 proposal；成功提交后清理本地成功轨迹，失败或未决轨迹最多保留七天。记忆只从 Main 已提交 Turn 异步投影，不从 Chat 终态候选直接 ingest（ADR-21）。

## 4. ToolEffect 与 Generation

图片/视频工具不是通用“成功 hook”。它是 Main 暴露的窄命令端口：

1. Chat 提交 `turnId + attempt + callId + arguments`。
2. Main 验证 active attempt、工具权限、entitlement 与余额。
3. Main 在 durable transaction 中建立 Generation Request/Attempt 和 reserve，再 ACK。
4. Gen 只执行 provider，产出不可变 TerminalRecord。
5. Main 根据 Artifact/Delivery 终态 settle；失败、取消或无交付时 release/refund。

`callId` 相同而参数 digest 不同必须冲突；相同请求 replay 返回同一个 Generation，不重复扣费。

## 5. Generation 状态链

```text
Request admitted
  -> Attempt dispatched
  -> TransportExecution
  -> immutable TerminalRecord
  -> Artifact
  -> Delivery
  -> Settlement or refund
```

- Request/Attempt 是执行身份；Job 展示字段不能反推或补造它们。
- provider 超时、进程退出和 terminal relay 重试都不能产生第二笔结算。
- 图片/视频 worker ownership 在启动和恢复时必须精确；mock video 不注册真实 video worker。
- 写入失败的私有产物不进入 Artifact/Delivery。Gen 对所有已尝试的精确 key 回滚，确认已存在的对象不回滚；未获删除成功确认的 key 进入 failed TerminalRecord 的可选 `cleanupKeys`。Main 验证不可变 dispatch 的 attempt 前缀、文件名与数量预算，在同一接收事务建立清理 outbox，并以 lease/CAS 独立重试；账号擦除也枚举该终态和所有状态的清理 outbox，未删完不能完成。
- 自托管 runner 的记录优先于超时判断：prompt 从 `/history` 与 `/queue` 连续两次消失、或超出执行预算后经取消确认已停止，都是确定失败；取消期间完成的产物照常交付；只有取消后仍在运行或 runner 持续失联才进入 `unknown`（ADR-13 §2.1.6）。
- Main 只在 Bull source 行已不被 worker 持有时才隔离 `running` Attempt；持有期间最多宽限到 stale 阈值的 6 倍。
- 已有待清理 key 时，不自动重用同一 attempt 调用 provider；终态重放只重投原始记录。该协议覆盖已观察到的写入/回滚失败，不宣称覆盖成功 put 后、首次 TerminalRecord 持久化前的所有进程崩溃；open/unknown 生成执行仍须运营收敛后才允许账号硬删。

## 6. Provider 边界

- Chat 模型只由 `packages/chat/src/agent-runtime` 的 OpenAI-compatible adapter 调用。
- 图片/视频 provider 只由 `packages/gen` 执行。
- Main 持有产品策略、moderation、entitlement、ledger、Generation 和交付状态机。
- Provider adapter 只做协议、超时、错误映射与原始执行证据，不做余额更新。
- 语音网关在单一专用线程上执行合成（MLX 要求加载与推理同线程），事件循环保持空闲以响应 `/health`；排队超限返回 503 + `Retry-After`。语音不参与 Gen 的设备租约。
- VoiceClip 单条文本上限 12000 字符，Main 与网关一致；Ming、Pocket 内部切句，Breeze 由网关按句切分后拼接。provider 超时按每 2000 字符一份配置时长线性放大，因此 Fish 上限 24 分钟、Pocket 12 分钟。朗读文本在指纹之前由 `voiceSpeechText` 统一去掉 `*动作*` 叙述；此前的请求保持原文和原 provider key。
- 网关幂等缓存按 `VOICE_CACHE_TTL_DAYS`（默认 7 天）过期，后台线程在幂等锁下逐文件删除，重放会刷新条目；过期后的同 key 重试重新渲染。擦除标记位于子目录，不参与清理。
- VoiceClip 租约为 30s，owner 每 10s 心跳，覆盖合成、编码、上传和提交；进程死亡后最多 30s 就不再占用该用户的预算回合。调用方断开、Call 轮次被取消或 owner 被接管时，Main 中止 provider 请求，网关丢弃尚未开始的渲染；已在 MLX 上运行的渲染无法停止，结果进入幂等缓存供同 key 重试。
- Main 的同步 VoiceClip 和视频后期合成也拥有持久请求/租约与写入证据。账号擦除不能只等待 Gen 的原生生成终态；还须等待 Main 在途私有写入退出、枚举未交付文件，并取得历史 TTS 缓存/alias 的持久擦除 ACK（ADR-17 §6）。语音写入者崩溃不会让擦除永远等待：未登记写入的请求在租约过期后关闭，已登记的写入者等到其持久记录的写入截止时间（约 3 分钟）之后关闭。

## 7. 可靠性与可观测

- BullMQ job 使用业务 identity，不使用随机重试 identity。
- 每次 attempt 记录 provider/model/workflow、开始/结束时间、错误、artifact 和 settlement。
- terminal ingest 与 finalizer 可重复执行；所有写入都以 CAS/唯一约束保护。
- 发布或恢复前 pause/drain 生成队列，确认没有 active/unknown attempt，再切进程。
- Chat 监控 AgentRun active/failed trace、Main ACK 延迟、SSE 重连、memory projection lag 和内嵌 Pi readiness；不监控不存在的 Chat DB/queue。
