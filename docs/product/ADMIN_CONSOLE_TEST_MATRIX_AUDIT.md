# Admin Console §21 Test Matrix Evidence Audit

> 基线：`ADMIN_CONSOLE_FIRST_PRINCIPLES_REMEDIATION_PLAN.md` §21.1/§21.2，代码基线 `d392fed2`。
> 判定规则：只有能通过公共 seam 让错误实现失败的自动化测试才记为“已验证”；源码存在、窄单测或人工推断只记为“部分”。生产 canary/观察窗口不属于本地测试通过。

## §21.1 测试矩阵

| 层级 | 判定 | 当前权威证据 | 尚缺或弱证据 |
| --- | --- | --- | --- |
| Pure state/invariant | 已验证 | `characters/readiness.test.ts`、`generation-attempt-events.integration.test.ts`、`content-production-state.test.ts`、`metrics/engine.test.ts`、`reconciliation/invariants.adversarial.integration.test.ts` | Incident/Case 的部分推导仍主要由 integration 覆盖，不是独立 property model。 |
| Property/table-driven | 部分 | `characters/readiness.test.ts`、`creative/retry-executor.test.ts`、`admin/permissions.test.ts`、`shared/command-reliability.test.ts`；`content-production-state.test.ts` 现穷举 success/failed/active item 组合至 5 项并证明恰有一个 outcome；`mutation-transport.test.ts` 对 55/55 mutation 做 transport 分类 | 31 个 mutation 仍在机器可读 pending inventory；尚无对全部领域合法/非法 transition 的统一穷举。 |
| Postgres integration | 已验证 | `characters/creation.integration.test.ts`、`shared/command-reliability.test.ts`、`incidents/incident-case.integration.test.ts`、`remaining-canonical-lists.integration.test.ts`、`immutable-evidence-migration.integration.test.ts` | 跨进程故障点由进程测试和 rehearsal 分担，不应仅用 integration 数量声称覆盖。 |
| Contract | 部分 | `packages/shared/src/admin/**/*test.ts`、`commands/authoritative.integration.test.ts`、各 Route Handler integration；`api-manifest.test.ts` 已从 76 个真实 route files 精确枚举 84 个 HTTP operation；117 个唯一 contract ref 全部可解析，其中 88 个真实 Zod/transport binding 自动跑正反 fixture | 29 个尚未共享化的 ref 以 owner/reason 精确列入 pending，并由 `requireExecutable…` fail closed；HTTP/in-process parity 不是所有 endpoint 都有。 |
| Cross-service | 已验证（本地） | `processes/chat-outbox.test.ts`、`chat/test/durable-outbox.test.ts`、`chat/test/reliability.test.ts`、`processes/event-consumer.metrics.integration.test.ts`、`generation-manifest-ingest.test.ts` | 真 Redis 进程被杀、网络分区和每个 projector 的独立重建仍属于 chaos/rehearsal 证据。 |
| Metric golden dataset | 已验证 | `metrics/engine.test.ts`、`metrics/projector.test.ts`、`event-consumer.metrics.integration.test.ts`、`metrics/backfill.test.ts`；projector golden chain 从 typed signup/D0/D1 依次重放 regenerate/edit/delete/selection/replacement 并断言 canonical Activation/D1 | D7 成熟窗口继续由 engine 边界 fixture 单独锁定，避免用短测试时钟伪造成熟。 |
| API/AuthZ | 已验证（admission） | `api-manifest.test.ts`、`authority-manifest.test.ts`、`authority-execution-matrix.test.ts`、`permissions/grant-bundles.integration.test.ts`、`commands/authoritative.integration.test.ts`、`bootstrap/route.test.ts`、`nav-config.test.ts`：84/84 operation 精确覆盖；83 个 protected Route Handler 逐个以匿名真实调用证明在 body/DB 前 401；exact method allOf、动态 resolver allowlist、未知 production operation 与未声明 handler permission fail closed；11 个 v2 workspace nav/deep-link 由 shared SSoT 派生 | 全 endpoint response DTO 正反 fixture 归 Contract 行继续跟踪；生产实时撤权/session canary 仍是外部 Gate。 |
| E2E Character | 已验证（浏览器） | `admin-v2-workspaces.e2e.ts` 串起 create/resume、blocker、pinned validation、preview、publish、24h monitor 与 immutable snapshot rollback，并断言数据库 authority | 生产 canary 不由本地 Playwright 代替。 |
| E2E Creative/Incident | 已验证（浏览器） | `admin-v2-workspaces.e2e.ts` 从 Creative review/placement/verification 进入 Incident authority verification、resolve、postmortem close，并断言 facts/Audit | 生产 canary不由本地 Playwright 代替。 |
| E2E Case | 已验证（浏览器） | `admin-v2-workspaces.e2e.ts` 覆盖 Evidence、decision、downstream authority verify、close 与 Decision/Audit facts；并由 integration 锁定多 source/recurrence | 生产 canary不由本地 Playwright 代替。 |
| E2E Today | 已验证（浏览器） | `today/query.test.ts` 覆盖 verification failed re-entry；`admin-v2-workspaces.e2e.ts` 从已验证 Case/Incident 投影到 Recently resolved，并验证 canonical deep links | 生产 canary不由本地 Playwright 代替。 |
| Component/A11y | 已验证（核心 Gate） | `operations/workspaces.test.tsx`、`collaboration.test.tsx`、`a11y-error-boundary.test.ts`；`admin-v2-workspaces.e2e.ts` 对六个核心 surface 执行 axe WCAG 2.2 AA，验证 dialog focus trap/restore、键盘 tab、375px 与 834px 四条核心流程无横向溢出 | 全部 compatibility 页面仍按各自 sunset 节奏治理，不冒充生产辅助技术人工验收。 |
| Migration rehearsal | 已验证（本地） | `admin-migration-rehearsal.mjs` + readiness 命令覆盖 fresh/repeat/baseline/upgrade/rollback/forward-fix | 生产快照 backfill/shadow 仍必须在专用环境取证。 |
| Load/Chaos | 部分（隔离 transport rehearsal 已验证） | `admin-production-like-readiness.ts` 覆盖 100k Jobs/Cases、1m Events 与真实 Today handler；`admin:readiness:chaos` 在专用端口由父 harness SIGKILL 临时 PostgreSQL/Redis 与挂起在精确故障点的 consumer/dispatcher/projector 子进程，再启动全新 recovery 子进程验证 lease recovery、commit-before-LREM ACK、无 ghost queued、provider boundary 单调用、Audit/Outbox/receipt 单副作用、watermark catch-up 与 replay no-op；scheduled publish 并发另由 `release-executor.integration.test.ts`、`release-monitor.integration.test.ts` 锁定 | chaos harness 使用隔离的最小 `chaos_*` transport schema，不等同于对真实 Prisma/领域模块做进程 kill；网络分区与真实模块 L3 仍须在集成环境演练。进入 schema-v5 Gate 前还必须保存为不可变 artifact 并由受信 collector 签名。 |

