# Admin Console §21 Test Matrix Evidence Audit

> 基线：`ADMIN_CONSOLE_FIRST_PRINCIPLES_REMEDIATION_PLAN.md` §21.1/§21.2，代码基线 `d392fed2`。
> 判定规则：只有能通过公共 seam 让错误实现失败的自动化测试才记为“已验证”；源码存在、窄单测或人工推断只记为“部分”。生产 canary/观察窗口不属于本地测试通过。

## §21.1 测试矩阵

| 层级 | 判定 | 当前权威证据 | 尚缺或弱证据 |
| --- | --- | --- | --- |
| Pure state/invariant | 已验证 | `characters/readiness.test.ts`、`generation-attempt-events.integration.test.ts`、`content-production-state.test.ts`、`metrics/engine.test.ts`、`reconciliation/invariants.adversarial.integration.test.ts` | Incident/Case 的部分推导仍主要由 integration 覆盖，不是独立 property model。 |
| Property/table-driven | 部分 | `characters/readiness.test.ts`、`creative/retry-executor.test.ts`、`admin/permissions.test.ts`、`shared/command-reliability.test.ts` | 尚无对全部领域合法/非法 transition 的穷举；Creative 任意 item 组合尚未做生成式/property 覆盖。 |
| Postgres integration | 已验证 | `characters/creation.integration.test.ts`、`shared/command-reliability.test.ts`、`incidents/incident-case.integration.test.ts`、`remaining-canonical-lists.integration.test.ts`、`immutable-evidence-migration.integration.test.ts` | 跨进程故障点由进程测试和 rehearsal 分担，不应仅用 integration 数量声称覆盖。 |
| Contract | 部分 | `packages/shared/src/admin/**/*test.ts`、`commands/authoritative.integration.test.ts`、各 Route Handler integration | “每个 Zod request/response 都有正反 fixture”尚未建立可枚举 manifest；HTTP/in-process parity 不是所有 endpoint 都有。 |
| Cross-service | 已验证（本地） | `processes/chat-outbox.test.ts`、`chat/test/durable-outbox.test.ts`、`chat/test/reliability.test.ts`、`processes/event-consumer.metrics.integration.test.ts`、`generation-manifest-ingest.test.ts` | 真 Redis 进程被杀、网络分区和每个 projector 的独立重建仍属于 chaos/rehearsal 证据。 |
| Metric golden dataset | 部分 | `metrics/engine.test.ts`、`metrics/projector.test.ts`、`event-consumer.metrics.integration.test.ts`、`metrics/backfill.test.ts` | chat regenerate/edit/delete 到最终 D1/D7 报表的单一 golden replay fixture 尚未闭合。 |
| API/AuthZ | 部分 | `permissions/grant-bundles.integration.test.ts`、`commands/authoritative.integration.test.ts`、`bootstrap/route.test.ts`、`nav-config.test.ts`、`jobs/query.integration.test.ts` | 没有机器可枚举的“每个 endpoint × permission”总矩阵；DTO 裁剪集中在核心域而非全部 endpoint。 |
| E2E Character | 部分 | `admin-v2-workspaces.e2e.ts` + release lifecycle/executor/monitor integration | 浏览器级 blocker→修复→preview→publish→monitor→rollback 尚未由一条真实 E2E 串起。 |
| E2E Creative/Incident | 部分 | `creative/creative-loop.integration.test.ts`、`creative/incident-attachment.integration.test.ts`、`incidents/incident-case.integration.test.ts` | 领域闭环已在 Postgres seam 验证；浏览器级整链仍缺。 |
| E2E Case | 部分 | `incidents/incident-case.integration.test.ts`、`cases/customer-case.integration.test.ts` | 多 source→decision→downstream verify→recurrence 未由单条浏览器测试闭合。 |
| E2E Today | 已验证（领域 seam） | `today/query.test.ts` 覆盖 action、Recently resolved、verification failed re-entry | 浏览器 E2E 主要验证 workspace/navigation；真实 command 完成后的 UI re-entry 仍可增强。 |
| Component/A11y | 部分 | `operations/workspaces.test.tsx`、`collaboration.test.tsx`、`a11y-error-boundary.test.ts`、表格 caption/scope 回归 | 完整 keyboard/focus trap/tab arrows/读屏播报与 responsive 四条核心流没有统一自动化 AA harness。 |
| Migration rehearsal | 已验证（本地） | `admin-migration-rehearsal.mjs` + readiness 命令覆盖 fresh/repeat/baseline/upgrade/rollback/forward-fix | 生产快照 backfill/shadow 仍必须在专用环境取证。 |
| Load/Chaos | 部分 | `admin-production-like-readiness.ts` 覆盖 100k Jobs/Cases、1m Events；outbox/lease/projector recovery 单测 | DB/Redis outage、dispatcher 真重启、并发 scheduler、projector lag 的 production-like failure injection 尚未形成同一可重跑套件。 |

