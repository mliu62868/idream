# 14. Companion Chat 技术设计

> 当前实现。若本章与历史审计或旧 SQL 冲突，以本章、ADR-20 与代码为准。

## 1. 决策

- Main PostgreSQL 是产品聊天唯一权威：`ChatSession`、`Turn`、附件、Scene、额度、计费和生成结算。
- 一个 `Turn` 恰好是一条用户消息和一条被选中的最终 assistant 回复。重试/再生成增加 `attempt`，不制造第二份产品回复。
- Chat 服务不连接 PostgreSQL。它只在 `CHAT_FS_ROOT` 保存 `AgentRun` 输入、事件和终态证据。
- `chat-agent` 是唯一 DSH 执行器；official igrep workspace 保存通用记忆。`SOUL.md` 不是独立产品权威。
- Main 在调用 Chat 前先提交 Turn，并在同一事务内冻结 ContentVersion、Release、VisualProfile、上下文与 Scene 执行快照；重试不得从可变 Session 重算。
- Chat 的终态必须先得到 Main 的持久 ACK，之后才能发 SSE `done` 和向 DSH 返回 `commit_ack`；`terminal.json` 只在 DSH/igrep commit 返回后落盘。
- pending Turn 是可恢复的 admission intent；带退避的租约调度保证 Chat 不可用时不丢 Turn，也不让队首坏 Turn 饿死后续 Turn。
- edit/regenerate/delete 只作用于 Session 最后一个 Turn，并从 Main 剩余 Turns 重建记忆。

## 2. 权威边界

| 事实 | 权威 |
|---|---|
| 用户、Character、immutable Soul/Release pin | Main PostgreSQL |
| ChatSession、Turn、Scene、产品消息列表 | Main PostgreSQL |
| 额度、DreamCoin、Generation Request/Attempt/Artifact/Delivery/Settlement | Main PostgreSQL |
| AgentRun input/events/terminal | `CHAT_FS_ROOT/runs/` |
| 通用 companion memory | DSH official igrep workspace |
| token 流 | Redis SSE 缓冲；不是终态权威 |

Main 与 Chat 同时保存数据并不重复：Main 保存产品事实，Chat 保存一次 agent 执行的本地证据。两者不能互相回填为另一类权威。

## 3. Turn 热路径

```text
Browser
  -> Main POST /api/v1/chat/sessions/:id/messages
  -> Main: moderation/quota/idempotency
  -> Main: commit user + pending assistant as one Turn
  -> Main: sign immutable execution snapshot
  -> Chat POST /internal/agent-runs
  -> Chat: atomically persist input.json
  -> DSH run + tool effects
  -> Chat: atomically persist proposal.json
  -> Chat: POST terminal candidate to Main
  -> Main: CAS exact turnId + assistantMessageId + attempt
  -> Chat: SSE done
  -> Chat: return commit_ack to DSH
  -> DSH/igrep: commit memory and return
  -> Chat: persist terminal.json
```

关键不变量：

1. Main 没有提交 Turn，Chat 不执行。
2. attempt 不是产品消息；旧 attempt 不能覆盖新 attempt。
3. Main 没有 ACK terminal，Chat 不宣告完成、不写入记忆。
4. SSE、Redis、AgentRun event 都不能反向成为产品消息列表。
5. admission HTTP 失败只让 Turn 保持 pending；后台必须重放同一个 Turn pin。
6. 已存在 `proposal.json` 的恢复只能 exact replay，不能重新采样模型。
7. `terminal.json` 必须位于 DSH `commit_ack` 下游；Main duplicate terminal ACK 会安排 canonical rebuild，闭合 ACK 后崩溃窗口。
8. 同一 Turn/User 的持久 tombstone 先于删除生效；迟到 admission、event、terminal 不能重建已清除文件。

## 4. AgentRun 文件布局

```text
CHAT_FS_ROOT/
  runs/<turnId>/<attempt>/
    input.json
    events.jsonl
    proposal.json
    terminal.json
  run-index/assistant/<assistantMessageId>.json
  run-tombstones/<turnId>.json
  user-tombstones/<sha256(userId)>.json
  account-deletions/<requestHash>.json
```

- `input.json` 用 temp + fsync + rename 原子落盘。
- `events.jsonl` 用 append + fsync；只用于恢复和诊断。
- `terminal.json` 不可变。
- `proposal.json` 不可变，且先于 Main terminal POST 落盘。
- Main 重试同一 snapshot 时允许新的 `admittedAt` 和可变 entitlement 变化；执行身份由 immutable Turn snapshot 决定，首次签名 authority 保存在 input 中。
- worker 启动时只恢复有 input、无 terminal 的 AgentRun。
- cancel/regenerate/delete/account erasure 先写 attempt、Turn 或 User tombstone，再清除目录；账号删除扫描与 admission 使用固定的 User → Turn 锁顺序。

## 5. ToolEffect 与生成计费

Agent 工具不能直接扣钱，也不能在 provider 成功后用普通 callback 猜测结算。

