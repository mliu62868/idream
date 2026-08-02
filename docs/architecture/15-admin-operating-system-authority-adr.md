# ADR-11 · Admin 运营系统的权威、可靠性与渐进切换

更新日期：2026-07-11

状态：已采纳；本地代码态完成，生产切换仍受观察 Gate 约束

关联方案：[`ADMIN_CONSOLE_FIRST_PRINCIPLES_REMEDIATION_PLAN.md`](../product/ADMIN_CONSOLE_FIRST_PRINCIPLES_REMEDIATION_PLAN.md)

## Context

旧 Admin 同时存在单字段多语义、客户端重算 readiness、原始记录列表、进程内副作用和 main 源码直连。它们让“HTTP 成功”“worker 停止”“用户收到结果”“资金结算完成”被误认为同一事实，也让权限、审计、重试和回滚难以独立证明。

## Decision

1. `main` 保持 Character、Generation、Creative、Incident、Case、Billing 与 Admin command 的领域 authority；`admin` 只保留 UI/BFF，依赖 shared contract，通过签名 HTTP 调 main，不导入 main server、Prisma、BullMQ 或 auth 实现。
2. 状态按正交语义拆分。Generation 使用 Request（物理兼容表仍为 `GenerationJob`）→ Attempt → TransportExecution → Artifact → Delivery；资金只由 append-only `DreamcoinLedger` 权威，`GenerationSettlementLink` 仅建立可审计引用。Creative Run 的 execution/review/deployment/verification 分轴。
3. 官方角色只通过 immutable ContentVersion/Revision/Release Snapshot 发布；`CharacterServing` 是唯一 runtime pointer authority。schedule/publish/rollback 每次重算当前 policy，并在同一事务写 pointer、legacy projection、Command、Audit 和 Outbox。rollback 创建新的 Release，而不复活历史行。
4. `ControlPlaneCommand` 是异步动作 aggregate。canonical request hash 绑定 command、target、payload、expected version 与 approval；approval 在同一事务条件消费。领域写、Command、Audit 和 Outbox 原子提交；lease 只对声明幂等的执行恢复。
5. 跨服务只在 durable receipt/canonical row 已提交后 ACK。Generation provider 调用前先登记 TransportExecution；自动 transport retry 只允许 deterministic provider idempotency。provider 结果先写覆盖全部终态的 immutable terminal record，再进入 Main-owned durable relay；Main 短时不可用只重试 relay row，relay admission 中断只重投 record，不再次调用 provider。
6. Incident 与 typed Case 是运营 authority；Today/Work Item 只是从领域根重建的排序投影，不拥有第二套状态。Incident occurrence assignment、Case Evidence、Review Decision、Metric definition 与发布快照由数据库拒绝原地改写。
7. canonical Product Event、fact projector 与 typed Metric Registry 是指标 authority。无法证明 attribution、成熟度、coverage 或 freshness 时 fail closed 为 `null/invalid`；NS-01 未批准前 WPCU 正式、WSCU/WSCrU/WPSCU 仅 shadow。
8. 切换使用 expand → backfill → shadow → read canary → write canary → constraint validation → legacy sunset。任何 invariant、shadow mismatch、重复结算、权限或 Audit 原子性失败都阻止扩大流量。写代理故障 fail closed；回滚切流量/读路径，不删除 additive schema 或证据。

## Rejected alternatives

- 一次性物理重命名/重写全部表和 API：扩大回滚面，且不改善业务不变量。
- Admin 直接连接数据库或导入 main service：缩短单次开发路径，但破坏 actor、permission、command 和部署边界。
- 通用工作流表拥有所有领域状态：会产生第二套 authority。
- BullMQ completed、HTTP 200 或 provider success 直接等同业务成功：无法证明 delivery、verification 与 settlement。
- 非幂等 provider 在 ambiguous outcome 后自动 retry：可能重复调用与重复成本。
- 为历史缺失上下文猜测 release/placement/exposure：制造不可纠正的伪精确归因。

## Consequences

正向结果：每个事实有唯一解释；高风险动作可幂等、可审计、可恢复；Admin 可独立构建发布；事件与指标能重建并 fail closed；生产切换有可执行 Gate。

代价：模型与事件数量增加；运营 UI 必须解释多轴状态；跨服务完成需要 durable ACK；历史缺失数据会明确显示 partial/unavailable；生产完成声明必须等待真实 backfill、canary 和成熟观察窗口。

## Verification and rollback

- 本地门禁：`bun run test`、`bun run check`、`admin:readiness:shadow`、`admin:readiness:load`、`admin:readiness:migrations`、`admin:readiness:chaos`。
- 生产门禁：§19.4 invariant ledger、shadow mismatch、permission matrix、read/write canary、error budget、legacy traffic=0、两个成熟指标窗口和对应 DRI 签字。
- 回滚：关闭 v2 read/write flag 或 BFF canary；停止 dispatcher；保留 additive schema、append-only evidence 与 pending outbox；修复后 forward replay。不得回滚为绕过 command 的任意状态 PATCH。
