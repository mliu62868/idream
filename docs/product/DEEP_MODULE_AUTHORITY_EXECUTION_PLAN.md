# Deep Module Authority Execution Plan

Updated: 2026-08-01

Status: Implemented and isolated full-suite verified; development DB migration, production cutover/live media canary, browser operator journey, and customer default-profile cutover pending

Decision record: [`ADR-13`](../architecture/17-deep-module-authority-boundaries.md)

Implementation status SSoT: [`CURRENT_FUNCTIONAL_COVERAGE.md`](./CURRENT_FUNCTIONAL_COVERAGE.md)

## 1. Goal

把六组已经存在但 Interface 偏浅的权威收进深 Module：

1. Gen 唯一执行；
2. Dreamcoin Ledger 唯一写入；
3. Admin manifest-backed mutation execution；
4. aggregate-owned state transitions；
5. Main ↔ Chat Durable Exchange；
6. Character Production Journey。

计划只改变 owner 和 Interface，不发明第二套业务状态，不扩大产品功能。

## 2. Completion contract

每个阶段只有同时满足以下条件才算完成：

1. 新 Interface 有成功、重放、冲突和失败行为测试；
2. 所有目标调用方已经迁移；
3. 旧 helper、回退路径、env 和重复推导已经删除；
4. 架构边界测试能阻止旧路径重新出现；
5. focused tests 与 `bun run check` 退出码为 0；
6. 涉及运行时的阶段有 PM2、HTTP 和持久化证据；
7. 涉及操作流程的阶段有真实浏览器证据；
8. `CURRENT_FUNCTIONAL_COVERAGE.md` 只在证据完成后更新。

“新路径可用但旧路径仍保留”不算完成。

## 3. Guardrails

- 保留现有目录与 Next Route 文件结构；
- 就地修改权威文件，不创建 `v2`、`new` 或兼容副本；
- 不建立通用工作流引擎；
- 不新增 Character Journey 状态表；
- 不恢复 Main 图片/视频执行回退；
- 不保留跨服务 Redis 直投回退；
- 不把所有 Admin mutation 强制改成异步 command；
- 不直接连接数据库执行 migration；只提交 Prisma migration / SQL，由用户执行；
- 不把现有工作区 WIP 混入阶段提交。

当前工作区已有大量 Character、Gen 和模型评测 WIP，且与本计划目标文件重叠。实施每阶段开始前必须保存：

```bash
git status --short
git diff -- <owned paths>
```

提交时只 stage 本阶段 owned hunks。若启动 agent team，每个 teammate 必须使用独立 worktree branch，最终由主 agent 统一合并。

## 4. Dependency order

```text
P0 Baseline
  │
  ├─▶ P1 Gen unique execution
  │      │
  │      └─▶ P2 Ledger single writer
  │               │
  │               └─▶ P3 Admin write execution
  │                        │
  │                        └─▶ P4 Aggregate transitions
  │                                 │
  │                                 └─▶ P5 Durable Exchange
  │                                          │
  │                                          └─▶ P6 Character Journey
  │
  └─▶ P7 Full closure
```

顺序理由：

- 先删除 Main provider execution，可同时减少 Ledger 和 Chat event 的重复调用点；
- Ledger、Admin admission 和 transition 先稳定，Journey 才能依赖一致写语义；
- Durable Exchange 在 command/transition 事实稳定后切换；
- Journey 最后消费所有权威的最终形状。

## 5. P0 — Baseline and executable inventories

### Scope

把当前六类旧路径变成可执行 inventory，避免迁移时漏调用点。

### Changes

- 为以下模式建立静态扫描测试或明确 inventory：
  - `packages/main` 中图片/视频 provider invocation；
  - `dreamcoinLedger.create/upsert/update` 与重复 `appendLedger`；
  - Admin Route 自行认证、解析幂等键、读取 `If-Match`、调用 atomic mutation；
  - 有限状态字段的直接 Prisma update；
  - `MAIN_TO_CHAT_QUEUE`、`CHAT_DURABLE_INGEST_URL` 和直接 queue producer；
  - `resolveCharacterProductionEntry`、`portfolioNextAction` 及其他 Journey 推导。
- 记录当前 focused tests 和当前失败项；不把用户 WIP 导致的既有失败归因给本计划。

### Suggested commit

```text
test(architecture): inventory deep-module authority leaks
```

