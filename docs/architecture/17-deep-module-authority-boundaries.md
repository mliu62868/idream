# ADR-13：全项目深模块权威边界

更新日期：2026-08-01

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
  atomically create Attempt + dispatch Outbox
  consume terminal relay and ingest immutable terminal record
  finalize Artifact/Delivery
        │
        ▼
Gen
  claim transport work
  GenerationExecution invokes image/video adapter
  persist terminal record
  enqueue record into Main-owned durable relay
```

不变量：

- `main` 不加载图片/视频 provider adapter，不直接调用 ComfyUI、sd.cpp、Draw Things 或视频 runtime；
- `main` 不保留 internal worker/serverless provider execution 回退；
- BullMQ completed 不是生成成功 authority；
- Gen 在真实调用前必须持有可审计的 Attempt/Transport identity；
- Main 的 Attempt 与 dispatch Outbox 必须在同一事务提交，不能先建 Attempt 再直接 enqueue；
- Gen 先持久化 immutable terminal record，再按 immutable Attempt key 投递 Main-owned durable relay；record 覆盖 succeeded / failed / blocked / unknown；
- Main 短时不可用只重试 relay row；relay admission 中断时 Gen 只重投已持久化 record，不重放 provider invocation；
- output storage authority 属于 immutable Attempt，而不是 Request：前缀固定为 `gen/{requestId}/attempts/{attemptId}/`，terminal ingest 同时校验 dispatch 前缀和所有 artifact key；
- Main 只做 dispatch、terminal-record ingest、settlement 和 finalization；
- provider outcome 不明确且 provider 不支持确定性幂等时，不自动重放 provider invocation。
- 图片与视频共用 `GenerationExecution` 的 resume → transport → invoke → retry decision → terminal persist + relay admission 生命周期；modality adapter 只负责调用与产物归一化。

未来若部署到 serverless，不恢复 Main 内执行路径；单独部署 Gen adapter。

#### 2.1.1 unknown 是独立终态，不是 failed 的一个可选字段

`unknown`（provider 结果不明确，可能已扣费已产出）与 `failed`（确定失败）的处置相反：前者不退款、不重试、进运营裁决，后者退款且可重试。

该区别一度被编码成 finalize payload 里 `generation.failed` variant 上的一个**可选**字段 `error.attemptOutcome`，解码端缺省落到 `"failed"` —— 漏传即对一次可能已扣费已产出的生成执行退款并重试。

现在 `generation.unknown` 是 finalize 判别联合的独立 variant：

- 编码端按 terminal record 的 outcome 直接发对应 variant；
- 解码端按 variant 分派，`finalizeGenerationUnknown` 的签名只接受 unknown；
- 分支缺失是**编译错误**（switch + `never` 兜底），不是静默 no-op；
- 退款入口的参数类型收窄为 `"failed" | "blocked"`，"退款路径带模糊终态"不可表达；
- 旧形状在解析边界单点归一化（迁移窗口，旧 payload 排空后删除），业务分支里没有兼容代码。

Outbox payload 与 Bull payload 的 `canonicalSha256` 比对必须用**原始 wire 字节**，不能用 zod 解析后的对象 —— 否则 schema 每少留一个字段都会让在途任务判定终态不匹配。

#### 2.1.2 跨进程 wire 标识符只有一个构造入口

provider 幂等键、dispatch requestId、terminal record 存储路径、finalize dedupe key、BullMQ jobId 推导，全部由 `packages/shared/src/contracts/generation-identity.ts` 构造，main 与 gen 两侧只 import。

理由：这些字面量此前在两个包里各存 3–6 份拷贝，其中 `bullMqJobIdForDedupeKey` 是两份逐字节相同的独立实现。任一侧改动编译期与 CI 都不报错，只有生产表现为 100% terminal record 被 quarantine，或（更糟）同一 Attempt 被 provider 调用两次。

改这些格式属于**跨服务迁移**，不是重构。

#### 2.1.3 `payload.provider` 是记账字段

实际后端由 workflow 描述符的 `backendKind` 决定，与 `payload.provider` 无关。后端身份的真 pin 是 `workflowKey@workflowVersion`，图片与视频**同强度强制**（图片侧曾有「两者都缺则跳过校验」的逃生口，已删）。

`GenerationModelProfile.runner` 的默认值 `sd_cpp` 指向一个 gen 里已不存在的 runner，保留是因为线上可能有沿用默认值的 profile；gen 把它映射到 backend 适配器后照常执行。要收敛需单独的 DB 迁移。

#### 2.1.4 dispatch envelope authority 与 refund cause

「这份证据是否属于那个不可变 Attempt」曾有三份实现，检查项互不相同（运行时 ingest 查 transportAttemptNo、离线闸门不查、Blob 恢复路径不查 workflow），且没有任何测试断言三者等价。现在只有 `checkExactGenerationDispatchAuthority` 一个纯函数，输入 `{job, attempt, dispatch, evidence?}`，输出 `ok | 结构化 code`；transport 事件、Blob 终态记录、relay row 先归一成同一种 **evidence identity** 再判定。

合并时取的是检查项**并集**——它当场暴露了一个手搓 fixture 缺 9 个必填字段。这是并集该有的效果，不是回归。

`generation-dispatch-cutover` 只减少约 76 行而非预估的 250–350：`assess` 与 `classifyDrainFailedRows` 的 failed-row 分类**语义确实不同且不能统一**（drain 路径不加载 terminal outbox，其 aiFinalize 分支无法检查 exact）。这反证了原判断——跨存储集合关系（Bull row vs Outbox row）是类型和运行时结构保证不了的部分，值得留在离线闸门里。

退款只有 `refundGenerationRequest(tx, {requestId, userId, cause, requested?})` 一个入口。`cause` 是业务意图的判别联合，决定 ledger 幂等身份；运营手动退款与自动失败退款不再共用 `generation:{id}:refund`（共用时，运营点了退款、系统显示成功、钱其实是之前那笔，无法从结果区分）。

**settlement clamp 是不同 cause 能安全共存的原因**：同一事务内 `refundable = max(0, captured − refunded)` 是退款金额的唯一上界。因此拆分幂等键不需要额外护栏——自动退过之后运营再点，走新键但 `refundable` 已为 0。

但这句话此前只在**串行**下成立。clamp 是一次「先读后发」，而 ledger 自己的锁是**按用户**的：它串行化两笔写，不串行化决定这两笔写的两次读。两个 cause 各自读到 `refunded = 0`，就各自全额发一次——幂等键不同，`postDreamcoinEntry` 也不会拦。六个退款调用点里五个碰巧先拿了 `generation_jobs` 行锁，唯独完成路径的缺量部分退款没拿；而事件退款（`incident_action`）压根不改 Request，因此也不会让部分退款那笔的版本 CAS 失败。40 币的扣费实测退回 80。

现在这把行锁收进 `ensureGenerationSettlementLinks` 本身——产出 `refundable` 的那次读**不可能**不持锁，clamp 因此是判断而不是猜测。锁序固定为 `generation_jobs → users`（该读永远先于 `postDreamcoinEntry`）。这是 §3.3 第 2 条的写法：与其加一条「调用方必须先上锁」的检查，不如让「不上锁地读 clamp」不可表达。

顺带修掉一个白发币口子：缺量部分退款此前完全不查 settlement，只凭 `costDreamcoins > 0` 就发币，而它是**记账值**——未真正扣费的 Request 会凭空得币。

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

#### 2.3.1 body 解析只有一次，且由 manifest 键控

此前 `jsonBody(request)` 内部已按 manifest 查找并解析，但约 40 个 route handler 又手工 import 一个 request schema 再 parse 一遍。那行手工 import 是**第三处**契约引用：manifest 的字符串 ref 是第一处、registry 的可执行 schema 是第二处，而没有任何测试对账第三处。import 错同域相似的 schema，运行时会先按 manifest 收窄、再按 handler 收窄，**大概率静默通过**。

现在 `jsonBody(request, ref)` 返回 `z.infer`，route 文件里 request schema 的 import 数为 0。运行时补一条：声明的 ref 与 method+path 解析出的 manifest 条目不符即失败关闭，且该断言必须排在 per-Request 解析缓存**之前**——否则两次声明不同契约的调用会共用同一次 parse 结果。

守卫的禁用名单**从 manifest 推导**而非硬编码符号名（非 GET 操作的 request ref 去掉 transport 后缀即为 body 契约集合），并断言扫到的 route 文件数等于 manifest 去重路由数。

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
- **deepLink 是完整答案，包含页内锚点**：服务端一度只为路线类 blocker 下发 fragment，其余交给 admin 自建 `code → 锚点` 表补齐；两边各漏一半，`visual_identity_missing` 与 `visual_anchor_missing` 两类阻塞点进去只能落到页首。锚点表现在与 blocker code 联合类型绑定（漏一个 code 是编译错误），admin 侧原样透传；
- **链接的 base 也是答案的一部分，不能靠字符串手术拼**：只补 fragment 仍然不够。`readiness.ts` 这个纯闸门模块自己手拼 admin URL，用的却是一套 admin 不存在的 tab 词表（`?tab=visual-identity` / `?tab=persona` / `?tab=overview` 全部静默回落到缺省 tab），路线类更是指向 `/admin/ops/profiles` 这个完全不同的页面；workspace 投影再用 `String.replace` 修其中一个 tab、给另一个页面的 URL 拼上只有角色运营台才有的锚点——于是「路线未合格」的 deepLink 是 `/admin/ops/profiles?characterId=…#route-qualification-workbench`，URL 合法、页面能开、点了什么也不会发生。现在 base + tab + 锚点整体由 `characters/character-deep-link` 一份表拥有，`readiness.ts` 不再产出链接（它只回答哪些闸没过）；
- **守卫必须是形状断言，不是符号黑名单**：ADR 首版的 Journey 守卫断言两个旧符号名不出现、且只扫一个文件，于是换个名字住到另一个文件的重算逻辑完全不可见。现在守卫扫 characters 目录全部前端文件、断言三类**形状**（自己数图池槽位、自己推用途顺序、自造 fragment 顶掉服务端 deepLink），并正向断言关键字段确实被消费；另有跨包守卫校验服务端每个锚点都对应 admin 里真实存在的 DOM id。新增守卫时应先注入一次真实漂移确认它会失败。
- 成功动作后重新读取投影，并自动进入新的下一步；
- 自动前进只改变导航和可见任务，不自动采用候选、不自动激活 Voice、不自动发布 Release；
- Journey 不拥有 Visual、Creative、Release、Serving 或 Performance 状态。

