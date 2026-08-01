# ADR-13：全项目深模块权威边界

更新日期：2026-07-31

状态：Accepted / Implemented in source；live authority chains verified；browser operator journey and customer default-profile cutover pending

实施计划：[Deep Module Authority Execution Plan](../product/DEEP_MODULE_AUTHORITY_EXECUTION_PLAN.md)

深化自：[ADR-11](./15-admin-operating-system-authority-adr.md)、[ADR-12](./16-character-asset-studio-authority.md)

## 1. Context

项目已经建立 Generation Request/Attempt、Dreamcoin Ledger、Admin Command、状态矩阵、跨服务 Outbox/Inbox、Character Release/Serving 等正确的领域名词和持久化事实。

当前主要问题不是缺少更多实体，而是关键 Interface 仍然偏浅：

- `main` 与 `gen` 都存在图片/视频执行路径，部署开关会改变“谁真正调用 provider”；
- `DreamcoinLedger` 有公共 helper，但仍有重复 helper 和直接写表调用；
- Admin API manifest、mutation transport、Route admission 和 mutation 执行分别维护；
- 状态矩阵只回答“能不能转”，实际锁、版本更新、时间戳、事件和审计仍由调用方拼装；
- Main → Chat 同时支持 HTTP durable ingest 与共享 Redis 队列直投，两条路径的成功语义不同；
- Character Portfolio 与 Character Workspace 分别推导运营下一步，存在漂移空间。

这些重复代码本身不是核心问题。核心问题是：业务调用方必须理解可靠性协议的多个细节，才能正确完成一次写入。

本 ADR 在不增加第二套领域 authority 的前提下，把这些复杂度收进六个深 Module。

## 2. Decision

### 2.1 Gen 是图片/视频唯一执行权威

`packages/gen` worker 是图片和视频 provider invocation 的唯一执行者。

边界如下：

```text
Main
  accept Request
  reserve/settle Dreamcoin
  create Attempt + dispatch intent
  ingest immutable completion manifest
  finalize Artifact/Delivery
        │
        ▼
Gen
  claim transport work
  invoke image/video provider
  persist completion manifest
  redeliver manifest until Main durable ACK
```

不变量：

- `main` 不加载图片/视频 provider adapter，不直接调用 ComfyUI、sd.cpp、Draw Things 或视频 runtime；
- `main` 不保留 internal worker/serverless provider execution 回退；
- BullMQ completed 不是生成成功 authority；
- Gen 在真实调用前必须持有可审计的 Attempt/Transport identity；
- Gen 先持久化 immutable completion manifest，再请求 Main durable ACK；
- Main 只做 dispatch、manifest ingest、settlement 和 finalization；
- provider outcome 不明确且 provider 不支持确定性幂等时，不自动重放 provider invocation。

未来若部署到 serverless，不恢复 Main 内执行路径；单独部署 Gen adapter。

### 2.2 Dreamcoin Ledger 只有一个类型化写入口

业务调用方不得自由组合 `(delta, reason: string)`，也不得直接写 `DreamcoinLedger`。

公开写 Interface 为单一类型化入口：

```ts
postDreamcoinEntry(tx, intent)
```

`LedgerIntent` 是按当前业务原因区分的 discriminated union，至少覆盖：

- `signup_bonus`
- `subscription_grant`
- `generation_spend`
- `refund`
- `redeem`
- `referral`
- `admin_adjust`

Ledger Module 统一负责：

- 校验 reason 与金额符号；
- 校验每类 intent 必需的 `sourceId`、`idempotencyKey` 和关联标识；
- 锁定用户账本并计算 `balanceAfter`；
- 创建 append-only entry；
- 仅在生成消费/退款场景建立 `GenerationSettlementLink`；
- 对相同幂等键返回同一结果，对 payload 冲突 fail closed。

`admin_adjust` 可以是正数或负数，但必须保留 actor、reason 和稳定幂等身份。其他 intent 的符号由类型和运行时校验共同约束。

余额查询可以保留独立只读投影；报表可以直接聚合账本。唯一性只约束写 authority，不强迫所有读路径经过一个服务函数。

### 2.3 Admin manifest 是写请求运行时权威

`ADMIN_V2_API_OPERATIONS` 不再只是静态审计清单。每个 Admin 写 operation 的以下协议只定义一次：