### Gate

- inventory 对已知调用点数量稳定；
- 测试能在新增一个违规 fixture 时失败；
- 只新增检测，不改变运行时行为。

## 6. P1 — Gen unique execution

### Target Interface

```ts
// Main
dispatchGenerationAttempt(attempt)
ingestGenerationTerminalRecord(envelope)
finalizeGenerationAttempt(terminalRecord)

// Gen
GenerationExecution.run(job)
persistTerminalRecord(result)
deliverTerminalRecordUntilAck(terminalRecord)
```

### Work items

#### P1.1 Lock the package boundary

- 明确 `packages/gen/src/{image,video,pipeline,generation-execution,terminal-record}.ts` 为 provider execution owner；
- 共享契约只暴露 pinned Attempt/Transport input 与 immutable terminal record；
- 加边界测试：`packages/main` 不得导入 Gen backend/provider，也不得请求 ComfyUI/sd.cpp/Draw Things/video runtime。

Suggested commit:

```text
test(gen): lock provider execution to gen package
```

#### P1.2 Remove Main execution

- 删除 `packages/main/src/server/ai/local-pipeline.ts` 中图片/视频 provider invocation；
- 删除 `/api/internal/worker` 中承担图片/视频执行的分支，但保留仍有独立职责的 worker endpoint；
- Main generation service 只创建 Request/Attempt、写 dispatch intent；
- Main finalizer 只接收 immutable terminal record，不根据部署配置自行生成；
- 删除仅为 Main execution 服务的 provider/env/import。

Suggested commit:

```text
refactor(gen): make gen worker the only media executor
```

#### P1.3 Prove terminal-record recovery

- 覆盖 Gen 调用成功、relay enqueue 中断、terminal record 重投；
- 覆盖 Main 短时不可用时 terminal relay 独立重试与进程重启恢复；
- 证明重投不会再次调用 provider；
- 覆盖 cancelled Request 的晚到 terminal record；
- 覆盖 ambiguous non-idempotent provider outcome。

Suggested commit:

```text
test(gen): prove durable completion replay without reinvocation
```

### Focused verification

```bash
bun test packages/gen/src/pipeline.test.ts
bun test packages/gen/src/backend/backend-image-model.test.ts
bun test packages/gen/src/backend/backend-video-model.test.ts
bun test packages/main/src/server/modules/ourdream/image-generation-service.test.ts
bun test packages/main/src/server/ai/generation-terminal-record-ingest.test.ts
```

若实际文件名与当前测试入口不同，以同目录现有 Vitest 文件为准，不新建重复测试套件。

### Runtime evidence

- `pm2 jlist`：只有 `gen-image` / `gen-video` 拥有 provider execution；
- Main HTTP 创建 Request 后，Gen 消费一次；
- terminal record 持久化；
- Main finalization 后 Request/Attempt/Artifact/Delivery/Settlement 链闭合；
- 暂停 Main finalizer再恢复时不重复调用 provider。

## 7. P2 — Ledger single writer

### Target Interface

```ts
type LedgerIntent =
  | SignupBonusIntent
  | SubscriptionGrantIntent
  | GenerationSpendIntent
  | RefundIntent
  | RedeemIntent
  | ReferralIntent
  | AdminAdjustmentIntent;

postDreamcoinEntry(tx, intent): Promise<LedgerEntry>
```

### Work items

#### P2.1 Introduce typed intent

- 在 Billing/Ledger owner 内定义 union；
- 给每个 reason 定义金额符号、必需 source 和幂等 identity；
- 对相同 key + 相同 canonical intent 返回同一 entry；
- 对相同 key + 不同 intent 返回 conflict；
- 余额锁定、aggregate 与 `balanceAfter` 计算只保留一份。

Suggested commit:

```text
refactor(billing): add typed dreamcoin ledger intent
```

#### P2.2 Migrate call sites by business family

依次迁移：

1. signup / subscription / referral / redeem；
2. generation spend / capture / refund / cancel；
3. Admin adjustment / incident refund / dead-letter compensation。

每组迁移后补相同 key replay、并发与余额测试。

Suggested commits:

```text
refactor(billing): route rewards through ledger authority
refactor(billing): route generation settlement through ledger authority
refactor(billing): route admin compensation through ledger authority
```

#### P2.3 Delete duplicate writers

