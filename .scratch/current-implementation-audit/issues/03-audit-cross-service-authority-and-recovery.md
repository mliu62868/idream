# 审计跨服务权威与故障恢复闭环

Type: grilling

Status: resolved

## Question

Main、Chat、Gen、Admin、Shared、Voice 与存储边界是否仍各自只有一个写权威，并在幂等、重试、超时、晚到终态、unknown reconciliation、结算／退款、Outbox／Inbox ACK、Scene／Memory／Relationship、Release pin 与 Serving projection 上 fail closed？找出任何双写、可变事实覆盖不可变快照、无 durable carrier、错误恢复或 UI 状态越权，并给出源码与测试证据。

## Answer

审计锚点为 `master@1fb5d544fc8cd5630a8bcd33e1e8cc25cbb982cc`。结论是：Generation、结算／退款、Chat 文件投影、Scene／Memory／Relationship、Inbox、Voice、Release／Serving 和 Admin UI 的仓库级写权威总体保持单一且 fail closed；但 Main↔Chat 双向 Outbox 发送端存在一个已复现的并发单调性缺陷。这里的“权威”指能决定业务事实的唯一写入者；队列、缓存、UI projection 与派生视图都不是权威。“终态”必须单调，不能被较早状态覆盖；`unknown` 表示 provider 可能已执行但当前没有可安全采用的业务终态，只能追加证据并交由 reconciliation。

### P1：并发 Outbox dispatcher 可在 durable ACK 后把发送端事实回退为 pending／failed

- Chat→Main：`packages/chat/src/outbox.ts:62-107` 先 `findMany(status=pending)`，然后成功路径按 `id` 无条件写 `delivered`，失败路径也按 `id` 无条件写 `pending|failed`。没有 claim、lease、版本或 from-state CAS。
- Main→Chat：`packages/main/src/processes/chat-outbox.ts:48-100` 是同一结构，同样没有并发 claim 或条件更新。
- 并发不是假设：Main 的 `packages/main/src/processes/event-consumer.ts:770-778` 用 5 秒异步 `setInterval`，没有 in-flight guard，业务服务也会直接调用 dispatcher；Chat 的 `packages/chat/src/worker.ts:32-34` 与 `packages/chat/src/reconcile.ts:207` 都可进入同一 dispatcher。单进程并不能阻止两个异步调用重叠。
- 当前两个 Outbox schema 只有 `pending|delivered|failed` 数据列，没有处理租约或版本字段：`packages/chat/prisma/schema.prisma:321-336`、`packages/main/prisma/schema.prisma:2193-2209`。
- 用当前 `deliverPendingOutbox` 和注入式 fake Prisma 做并发复现：两个调用同时读到 `attempts=7,status=pending`；一个收到 durable ACK 并写 `delivered`，另一个在其后抛出传输错误。实际输出为：

  ```json
  {"results":[{"delivered":1,"failed":0},{"delivered":0,"failed":1}],"finalSenderState":"failed","receiverDurablyAcknowledged":true}
  ```

- Receiver 侧没有出现第二个缺陷：Chat Inbox 使用唯一 source key、payload hash、sticky quarantine 和 processing lease CAS（`packages/chat/src/inbox.ts:27-129`）；Main ingest 使用事务 advisory lock、source key 与 payload hash（`packages/main/src/processes/event-consumer.ts:213-275`）。因此当前直接影响是发送端 durable truth 错误、重复投递、错误告警和可能永久停在 `failed`，不是已证实的业务副作用双写或事件丢失。
- 现有测试只覆盖“先失败、后成功”的顺序路径及“ACK 后才写 delivered”：`packages/main/src/processes/chat-outbox.test.ts:30-55`、`packages/chat/test/durable-outbox.test.ts:30-50`，缺少混合成功／失败的并发回归用例。
- 后续修复应保证“已获 durable ACK ⇒ delivered 永远胜出”，且失败更新必须带 from-state／attempt 条件；可先用最小条件更新完成单调性，不必为这个缺陷预设新抽象。修复应同时覆盖两个方向，并加入成功与晚到失败两种更新顺序的并发测试。本票按审计范围没有修改实现。

### 其余权威边界