- permission 与 resource scope；
- request parser / response contract；
- `Idempotency-Key` / `If-Match` 要求；
- command type 与 target identity；
- execution mode：同步原子 mutation 或异步 durable command。

Next Route Handler 继续存在，不建立中央动态路由器。Route 只负责：

- 提取路径参数；
- 选择 operation id；
- 提供领域 target 与 mutation/command callback。

统一执行入口负责：

```text
authenticate
  → authorize from manifest
  → parse request and required headers
  → bind canonical request hash
  → enforce idempotency / expected version
  → execute atomic mutation or accept durable command
  → return contract response
```

同步原子 mutation 与异步 durable command 是同一个 Module 的两种执行模式，不能被错误合并成“所有操作都异步”。

领域 mutation 继续拥有自己的业务不变量；通用执行入口不解释 Character、Incident、Billing 等领域规则。

### 2.4 每个聚合拥有唯一 transition Interface

共享层保留状态集合、允许边和小型纯函数，不建立万能工作流引擎。

每个有限状态聚合提供自己的 transition Interface，例如：

- `transitionGenerationRequest`
- `transitionCharacterRelease`
- `transitionCharacterServing`
- `transitionCreativeRun`
- `transitionIncident`
- `transitionCase`
- `transitionExperiment`
- `transitionControlPlaneCommand`

每个 transition 在调用方提供的同一事务内完成：

1. 读取并锁定当前 row/version；
2. 校验当前状态、目标状态和领域前置条件；
3. 以 compare-and-swap 更新状态、version 和领域时间戳；
4. 写入该聚合要求的事件、审计或关联证据；
5. 返回新的权威快照。

禁止业务代码继续使用以下两段式模式：

```text
isTransitionAllowed(current, next)
  → caller performs arbitrary Prisma update
```

只读投影、测试矩阵和 UI 展示可以调用纯状态矩阵；生产状态写入必须调用聚合 transition。

### 2.5 Main ↔ Chat 统一使用 Durable Exchange

双向跨服务业务事件只有一种成功语义：

```text
Sender domain TX
  → Sender Outbox
  → HTTP durable ingest
  → Receiver Inbox + payload hash committed
  → durable ACK
  → Sender marks Outbox delivered
  → Receiver-local queue wakes consumer
```

不变量：

- ACK 只表示 receiver 已持久化 Inbox receipt，不表示副作用已经消费完成；
- receiver 用 `(sourceService, sourceEventId)` 去重；
- 相同 identity、相同 canonical hash 是 replay；
- 相同 identity、不同 hash 进入 quarantine，不能 ACK 为成功；
- Outbox delivery 是 at-least-once，Inbox apply 必须幂等；
- BullMQ 只负责服务内部消费唤醒，不承担跨服务交付 authority；
- BFF 继续承载同步 Chat HTTP/SSE，不与 Durable Exchange 混合。

删除：

- Main → Chat 的 `MAIN_TO_CHAT_QUEUE` 跨服务直投；
- `CHAT_DURABLE_INGEST_URL` 可选切换；
- 任何以“成功 enqueue 到共享 Redis”等价于“Chat 已持久接收”的路径。

Chat → Main 使用同一 envelope、receipt、hash、ACK 和重试语义。

### 2.6 Character Production Journey 是服务端投影

`CharacterProductionJourney` 是基于现有权威事实实时计算的运营投影，不新增 Journey 状态表。

输入事实包括：

- active `CharacterVisualProfile`；
- sealed active `ReferenceSetRevision`；
- active non-stale `GenerationRouteQualification`；
- Character Creative Run、Review Decision 与 draft asset pack；
- QA、candidate Release 与 `CharacterServing`；
- live monitor / performance facts。

统一输出至少包含：

```ts
type CharacterProductionJourney = {
  stage: string;
  status: string;
  steps: readonly JourneyStep[];
  blockers: readonly JourneyBlocker[];
  primaryAction: JourneyAction;
  assetPack: {
    adopted: number;
    total: 3;
    missingPurposes: readonly CharacterAssetPurpose[];
  };
  live: CharacterLiveSummary;
};
```

不变量：