- 删除 `ourdream/service.ts`、`local-pipeline.ts` 等重复 `appendLedger` / balance helper；
- 禁止 `dreamcoinLedger.create/upsert/update/delete` 出现在 Ledger Module 和 migration/seed/test fixture 之外；
- 生成关联只允许由 generation spend/refund intent 建立。

Suggested commit:

```text
refactor(billing): remove direct dreamcoin ledger writers
```

### Focused verification

```bash
bun test packages/main/src/server/modules/ourdream/billing.test.ts
bun test packages/main/src/server/modules/ourdream/admin-console.test.ts
bun test packages/main/src/server/modules/ourdream/chat-gen-extra.test.ts
bun test packages/main/src/server/modules/admin-v2/incidents/action-executor.integration.test.ts
```

### Persistence evidence

- 每个 intent 写入一个 ledger row；
- replay 不增加 row；
- 并发相同 key 最终只有一个 row；
- `balanceAfter` 与全量 delta 聚合一致；
- generation spend/refund 有且只有一个正确 `GenerationSettlementLink`；
- 非生成 intent 没有 settlement link。

## 8. P3 — Manifest-backed Admin write execution

### Target Interface

```ts
executeAdminMutation(operationId, request, {
  params,
  target,
  mutate,
});
```

Manifest operation 需要可执行 metadata：

```ts
{
  authorization,
  requestContract,
  responseContract,
  mutationTransport,
  commandType,
  executionMode: "atomic" | "durable",
}
```

### Work items

#### P3.1 Make manifest metadata executable

- 合并 API manifest 与 mutation transport 的重复 operation identity；
- contract registry 负责把 schema ref 解析为实际 Zod parser；
- production 中 unknown operation、unknown parser 或 transport mismatch fail closed；
- 保持 shared contract 可被 Admin client 使用，不把 Prisma callback 放进 shared。

Suggested commit:

```text
refactor(admin): make operation manifest executable
```

#### P3.2 Build the server execution Module

- 统一 authentication、permission、resource scope；
- body 只解析一次；
- 统一读取并验证 `Idempotency-Key` / `If-Match`；
- 统一 canonical hash、serializable retry 与 conflict mapping；
- atomic mode 复用并深化 `executeAtomicIdempotentMutation`；
- durable mode 复用 `acceptControlPlaneCommand`；
- 返回 manifest 声明的 response contract。

Suggested commit:

```text
refactor(admin): centralize mutation admission and execution
```

#### P3.3 Migrate one tracer bullet

先迁移一条同时需要 permission、idempotency 和 `If-Match` 的 Character Route。

证明：

- Route 只提取 path params 和提供领域 callback；
- 未认证请求在 body parse/DB 前返回 401；
- payload collision 返回 409；
- stale entity version 返回 409；
- replay 返回相同结果；
- audit/outbox 行为不变。

Suggested commit:

```text
refactor(admin): migrate character mutation tracer bullet
```

#### P3.4 Migrate remaining routes

按领域分组迁移：

1. Character / Creative；
2. Incident / Case / Today；
3. Billing / permissions / experiments / saved views；
4. backfill / reconciliation / remaining writes。

每组完成后删掉 Route 内重复 admission，不建立临时 wrapper 副本。

Suggested commits:

```text
refactor(admin): migrate character and creative mutations
refactor(admin): migrate incident and case mutations
refactor(admin): migrate control-plane mutations
refactor(admin): migrate remaining v2 mutations
```

#### P3.5 Lock the boundary

- 静态测试禁止写 Route 直接调用 `authenticatedAdminActor`、自行读取幂等/If-Match 或直接调用 atomic helper；
- API manifest、contract registry、transport 和 Route inventory 必须一一对应；
- 删除旧 transport SSoT，保留一个 operation definition。

Suggested commit:

```text
test(admin): forbid route-level reliability protocols
```

### Focused verification

```bash
bun test packages/shared/src/admin/admin-contracts.test.ts
bun test packages/shared/src/admin/contract-registry.test.ts
bun test packages/main/src/server/modules/admin-v2/shared/admin-bff.test.ts
bun test packages/main/src/server/modules/admin-v2/shared/command-reliability.test.ts
bun test packages/main/src/server/modules/admin-v2/shared/mutation-recovery.integration.test.ts
bun test packages/main/src/server/modules/ourdream/admin-console.test.ts
```