| 边界 | 当前仓库结论 | 主要证据 |
| --- | --- | --- |
| Generation Request → Attempt → TransportExecution → TerminalRecord | 通过 | `generation-attempt-architecture.test.ts` 固定 Attempt 三类写权威并禁止绕过 Outbox；Gen 在 provider 调用前写不可重放 invocation guard，TerminalRecord put-if-absent；Main 对 envelope、transport identity、terminal event、late evidence 与 unknown resolution fail closed。 |
| Artifact／Delivery／Settlement／Refund | 通过 | late success 只归档或追加 reconciliation evidence，不重开已完成／取消／unknown 的业务终态；退款 key 按原因稳定，金额限制为 captured-refunded，锁与幂等测试通过。 |
| Chat Scene／Memory／Relationship／文件事实 | 通过 | `file-mutations.ts` 用 domain intent → projector role → immutable receipt；`memory.ts` 在 user+turn lock 内重读消息、attempt、linkage 和 Scene anchor；no-memory 仍推进 Scene，但不写 memory／relationship／file intent。 |
| Main↔Chat Inbox ACK | 通过 | 两侧 receiver 都以 durable receipt 后 ACK，精确 replay 可重放，payload conflict sticky quarantine，Chat effect consumer 使用 lease CAS。 |
| Character ContentVersion／Release pin／Serving | 通过 | Release、Serving、Project 状态只经 versioned transition authority；rollback 创建新 Release；Chat session 固定 immutable Release，旧会话不随 Serving 指针漂移，显式 migration 才改变 pin。 |
| Voice | 通过 | `VoiceClipRequest` 以 user+message 唯一、lease owner/expiry/attempt CAS、固定 provider/synthesis payload；provider success 后 usage、cost、asset、request terminal 在同一事务提交，旧 owner 不能覆盖。 |
| Admin／UI | 通过 | Admin 只经 Main proxy/BFF；静态守卫禁止前端自行推导 Character journey 状态或直写业务状态，服务端 deep link/progress 为 projection。 |
| DB／Blob／Queue 存储职责 | 仓库级通过 | DB／Blob 承载 immutable fact 或 durable intent，BullMQ 只负责本地唤醒／工作调度；跨服务 Redis delivery 被静态守卫禁止。生产迁移、对象存储和真实 worker cutover 不在本票证据内。 |

没有发现新的双写、可变 persona 覆盖 ContentVersion、无 durable carrier、late terminal 重开业务终态、Voice 重复扣费、Release pin 漂移或 UI 越权路径。这个结论只到“当前 revision 的仓库实现 + 测试数据库”，不代表真实 provider、生产数据库、对象存储、队列 cutover 或浏览器操作旅程已验证。

### 本票验证

- Main：14 个测试文件、204 个用例通过，覆盖 deep-module/finite-state/state-transition 守卫、Generation attempt/transport/terminal/refund/lifecycle、Main→Chat outbox、Release executor/lifecycle、Voice reclaim/generation。
- Chat：6 个测试文件、40 个用例通过，覆盖 durable outbox、memory authority races、Release pin、reliability、relationship authority/evidence；测试数据库边界 SQL 的正负权限检查也通过。
- Gen：2 个测试文件、8 个用例通过，覆盖 immutable invocation/terminal record 与 transport evidence。
- Admin：4 个测试文件、28 个用例通过，覆盖 Main proxy、durable mutation intent、authority state 与 Character QA authority。
- 合计：26 个测试文件、280 个用例通过。并发 Outbox 复现不是测试通过项，而是本票确认的失败行为。

Domain Modeling 没有新增 `CONTEXT.md`：本票只确认了已有架构术语的实现边界，没有解决新的稳定产品领域词汇。

### Repair follow-up — 2026-08-11

用户随后明确授权修复。Main→Chat 与 Chat→Main dispatcher 均已改为单调条件更新：失败只能用 `id + status=pending + observed attempts` CAS 推进其精确快照；receiver durable ACK 可以把并发产生的 `pending|failed` 收敛为 `delivered`。ACK 调用与本地 delivered 写已拆开，因此 ACK 后的本地持久化异常不会再被误记成传输失败。没有新增 schema、状态、锁或迁移。

双向测试先在旧实现上稳定失败：Chat 得到晚到失败计数 1；Main 最终为 `attempts=8,status=failed`。修复后两个方向及两种顺序（ACK 后晚到失败、retry-exhausted failure 后 ACK）均通过。最终验证：Main outbox + deep-module authority 14/14，Chat outbox 4/4，`bun run check` 的 lint、typecheck、五包 production build 全部通过，`git diff --check` 通过。