## 3. Authority map

| 事实 | 唯一写 authority | 调用方只需要表达 |
| --- | --- | --- |
| 图片/视频 provider execution | Gen execution Module | Attempt identity 与 pinned recipe |
| Dreamcoin entry | Ledger Module | 类型化业务 intent |
| Admin mutation admission | Admin Write Execution Module | operation id、target、领域 callback |
| Creative Run 创建 | `admin-v2/creative/run-create` | manifest 声明的 run brief + actor |
| Creative Run item 评审结论 | `admin-v2/creative/review-decision` | 决定 + 质量清单 + 期望版本 |
| Creative 投放位状态与验证 | `admin-v2/creative/placement` | 投放位标识 + 期望版本 |
| 素材可否面向客户发布 | `admin-v2/creative/customer-publishable-asset` | 素材 + 可选 pinned provider 快照 |
| Today 工作项紧急度（SQL 与 TS 两侧） | `admin-v2/today/work-severity` | 来源类型 |
| AdminCase priority→severity | `admin-v2/cases/case-severity` | priority |
| 聚合状态变更 | 对应 aggregate transition | 目标状态与领域原因 |
| Main ↔ Chat event delivery | Durable Exchange Module | 类型化 event envelope |
| Character 运营下一步 | Character Journey projector | Character identity / snapshot |
| Character 运营台 deepLink（base/tab/锚点） | `characters/character-deep-link` | characterId + tab 或锚点名 |
| release placement slot → 生产用途 | `characters/character-release-contract` | slotKey |
| Character Release 命令分派 | `RELEASE_COMMAND_HANDLERS` | commandType |
| 生成终态处置（failed / unknown / blocked） | finalize 判别联合 | terminal record 的 outcome |
| 产物迟到归档处置 | `lateArtifactDisposition` | Request 态与 Attempt 态（Attempt 优先） |
| 跨进程 wire 标识符 | `shared/contracts/generation-identity` | attemptId |
| 跨端枚举取值集合 | `@idream/shared/catalog` | 引用常量，不重打字面量 |
| dispatch 证据归属判定 | `checkExactGenerationDispatchAuthority` | job / attempt / dispatch / evidence |
| 退款金额与幂等身份 | `refundGenerationRequest` | 类型化 refund cause |
| 跨服务 env 默认值 | `shared/contracts/env` | 变量名（判据：两进程取值不同就会坏） |
| chat 轮次写入协议 | `withTurnAuthority` | userId / sessionId + 回调 |
| 生成报价与提交校验 | `ourdream/generation-quote` | 六字段令牌（含双指纹） |
| 订阅激活与权益派生 | `ourdream/subscription-lifecycle` | 计划 + provider 发票 + checkout purchase-order |
| Feed 分页连续性 | `ourdream/discovery` 的签名游标 | limit（快照与排除集由游标自带） |
| 公开面 Character / MediaCollection 的 wire 形状 | `ourdream/public-read-model` | 一行已读出的 row（`*Include` 与 `*DTO` 同源） |
| 谁算客户互动 actor | `ourdream/public-content-audience` | userId（与 `activeCustomerUserWhere` 同一份判断） |
| Admin 写请求 body 解析 | `jsonBody(request, ref)` | manifest contract ref |
| 上线门禁证据形状 | `server/readiness/evidence` | probe 名（生产端必填 / 消费端全可选） |
| probe 报告的 env 变量与解码器 | `server/readiness/probe-report` | probe 名（生产端写、门禁读同一个 key） |
| 前端一次生成请求 | `lib/generation-request` | submit / retry / applyServerJob / refreshQuote |
| 两侧前端取数编排 | `useViewerResource` / `useAuthorityResource` | path + parser（+ 轮询策略） |