## §21.2 反例 fixture

| 反例 | 判定 | 自动化证据 / 说明 |
| --- | --- | --- |
| approved/public 但 Persona、anchor 或 refs 缺失 | 已验证 | `characters/readiness.test.ts` + `reconciliation/invariants.adversarial.integration.test.ts`。 |
| active Visual Identity，0 anchor、0 evidence、null scores | 已验证 | `admin/characters/visual-profiles.test.ts` 的 exact fixture；证明 active 不会伪造 anchors/scores。 |
| Creative 0/4、1/4、4/4 | 已验证 | `admin/content-production-state.test.ts`。 |
| failed Attempt 带 legacy `completedAt`、无 success fact | 已验证 | `admin/generation-job-state.test.ts`、`ourdream/admin-console.test.ts`。 |
| retry HTTP 重放、两个 tab 并发 publish | 已验证 | retry replay 在 `jobs/query.integration.test.ts`；`characters/release-executor.integration.test.ts` 以两个独立 command/worker 竞争同一 Serving CAS，锁定一次成功、一次 conflict、单份副作用。 |
| schedule 后 policy/Identity/Reference stale；两个 scheduler 并发 | 已验证 | `release-executor.integration.test.ts` 覆盖 policy/route/reference drift、reschedule 后旧 occurrence 拒绝、双 scheduler/worker 只产生一份 Serving/Audit/Outbox/ReleaseEvent，并验证 restart replay。 |
| full/partial/重复 refund，execution 不被账务覆盖 | 已验证 | `generation-request-lifecycle.integration.test.ts`、`incidents/action-executor.integration.test.ts`、`content-production-state.test.ts`、adversarial invariant。 |
| completed/failed terminal 并发；transport retry 与 business retry 分离 | 已验证 | `generation-attempt-events.integration.test.ts`、`generation-transport-execution.integration.test.ts`、retry command tests。 |
| Redis 丢失、receipt 后 projector 崩溃、payload conflict、main→chat 丢失 | 已验证（隔离 transport + process seam） | `admin:readiness:chaos` 实际 SIGKILL/restart 专用 Redis，并由父 harness SIGKILL fault 子进程、启动全新 recovery 子进程；main/chat outbox、durable ingest、payload conflict、event consumer recovery tests 补齐真实领域 seam。 |
| manifest 已写但 main ingest 暂失败；ambiguous provider 不自动 retry | 已验证 | `packages/gen/src/pipeline.test.ts`、`generation-manifest-ingest.test.ts`。 |
| 一个 Attempt 多个 TransportExecution、provider cost、technical success 下钻 | 已验证 | `jobs/query.integration.test.ts`；`GenerationJobDetailResponse` 与 Jobs inspector 现在展示每个 transport、cost、manifest 和 technical outcome。 |
| chat duplicate/out-of-order/delay/regenerate/edit/delete/release switch/backfill | 已验证 | chat hot-path/reliability/release-pin/backfill 覆盖 transport 次序；`metrics/projector.test.ts` 的单一 golden replay 串起 regenerate/edit/delete/selection/replacement 并验证最终 canonical Activation/D1。 |
| D0 duplicate、D1 exact、D2 非 D1、D7 immature | 已验证 | `metrics/engine.test.ts` exact boundary fixture。 |
| 老用户 window 内新订阅不进 signup conversion | 已验证 | `metrics/engine.test.ts` cross-cohort fixture。 |
| fixture/internal/audit 混入生产窗口 | 已验证 | `events/durable-ingest.integration.test.ts`、`metrics/backfill.test.ts`、`metrics/projector.test.ts`。 |
| 同 target 并发两条 report | 已验证 | `incidents/incident-case.integration.test.ts` 通过 active Case unique/correlation serialization 聚合。 |
| approval 被不同 payload/version 重用 | 已验证 | `commands/authoritative.integration.test.ts` + `shared/command-reliability.test.ts`。 |
| 同 idempotency key/body 但 commandType/target/version/approval 不同 | 已验证 | `shared/command-reliability.test.ts` 对 canonical hash 每个维度逐项反例；HTTP conflict 覆盖跨 command/target。 |
| running/verifying 崩溃、lease recovery/maxAttempts | 已验证 | `shared/command-reliability.test.ts`。 |
| Character A pointer 指向 Character B Release | 已验证 | `characters/readiness.test.ts` + adversarial reconciliation。 |
| BFF session expired、permission revoked、HMAC replay/clock skew | 已验证 | `jobs/query.integration.test.ts` 的 expired session + live revoke；`shared/admin-bff.test.ts` 的 replay/clock/body/path binding。 |

## 本轮修复的假覆盖

1. Generation Job detail 原先没有 `TransportExecution`，即使底表存在多个 provider invocation，操作者也无法下钻。现已把 transport authority 加入 shared contract、main query 和 Admin inspector，并以两次 transport（failed→succeeded）、独立 provider request、cost、manifest fixture 锁定。
2. `applyOverrides` 原先按未排序的数据库行顺序应用 grant/revoke；历史 grant 可能覆盖新 revoke。现按集合语义固定为 `role ∪ grants − revokes`，并以逆序 pure fixture 和真实 endpoint 撤权 fixture锁定。

## 仍应作为发布阻断项跟踪

- 29 个 pending contract ref 必须继续共享化并进入真实 Zod 正反 fixture；31 个 pending mutation 必须补齐幂等键或乐观锁的 replay/collision/failure semantics。机器可读 inventory 只是诚实 Gate，不是完成。
- production-like 网络分区，以及直接运行真实 Prisma/dispatcher/projector 模块的进程 kill L3 演练；隔离 `chaos_*` transport schema 不替代该证据。
- 生产 read/write canary、实时撤权/session、辅助技术人工验收和持续观察窗口；本地自动化不能签发这些外部证据。