```text
DSH tool_call
  -> Chat ToolEffectPort
  -> Main validates exact active Turn attempt + callId
  -> Main creates/reserves Generation Request
  -> Gen executes provider
  -> Main delivery success settles reservation
  -> Main terminal failure releases/refunds reservation
  -> Chat observes tool result and continues DSH
```

幂等键由 `turnId + attempt + toolCallId` 决定；参数 digest 不同则冲突。当前 Chat 工具只有图片生成与编辑，因此实现只覆盖 image。将来真实 video tool 出现时复用同一端口和既有 Generation 生命周期，不增加通用 hook 框架。

## 6. API

Browser 只访问 Main：

- `GET/POST /api/v1/chat/sessions`
- `GET/PATCH/DELETE /api/v1/chat/sessions/:id`
- `POST /api/v1/chat/sessions/:id/messages`
- `PATCH/DELETE /api/v1/messages/:id`
- `POST /api/v1/messages/:id/regenerate`
- `POST /api/v1/messages/:id/cancel`
- `GET /api/v1/messages/:id/stream`
- `DELETE /api/v1/chat/memory/:characterId`

Main 到 Chat：

- `POST /internal/agent-runs`
- `POST /internal/agent-runs/:turnId/:attempt/cancel`
- signed `GET /api/v1/messages/:assistantMessageId/stream`
- `POST /internal/events/account-deletion-v2/ingest`
- `POST /internal/companion-memory/purge`
- `POST /internal/companion-memory/rebuild/prepare`
- `POST /internal/companion-memory/rebuild/promote`

Chat 到 Main：

- `POST /api/internal/chat/turns/terminal`
- `POST /api/internal/chat/tool-effects`
- `POST /api/internal/events/account-erasure-completion-v2/ingest`

## 7. 修订、记忆与额度

- 每日免费消息只统计新建且 user status 为 sent 的产品 Turn。Main 先锁用户、再锁 Session，在同一事务内检查额度、创建 Turn 和不可变 `ChatTurnUsageFact`；删除 Turn 不会返还或绕过当天额度。
- edit/regenerate/delete 先锁用户、Session 与目标 Turn，并验证目标仍是最后一个 Turn；存在后续 Turn 时返回 conflict，不截断历史。
- edit/regenerate 不消费新消息额度，但会增加原 Turn attempt；旧 AgentRun 被精确清除，rebuild 完成后才接纳新 attempt。
- Turn/Session 删除以带租约、心跳和过期接管的 durable Main outbox 驱动 relationship rebuild；重建以分页 AsyncIterable 直接流送 Main committed、Turn-pinned memory，不把完整历史加载进内存。
- “清空记忆”归档旧 Session、关闭其 memory projection，并先提交 durable purge intent 再异步物理 purge relationship workspace；接口返回 queued 事实，不把尚未完成的物理删除表述成已完成。
- memory rebuild/purge 的单调 authority version 来自数据库行锁增量，不来自进程时钟；pending/processing lifecycle 会暂停该关系的新 Turn 与 admission。
- 非创建者只可创建或继续使用仍由当前 live Serving 指向的 published Release；Session 与 Turn 同时固定该 Release 的 VisualProfile id/version。

## 8. Readiness

Chat admission 的 readiness 证明文件根可写、Redis SSE 可用、DSH full readiness 可用。green 结果只有 5 秒 TTL；过期后下一次 `/readyz` 或 admission 必须合并为一次完整复探。旧的 green 不能永久覆盖后续依赖故障。

## 9. 账号删除

Main 保留 30 天 grace period。到期后 Main 投递精确删除请求；Chat 先写 User admission tombstone，再幂等删除该用户的 AgentRun 和 DSH workspace，并兼容清理 cutover 前遗留的 `mem/<userId>`，写本地无 PII 回执，再同步提交 Main completion。completion 可在精确 outbox request 的 `processing` 租约内回调；Main 随后删除 Blob 和产品数据库事实。

## 10. 运行配置

```dotenv
# Main
DATABASE_URL=postgresql://...
CHAT_SERVICE_URL=http://127.0.0.1:3100
CHAT_BFF_SIGNING_SECRET=...
INTERNAL_TOKEN=...

# Chat local runner
CHAT_PORT=3100
CHAT_FS_ROOT=/absolute/durable/path
CHAT_REDIS_URL=redis://...
MAIN_WEB_URL=http://127.0.0.1:3000
DSH_AGENT_URL=http://127.0.0.1:3101
DSH_AGENT_TOKEN=...
```

不存在 `CHAT_DATABASE_URL`、Chat Prisma schema、`chat_service` 或 `chat_projector` 运行角色。

## 11. 迁移与验证

1. 用户依次应用 Main Prisma migration：`20260827120000_main_chat_turn_authority` 与 `20260828210000_chat_runtime_hardening`。
2. 暂停旧 Chat writer。
3. 用户运行 `db/sql/2026-08-27-chat-turns-to-main.sql` 导入产品事实。
4. 启动 Main、chat-agent、Chat，验证发送、再生成、图片 ToolEffect、取消、恢复和账号删除。
5. 稳定观察后另行审核并删除旧 `chat` schema/roles；导入脚本不做不可逆删除。