### HTTP evidence

对 atomic 与 durable operation 各验证一条：

- missing/invalid BFF → 401；
- missing permission → 403；
- invalid body/header → 400；
- stale version / payload collision → 409；
- first request → committed/accepted；
- exact replay → same result/receipt；
- DB 中 domain + Command/Audit/Outbox 满足该 operation 的原子性要求。

## 9. P4 — Aggregate-owned transitions

### Target shape

共享层：

```ts
defineTransitionAuthority(states, edges)
```

聚合层：

```ts
transitionIncident(tx, input)
transitionCase(tx, input)
transitionCharacterRelease(tx, input)
```

### Work items

#### P4.1 Deepen command transitions first

- 以现有 `control-plane-command-transition.ts` 为基准；
- 确保 Command 与 CommandAttempt 只能通过 transition Interface 改状态；
- 统一 lease/retry/terminal timestamp 规则；
- 边界测试禁止其他模块直接更新这两个状态字段。

Suggested commit:

```text
refactor(admin): seal command state transitions
```

#### P4.2 Generation transitions

- Request 与 Attempt 分别拥有 transition；
- finalization、cancel、retry、late terminal record 都调用同一入口；
- `refunded` 不作为 execution outcome；
- transition 与 Ledger settlement 保持同事务或可证明的 durable sequence。

Suggested commit:

```text
refactor(generation): centralize request and attempt transitions
```

#### P4.3 Incident and Case transitions

- 合并 service/workflow/executor 内重复的“check then update”；
- transition 统一 version、active key、领域时间戳、Audit/Event；
- split/merge/resolve/close/reopen/wait 覆盖并发冲突。

Suggested commit:

```text
refactor(operations): centralize incident and case transitions
```

#### P4.4 Character transitions

- Project phase、Release status 与 Serving state 分别封装；
- proposal/review/validate/publish/schedule/rollback/pause/resume/retire 不再自行改状态；
- immutable Release 与 Serving pointer 边界保持 ADR-12 语义。

Suggested commit:

```text
refactor(characters): centralize release and serving transitions
```

#### P4.5 Creative and Experiment transitions

- Creative lifecycle/workflow/verification/item/placement 分轴封装；
- 不把多轴合并成一个复合 enum；
- Experiment start/stop 走唯一 transition。

Suggested commit:

```text
refactor(creative): centralize workflow transitions
```

#### P4.6 Lock all finite-state writers

- inventory 中的直接 finite-state update 归零；
- 允许 migration、seed、test fixture 和 transition Module 自身；
- 完整矩阵测试继续覆盖全部 state × state。

Suggested commit:

```text
test(architecture): forbid direct finite-state writes
```

### Focused verification

```bash
bun test packages/main/src/server/modules/admin-v2/shared/state-transition-authority.test.ts
bun test packages/main/src/server/modules/admin-v2/shared/finite-state-authority-inventory.test.ts
bun test packages/main/src/server/modules/admin-v2/characters/release-lifecycle.integration.test.ts
bun test packages/main/src/server/modules/admin-v2/characters/release-executor.integration.test.ts
bun test packages/main/src/server/modules/admin-v2/incidents/lifecycle.integration.test.ts
bun test packages/main/src/server/modules/admin-v2/cases/mutation-reliability.integration.test.ts
bun test packages/main/src/server/modules/admin-v2/creative/workflow.test.ts
```

## 10. P5 — Main ↔ Chat Durable Exchange

### Target Interface

发送方：

```ts
recordDurableEvent(tx, typedEvent)
dispatchPendingEvents(destination)
```

接收方：

```ts
persistDurableInbox(envelope)
consumeDurableInbox(receiptId)
```

### Work items

#### P5.1 Unify envelope and ACK contracts

- shared contract 固定 `sourceService/sourceEventId/eventType/schemaVersion/occurredAt/aggregate/payload`；
- canonical hash 算法只保留一份；
- ACK 区分 `persisted`、`duplicate`、`quarantined`；
- quarantined 不能 `acknowledged=true`。

Suggested commit:

```text
refactor(events): unify durable envelope and receipt contract
```

#### P5.2 Harden both receiver ingresses

- Chat `/internal/events/ingest` 在 ACK 前持久化 Inbox；
- Main `/api/internal/events/ingest` 在 ACK 前持久化 canonical Inbox/Product Event receipt；
- receiver-local enqueue 失败不撤销 durable ACK，由 reconciler 补唤醒；
- exact replay 与 hash collision 有对称测试。

