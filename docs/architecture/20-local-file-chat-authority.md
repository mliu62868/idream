# ADR-20：Main Turn 权威与本地 AgentRun

> 状态：Accepted

Main 使用 PostgreSQL 保存并展示产品会话、用户消息、唯一选中最终回复、附件状态、Scene、幂等 receipt、权益、用量和结算。`packages/chat` 不连接 PostgreSQL；它使用本地文件保存一次回复所需的 PreparedTurn、DSH 事件、流式暂态、工具调用过程与 igrep workspace。Chat 文件中的 transcript 是从 Main 产品 Turn 派生的 Agent 输入，不是第二份聊天记录权威。

## 产品 Turn

客户端的 Chat 接口属于 Main。Main 在一个事务中完成权限与额度检查，写入用户消息和 pending assistant intent，然后把带 `turnId`、`attemptId`、不可变 Soul/Release、Scene、最近 Turn 与工具权限的签名执行快照交给 Chat。用户级锁串行化跨 Session 的每日额度；只有新产品 Turn 消耗消息额度，edit/regenerate 不重复计量。产品 Turn 修订只允许当前 Session 的最后一个 Turn，拒绝隐式截断或分支历史。

pending Turn 同时是持久的 AgentRun admission intent。同步调用 Chat 失败时 Main 仍返回 `202`，保持 pending，并由后台 reconciliation 重放同一个 immutable Turn snapshot；只有 Chat 原子保存 `input.json` 并 ACK 后，Main 才将 assistant 状态改为 generating。Session 后续切换 Character 版本不能改变已经固定在 Turn 上的 ContentVersion/Release pin。

Chat 只生成 terminal candidate。候选先原子写入不可变 `proposal.json`，再调用 Main 的幂等 terminal commit；Main 以 `turnId + attempt` 做 CAS，写入最终回复、用量和产品事件并返回 durable ACK。崩溃恢复只重放该 proposal 的精确字节，不重新调用模型。Chat 收到 ACK 后才发送 SSE `done` 并允许 igrep ingest；duplicate ACK 让 Main 安排一次 transcript rebuild，以闭合 ACK 后、memory promotion 前的崩溃窗口。失败、取消和超时同样由 Main 写入产品终态。

## AgentRun 文件

每次执行位于 `CHAT_FS_ROOT/runs/<turnId>/<attempt>/`，只包含执行所需或排障所需的本地事实：

- `input.json`：Main 已签名并固定的执行快照。
- `events.jsonl`：DSH、流式和工具过程事件；append 后 `fsync`。
- `proposal.json`：准备提交 Main 的唯一不可变 terminal candidate。
- `terminal.json`：Main terminal commit ACK 或失败终态，使用临时文件加原子 rename。
- igrep workspace：从 Main 已提交的产品 Turn 重建的长期记忆派生物。

同一 AgentRun 只有一个 Bun writer。进程恢复优先读取 `proposal.json`：存在 proposal 时只做 exact terminal replay，不再执行 DSH；没有 proposal 时才恢复未完成执行。任何本地 run 都不能自行出现在用户历史中。

edit、regenerate、Turn delete 与 Session delete 在同一 Main 事务中写入 durable relationship rebuild intent。重建先清除被更正 Turn 的本地 AgentRun，再以 Main 剩余、已提交且 memory-enabled 的 Turns 生成 fenced NDJSON candidate，最后在用户级 Main 锁下 promote；intent pending 期间不接纳该关系的新 AgentRun。用户“清空记忆”语义不同：Main 归档旧 Session、让旧 transcript 退出记忆投影权威，并物理删除 relationship workspace，不使用 quarantine。

## 工具效果与计费

Chat 不读取余额、不扣费，也不在成功后运行通用 billing hook。DSH 工具调用进入一个窄的 Main `ToolEffectPort`，幂等身份为 `attemptId + callId`：

1. Main 校验当前 entitlement/余额。
2. Main 原子创建 Generation Request/Attempt 并预留或先扣账本，再 durable ACK 工具效果。
3. Gen 只执行 provider；不可变 TerminalRecord 记录结果。
4. 产物交付成功后 Main settlement 确认该笔费用，不二次扣费；失败、取消或无交付则释放预留或退款。
5. Main 的附件终态事件可更新正在运行的 Agent，但附件与账单始终以 Main 为准。

## 明确不做

- 不在 Chat 建 Prisma 兼容层、文件消息数据库、余额镜像、usage ledger 或第二套 outbox/inbox。
- 不让 Chat 的 DSH SessionEvent、SSE token、igrep workspace 或 terminal candidate 成为产品消息。
- 不用“成功回调直接扣费”；通知丢失、重复和并发余额竞争由 Main 的 reserve/settle 状态机解决。
- 不做 Main PG 与 Chat 文件的产品 Turn 双写。Main 写产品事实，Chat 写 AgentRun，二者的数据类别不同。

## 迁移顺序

1. 在 Main 建立 Turn Ledger 与幂等 terminal commit；现有 Chat 表先只作为离线迁移来源。
2. Main BFF 先写 pending Turn，再向 Chat 发送签名执行快照；历史读取改为 Main。
3. Chat 用本地 `AgentRunStore` 替换 Prisma、PG views、advisory lock、file-mutation projector 与 Chat outbox/inbox。
4. 图片/视频工具通过 Main `ToolEffectPort` 接入现有 Generation Request → Attempt → TerminalRecord → Delivery → Settlement。
5. 用户停写后执行 PG Chat Turn 导入 Main、数量/哈希校验和 cutover；确认无 pending run 后删除 Chat schema、roles、SQL 和 Prisma 依赖。

在 production cutover 完成前，`LEGACY_MAIN_TO_CHAT_EVENTS` 及对应 Admin failed-outbox reconciliation 仅用于审计/处置历史 carrier。它们参与 readiness，确保旧积压不会被隐藏，但新的 Chat dispatcher 永远不选择它们；cutover 后再单独删除该迁移表面。