## §21.2 反例 fixture

| 反例 | 判定 | 自动化证据 / 说明 |
| --- | --- | --- |
| approved/public 但 Persona、anchor 或 refs 缺失 | 已验证 | `characters/readiness.test.ts` + `reconciliation/invariants.adversarial.integration.test.ts`。 |
| active Visual Identity，0 anchor、0 evidence、null scores | 已验证 | `admin/characters/visual-profiles.test.ts` 的 exact fixture；证明 active 不会伪造 anchors/scores。 |
| Creative 0/4、1/4、4/4 | 已验证 | `admin/content-production-state.test.ts`。 |
| failed Attempt 带 legacy `completedAt`、无 success fact | 已验证 | `admin/generation-job-state.test.ts`、`ourdream/admin-console.test.ts`。 |
| retry HTTP 重放、两个 tab 并发 publish | 已验证 | retry replay 在 `jobs/query.integration.test.ts`；`characters/release-executor.integration.test.ts` 以两个独立 command/worker 竞争同一 Serving CAS，锁定一次成功、一次 conflict、单份副作用。 |
| schedule 后 policy/Identity/Reference stale；两个 scheduler 并发 | 部分 | policy/route/reference drift 有 executor/reconciliation 证据，publish CAS 并发也已锁定；自动 scheduler 的双 dispatcher 触发尚缺。 |
| full/partial/重复 refund，execution 不被账务覆盖 | 已验证 | `generation-request-lifecycle.integration.test.ts`、`incidents/action-executor.integration.test.ts`、`content-production-state.test.ts`、adversarial invariant。 |
| completed/failed terminal 并发；transport retry 与 business retry 分离 | 已验证 | `generation-attempt-events.integration.test.ts`、`generation-transport-execution.integration.test.ts`、retry command tests。 |
| Redis 丢失、receipt 后 projector 崩溃、payload conflict、main→chat 丢失 | 已验证（进程 seam） | main/chat outbox、durable ingest、event consumer recovery tests；真实 Redis kill 属 chaos 缺口。 |
| manifest 已写但 main ingest 暂失败；ambiguous provider 不自动 retry | 已验证 | `packages/gen/src/pipeline.test.ts`、`generation-manifest-ingest.test.ts`。 |
| 一个 Attempt 多个 TransportExecution、provider cost、technical success 下钻 | 已验证 | `jobs/query.integration.test.ts`；`GenerationJobDetailResponse` 与 Jobs inspector 现在展示每个 transport、cost、manifest 和 technical outcome。 |
| chat duplicate/out-of-order/delay/regenerate/edit/delete/release switch/backfill | 部分 | chat hot-path/reliability/release-pin + metric projector 覆盖各段；尚无一个 golden replay 串起全部 correction。 |
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

- 自动 scheduled-release dispatcher 的双 scheduler 触发测试（publish command/Serving CAS 并发已覆盖）。
- 76 个 v2 Route Handler 的可枚举 endpoint-permission-contract manifest；当前不能声称“每个 endpoint”已证明。
- Character、Creative/Incident、Case 四条浏览器级完整闭环，不以 integration 冒充浏览器 E2E。
- production-like DB/Redis kill、dispatcher restart、projector lag chaos 套件。
- WCAG 2.2 AA keyboard/focus/screen-reader 自动化验收。