Suggested commit:

```text
refactor(events): make both ingresses durably acknowledge
```

#### P5.3 Cut Main sender to HTTP ACK

- `packages/main/src/processes/chat-outbox.ts` 只走 Chat durable ingest；
- direct queue producers 先改为事务内 `recordMainToChatEvent`：
  - generation/chat image events；
  - compliance/user lifecycle events；
  - moderation/character removal；
  - session Release migration；
- sender 只有收到 durable ACK 才标记 delivered。

Suggested commit:

```text
refactor(events): deliver main outbox through chat inbox ack
```

#### P5.4 Confirm Chat sender symmetry

- `packages/chat/src/outbox.ts` 与 Main sender 使用相同 response semantics；
- Main receipt persisted 后 ACK；
- Main consumer/projector 失败由本地 durable receipt 重试，不要求 Chat 重投 provider/domain effect。

Suggested commit:

```text
refactor(events): align chat outbox with durable exchange
```

#### P5.5 Delete cross-service queue fallback

- 删除 `MAIN_TO_CHAT_QUEUE`；
- 删除 Chat worker 对该 queue 的 consumer；
- 删除 `CHAT_DURABLE_INGEST_URL`，改为明确必需的 Chat ingest URL；
- 删除 ecosystem/env/readiness 中的可选切换描述；
- Redis 中旧 queue 归零后移除运行时依赖。

Suggested commit:

```text
refactor(events): remove cross-service redis delivery
```

### Deployment sequence

1. receiver-first 部署 Chat 与 Main ingress；
2. HTTP 探针验证 exact replay/collision；
3. 切 Main sender；
4. 观察 Main Outbox 与 Chat Inbox；
5. 切并确认 Chat sender；
6. 等待旧 `chat.inbound` queue 归零；
7. 删除 queue consumer、constant 和 env；
8. 保存 PM2/HTTP/DB 证据。

### Focused verification

```bash
bun test packages/shared/src/contracts/durable.test.ts
bun test packages/main/src/processes/chat-outbox.test.ts
bun test packages/main/src/processes/event-consumer.test.ts
bun test packages/chat/src/outbox-scheduling.test.ts
bun test packages/chat/src/service.test.ts
bun test packages/chat/src/durable-exchange.integration.test.ts # P5 新增
```

### Persistence evidence

- sender Outbox pending → delivered；
- receiver Inbox persisted/duplicate；
- payload collision → quarantined，sender 不标 delivered；
- receiver-local queue 暂停后 ACK 仍安全，恢复 reconciler 后 applied；
- 任意一侧重启不丢 event、不重复 domain effect；
- Redis 不再出现跨服务 `chat.inbound` 任务。

## 11. P6 — Character Production Journey

### Target Interface

```ts
projectCharacterProductionJourney(db, characterId)
projectCharacterProductionJourneys(db, characterIds)
```

批量 Interface 是 Portfolio 的正式入口，必须避免逐 Character 重复查询。

### Work items

#### P6.1 Define the shared projection contract

契约包括：

- `stage` / `status`；
- ordered `steps`；
- structured `blockers`；
- exactly one `primaryAction`；
- draft/live asset-pack progress；
- live Release/Serving summary；
- projection version / as-of。

`primaryAction` 使用稳定 code + deep link + 可选 command metadata，不把英文 UI copy 当 authority。

Suggested commit:

```text
feat(characters): define production journey contract
```

#### P6.2 Build one server projector

- 从 Workspace/Portfolio 当前查询中提取事实加载；
- 明确优先级：
  1. 未完成或阻塞的显式 command；
  2. visual identity/reference/route readiness；
  3. active image Run；
  4. missing draft asset purpose；
  5. preview/QA；
  6. candidate Release；
  7. live monitor；
- 同一 snapshot 只产生一个 action；
- live 且 asset pack 不完整必须同时表达 live 状态与补包动作。

Suggested commit:

```text
feat(characters): project one authoritative production journey
```

#### P6.3 Replace Portfolio derivation

- 删除 `portfolioNextAction`；
- Portfolio 使用 batch projector；
- 卡片分组、优先级和 deep link 只读 Journey；
- 保持 keyset pagination，不做页内假排序；
- 增加 query-count/N+1 回归测试。