## 3.1 守卫的形状决定它能抓住什么

本轮多次实证：**文本/符号黑名单式守卫只能抓住你已经修过一次的漂移**。ADR 首版的 Journey 守卫拉黑两个旧符号名、只扫一个文件，于是换了名字住到另一个文件的重算逻辑完全不可见。

新增或修改守卫时遵循：

1. **断言形状或集合相等，不断言具体符号名**。可用的形状：某类写法在整个目录里不得出现；某组值必须**恰好等于**白名单（dreamcoin 写入者集合、路由↔manifest 集合）；某个实现必须只有一份（源码扫描）。
2. **守卫必须自检**。扫描一个目录的守卫要断言「文件清单确实包含关键文件且数量下限成立」，否则目录改名后它会静默扫描空集合然后全绿。
3. **新守卫必须先注入一次真实漂移，确认它会失败**。本轮三次都靠这一步发现问题：跨包锚点守卫的正则把漂移值截成合法前缀反而放行；shared 准入守卫跟随符号链接 ELOOP、又把构建产物里搬家前的旧 import 当成违规；i18n 互斥断言若走 import 而非 AST，要抓的重复会先被合并掉。
4. **遍历仓库的守卫只扫源码**：不跟随符号链接（Prisma 生成物里有自指链接），跳过所有点开头目录与生成物目录（构建快照里留着搬家前的旧 import）。
5. **债务清单必须会缩短**：单消费者豁免要写明「阻止它搬家的约束」，并有断言检查台账本身是否陈旧（条目升到 2 个消费者 / 掉到 0 / 消费方对不上都失败）。
6. **对账一个字段抓不住整条答案**：跨包锚点守卫只证明「这个 fragment 在 admin 里存在」，证明不了它挂在哪个页面、哪个 tab 上——`/admin/ops/profiles?…#route-qualification-workbench` 完美通过。凡是「服务端拼一条给人点的字符串」，守卫要覆盖它的**全部组成部分**：tab 词表与 admin 断言集合相等、锚点断言存在于 admin DOM、并断言整个目录里只有一个构造入口（`` `/admin/characters/ `` 这种写法在 characters 目录里只允许出现在 builder 里）。

再补一条同形实证：`GenerationAttempt` 写入守卫此前只拉黑 `create` / `upsert`，因此漏掉了真正决定钱的那次写——`generationAttempt.update({ data: { status } })`。Attempt 的 status 列没有任何数据库约束兜底（「每个 Attempt 只有一条终态事件」的唯一索引约束的是事件表，不是 Attempt 行）。现在守的是「整个 `src` 里写 Attempt 行的文件集合**恰好等于**三条白名单」，并自检扫到的文件数下限与三个关键文件确实在列。已知残留：白名单内某个模块自己新写 status 抓不到，这一条仍靠评审。

### 3.2 重复的形状不等于重复的判断

`release manifest → 用途→assetId` 这个投影在 characters 目录里有三份实现，看上去是典型的复制品。实际只有两份该合：workspace 预览投影与 renderer preview token 校验逐字相同，且都必须在歧义时 fail-closed（renderer 要按 token 里的 assetPack 验签发内容）。第三份在 `production-journey` 里**故意更宽**：它只统计运营完成度，对 legacy manifest 里重复登记同一张图的历史数据从宽，`portfolio.integration` 的 legacy fixture 直接钉着这个差别。

合并前先问「两边在歧义时该不该给同一个答案」。这里该共用的只有 slot→purpose 那张表，不是整个投影。

再补一条实证（`ourdream → admin` 依赖方向守卫）：**注释不是边界**。前台公开只读投影 `listActiveTemplates` 曾住在 `modules/admin/characters/templates.ts`，靠文件头一行「公开只读，不要求 admin 权限」声明它其实不属于那里。名字、位置、import 全都编译得过，符号黑名单抓不到。现在守的是「`modules/ourdream/**` 里出现的 `modules/admin/**` import 集合**恰好等于**白名单」，白名单只有 v1→admin 的 dispatch 接缝一条；多一条是新的错误方向，少一条说明白名单陈旧。按第 1 条：能抓住这类漂移的只有集合相等，不是任何形式的命名约定。

### 3.3 一个判断跨 SQL 与 TS 两侧时，收成同一个字面量

`today/query.ts` 里每个工作来源的紧急度规则写三遍：SQL 排序用的 `severity_rank`、按紧急度
选行的 WHERE 谓词、以及 `projectRow` 里的 TS 三段式。**选行走 SQL、投影走 TS，这不是巧合而是
必然** —— 分页要在库里排序取前 N，展示要在进程里算字段。于是同一条规则必须有两种表达。

两种表达无法归一成一份代码，但可以归一成同一个字面量：

- 每条规则的 SQL 表达与 TS 表达写在相邻几行（`today/work-severity.ts`）；
- 「按紧急度选行」一律由 rank 相等推导（`AND (<rank 表达式>) = <rank>`），不再手抄第三份谓词。
  `character_release` 那份手抄谓词有四个分支，是最容易漂的一处；
- 对账不靠形状守卫，靠一条**行为断言**：每个紧急度「宣称的条数 == 真能翻出来的条数」，且四档
  之和等于不筛时的总数。两侧任一处改动而另一处不改，这条断言当场变红（已分别注入 TS 侧漂移与
  SQL 侧漂移验证）。

这条对账之所以值钱，是因为不一致的表现是**两个互相矛盾的答案同时返回**：`totalCount` 来自各
来源的 SQL count，`items` 来自 TS 过滤之后的结果 —— 页面显示「共 N 条」却一条也翻不出来。

顺带实证了 §3.1 第 2 条：`mediaAssetPlacement` 写者守卫若用仓库里现成的 AST 检测器
（`mutationWritesField`）会得到假绿 —— 那个检测器要能解析出 Prisma client 的来源，而 legacy
`admin/content/placements.ts` 的事务是 `auditedTransaction("...", async (tx) => …)` 这种自定义
包装，`tx` 解析不出来，**整个文件对它隐形**。守卫改用文本扫描后才看得见两个写者。

### 3.4 先问检查器守的不变量能不能变成不可表示

离线检查器只在「不变量无法被类型或 schema 表达」时才有价值。新增或审查一个检查器时先按这个顺序问：

1. **它守什么？** 用一句话写出来。写不出来的，先补清楚再谈保留。
2. **写入侧能不能让它不可表示？** 已实证有效的三种手法：
   - 「两处字面量必须一致」→ 收成一张按名索引的表，两侧都只能引用同一个条目
     （probe 报告的 env 变量此前生产端 1 处、消费端 5 处各存一份；`readiness/probe-report`
     收口后「probe 写 A、门禁读 B」不可表达）；
   - 「这个 map 必须覆盖所有 code」→ `Record<Name, T>` + 由它映射出调用方的入参类型
     （`LaunchReadinessProbeOptions` 从 `PROBE_REPORTS` 映射，漏接一个 probe 是编译错误）；
   - 「状态 A 之后不能出现字段 B」→ CHECK 约束 / 唯一索引，而不是事后 GROUP BY 数重复行。
3. **已经不可表示的检查要删，但删之前先确认那条结构保证真的在**。
   `duplicate_canonical_source_effect` 与 `chat_replay_duplicate_fact` 曾按已有唯一索引覆盖的
   列 `GROUP BY … HAVING count(*) > 1` —— 索引在，它们**永远返回零行**，报告里那两个 passed
   是恒真的。真正会漂移的是索引本身被删被改名，所以换成一条集合相等检查
   （`projection_dedupe_constraint_missing`：期望的唯一约束集合必须恰好存在于 `pg_index`）。
   **行数几乎没变，但它从「查一个不可能的状态」变成了「查那个不可能性还成立吗」。**
4. **删不掉但需要 DB 约束的，只出 SQL，不自己执行**，并且约束落地前不要先删检查
   （见 `packages/main/prisma/manual/2026-08-03-invariant-collapse-check-constraints.sql`：admin_cases 的
   activeKey 身份约束一旦生效，三条 Case 检查同时不可表示）。
5. **不是所有检查器都能收**。跨存储集合关系（Redis Bull row ↔ PostgreSQL Outbox row）、
   真实进程崩溃恢复（`readiness/dependency-chaos-process`）没有类型或 schema 表达形式，
   属于离线闸门该留的部分。`generation-dispatch-cutover` 就是这一类：payload 层面的 cutover
   早已完成（`shared/contracts/payloads` 里 `attemptId/attemptNo` 全部必填，旧形状不可构造），
   但那 1000 行不是过渡脚手架 —— 它是 `scripts/start-pm2-ecosystem.cjs` 每次生产 start /
   restart / reload 都会跑的静默期验证，删了等于放弃零丢失重启。

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

Generation worker 切换另有 fail-closed 门禁：在部署要求 `attemptId / attemptNo` 的 Gen
版本前运行 `bun run --cwd packages/main check:generation-cutover`。所有活动 Request 必须已有
最新 Attempt 与精确 immutable dispatch Outbox；Redis 中 image/video/terminal-ingest/finalize 四类 in-flight
Bull row 还必须绑定同一最新 Attempt、pins、attempt 级 dedupe 与对应 Outbox；所有
`pending / dispatched` terminal Outbox 也独立验证，不依赖它是否已有 Bull row。检查只读，不做
删除或重派。
活动 Request 的最新 queued/running Attempt 若已绑定 `terminalRecordRef`，还必须存在精确 terminal
Outbox 与非终态 exact finalize Bull row；delivered Outbox 对应的 Bull row 缺失、failed 或 completed
都是 stranded finalization。合法 `unknown` Attempt 则以 delivered exact Outbox、Attempt unknown
terminal event 与 `provider_outcome_unknown` Request event 证明 finalization 已完成，并允许 Bull row
completed 或已移除；Request 保持 active 以等待运营对账。

生产 PM2 start/restart/reload wrapper 先在 Main/Gen/finalizer 在线时全局 pause image、video、
terminal-ingest、finalize queue，等待 active handler 完成；Gen 可把新 terminal record 投进暂停的
durable relay，Main 可把已摄入 record 的 terminal Outbox 投进暂停的 finalize queue；再先停
admission/direct producer，后停 Gen worker，finalizer 最后。`pm2 jlist` 证明非 voice app 为
`stopped / errored / absent` 后才执行门禁和目标 PM2 action；全部成功后才 resume。任一阶段非零
都保持四条 queue paused，禁止通过 legacy payload fallback、读取可变 Job 字段、静默补造 Attempt 或
手工 resume 绕过门禁。

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
