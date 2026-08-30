# ADR-19 · DSH Companion 执行内核

> 状态：部分由 [ADR-21](./21-companion-chat-deep-runtime.md) 取代。DSH/igrep 唯一执行内核仍有效；独立 `chat-agent` process/interface 与同步 workspace promotion 不再有效。产品数据权威见 ADR-20。
>
> 更新日期：2026-08-28

## 决策

原决策把 Companion Chat 的模型循环放在独立 `packages/chat-agent` 中；该进程边界已经由 ADR-21 删除。以下保留的是仍有效的 DSH/igrep 执行约束：

- `@deepseek-ai/dsh-*` 固定 `0.1.1-rc.2`。
- official igrep plugin 管理通用 companion memory。
- Chat 负责把 Main 的不可变执行快照编译成 PreparedTurn，并接收 DSH 事件。
- DSH 不拥有产品 Turn、Scene、余额、Generation、附件或结算。

本 ADR 只定义**怎么执行一次 AgentRun**。Main/Chat 存储与计费边界见 [ADR-20](./20-local-file-chat-authority.md)。

## 接口

```text
Chat
  -> POST /runs (PreparedTurn + workspace/profile + tool policy)
chat-agent
  -> ordered events: token / tool_call / tool_result / assistant / terminal
  -> narrow ToolPort back to Chat/Main
Chat
  -> terminal candidate to Main
```

DSH session/event 是执行证据，不是用户消息。Chat 只有拿到 Main terminal durable ACK 后，才能把 run 标记为已提交、发送 SSE `done` 并允许 official igrep ingest。

## Workspace 与记忆

- normal profile 可使用 `(userId, characterId)` 范围的 official igrep workspace。
- private/memory-off profile 必须使用隔离 workspace，run 结束后不进入长期记忆。
- 记忆只摄入 Main 已提交的 Turn，可删除和重建。
- `SOUL.md`、workspace transcript 和检索结果都是派生输入，不能覆盖 Main pin 的 immutable Soul/Release/Scene。
- 账号删除必须清理该用户的 DSH workspace；Main completion receipt 是产品删除流程的权威。

## 工具

工具列表由 Main authority snapshot 和 Chat product policy 共同限制。当前只暴露已实现的图片 create/edit ToolEffect；DSH 不能直接调用 Gen provider、数据库或 ledger。

每个工具调用必须携带稳定 `callId`。Main 使用 `turnId + attempt + callId + argumentsDigest` 做幂等；DSH 重试只能拿到同一效果，不能重复生成或扣费。

## 失败与恢复

- 模型超时、DSH 退出、Chat 重启或 SSE 断开不会自动提交产品回复。
- AgentRun 从本地 input/events 恢复；Main 仍决定当前 attempt 是否 active。
- 旧 attempt 的 terminal 到达时必须被 Main CAS 拒绝。
- commit ACK 丢失时允许提交完全相同的 terminal；任一内容、model、usage、Scene 或 evidence 变化都视为冲突。
- `terminal.json` 是 DSH memory commit 下游的恢复标记；Main ACK 后、DSH commit 前崩溃时，proposal exact replay 得到 duplicate ACK，并由 Main 安排 canonical relationship rebuild。
- cancel、regenerate、Turn delete 和 account erasure 先持久化 attempt/Turn/User tombstone；迟到的 AgentRun 写入必须 fail closed。

## 非目标

- 不复制 DSH 的 session database。
- 不维护 iDream 自研 memory item API。
- 不让模型自行决定 entitlement、计费、发布或产品消息可见性。
- 不保留旧 Chat PG projector/outbox 作为回退运行路径。

## 验证

1. PreparedTurn 映射、normal/private profile 和 workspace 隔离测试。
2. token/tool/terminal 顺序与 timeout/cancel 测试。
3. commit ACK 前后记忆 ingest fence。
4. Chat/chat-agent 重启与 exact replay。
5. 图片 ToolEffect 幂等、参数冲突和失败退款的 Main 集成测试。