Suggested commit:

```text
refactor(characters): drive portfolio from journey projection
```

#### P6.4 Replace Workspace derivation

- Workspace DTO 包含 Journey；
- 删除前端 `resolveCharacterProductionEntry`、重复 asset-pack progress 和 blocker target 推导；
- 顶部先展示 live truth，再展示 primary action；
- deep link 必须落到实际可执行控件。

Suggested commit:

```text
refactor(characters): drive workspace from journey projection
```

#### P6.5 Advance after success

- generation、review、adoption、QA、Release command 成功后刷新 Journey；
- 自动导航到新的 primary action；
- 不自动采用候选；
- 不自动激活 Voice；
- 不自动发布 Release；
- unknown command outcome 继续保持写锁并走 mutation receipt recovery。

Suggested commit:

```text
feat(characters): advance to the next projected action
```

#### P6.6 Delete duplicate workflow logic

- 静态测试禁止 Admin UI 重新组合 Journey stage/next action；
- 删除旧 copy map 中仅服务客户端推导的分支；
- 保留纯展示映射与 i18n。

Suggested commit:

```text
test(characters): forbid client-owned journey derivation
```

### Focused verification

```bash
bun test packages/shared/src/admin/contracts/characters-visual-workspace.test.ts
bun test packages/main/src/server/modules/admin-v2/characters/portfolio.integration.test.ts
bun test packages/main/src/server/modules/admin-v2/characters/workspace.integration.test.ts
bun test packages/admin/src/features/characters/CharacterWorkspaceProduction.test.ts
bun test packages/admin/src/features/characters/CharacterPortfolioVisual.test.tsx
bun test packages/admin/src/features/characters/CharacterAssetStudio.mounted.test.tsx
```

### Browser journey

至少覆盖一名新 Character 与一名已上线但资产包不完整的 Character：

```text
create / open Character
  → establish Visual Identity
  → seal Reference Set
  → qualify route
  → generate one purpose
  → review candidate
  → explicitly adopt
  → fill all three purposes
  → preview + QA
  → propose/review/validate Release
  → explicitly publish
  → monitor live Character
```

每次成功后检查：

- 顶部线上状态正确；
- primary action 唯一且可点击；
- 自动进入新的下一步；
- asset-pack adopted/total 正确；
- 刷新页面后 Journey 不依赖客户端旧状态；
- console error/warning、网络 4xx/5xx 和横向溢出为零。

## 12. P7 — Full closure

### 2026-07-31 implementation result

- P0–P6 已完成；旧 provider execution、自由 Ledger 写入、Route 自组 mutation 协议、调用方状态写入、跨服务 Redis 直投和客户端 Journey 推导均已删除。
- `git diff --check`、根 `lint`、`typecheck`、全量 `test` 与 production `build` 退出码均为 0。全量测试为 `404 passed files + 2 skipped files / 2,679 passed tests + 3 skipped tests`；build 为 `5/5`。最终 build 产物为 Main `idream-9626f3cc-c7a3-45bd-a4a5-9948f223a43d`、Admin `idream-9afddb6a-cad4-4c6a-892c-e58fd256090a`，共同 build ID 为 `build-TfctsWXpff2fKS`。
- 当前 PM2 中 Main、Admin、Chat、Gen image/video、finalizer、event consumer 与 command worker 均为 `online`；Main `/`、Admin `/admin/characters`、Chat `/healthz` 本轮 HTTP 均返回 200。
- Main → Gen → Main 真实链已完成：Admin test Job `cms91ymbw00012ul7zdz3g6vf` / Attempt `cms91ymc800042ul7l0m8y2h6` 经 `redcraft-krea2-redmix3-txt2img` 执行，Main 摄入当时的不可变 completion evidence（现由 terminal record authority 承接）后终结为 `completed` / `succeeded`。产物为 832×832 PNG、871,984 bytes、SHA-256 `d269bf4fb059747d75581c87d19965ed60d1a4e278a05db587f77aef06d168c1`；通过 Admin media BFF 读取返回 HTTP 200，字节哈希与 Blob 一致。
- customer 默认生成的失败路径也已真实验证：旧开发库 active default/premium profile 仍指向已删除的 `redcraft-krea2-txt2img`，Job `cms91jow800xi66l736d5xseq` 因 `unknown_model` 失败；Ledger 精确产生一笔 `-5 generation_spend` 与一笔 `+5 refund`，净变化 0。源码没有增加 alias/fallback，也没有静默改写 operator-owned profile；必须由 operator 通过新的有效 profile 完成默认 profile cutover。
- Main ↔ Chat 双向真实链已完成：显式 `alexa-reeves` 的 signed BFF conversation probe 全绿并以退出码 0 完成 create/send/SSE/reload/no-memory/blocked-input/cleanup。临时用户删除产生 Main `user_deleted_cms91ipu500xc66l7ijjohtvz` Outbox `delivered` → Chat Inbox `consumed`；Chat 随后产生 `evt_91af71673c7b465bbb805dd8d2738762` (`chat.account_erasure.completed`) Outbox `delivered` → Main receipt `processed`。
- Admin atomic/durable 真实链已完成并清理 fixture：atomic recovery override 用同一 idempotency key 重放后仍只有一个 `succeeded` command；durable incident resolve 只有一个 `succeeded` command 和一个 `succeeded` attempt。该验收发现 inline durable command 在副作用改变 entity version 后先返回 409、无法重放；现已把 Incident resolve 与 Case close 的 exact replay 提前到 mutable preflight 之前，运行态重放返回原始 `requestId` / `commandId`，新增 integration test 防止回归。隔离 incident、commands、attempt、audits 与 outbox 已精确删除，残留均为 0。
- 浏览器 runtime 连接重试后仍返回空实例列表，因此 §11 Character operator journey 未执行；历史截图和旧 Playwright checkpoint 不冒充本轮证据。加上 customer 默认 profile 尚未完成 operator cutover，P7 Full closure 仍不能标记完成。