- 同一 Character 同一权威快照只有一个 primary action；
- primary action 必须可执行，不能只链接到说明页；
- Portfolio 与 Workspace 使用同一服务端投影；
- UI 不再重算生产阶段、资产包完成度或下一步；
- 成功动作后重新读取投影，并自动进入新的下一步；
- 自动前进只改变导航和可见任务，不自动采用候选、不自动激活 Voice、不自动发布 Release；
- Journey 不拥有 Visual、Creative、Release、Serving 或 Performance 状态。

## 3. Authority map

| 事实 | 唯一写 authority | 调用方只需要表达 |
| --- | --- | --- |
| 图片/视频 provider execution | Gen execution Module | Attempt identity 与 pinned recipe |
| Dreamcoin entry | Ledger Module | 类型化业务 intent |
| Admin mutation admission | Admin Write Execution Module | operation id、target、领域 callback |
| 聚合状态变更 | 对应 aggregate transition | 目标状态与领域原因 |
| Main ↔ Chat event delivery | Durable Exchange Module | 类型化 event envelope |
| Character 运营下一步 | Character Journey projector | Character identity / snapshot |

## 4. Rejected alternatives

### 4.1 保留 Main provider execution 作为应急回退

拒绝。它让同一 Attempt 在不同部署配置下拥有不同执行 owner，并迫使 Main 继续理解 provider runtime。

### 4.2 暴露通用 signed delta Ledger API

拒绝。它允许 reason、符号、source 和 settlement link 出现无效组合。

### 4.3 为每种账本原因建立独立公开方法

拒绝。方法数量增长但可靠性协议仍然重复；一个类型化 intent 已足够表达当前七类业务。

### 4.4 用中央动态 router 取代 Next Route Handler

拒绝。它破坏现有 App Router 文件结构，也没有增加领域封装深度。

### 4.5 建立一个跨所有领域的通用状态机

拒绝。各聚合的锁、版本、时间戳、事件和副作用不同，通用引擎会把领域规则变成 callback 配置。

### 4.6 保留共享 Redis 跨服务直投

拒绝。成功 enqueue 不能证明 receiver 已持久化，且形成第二套 ACK 语义。

### 4.7 新增 Character Journey 状态表

拒绝。Journey 是多个 authority 的组合视图，持久化会产生第二套流程状态和修复任务。

## 5. Consequences

正向结果：

- 每个高风险事实只有一个写入口；
- 业务调用方不再拼装锁、幂等、ACK 或 transition 细节；
- 部署配置不再改变业务 authority；
- Portfolio 与 Workspace 对运营下一步给出一致答案；
- 可以用架构边界测试禁止旧路径重新出现。

代价：

- 迁移期间必须逐调用点收口，不能一次性替换后靠兼容 fallback 兜底；
- Admin manifest 需要可执行 parser/transport metadata；
- 跨服务 sender/receiver 必须按兼容部署顺序切换；
- 聚合 transition 需要覆盖现有直接状态写入；
- Journey 投影查询需要控制批量加载，避免 Portfolio N+1。

## 6. Migration and rollback

实施采用 tracer-bullet + in-place replacement：

1. 先增加目标 Module 与行为测试；
2. 迁移一条真实路径，验证新 Interface；
3. 按领域迁移剩余调用点；
4. 加边界测试禁止旧写法；
5. 删除重复 helper、旧 env、回退执行路径和前端推导；
6. 运行 focused test、仓库 check、HTTP/PM2/DB/browser 闭环。

跨服务切换按 receiver-first：

1. 部署并验证 receiver durable ingest；
2. 切 sender 到 HTTP ACK；
3. 等待旧队列归零；
4. 删除跨服务 Redis producer/consumer 与 env；
5. 回滚时回滚 sender/receiver 版本组合，保留 pending Outbox，不恢复第二交付路径。

本 ADR 不要求新增数据库表。若实施发现必须修改 schema，只提交 Prisma migration / SQL 脚本，由用户执行；agent 不直接连接数据库改表。

## 7. Verification

每个阶段至少提供：

- 行为测试：新 Interface 的成功、重放、冲突和失败语义；
- 边界测试：禁止旧 import、直接写表、直接状态 update 或跨服务 queue；
- focused integration tests；
- `bun run check`；
- PM2 开发拓扑进程 owner 检查；
- 真实 HTTP 请求与持久化终态检查；
- Character Journey 阶段的真实浏览器 operator journey。

完整命令和阶段 Gate 见实施计划。
