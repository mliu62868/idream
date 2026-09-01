# 14. Companion Chat 技术设计

> 当前实现。若本章与历史审计或旧 SQL 冲突，以本章、ADR-21 与代码为准。

## 1. 决策

- Main PostgreSQL 是产品聊天唯一权威：`ChatSession`、`Turn`、附件、Scene、额度、计费和生成结算。
- 一个 `Turn` 恰好是一条用户消息和一条被选中的最终 assistant 回复。重试/再生成增加 `attempt`，不制造第二份产品回复。
- Chat 服务不连接 PostgreSQL。它只在 `CHAT_FS_ROOT` 保存未决恢复证据和有界失败 trace。
- DSH/official igrep 是 `packages/chat/src/agent-runtime` 的内部实现，与 Chat 同进程、同生命周期。`SOUL.md` 不是独立产品权威。
- Main 在调用 Chat 前先提交 Turn，并在同一事务内冻结 ContentVersion、Release、VisualProfile、上下文与 Scene 执行快照；重试不得从可变 Session 重算。
- Chat 的终态必须先得到 Main 的持久 ACK，之后才能发 SSE `done`；成功 run 随即清理。
- pending Turn 是可恢复的 admission intent；带退避的租约调度保证 Chat 不可用时不丢 Turn，也不让队首坏 Turn 饿死后续 Turn。
- 每个已提交 memory-enabled Turn 都由 Main outbox 异步投影；edit/regenerate/delete 从 Main 剩余 Turns 重建记忆，重建期间新 Turn 继续但临时禁用长期记忆。

## 2. 权威边界

| 事实 | 权威 |
|---|---|
| 用户、Character、immutable Soul/Release pin | Main PostgreSQL |
| ChatSession、Turn、Scene、产品消息列表 | Main PostgreSQL |
| 额度、DreamCoin、Generation Request/Attempt/Artifact/Delivery/Settlement | Main PostgreSQL |
| 未决 proposal 与 7 天失败 trace | `CHAT_FS_ROOT/runs/` |
| 通用 companion memory | DSH official igrep workspace |
| token 流 | Redis SSE 缓冲；不是终态权威 |

Main 与 Chat 同时保存数据并不重复：Main 保存产品事实，Chat 只保存尚未判定的恢复输入或短期诊断事实。两者不能互相回填为另一类权威。

### 2.1 Agent system prompt 权威

Chat 只构造一条 system message，层级固定：

1. Shared 中版本化的 `COMPANION_PRODUCT_AGENT_PROMPT`：所有角色共同的陪伴目标、直接性、主动性和动作一致性。
2. `buildCompanionRuntimeAuthority`：当前 Turn 的 memory、tool、事实与输出约束。
3. immutable compiled Character Soul：角色身份、声音和角色特有互动方式。

opening、历史 Turn、memory recall、Scene 与时间是可变事实，作为紧邻当前用户消息的 replay/plugin messages 输入；不得复制进 system prompt。`PreparedTurn.trace` 固定 Product Contract 版本、最终 system prompt SHA-256 与 Soul fingerprint，三者原样进入 Main 终态证据。

Product Contract 决定「这是怎样的陪伴产品」，Soul 决定「此刻由谁、用什么声音表达」。Soul 不能覆盖 Product Contract 或 Runtime Authority，Runtime 也不能重写 Soul 的角色事实。

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
  -> Chat: delete successful run files
  -> Main outbox: asynchronously project committed Turns to igrep
```

关键不变量：

1. Main 没有提交 Turn，Chat 不执行。
2. attempt 不是产品消息；旧 attempt 不能覆盖新 attempt。
3. Main 没有 ACK terminal，Chat 不宣告完成；memory 只读取 Main 已提交 Turn。
4. SSE、Redis、AgentRun event 都不能反向成为产品消息列表。
5. admission HTTP 失败只让 Turn 保持 pending；后台必须重放同一个 Turn pin。
6. 已存在 `proposal.json` 的恢复只能 exact replay，不能重新采样模型。
7. proposal 包含完整终态候选和工具 effect identity；Main duplicate ACK 后本地可直接清理，闭合 ACK 后崩溃窗口。
8. 同一 Turn/User 的持久 tombstone 先于删除生效；迟到 admission、event、terminal 不能重建已清除文件。

## 4. AgentRun 文件布局

```text
CHAT_FS_ROOT/
  runs/<turnId>/<attempt>/
    input.json
    events.jsonl
    proposal.json
    completion.json       # 仅 failed/cancelled，7 天后清理
  run-index/assistant/<assistantMessageId>.json
  run-tombstones/<turnId>.json
  user-tombstones/<sha256(userId)>.json
  account-deletions/<requestHash>.json