### Static and test gate

```bash
git diff --check
bun run lint
bun run typecheck
bun run test
bun run build
```

`bun run check` 可以替代 lint + typecheck + build，但完整测试仍单独执行。

### Runtime gate

```bash
pm2 jlist
curl -fsS http://127.0.0.1:3000/
curl -fsS http://127.0.0.1:3100/healthz
```

端口以当前 `pm2 jlist` 和 env 为准，不相信历史日志。

必须保存：

- Main/Chat/Gen/Admin 进程 owner 与 mode；
- 一次真实 generation 的 Request → Attempt → Gen → Manifest → Artifact → Ledger 链；
- 一次双向 Durable Exchange replay；
- 一次 Admin atomic mutation 与 durable command；
- 一次完整 Character operator journey；
- 对应数据库终态与零重复计费证明。

### Documentation closure

证据完成后再更新：

- `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`；
- `docs/product/REMAINING_WORK_EXECUTION_PLAN.md`；
- `docs/architecture/06-async-jobs-and-ai.md`；
- `docs/architecture/08-billing-and-entitlements.md`；
- `docs/architecture/14-chat-service-tech-design.md`；
- Character Asset Studio 运营文档。

不得在实现前把“Approved design”写成“Implemented”。

## 13. Rollback

- 每个阶段保持可单独 revert 的提交；
- 回滚代码版本，不恢复已删除的第二 authority；
- Gen 回滚必须成对回滚 dispatcher/terminal-record contract，pending work 保留；
- Ledger 回滚不得删除 ledger entry 或 settlement evidence；
- Admin 回滚保留已创建 Command/Audit/Outbox；
- transition 回滚不得逆向改写 terminal row；
- Durable Exchange 回滚 sender/receiver 兼容版本，pending Outbox 继续保留；
- Journey 回滚只影响投影/UI，不改任何 Visual/Creative/Release/Serving 权威。

如阶段需要 schema 变更，rollback 使用 forward-fix migration；不删除 append-only evidence。

## 14. Definition of done

以下断言必须全部为真：

- Main 内不存在图片/视频 provider execution；
- `DreamcoinLedger` 生产写入只有一个类型化入口；
- Admin 写 Route 不再拼装 admission/reliability 协议；
- 有限状态生产写入只经过 aggregate transition；
- Main ↔ Chat 不再用共享 Redis 交付业务事件；
- Character Portfolio 与 Workspace 使用同一 Journey；
- 无 `_v2`、`_new`、deprecated fallback 或注释掉的旧实现；
- focused、full test、build、PM2、HTTP、DB 与 browser 证据齐全；
- 工作区没有本计划产生的调试文件或未归属临时产物。
