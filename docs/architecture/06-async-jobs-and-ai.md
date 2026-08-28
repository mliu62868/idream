# 06 · 异步任务与 AI 执行

更新日期：2026-08-28

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

Chat 没有 `chat.generate`、`chat.memory.extract` 或 `chat.outbox.deliver` queue。

## 3. Chat AgentRun

```text
Main transaction commits Turn
  -> Main signs execution + authority snapshot
  -> Chat atomically creates AgentRun
  -> DSH emits model/tool events
  -> Chat streams transient tokens through Redis/SSE
  -> Chat posts terminal candidate to Main
  -> Main exact-attempt CAS + usage commit
  -> durable ACK
  -> Chat writes terminal.json, emits done, permits memory ingest
```

重连从 Redis/AgentRun events 恢复传输，但产品完成状态必须重新向 Main 查询。相同 idempotency key 对已终态 Turn 只返回当前产品结果，不重启模型。

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

## 6. Provider 边界

- Chat 模型只由 `chat-agent` 的 OpenAI-compatible adapter 调用。
- 图片/视频 provider 只由 `packages/gen` 执行。
- Main 持有产品策略、moderation、entitlement、ledger、Generation 和交付状态机。
- Provider adapter 只做协议、超时、错误映射与原始执行证据，不做余额更新。

## 7. 可靠性与可观测

- BullMQ job 使用业务 identity，不使用随机重试 identity。
- 每次 attempt 记录 provider/model/workflow、开始/结束时间、错误、artifact 和 settlement。
- terminal ingest 与 finalizer 可重复执行；所有写入都以 CAS/唯一约束保护。
- 发布或恢复前 pause/drain 生成队列，确认没有 active/unknown attempt，再切进程。
- Chat 监控 AgentRun active/terminal、Main ACK 延迟、SSE 重连和 DSH readiness；不监控不存在的 Chat DB/queue。