```

- `input.json` 用 temp + fsync + rename 原子落盘。
- `events.jsonl` 用 append + fsync；只用于恢复和诊断。
- `proposal.json` 不可变，且先于 Main terminal POST 落盘。
- Main 重试同一 snapshot 时允许新的 `admittedAt` 和可变 entitlement 变化；执行身份由 immutable Turn snapshot 决定，首次签名 authority 保存在 input 中。
- 进程启动时只恢复有 input、无 completion 的 AgentRun；已有 proposal 只能 exact replay。
- Main accepted/duplicate accepted 后删除整个 run 目录；failed/cancelled trace 与 assistant index 最多保留七天。
- cancel/regenerate/delete/account erasure 先写 attempt、Turn 或 User tombstone，再清除目录；取消由 Main 事务内 durable outbox 最终送达。账号删除同时写 AgentRun 与 workspace User tombstone；workspace purge、rebuild prepare/promote 使用同一 User 锁，删除后不能重建记忆目录。

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

ToolEffect 明确携带作用域，不能把调用语义编码进模型生成的 `callId`。普通模型 tool call 使用 `effectScope=attempt`，幂等键由 `turnId + attempt + toolCallId` 决定，参数 digest 不同则冲突。`PreparedTurn.requiredAction` 表示产品已经接受的明确用户图片意图，使用 `effectScope=turn_action`，效果身份仅由 `turnId + tool name` 决定：regenerate 即使让 Agent 写出不同的具体场景，也只把首次接受的同一附件重绑到当前 attempt，不创建第二个 Generation Job、不改写已经持久化的生成控制，也不重复扣费。`intent.requestedNudity` 是独立的结构化用户边界，由 Main 编译进最终生图 prompt；Agent 负责具体场景，不负责重建或猜测这条边界。当前 Chat 工具只有图片生成与编辑，因此实现只覆盖 image。将来真实 video tool 出现时复用同一端口和既有 Generation 生命周期，不增加通用 hook 框架。

明确图片意图在模型运行前由 `PreparedTurn` 固化并预留一次 Main ToolEffect。Main 接受动作后，Chat 不再运行 DSH/Caption 模型，而是按当前消息脚本和签名 locale 直接提交版本化的确定性确认文案：

- 确认文案一次性进入 SSE 和 Main terminal，不能被 Character Soul 改写成拒绝、交换条件或拖延；
- 附件状态独立拥有 `requesting/accepted/queued/running/completed/failed` 交付事实，文案不虚构图片已完成；
- Main ACK 不确定时，Chat 使用完全相同的 effect identity 有界重试并对账；
- terminal evidence 记录 Product Contract、PreparedTurn、system prompt digest、Soul fingerprint，以及 required action 的 call/attachment/job/media id 和确认语言；不能用 DSH 的 `toolCalls=0` 冒充没有产品动作。

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
- edit/regenerate 不消费新消息额度，但会增加原 Turn attempt；旧 AgentRun 被精确清除。rebuild 未完成时新 attempt 使用 `memoryEnabled=false`，不阻塞聊天。
- Turn/Session 删除以带租约、心跳和过期接管的 durable Main outbox 驱动 relationship rebuild；重建以分页 AsyncIterable 直接流送 Main committed、Turn-pinned memory，不把完整历史加载进内存。
- “清空记忆”归档旧 Session、关闭其 memory projection，并先提交 durable purge intent 再异步物理 purge relationship workspace；接口返回 queued 事实，不把尚未完成的物理删除表述成已完成。
- memory rebuild/purge 的单调 authority version 来自数据库行锁增量，不来自进程时钟；pending/processing destructive lifecycle 只隔离长期记忆，不暂停该关系的新 Turn。
- memory prepare 在独立候选 workspace 执行，promote 只做原子目录切换；两者都不获取 relationship-wide Agent 锁，也不取消已经运行的 Turn。Main 精确取消被修订的旧 attempt，并把破坏性重建期间的新 attempt 固定为 private execution。
- 普通 memory projection 至少一次投递并按 relationship 合并；旧 authority version 不能 promote 覆盖新 workspace，投影延迟不能阻塞聊天。
- edit/regenerate 增加 attempt，但都先恢复到该 Turn 之前的 Scene，再由替代回复计算一次 delta；同一逻辑 Turn 的 Scene version 只推进一次。
- 非创建者只可创建或继续使用仍由当前 live Serving 指向的 published Release；Session 与 Turn 同时固定该 Release 的 VisualProfile id/version。

## 8. Readiness

Chat admission health 证明文件根、Redis、DSH/igrep 基础依赖可用；`/readyz?full=1` 另行认证精确版本、profile、provider/model、工具桥、rebuild 与隔离。green 结果只有 5 秒 TTL；旧的 green 不能永久覆盖后续依赖故障。

## 9. 账号删除

Main 保留 30 天 grace period。到期后 Main 投递精确删除请求；Chat 先写 User admission tombstone，再幂等删除该用户的 AgentRun 和 DSH workspace，写本地无 PII 回执，再同步提交 Main completion。completion 可在精确 outbox request 的 `processing` 租约内回调；Main 随后删除 Blob 和产品数据库事实。

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
DSH_IGREP_PLUGIN_URL=file:///absolute/path/to/plugin.js
DSH_IGREP_CANONICAL_ROOT=/absolute/durable/memory
DSH_IGREP_PRIVATE_ROOT=/absolute/private/runtime
CHAT_MODEL_PROVIDER=openai
CHAT_MODEL_BASE_URL=http://127.0.0.1:8080/v1
CHAT_MODEL_NAME=...
CHAT_MODEL_API_KEY=...
```

不存在 `CHAT_DATABASE_URL`、Chat Prisma schema、`chat_service` 或 `chat_projector` 运行角色。

## 11. 迁移与验证

1. 用户依次应用 Main Prisma migration：`20260827120000_main_chat_turn_authority` 与 `20260828210000_chat_runtime_hardening`。
2. 暂停旧 Chat writer。
3. 用户运行 `db/sql/2026-08-27-chat-turns-to-main.sql` 导入产品事实。
4. 运行 `bun run chat-runtime:cutover`，有界 drain 后启动 Main 与 Chat，验证发送、再生成、图片 ToolEffect、取消、恢复、记忆投影和账号删除。
5. 稳定观察后另行审核并删除旧 `chat` schema/roles；导入脚本不做不可逆删除。
