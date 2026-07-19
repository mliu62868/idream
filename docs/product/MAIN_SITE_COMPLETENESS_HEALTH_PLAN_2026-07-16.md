<!-- /autoplan restore point: /Users/kk/.gstack/projects/mliu62868-idream/master-autoplan-restore-20260716-164559.md -->

# 主站完整性与健康闭环计划（2026-07-16）

状态：**code-owned controlled-beta Gate 已完成当前源码的数据库、静态、全量测试、fresh Playwright、immutable build、PM2、HTTP、本地浏览器与三层一致性备份/恢复阶段。** Main migrations `60/60`、Chat boundary 正向 + 15 负向、根 lint `2/2`、typecheck `6/6`、五包全量 `2,486 passed + 3 skipped tests` 与 fresh Playwright `164/164` 已通过；最终 Main/Admin releases、7 logical PM2 apps / 8 processes、HTTP、1440/834/375 响应式复验，以及 Main DB + Chat FS + local Blob 的静默备份/隔离恢复均已收口。公开生产环境继续为 `NOT_EVALUATED`，本文不宣称 public launch。

> 本文后续 Phase 1–3.5 与末尾 GSTACK verdict 是实施前的审查快照。当前执行事实与未完成 Gate 以本节和 `CURRENT_FUNCTIONAL_COVERAGE.md` 为准。

## 0. 2026-07-18 已验证执行记录

### 0.1 数据保护、迁移与主库终态

- 2026-07-17 的仓库内 ignored 数据库恢复副本及 SHA-256/一次性恢复演练只是事故后的 Main DB checkpoint，不是 reset 前原始数据备份。2026-07-18 的最终静默 checkpoint 已同时捕获 Main PostgreSQL、`CHAT_FS_ROOT` 与 local Blob，artifact base 为 `/Users/kk/code/idream/local-backups/idream-main-final-20260718-60/idream-main-final-20260718-60`；bundle 目录 mode `0700`、23 个文件均为 `0600`、总大小 171M，bundle SHA 校验全部通过。
- 60 个 Prisma migration 已完成空白库 fresh replay、现有快照 upgrade、重复 deploy、应用回滚/前滚演练，并在当前 Main 开发库完成 deploy；migration status 为 `60/60`，schema drift 结果为 `No difference`。
- 下列业务指纹在 deploy 前后完全一致，证明本次 additive migration 没有改写这些既有数据：

| 保护面 | before = after 指纹 |
| --- | --- |
| RoutePage 正文 | `169\|40013884913dcfebc68551487c65eabb` |
| RoutePage legacy columns | `169\|f8d09bc9a4a75b809fecee9bb9924df1` |
| ProductFeedback（排除本次新增 `source` / `updatedAt`） | `3\|569a7e78632ee0fe8c31655fdd4750c5` |
| Subscription | `0\|d41d8cd98f00b204e9800998ecf8427e` |
| Entitlement | `1\|58bcf35022a8d1fde65aacb6a9f45287` |
| Dreamcoin ledger | `2\|30628529ba89bc5ad3c4699a6a734b4d` |
| CharacterLike / MediaLike / Follow（各自） | `0\|d41d8cd98f00b204e9800998ecf8427e` |

- 最终 checkpoint 源端为 migrations `60`（latest `20260718012000`）、20 users；characters、Releases、live Servings、active PublicCatalogQualifications、MediaAssets 各 16；base tables `234`、views `7`、sequence `1`；16 项 authority assertion 全部成立，broken chain 为 0。Main outbox `3,936`（pending `0`、failed `0`）、inbound `5,738`（received `0`）；Chat sessions `294`、messages `818`、attachments `4`，outbox `1,552` / inbox `488`（均 pending `0`、failed `0`），file mutations `5`（pending `0`）；Redis operational queues pending/failed 均为 0。Release 的 `legacy=true` 是 editorial import discriminator，不表示仍由 legacy serving authority 对外服务。
- 16 个 official Character 均逐一具备 canonical image asset、published ready Release、live Serving 和 active qualification；没有用 synthetic fallback 或 repair 占位维持目录数量。
- 当前库 invariant ledger 返回 `qualityState=certified`、`decisionUse=allowed`、`totalViolations=0`、`unavailableChecks=0`、`failed=[]`。这是当前开发库的权威终态证明，不冒充外部生产环境认证。

### 0.2 已完成的代码正确性修复

- 真实数据：公开角色、合集、反馈和媒体读取改为服从 canonical provenance / publishability / Release / Serving / qualification；移除角色图片的 synthetic fallback。官方编辑 seed 是经 DB → Release → Serving → Qualification 治理的冷启动供给，不是测试 fixture 或自然用户活动；actor-scoped 个人数据为空时保持任务型空态，不混入官方供给或虚构计数。当前关键页面 Gate 后未发现确定性的 P0/P1 假数据路径。
- 错误与缓存：私有 API 响应统一为 `private, no-store`；CMS 明确区分 absent、invalid 与 unavailable，媒体存储或签名失败不再回退到可能失真的 URL；异步页面以当前 viewer/query/request scope 为准，失败和晚到响应不能冒充当前成功数据。
- Billing：CheckoutSession 在 provider 副作用前持久化 intent、offer snapshot 和 idempotency identity；前端可恢复 pending intent；provider invoice、webhook、activation 与 entitlement/ledger 在锁和 reconciliation lifecycle 下幂等处理，未知或无法对账的状态 fail closed。
- Generate：触达 DTO、viewer/query/request scope、stale response 和 retry/recovery 使用同一 authority；malformed/旧 scope 不再降级为空成功，source/profile/capability 缺失在建 Job 和预留币前 fail closed，可重试终态复用原设置但创建新的权威尝试。
- Admin v2：所有 protected operation 在 body parse 与 data access 之前完成 authentication；authority execution matrix 锁定未登录请求统一返回 401，避免以 malformed body 绕过认证顺序或形成 validation oracle。
- 并发写：Prisma 7 adapter 的 `P2034` 与 adapter-pg `TransactionWriteConflict` 被统一归类为 serializable write conflict；原子幂等 mutation 最多自动重试 3 次，耗尽后返回稳定 authority conflict。并发 reconciliation / atomic mutation 回归证明竞争请求只收敛到一个 tombstone 或 committed result。
- Chat：boundary SQL 已在目标库通过正向能力检查与 15 项负向拒绝检查；`chat_service` 请求角色只能写 durable file intent，显式 `chat_projector` 连接执行文件副作用并完成 receipt，DB trigger/grant 拒绝请求路径伪造完成或删除未完成 intent。
- CMS / SEO：169 条既有 RoutePage 被保留为未发布模板库存，不冒充公开正文；只有满足版本化 publish authority 的 CMS 才能公开，当前 published CMS 为 0。三个真正撰写的静态文章与专用产品页由精确正向 registry 授权，其余泛化 SEO/template 路径返回 404。publish/unpublish 会同时失效 path/tag 与 sitemap cache；公开读取、canonical、indexing status 和 sitemap distribution 使用同一已发布 authority。动态角色 metadata 已改为读取角色 SSoT，既定 `noindex` 规则继续保留。

### 0.3 最终自动化、浏览器与运行证据

- 最新统一全量测试为 Shared `36 files / 175 tests`、Admin `89 / 397`、Gen `14 / 117`、Main `219 passed files + 2 skipped files / 1,585 passed + 3 skipped tests`、Chat `27 / 212`；五包合计 `385 passed files + 2 skipped files / 2,486 passed tests + 3 skipped tests`。
- 根 lint `2/2`、typecheck `6/6` 与 scoped `git diff --check` 通过。根 production build `5/5` 通过；834px 修复后执行 Main-only final immutable build。最终 Main release 为 `idream-f7579f81-cc0e-419f-a259-9f6f78c962f9` / `build-TfctsWXpff2fKS`，Admin release 为 `idream-8838f3a3-c801-47cd-8df7-36c96cb88447` / 同一 build ID。
- fresh Playwright 以 `PW_RUN_ID=c3d4e5f6` 在隔离端口 3880–3883 完成 `164/164`，耗时 4.5m。该运行真实拉起 Main、Admin、Chat 与 worker，证明测试 DB、Redis namespace、Next distDir 和显式 Chat projector connection 都按 run 隔离；此前 focused `2/2` 与 `f17a2034` `9/9` 保留为 scoped historical evidence。
- PM2 最终为 7 logical apps / 8 processes online；`/`、`/explore`、`/admin/today` 为 200，Chat `/healthz` 为 `ok`。Main 关键页 1440px/375px 无 overflow/console error；834px 审查先捕获首页 `scrollWidth=1047`，TopControls breakpoint 修复经独立 E2E `1/1` 后，最终 runtime 为 `scrollWidth=834` 且 filters 均在 viewport 内。Admin Today/Characters/Creative/Incidents/Cases 为 `zh-CN`，375px/834px 无 overflow，console error 为 0。
- `redcraft_krea2_default` candidate ready；真实 workflow-native `BackendImageModel → ComfyUI 0.28.0` MPS smoke 为 832×1024、880,175 bytes、132,649ms 并通过。当前生产 worker 使用 `GEN_IMAGE_PROVIDER=backend` 和 ComfyUI 8188。
- `launch:probe:pipeline --include-catalog` 结果为 `6/7`：web/product/chat-service/chat-model/voice/catalog 通过，legacy `pipeline@8091` image check 因网关未运行失败。它不是当前 backend/ComfyUI failure，pipeline suite 也不能宣称通过。
- 三层一致性备份及隔离恢复已通过：`CHAT_FS_ROOT` 为 429 files / 550,987 bytes；Blob 为 13,634 files / 162,163,688 bytes，Main/Gen effective mock root 一致。PostgreSQL client `18.3` 对 server `16.14` 完成恢复；source 与 restore 的 counts、schema、logical DB、Chat FS、Blob 比较均为 `0` difference（equal），disposable restore DB 清理后 remaining `0`。
- 4 个 ComfyUI UI workflow 已完成 sync/readback：`qwen-image-edit-img2img`、`qwen-image-edit-multi-identity`、`qwen-image-edit-multi-reference`、`redcraft-krea2-txt2img`。真实 smoke artifact 为 `/private/tmp/idream-qwen-img2img-smoke.png`（832×1216，SHA-256 `3e0bdfa40aa9f70fa7c6fbaeb38f360254c89febf31988221ae2ef2b54fc5ea5`）、`/private/tmp/idream-qwen-multi-identity-smoke/sample-01.png`（832×1216，SHA-256 `965c9f20dd71cd294429bc7c87e940328d441fd48380599aee533343162cb512`）与 `/private/tmp/idream-qwen-identity-source-smoke.png`（832×1216，SHA-256 `b2361c115cf2b8351303cc468d82661f0a40074bee4b026927bcf4e9a889d6e5`）。它们不替代 publish/qualification/生产容量 Gate。
- 恢复后 PM2 回到 7 logical apps / 8 processes 且全部 online，Main/Admin HTTP 为 200、Chat health 为 `ok`。上述证据完成本地 code-owned controlled-beta Gate 的 DB/static/test/E2E/build/runtime/browser/backup 阶段；production providers、production canary/backfill、生产容量与 public-launch readiness 继续为 `NOT_EVALUATED`。

## 1. 第一性原理定义

主站“完整”不是每个页面都塞满数字，而是：

1. 用户从发现角色、注册、创建、聊天、生成图片、管理资产、订阅与账户管理，能够沿一条真实、可恢复、可解释的链路完成任务。
2. 每个展示值都来自明确权威：用户事实、官方编辑内容、真实运营配置或明确标注的本地演示能力；未知值保持未知，空数据进入有行动入口的空态。
3. 前端状态与后端状态一致：loading、empty、error、partial、success 都有明确语义；旧响应不能在新请求失败时冒充当前结果。
4. 写操作具备认证、授权、幂等、并发保护、审计和可恢复性；跨服务完成态必须以持久化事实为准。
5. 健康不是“某个 focused test 通过”，而是全量测试、构建、迁移、进程、HTTP、浏览器和数据终态共同成立。

## 2. 当前产品边界

- 当前目标：内部演示 / 受控 beta 完整可用。
- 公开上线：继续由真实 provider、生产配置和 launch probes 严格阻断，不能弱化 Gate。
- 内容策略：保留审核通过的官方角色、合集和编辑内容作为产品供给；不得用测试夹具、虚构用户行为或伪精确指标填满页面。
- 用户历史数据：不清空、不覆盖；本轮只做兼容迁移、权威回填或显式隔离，并提供回滚证据。

## 3. 真相模型与权威边界

```text
官方编辑内容 ────────────────┐
真实用户行为 ────────────────┼──> Main PostgreSQL 权威事实
真实生成/聊天完成事件 ───────┘            │
                                           ├──> BFF / DTO / 页面状态
Chat PostgreSQL + durable outbox/inbox ────┤
Gen manifest + artifact authority ─────────┘

未知 / 未配置 / 无数据
    ├──> 明确 unavailable / empty / partial
    └──> 可恢复 CTA、诊断信息或严格 launch blocker

测试夹具 / synthetic / e2e / probe 数据
    └──> 仅隔离测试环境；生产读取 fail closed
```

## 4. 关键用户旅程与验收

| 旅程 | 必须成立的权威终态 | 无数据 / 失败时用户看到什么 |
| --- | --- | --- |
| Explore → 角色详情 | 仅公开、已批准、未删除角色；图片为可用权威资产 | 官方目录为空时显示清晰空态和 Create 入口 |
| 注册 / 登录 / 回跳 | session 持久化，`next` 安全保留 | 可恢复错误、登录/帮助入口，不吞掉原任务 |
| Create → 身份确认 → My AI | 显式确认的 preview anchor 成为角色视觉身份 | 草稿保留；生成失败不可发布占位图 |
| 角色 → Chat | session/message/SSE 完成态与 Chat DB 一致 | 失败可重试；历史会话不因局部失败消失 |
| Generate → Gallery | request/attempt/artifact/ledger 一致且可追踪 | provider 未配置时明确不可用，不伪造完成图 |
| 账户 / 权益 / 订阅 | entitlement 与 ledger 是展示权威 | 未知计划/价格 fail closed，不猜测权益 |
| Admin 运营 | 角色、素材、发布、审核均沿 canonical authority | 缺证据则阻断并给出修复入口 |

## 5. 本轮工作流

### A. 全量测试稳定性与环境隔离（P1）

- 修复 Main 全量 Vitest 中测试数据库被并发 reset、缺表、seed/配置泄漏等共同根因。
- 保证单测和全量运行使用相同 schema/seed 权威，Redis、provider、voice、generation profile 均有显式测试配置。
- 修复 `finite-state-authority-inventory` 的静态写入检测误报或真实绕权路径，并加入回归证明。

### B. 真实数据与空态一致性（P1）

- 复核所有主站页面和 BFF：不再出现 synthetic fallback、伪活跃数字、测试用户或失败后旧数据残留。
- 保留官方审核内容作为冷启动供给；用户个性化数据为空时使用任务型空态，而不是虚构互动。
- 对 Chat、Generation、Billing、Community、Creator 页面建立来源标签与 fail-closed 读取边界。

### C. 运行配置与能力健康（P1）

- 统一测试、开发和 PM2 的 provider/capability 解析，避免页面宣称可用但后端无 active profile，或测试因本机环境偶然通过。
- 健康接口区分 configured、reachable、qualified、ready；unknown 不转成 0 或 success。
- 保持公开 launch Gate 严格，内部 demo Gate 给出可操作诊断。

### D. 浏览器与跨服务闭环（P1）

- 桌面与移动端验证首页、角色详情、Create、Chat、Generate、Profile/Upgrade 的 loading/empty/error/success。
- 验证 Main → Chat → SSE → DB → Outbox 与 Main → Queue → Gen → Artifact → Finalizer 的持久化终态。
- 检查 console/page/request errors、图片解码、响应式溢出和权限边界。

### E. 文档与持续健康（P2）

- 更新当前覆盖、剩余工作和运行手册，使“内部可用”与“公开上线未就绪”不会混淆。
- 将全量测试、迁移 drift、catalog hygiene、进程/HTTP/browser probes 作为同一验收清单。

## 6. 失败与恢复矩阵

| 路径 | 失败模式 | 系统行为 | 用户行为 | 证明 |
| --- | --- | --- | --- | --- |
| DB 测试初始化 | 并发 reset / 缺表 | 单一全局初始化、每套件隔离数据 | 不适用 | 全量 Main tests 连续运行通过 |
| Public catalog | 无官方内容 / 污染夹具 | fail closed，输出零项或干净官方内容 | 看见空态或官方内容 | catalog probe + DB 查询 |
| Chat | 服务离线 / SSE 中断 | 保留已持久化消息，可重试 | 明确错误与 Retry | BFF/SSE/DB/outbox probe |
| Generation | 无 active profile / provider 失败 | 不扣错账、不伪造 artifact | 明确 unavailable/failed | integration + worker + artifact 查询 |
| Billing | provider 未配置 / entitlement malformed | fail closed | 清楚说明当前权益和不可用动作 | API + ledger/entitlement test |
| 页面查询 | 新请求失败 | 清除不相干旧结果，保留可恢复上下文 | alert + Retry | component/E2E |

## 7. 回滚与数据保护

- 代码改动按逻辑单元提交，可逐提交回滚。
- Prisma 仅允许 additive / compatible migration；先在临时 PostgreSQL 验证 fresh deploy、upgrade 和 drift。
- 不删除用户历史记录；需要清理的只限可证明的 e2e/probe/synthetic 数据，并先输出计数与匹配依据。
- 任何 provider 或 capability 变更必须保持旧环境 fail closed，不能用默认 success 掩盖缺配置。

## 8. 完成定义

- Main、Admin、Chat、Gen、Shared 全量测试通过，且 Main 全量套件重复运行不依赖顺序。
- lint、typecheck、build、Prisma migration status 与 drift 全绿。
- PM2 目标进程在线；关键 HTTP/launch probes 返回与实际能力一致的结果。
- 浏览器覆盖桌面与 390px 移动端关键旅程，console/page errors 为零，空态和失败态可恢复。
- DB 终态证明无新增测试污染、无虚构经营指标、现有用户/官方内容保留。
- `CURRENT_FUNCTIONAL_COVERAGE.md` 与本轮真实证据同步。

## 9. NOT in scope

- 在没有真实生产凭据时接通或伪装 Go.cam、BTCPay、R2/S3、Sentry。
- 为了视觉填充制造用户消息、点赞、收入、转化或留存。
- 重做已通过验证的整体视觉风格；仅修阻断任务、状态语义和真实数据呈现的问题。

## 10. 已有能力复用

- `CURRENT_FUNCTIONAL_COVERAGE.md` 的用户旅程与浏览器证据。
- Shared contracts、Main BFF、Chat durable inbox/outbox、Gen manifest/finalizer 权威链路。
- catalog / product-config / chat-service / launch probes。
- 既有官方角色、官方合集、素材权威与数据 provenance 过滤。
- Character Asset Studio 的 draft → review → release → live projection 权威链路。

## 11. Phase 1 — CEO / 产品与范围审查

### 11.1 前提确认

用户在本任务中连续要求“全面分析并修复”“之前的数据怎么办”“从第一性原理出发，让主站完整和健康”，因此以下前提已被显式确认：

| 前提 | 结论 | 依据 |
| --- | --- | --- |
| 当前里程碑是内部演示 / 受控 beta，而不是伪装公开上线 | 成立 | `REMAINING_WORK_EXECUTION_PLAN.md` 的 Target 与用户本轮指令 |
| 官方审核内容可以作为冷启动供给 | 成立 | 官方角色/合集是编辑资产，不是用户行为或经营指标 |
| 用户历史数据必须保留 | 成立 | 用户追问“之前的数据怎么办”；本计划只允许兼容迁移和可证明隔离 |
| 无真实数据时应呈现任务型空态 | 成立 | 空态必须帮助用户开始 Create/Chat/Generate，不制造点赞、消息或收入 |
| 当前运行事实高于旧覆盖文档 | 成立 | 当前全量 Main Vitest 为 1030 pass / 41 fail / 35 skip，旧“本地闭环可用”结论需重新认证 |
| 生产 provider Gate 继续严格 | 成立 | 真实生产凭据和外部证据未进入本轮授权范围 |

### 11.2 问题重述

本轮不是再做一次 164 路由的平均用力视觉巡检，也不是用“全站有内容”替代产品价值。真正的问题是：**当前代码态能否持续证明核心用户旅程使用真实权威、不会损坏既有数据、并在失败时给出真实且可恢复的状态。**

因此采用风险分层：

1. 核心交互链路做深验收：Explore、Auth、Character、Create、Chat、Generate、My AI/Profile、Upgrade。
2. Feed、Community、Creator 与 Admin 只深验其直接权威、权限和数据污染边界。
3. 其余静态/SEO 路由做共享模板、404、坏图、console 和链接 smoke，不逐页重复相同断言。
4. 生产指标认证、真实支付归因和 WPCU 观察继续保持 fail closed；本轮不能宣称改善商业结果。

### 11.3 现有代码复用图

| 子问题 | 已有权威 / 代码 | 决策 |
| --- | --- | --- |
| 用户/测试/内部数据分类 | `server/lib/user-data-provenance.ts` | 复用并补足边界测试，不新建第二套 provenance |
| 公开角色/合集/反馈受众 | `ourdream/public-content-audience.ts` | 作为公开查询 SSoT，禁止页面自行拼 where |
| 媒体 synthetic 判定 | `media-asset-authority.ts` / `creative-media-authority.ts` | 统一使用既有 fail-closed predicate |
| Chat 权威 | Chat DB + BFF + durable inbox/outbox | 主站不直写 Chat 权威表 |
| 生成权威 | Request → Attempt → manifest → Artifact → finalizer | 不把 queue completed 当作媒体完成 |
| 用户权益 | Plan/Subscription/Entitlement + Dreamcoin ledger | 未知 feature/price fail closed |
| 运营角色资产 | Character Asset Studio + Release manifest + serving projection | 不用 legacy Placement 绕过发布链路 |
| 上线健康 | catalog/product-config/chat-service/launch probes | 扩展证据，不复制另一套 readiness 计算 |

### 11.4 Dream state delta

```text
CURRENT
  已有广泛本地流程与官方内容
  + 当前工作区 194 个 tracked 文件变更 / 17k+ 新增行
  + Main 全量 41 failures
  + 旧覆盖文档仍写“本地闭环可用”
        │
        ▼
THIS PLAN
  测试/配置/数据权威确定性
  + 核心旅程风险分层闭环
  + 真实空态与能力健康
  + 文档只记录本轮重新验证事实
        │
        ▼
12-MONTH IDEAL
  生产 canary/backfill/reconciliation 全绿
  + 真实 provider 与支付/成本归因
  + certified WPCU/retention/character performance
  + 角色差异化、身份一致性与关系留存持续迭代
```

本轮只关闭 `CURRENT → THIS PLAN`。生产认证与产品 moat 不能被本地绿色测试替代。

### 11.5 实施方案比较

| 方案 | 完整度 | 代价 / 风险 | 决策 |
| --- | --- | --- | --- |
| 全 164 路由逐页深测 | 7/10 | 重复模板验证多、反馈慢、容易变成 QA theater | 拒绝 |
| 权威边界优先 + 核心旅程深测 + 其余模板 smoke | 10/10 | 需要先修测试基础设施，但证据可持续复跑 | 采用 |
| 直接接生产 provider 并以 launch 为目标 | 5/10 | 超出本轮授权和凭据边界，且不能替代本地正确性 | 延后 |
| 只修当前 41 个断言 | 4/10 | 可能逐个打补丁，无法关闭共同根因 | 拒绝 |

### 11.6 时间顺序

| 时间 | 目标 | 退出条件 |
| --- | --- | --- |
| Hour 1 | 将 41 个失败按共同根因聚类 | focused 运行能区分真实缺陷与级联失败 |
| Hour 2 | 修复 test DB / Redis / provider/config 隔离 | 全量 Main 第一次全绿 |
| Hour 3 | 修复真实数据、空态和能力边界回归 | provenance/catalog/config focused suites 全绿 |
| Hour 4 | 核心桌面 + 390px 浏览器旅程 | console/page/request 阻断错误为 0 |
| Hour 5 | migration、PM2、HTTP、跨服务终态 | drift=0，进程和持久化事实一致 |
| Hour 6+ | 第二次全量、污染审计、文档同步 | 重复运行不依赖顺序且无新增 fixture 污染 |

### 11.7 CEO 双视角

独立 Claude 子代理在限定时间内未能产出可验证文件引用，因此标记为 `[subagent-unavailable]`；Codex CLI 兼容模型完成了只读审查。

Codex 提出 5 个战略担忧：本轮可能把本地健康误当真正上线瓶颈；计划未突出角色差异化和付费留存；当前缺少 certified 商业度量；全路由平均深测会失控；内部 beta 与伪上线范围可能混淆。

处理结果：

- 接受“风险分层而非全路由平均深测”，已写入 11.2。
- 接受“不能用本地健康宣称商业价值”，本轮成功指标严格限于正确性、可恢复性与可验证性。
- 保留本轮健康修复：当前 41 个 Main 失败是新的直接证据，优先级高于 7 月 13 日旧覆盖结论。
- 角色差异化、关系留存、生产 canary/backfill/metric certification 进入 Dream state delta，不冒充本轮已完成工作。

| 维度 | 独立子代理 | Codex | 当前审查结论 |
| --- | --- | --- | --- |
| 前提有效 | N/A | 部分反对 | 当前测试事实证明仍需健康修复 |
| 问题正确 | N/A | 建议重心转生产/留存 | 本轮先关闭受控 beta 正确性，再进入生产/留存 |
| 范围校准 | N/A | 反对全站平均用力 | 同意，改为风险分层 |
| 替代方案 | N/A | 提出三轨重构 | 采纳可组合部分，不扩大 provider 范围 |
| 产品风险 | N/A | 商业度量与 moat 缺失 | 明示为后续 Gate，不伪造结果 |
| 六个月轨迹 | N/A | 警惕维护吞噬产品价值 | 用完成定义和 scope 边界防止无限维护 |

没有形成“双模型共同要求改变用户方向”的 User Challenge；Codex 的有效反对点作为 taste/mechanical 决策处理。

### 11.8 Section 1 — 架构审查

主站保持模块化单体，Chat 与 Gen 继续由现有服务边界持有权威。计划不新增服务或数据库，只修复权威读取、测试隔离和 capability 解释。主要架构缺口是原计划“复核所有页面”没有区分共享模板与核心交易链路，现已改为风险分层。

```text
Browser
  ├─ Core product screens ──> Main App/BFF ──> Main PostgreSQL
  │                                │
  │                                ├─ signed BFF ──> Chat Service ──> Chat PostgreSQL
  │                                │                    └─ durable outbox ──> Main projection
  │                                └─ queue request ──> Gen Worker ──> manifest/artifact
  │                                                     └─ Main finalizer/ledger
  └─ Static/SEO route families ──> shared content templates + public catalog authority

Test authority
  one dedicated DB + one isolated Redis namespace + explicit mock capabilities
  └─ no test file may reset schema while another file is executing
```

10x/100x 首先受 Generation provider、Chat stream workers、Postgres/Redis 连接和大列表查询限制；本轮不增加这些负载。单点故障通过现有 degraded/error 状态暴露，不在本轮引入第二套 fallback 数据源。

回滚：代码按小提交回滚；无 destructive migration；若 capability 解释回归，恢复旧代码后仍 fail closed。自动决策：采用现有边界，不做 service split。

### 11.9 Section 2 — Error & Rescue Registry

| 方法 / 路径 | 失败 | 捕获 | 恢复动作 | 用户看到 |
| --- | --- | --- | --- | --- |
| Vitest global setup | DB 不可达、非 test DB、schema reset 失败 | 是 | 立即终止，打印数据库名和修复命令 | 不适用 |
| Seed/config bootstrap | 缺表、重复键、无 active profile | 是 | 事务回滚；测试环境创建显式最小配置 | 不适用 |
| Public catalog query | DB/DTO/污染校验失败 | 是 | fail closed；不返回旧/合成条目 | empty 或 retryable error |
| Main → Chat BFF | 401、签名不匹配、连接失败、SSE 中断 | 是 | 保留已持久化消息；重试/恢复会话 | alert + Retry |
| Generation dispatch/finalize | profile 缺失、provider 失败、manifest 非法、重复完成 | 是 | 不伪造 asset；幂等 finalize；正确结算/释放 | unavailable / failed + recovery CTA |
| Entitlement/price parse | malformed/unknown | 是 | fail closed，不猜功能与价格 | 当前权益或明确不可用 |
| UI query refresh | 新请求失败/过期响应晚到 | 是 | request identity 防旧响应覆盖；清理不相干旧结果 | alert + Retry，必要时保留上下文 |
| Fixture cleanup | predicate 过宽或目标是 customer | 是 | dry-run 计数 + customer guard + transaction | 不适用 |

禁止 catch-all 后静默继续；错误日志至少带 request/actor/target/capability/source。AI/provider 空响应、非法 JSON、拒绝和超时分别建模，不合并为“生成成功但无图”。

### 11.10 Section 3 — 权限与数据保护审查

本轮不新增外部 API。所有读写继续通过现有 session、role/permission、对象所有权和 BFF 签名边界。最高风险操作是数据清理：只能以 `dataClass`、保留域名、source/provenance 和稳定前缀的交集选中，先 dry-run，再以 customer guard 拒绝任何真实用户记录。

输入继续由现有 Zod/route contract 校验；清理和探针参数不得拼进 SQL 或 shell。无新 secret；测试 secret 只用于 `APP_ENV=test`。结论：没有需要扩大安全架构的 finding，保留现有边界并补回归测试。

### 11.11 Section 4 — 数据流与交互边界

```text
INPUT ──> AUTH/VALIDATE ──> AUTHORITY QUERY ──> DTO PARSE ──> UI STATE
  │            │                  │                 │             │
  ├ nil        ├ forbidden        ├ no rows         ├ invalid     ├ stale response
  ├ empty      ├ malformed        ├ provider down   ├ partial     ├ navigate away
  └ duplicate  └ stale version    └ timeout         └ unknown     └ double submit

nil/empty      => typed validation or purposeful empty state
forbidden      => 401/403 without leaking object existence
no rows        => official supply empty or user-personal empty, never synthetic fill
invalid DTO    => fail closed + observable error
stale response => request identity/cancellation prevents overwrite
duplicate      => idempotency/concurrency guard returns same authority or conflict
```

必须覆盖：0/1/大量结果、快速重复提交、页面离开时异步完成、session 过期、两标签页并发、provider 超时、队列重复投递、部分 artifact 完成和旧响应晚到。

### 11.12 Section 5 — 代码质量审查

不新增通用 `TruthService` 或新的 provenance DSL。直接复用现有 `user-data-provenance`、public audience predicates、media authority、shared contracts 与 launch probes。静态 inventory 规则若误报，应修解析边界或测试语料，不以 allowlist 掩盖真实绕权。

发现一个小而确定的仓库身份错误：`packages/main/package.json` 仍描述为 website cloner 模板，并保留旧 repository/homepage/keywords。它会误导新工程师和自动化元数据，纳入 P2 机械修复。

### 11.13 Section 6 — 测试审查

```text
CODE PATHS                                      USER FLOWS
[P1] Test DB/Redis/config bootstrap             [P1] Explore → Character
  ├─ happy: reset once + seed                   [P1] Auth next → original task
  ├─ error: reject non-test DB                  [P1] Create → confirm → My AI
  ├─ edge: repeat full run                      [P1] Character → Chat → persisted reply
  └─ edge: no suite-local schema reset          [P1] Generate → artifact → Gallery/ledger

[P1] Public data authorities                    [P1] Profile/Upgrade entitlement truth
  ├─ official content allowed                   [P2] Feed/Community/Creator authority smoke
  ├─ customer content allowed                   [P2] Static/SEO shared-template smoke
  ├─ fixture/internal excluded
  └─ malformed provenance fails closed

[P1] Capability interpretation
  ├─ configured / reachable / qualified / ready
  ├─ unknown remains unknown
  └─ missing profile never becomes success
```

回归要求：先单独运行每个当前失败 suite，再以随机/相反顺序组合运行，最后连续两次执行 Main 全量；随后执行全 workspace test、lint、typecheck、build。关键用户流使用 E2E，跨服务持久化用 integration/probe，纯 predicate 用 unit。任何当前回归均为必须测试，不询问是否补。

### 11.14 Section 7 — 性能审查

本轮不引入新列表或跨表聚合。公开受众 where 必须下推数据库，不在内存中过滤全表；核心 E2E 深测，164 路由使用模板级 smoke，避免验证成本线性失控。健康探针设置有界 timeout，不无限等待 provider。

若修复新增查询，必须检查 existing indexes、select 字段和分页；不把诊断 probe 放入每个页面请求。没有发现需要新缓存或基础设施的工作。

### 11.15 Section 8 — 可观测性审查

健康结果统一区分：

```text
configured ──> reachable ──> qualified ──> ready
     │              │              │           │
 missing          timeout        stale       end-to-end failed
```

每一层保留 `checkedAt`、authority/source、错误代码和 remediation；`unknown` 不转换成 0、false success 或经营指标。跨服务 probe 必须携带 request/job/session id，最终报告能从 UI → API → queue/outbox → DB/artifact 重建路径。

### 11.16 Section 9 — 部署与回滚审查

1. 在临时 PostgreSQL 演练 migration fresh deploy、upgrade、重复 deploy。
2. 执行 focused + full tests、lint、typecheck、build。
3. 重启受影响 PM2 进程，确认监听者就是目标构建。
4. 跑 HTTP/probes 和核心浏览器流。
5. 查询 DB 污染计数、用户计数、权威终态。

旧代码和新 schema 必须兼容；无 destructive migration。若 smoke 失败，停止在本地，不写“已完成”文档；回滚对应提交并重跑相同 probe。

### 11.17 Section 10 — 长期轨迹

可逆性 5/5：代码和 additive migration 可独立回滚；用户数据不被重写。最大的长期风险不是本轮修复，而是继续用旧覆盖文档、focused tests 和巨大未提交工作区代替可复跑事实。计划通过重复全量、风险分层和终态查询降低该风险。

本轮之后应进入两条独立轨道：生产 canary/backfill/reconciliation/metric certification；角色供给质量、身份一致性、差异化与关系留存实验。它们不应被塞进“修全站”而失去明确验收。

### 11.18 Section 11 — 设计与 UX 审查

UI 范围只包括状态完整性，不重做视觉方向。信息顺序保持：用户当前任务 → 当前权威状态 → 一个主行动 → 必要恢复信息。核心屏幕必须覆盖 loading/empty/error/partial/success；空态文案区分“平台暂时无官方内容”和“你还没有个人内容”。移动端保持 44px 触控目标、可见 labels、键盘/读屏状态和 390px 无溢出。

```text
Explore / Character
  ├─ Chat ──> Auth return ──> Session ──> Message/reply
  ├─ Generate ──> Auth/entitlement ──> Job ──> Gallery
  └─ Create ──> Draft ──> Identity confirmation ──> My AI

所有异步节点：loading → success | empty | error/retry | partial
```

### 11.19 Failure Modes Registry

| 路径 | 失败模式 | Rescued | Test | 用户可见 | Logged |
| --- | --- | --- | --- | --- | --- |
| Test bootstrap | schema 被其他 suite 删除 | 待修 | 必须 | 不适用 | 必须 |
| Config bootstrap | 本机 env 泄漏导致 voice/profile 不一致 | 待修 | 必须 | 不适用 | 必须 |
| Catalog | fixture/internal 进入公开查询 | 是 | 已有，需全量复证 | 不展示污染内容 | 是 |
| Catalog | 合法官方内容被一刀切清空 | 是 | 必须 | 官方内容或有行动空态 | 是 |
| Chat BFF | signed request/service 失败 | 是 | 必须 | alert + Retry | 是 |
| Chat SSE | done 早于 DB finalize | 是 | 已有 probe，需复证 | 保留会话并可恢复 | 是 |
| Generation | 无 active profile | 待修/复证 | 必须 | unavailable | 是 |
| Generation | duplicate completion | 是 | 必须 | 单一完成结果 | 是 |
| Billing | malformed plan feature | 是 | 已有，需复证 | 不猜权益 | 是 |
| UI refresh | 旧结果覆盖新失败 | 部分 | 必须 | 当前 error/empty | 必须 |
| Cleanup | 误选 customer 数据 | 必须 fail closed | 必须 | 不适用 | 是 |

不存在允许 `Rescued=N + Test=N + Silent` 留在完成状态的行。

### 11.20 CEO Implementation Tasks

- [ ] **C1 (P1)** — 修复 Main 全量测试数据库、Redis 与运行配置的共同根因，并证明连续两次全绿。
- [ ] **C2 (P1)** — 以既有 provenance/public audience/media authorities 复证官方内容保留、fixture/internal 排除和空态边界。
- [ ] **C3 (P1)** — 对核心旅程做深度 E2E，对共享静态模板做有界 smoke。
- [ ] **C4 (P2)** — 修正 `packages/main/package.json` 的模板遗留元数据。
- [ ] **C5 (P2)** — 只在实时证据完成后更新覆盖文档和健康结论。

### 11.21 CEO Completion Summary

| 项目 | 结果 |
| --- | --- |
| Mode | SELECTIVE EXPANSION |
| System Audit | 当前 41 个 Main 失败推翻旧绿色结论；生产 Gate 仍严格 |
| Architecture | 1 个范围边界问题，已改风险分层 |
| Errors | 8 条关键错误路径，0 条允许静默 |
| Security | 无新增攻击面；清理路径需 customer guard |
| Data/UX | nil/empty/error/partial/stale/duplicate 已纳入 |
| Quality | 复用权威；发现 main package 模板元数据 |
| Tests | 3 类代码路径 + 8 个核心用户旅程 |
| Performance | 不做 164 路由逐页深测；无新基础设施 |
| Observability | configured/reachable/qualified/ready 四层 |
| Deploy | migration → tests/build → PM2 → HTTP/browser → DB |
| Future | 生产认证与 retention/moat 独立进入下一轨 |
| Design | 只做状态完整性与恢复，不重设计 |
| Outside voices | Codex 5 concerns；Claude subagent unavailable |
| Unresolved decisions | 0 |

## 12. Phase 2 — Design / 状态完整性审查

### 12.1 System audit 与范围

- UI scope：主页/Explore、角色详情、登录回跳、Create、Chat、Generate、Profile/Gallery、Upgrade，以及 Community/Creator 的真实空态和局部失败呈现。
- 分类：HYBRID。公开发现页保留品牌与内容锚点；Create/Chat/Generate/Profile/Upgrade 按任务型 App UI 处理。
- 仓库没有根级 `DESIGN.md`；本轮不引入第二套视觉系统，而是绑定现有 `RouteShell`、`AppSidebar`、`MobileBottomNav`、`CharacterGrid`、`authority-state.ts` 和各 Workspace 的组件/颜色/排版词汇。
- gstack designer 不可用，因此未生成 mockup；本轮是既有 UI 的状态契约修复，不是视觉改版。
- 初始设计完整度：**5/10**。方向正确，但逐屏层级、状态差异、长任务中间态、响应式与无障碍仍留给实现者猜测。10/10 的标准是下文所有屏幕和状态都有可见行为、唯一主行动、恢复规则与浏览器验收。

### 12.2 双视角独立审查

#### CODEX SAYS（design — UX challenge）

Codex 提出 6 项：角色页“一个主行动”与 Chat/Generate/Create 三分叉冲突；状态只到原则没有到逐屏行为；Chat/Generate 缺少 sending/streaming/reconnecting/queued/running/finalizing；响应式与无障碍不可硬验收；官方内容在各类空页的使用边界未定义；“未解决决策 0”缺少可信的 UX decision register。

#### CLAUDE SUBAGENT（design — independent review）

独立设计视角提出 6 项：信息层级仍偏工程；状态没有区分初次/刷新、首用/筛选空、阻断/局部错误；缺少唯一黄金闭环；没有“好奇→信任→期待→连接→掌控”的情绪弧；Retry/超时/保留输入/自动恢复仍过于通用；390px 与 44px 不足以覆盖虚拟键盘、焦点和动态播报。

#### Design litmus consensus

| 议题 | Codex | Independent | Primary resolution | 结果 |
| --- | --- | --- | --- | --- |
| 逐屏信息层级 | 明确反对当前三分叉 | 高优先级缺口 | 加入 screen × state × CTA 契约 | CONFIRM |
| 五态 + stale/partial | 高优先级缺口 | 高优先级缺口 | 加入页面状态矩阵 | CONFIRM |
| 长任务中间态 | Chat/Generate 不完整 | partial 定义不足 | 单列持久化与恢复语义 | CONFIRM |
| 黄金旅程/情绪弧 | 未单独反对 | 高优先级缺口 | 增加首会话黄金闭环与 5 秒/5 分钟/长期体验 | CONFIRM |
| 冷启动内容 | 要求 route-family map | 要求空态有行动 | 官方 editorial 可保留，但与个人历史严格分区 | CONFIRM |
| 响应式/无障碍 | 不可测试 | 不可测试 | 增加 WCAG 2.2 AA 与 viewport/IME/focus 契约 | CONFIRM |
| 视觉重设计 | 未要求 | 未要求 | 复用现有视觉系统，不扩张范围 | CONFIRM |

双方没有共同要求改变用户“主站完整和健康”的方向，因此没有 User Challenge。

### 12.3 Pass 1 — Information Architecture（6/10 → 10/10）

每个核心屏幕最多先回答三件事：**我正在做什么、现在什么是真的、下一步做什么**。系统诊断不能抢到用户任务之前；同一屏只能有一个视觉主 CTA。

```text
Route shell / navigation
  └─ Task heading or identity anchor
       └─ Authoritative primary content
            ├─ inline current status / capability
            ├─ ONE primary action
            └─ secondary context + recovery/detail
```

| 屏幕 | 第一层 | 第二层 | 主 CTA | 次级动作 / 恢复 |
| --- | --- | --- | --- | --- |
| Home / Explore | 可用的官方角色供给 | 搜索/筛选结果与当前查询范围 | 打开角色 | 清筛选、Create |
| Public character | 角色身份、权威图片与描述 | 当前可用能力 | **Chat** | Generate；若存在则将 Create with identity 降为文本入口 |
| Auth | 原任务与安全回跳目标 | 表单、字段错误、session 状态 | Log in / Join | Help；成功回原任务而非首页 |
| Create draft | 当前草稿与视觉 identity preview | 保存/预览生成状态 | **Confirm identity** | 修改、重试 preview；失败不允许发布占位图 |
| Chat session | 会话和已持久化消息 | sending/streaming/reconnecting 状态 | Send / Resume | Retry failed message、回角色页 |
| Generate | 角色/identity 与当前参数 | capability、余额、job 状态 | Generate / Retry same settings | Cancel（仅允许态）、Edit prompt、View gallery |
| Profile / Gallery | 账户事实或所选个人资产 tab | 当前 tab 的 authority state | 该空态对应的 Create/Explore/Generate | Retry tab；其他已加载账户事实不消失 |
| Upgrade | 当前权益与真实可购买 plans | provider/checkout 状态 | 选择或继续真实 checkout | Retry plans、返回原任务 |

### 12.4 Pass 2 — Interaction State Coverage（5/10 → 10/10）

全站共享语义：初次 loading 无 snapshot 时绝不显示 empty；刷新只可保留**同一 query scope** 的 snapshot，并显示“正在刷新/刷新失败”；切换筛选、用户或角色后立即丢弃旧 scope；晚到响应按 request identity 丢弃。`success` 只由权威 DTO/持久化终态触发，不能由 HTTP 200、队列接收或本地乐观状态替代。

| FEATURE | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL / STALE |
| --- | --- | --- | --- | --- | --- |
| Explore / search | 首次显示有稳定尺寸的内容骨架；刷新保留同 scope 结果并标注 Updating | 区分“官方目录暂无供给”与“当前筛选无结果”；分别给 Create 或 Clear filters | 无 snapshot 显示阻断错误 + Retry；不拿旧 query 冒充 | 仅渲染公开、批准、未删除且图片可用的角色 | 同 scope 刷新失败时保留卡片，顶部显示 checkedAt + Retry；其他 scope 清空 |
| Character detail | identity 区保留空间，Chat 禁用到角色权威完成 | 角色不存在/下架走 not-found，不伪造默认角色 | 主对象失败阻断；媒体副区失败不遮住已验证的角色信息 | 角色信息和主 CTA 与当前能力一致 | 主对象 ready、媒体失败时显示局部错误；Chat 仍可用时保持主 CTA |
| Auth return | 提交按钮显示进行中且防重复；原任务文案保持 | N/A | 字段错误关联到字段；服务错误保留输入和 next | session 持久化后回到安全 `next` | session 已建立但回跳失败时提供 Continue to original task |
| Create / identity | 显示 Draft saved / Generating preview；保留所有输入 | 新用户看到有方向的起始表单，不预填虚构人格或图片 | preview 失败保留草稿并提供 Retry preview/Edit；Confirm 禁用 | 只有显式确认的 preview anchor 成为身份，随后进入 My AI/角色详情 | 草稿已保存但 preview 失败；清楚区分已保存与未可发布 |
| Chat hub/session | hub 初次 loading 不显示“无聊天”；session 保留已持久化 history | 个人空态给 Explore/Create；不插入假会话 | history 失败阻断并 Retry；新回复中断不删除历史或已持久化用户消息 | `sending → persisted → streaming → finalized` 可区分；final 以 Chat DB 为准 | reconnecting 显示连续性；中断回复标记 interrupted，可 Resume/Retry，不冒充完成 |
| Generate / Gallery | capability 加载时禁用提交；job 显示 queued/running/finalizing | Gallery 个人空态给 Generate；不得把官方样图放进“我的作品”网格 | 未配置明确 Unavailable；提交失败不误扣账；job 失败可 Retry same settings | artifact 可读、manifest/finalizer/ledger 对齐后完成 | N 个输出仅部分成功时展示真实完成项和失败计数；缩略图失败不否认 artifact；状态延迟可 Refresh |
| Profile library | 账户 shell 与 tab 分开加载；切 tab 不拿前 tab 数据填充 | 每个个人 tab 使用专用任务空态 | tab 错误不清除已验证的账户/权益；Retry 当前 tab | 当前用户、当前 tab、当前 scope 的数据一致 | 账户 ready、library/collection 子区失败时局部提示；未知余额/权益不显示 0 |
| Upgrade / billing | plans 与 current entitlement 分开加载，checkout 防重复 | 真实 plans 为零时说明暂不可购买，不显示旧价格 | plans 失败可 Retry；checkout 失败保留所选 plan 与 return target | 真实 subscription/ledger 更新后标记 Current | plans ready 但 entitlement unknown 时不猜当前 plan；provider redirect 与 activation 分开呈现 |
| Community / Creator | 主对象和动态列表独立 loading | 只显示真实官方 placement/已发布作品或任务空态 | 主对象失败阻断；动态/作品失败局部恢复 | 所有计数与内容来自当前 authority | creator ready、作品失败时保留简介；禁止伪 follower/like/activity |

#### Route-family cold-start / empty-state truth map

| Route family | 允许的冷启动内容 | 禁止内容 | 主行动 |
| --- | --- | --- | --- |
| Explore | 已批准官方角色、官方合集、明确 editorial 模块 | fixture/test 用户、伪活跃/点赞/热度 | Open character；目录真空时 Create |
| My AI | 先显示真实个人空态；其下可有明确标注的“Official inspiration”独立区 | 把官方角色混进个人角色网格 | Create |
| Gallery | 个人空态；可在独立区展示官方 prompt/操作教程 | 把官方样图标成用户生成、伪造 generation history | Generate |
| Community | 当前有效的官方 campaign/placement | 假帖子、假参与人数、假趋势 | Explore/Create，取决于真实 placement |
| Creator | 该 creator 的已发布作品；可另列“Explore official creators” | 假 follower/like、把其他人的作品并入本人列表 | View work / Explore |
| Upgrade | 当前配置并可结算的真实 plan 与权益说明 | fallback 旧价格、猜测 entitlement | Retry / Return to task |

这解决“完全没有数据页面会很差”的问题：**保留真实官方供给和编辑内容做冷启动；个人历史为空时仍然诚实，但用独立的官方灵感区和明确下一步保持页面完整。**

### 12.5 Pass 3 — User Journey & Emotional Arc（4/10 → 10/10）

主站唯一首会话黄金闭环为：

```text
Official Explore → Character detail → Chat
  → Auth with safe return → persisted first message → finalized reply
  → Generate with the same selected identity → authoritative artifact/Gallery
  → return to Chat or Profile without losing context
```

Create 是拥有角色的第二闭环：`Create draft → preview → explicit identity confirmation → My AI → Chat/Generate`，不能和首访黄金路径争夺每一屏的主 CTA。

| STEP | USER DOES | USER FEELS | UI 必须提供 |
| --- | --- | --- | --- |
| 1 | 浏览官方角色 | 好奇但警惕真实性 | 权威图片和可理解身份，不展示伪互动 |
| 2 | 打开角色详情 | 判断是否契合 | 清晰 identity、能力与唯一 Chat 主行动 |
| 3 | 登录/注册 | 不想被打断 | 原任务和角色上下文可见，完成后安全回跳 |
| 4 | 发送首条消息 | 期待 | sending/persisted/streaming 明确，输入不丢 |
| 5 | 收到或恢复回复 | 连接与信任 | finalized 事实；中断时可恢复而非整段消失 |
| 6 | 用同一角色生成图片 | 创作期待 | 参数、identity、队列和账本状态真实可见 |
| 7 | 查看 Gallery | 获得回报与所有权 | 只展示可读权威 artifact，partial 诚实呈现 |
| 8 | 回 Chat/Profile | 掌控与连续性 | 状态、资产、会话和返回点都被保存 |

- 5 秒：品牌、真实官方角色和一个主行动建立“这是什么、能做什么”。
- 5 分钟：auth 不丢任务、首条回复和首个 artifact 给出真实反馈。
- 长期：会话、角色身份、资产与账本不因局部故障消失，形成可持续信任。

### 12.6 Pass 4 — AI Slop Risk（7/10 → 10/10）

本轮不新增通用 SaaS card mosaic、三栏功能格、装饰性 icon bubble、渐变噪声或泛化“Something went wrong”作为最终文案。功能页保持 calm task surface：主 workspace、权威状态、一个 accent、一个主行动；卡片仅在角色、会话、资产、plan 本身就是交互对象时使用。错误动作必须场景化为 `Reconnect`、`Retry preview`、`Retry same settings`、`Refresh status`、`Clear filters`，而非所有场景统一 Retry。

| Litmus | 结果 | 约束 |
| --- | --- | --- |
| 首屏产品是否明确 | YES | 角色/任务对象继续是视觉锚点 |
| 是否只有一个强锚点 | YES | 不让状态框抢过角色、会话或 artifact |
| 仅扫标题能否理解 | YES | task → status → action |
| 每个 section 是否一个职责 | YES | authority state 与内容模块同域呈现 |
| cards 是否必要 | YES | 只用于可选择的实体 |
| motion 是否改善层级 | YES | 只表达进度/过渡，并支持 reduced motion |
| 去掉阴影仍是否成立 | YES | 依靠排版、空间与内容层级 |

### 12.7 Pass 5 — Design System Alignment（6/10 → 10/10 for this scope）

无根级 `DESIGN.md` 是长期文档缺口，但不应让本轮发明新系统。实现必须：

- 复用 `RouteShell` 的 sidebar/topbar/mobile-nav 层级，不创建平行 shell。
- 复用 `authority-state.ts` 的 loading/ready/error/snapshot 语义并扩展，而不是每个 Workspace 自造布尔组合。
- 复用 `CharacterGrid`、现有 rounded surface、白色主 CTA、粉色 accent、既有 heading/body 词汇。
- 新共享组件只允许表达已有词汇中的 `AuthorityStatus`、`TaskEmptyState` 或 `PartialStateNotice`；不得为了统一外观抽象所有业务状态。
- 后续若做整体视觉重构，再通过独立 design consultation 产出全局设计权威；本轮不创建与 `REMAINING_WORK_EXECUTION_PLAN.md` 冲突的平行 `TODOS.md`。

### 12.8 Pass 6 — Responsive & Accessibility（4/10 → 10/10）

硬验收以 WCAG 2.2 AA 为目标：

- 390px：单列主任务；底部导航、sticky CTA、chat composer 与 `env(safe-area-inset-bottom)` 不重叠；软键盘打开后输入、Send、错误和最近消息仍可到达；无横向溢出。
- 768px：验证 sidebar/内容/副区切换点；状态和恢复动作不能被两栏拆散；对话 drawer、modal 和生成控制完整可键盘操作。
- 1280px：主 workspace 不被诊断信息挤压；副区是次级上下文，不形成第二主 CTA。
- 所有交互目标至少 44×44 CSS px；输入始终有可见 label；正文对比度至少 4.5:1，large text 与 UI 图形至少 3:1。
- 页面/回跳后焦点进入任务标题或原控件；modal/drawer 锁定并恢复焦点；错误摘要可聚焦且通过 `aria-describedby` 关联字段。
- loading/progress 使用 polite live region；阻断错误才 assertive；streaming 内容按句/阶段播报，不逐 token 轰炸读屏；完成与中断各播报一次。
- 路由/筛选/Retry 后保留合理焦点；新增内容不强抢焦点；聊天自动滚动只在用户位于底部时发生。
- `prefers-reduced-motion` 下移除非必要动画；visited 状态只用于内容型链接，app navigation 仍以当前位置语义为主。
- 浏览器测试覆盖键盘主流程、焦点恢复、live-region 文本、390px + virtual-keyboard 等价布局、768px 和 1280px。

### 12.9 Pass 7 — UX Decision Register（7 resolved，0 unresolved）

| 决策 | 选择 | 分类 | 验收影响 |
| --- | --- | --- | --- |
| Public character 主 CTA | Chat；Generate 次级；Create-with-identity（若有）更次级 | taste | 角色页只能有一个视觉主按钮 |
| Draft identity 主 CTA | Confirm identity | mechanical | preview 未成功/未确认时禁用 |
| 个人空页能否显示官方内容 | 可以，但必须在个人空态之后的独立 `Official inspiration` 区 | taste | 官方内容不进入个人网格/计数 |
| 刷新失败是否保留旧内容 | 仅同 scope snapshot，显式 stale/checkedAt；跨 scope 清空 | mechanical | late response 不能覆盖新状态 |
| 自动重试 | 安全 GET/SSE 可做一次有界重连；写操作仅在幂等且服务端确认安全时重放 | mechanical | 不重复扣费/建 job/发消息 |
| 长任务超时 | Chat 用 activity/reconnect 状态；Generate 以服务端 queued/running/finalizing/terminal 为准，不由任意客户端时钟伪判完成 | mechanical | status 延迟显示 Refresh status |
| partial 输出 | 保留真实完成部分，展示失败数量和针对失败部分的恢复动作 | mechanical | 不把 2/4 标成全部完成 |
| 成功后的落点 | Auth 回原任务；Create 到 My AI/角色详情；Chat 留在 session；Generate 留结果并给 Gallery；Billing 留成功态并给 Return | mechanical | 不让自动跳转吞掉结果 |

### 12.10 Design NOT in scope / What already exists / TODOs

**NOT in scope**

- 全站品牌、色彩、字体和导航重构：本轮只修状态、任务阻断与真实数据呈现。
- 为 164 个静态/SEO route 分别设计新页面：按模板族 smoke，核心交互深测。
- 用 skeleton、推荐或 editorial 掩盖真实不可用能力：任何视觉填充都不能改变 authority truth。

**What already exists**

- `RouteShell`、`AppSidebar`、`MobileBottomNav` 提供一致导航骨架。
- `authority-state.ts` 已区分初次 loading、snapshot 和 error；`CharacterGrid` 已有 loading/error/empty/load-more。
- `ChatHubWorkspace`、`GeneratorWorkspace`、`ProfileWorkspace`、`UpgradeWorkspace` 已有多种状态，可收敛到共享语义而无需重写视觉。
- 既有官方角色、合集和 editorial 是合法冷启动供给；其 provenance/audience authority 继续是展示 Gate。

**TODO auto-decision**：没有创建新的 `TODOS.md`。全局 `DESIGN.md` 有价值但不阻断本轮，且本仓库已经以 `REMAINING_WORK_EXECUTION_PLAN.md` 作为剩余工作 SSoT；避免建立竞争 backlog。若未来进入整体视觉重构，再单独执行 design consultation。

### 12.11 Design Implementation Tasks

- [ ] **U1 (P1, human: ~6h / CC: ~45min)** — Main UI authority states — 将核心 Workspace 收敛到同 scope snapshot、stale、partial 和 late-response 规则。
  - Surfaced by: Pass 2 — 状态原则尚未落到逐屏行为。
  - Files: `packages/main/src/components/ourdream/authority-state.ts`、Explore/Character/Create/Profile/Upgrade workspaces。
  - Verify: component tests + `bun --cwd packages/main test`。
- [ ] **U2 (P1, human: ~6h / CC: ~45min)** — Chat / Generation — 实现 sending/persisted/streaming/reconnecting 与 queued/running/finalizing/partial 的用户可见终态和恢复动作。
  - Surfaced by: Pass 2/3 — 长任务中间态和连续性不完整。
  - Files: `ChatSessionClient.tsx`、`GeneratorWorkspace.tsx` 及 BFF/component tests。
  - Verify: focused tests + Chat/Gen live probes + browser journey。
- [ ] **U3 (P1, human: ~4h / CC: ~30min)** — Empty-state truth — 区分官方供给、筛选空、个人空，并把官方灵感模块与个人网格隔离。
  - Surfaced by: Pass 2 — 冷启动页面必须完整但不可伪造历史。
  - Files: `CharacterGrid.tsx`、`ProfileWorkspace.tsx`、`GeneratorWorkspace.tsx`、`CommunityWorkspace.tsx`、`CreatorProfileClient.tsx`。
  - Verify: empty/catalog hygiene tests + frontend-truth E2E。
- [ ] **U4 (P1, human: ~5h / CC: ~40min)** — Responsive / accessibility — 补齐 focus、live region、virtual keyboard、安全区、键盘与 viewport 验收。
  - Surfaced by: Pass 6 — 现有 390px/44px 要求不可完整硬验收。
  - Files: core Workspace components、`packages/main/src/e2e/ui-workflows.e2e.ts`、`frontend-truth.e2e.ts`。
  - Verify: 390/768/1280 Playwright + keyboard/screen-reader assertions。

### 12.12 Design Completion Summary

| 项目 | 结果 |
| --- | --- |
| System Audit | UI scope confirmed；无 DESIGN.md；designer unavailable |
| Step 0 | 5/10；缺逐屏、状态、长任务、a11y 规范 |
| Pass 1 — Info Arch | 6/10 → 10/10 |
| Pass 2 — States | 5/10 → 10/10 |
| Pass 3 — Journey | 4/10 → 10/10 |
| Pass 4 — AI Slop | 7/10 → 10/10 |
| Pass 5 — Design System | 6/10 → 10/10 for scoped reuse |
| Pass 6 — Responsive | 4/10 → 10/10 |
| Pass 7 — Decisions | 7 resolved；0 deferred/unresolved |
| NOT in scope | 3 items written |
| What already exists | 4 reuse groups written |
| TODOS.md updates | 0；避免重复 SSoT |
| Approved mockups | 0；designer unavailable |
| Outside voices | Codex 6 concerns；independent design 6 concerns；7/7 themes confirmed |
| Overall design score | 5/10 → 10/10 specification completeness |

计划在本轮范围内已 design-complete；实现后仍需运行浏览器级 visual/interaction QA。

## 13. Phase 3 — Engineering / 可靠性与实施审查

### 13.1 Step 0 — Scope Challenge（不缩减）

本轮不能缩成“修两个断言”或“给空页面补内容”。最新证据显示，失败由四种不同层级组成：测试权威会被跨进程破坏；非生产身份边界 fail-open；公开内容的 canonical authority 仍有 legacy/null 绕路；Chat/Billing 等写路径在模糊网络失败下会重复产生副作用。它们都会让页面看似完整，却无法证明数据正确。

| 用户目标 | 实际代码边界 | 本轮工程责任 |
| --- | --- | --- |
| 保留之前的数据 | Main/Chat PostgreSQL、MediaAsset、CharacterRelease/Serving、ledger | 不删除；先 inventory，再 additive backfill，最后切换严格读 Gate |
| 无个人数据时页面不难看 | 官方角色/合集/editorial 与个人 My AI/Gallery 分域 | 保留真实官方供给；个人空态与 Official inspiration 明确分区 |
| 页面数据真实 | `public-content-audience.ts`、media authority、DTO/reducer | legacy/null/synthetic/malformed 不再被当作 ready/empty |
| 写入正确 | Chat service、Billing、Generation、BFF | durable intent + idempotency + concurrent replay |
| 可持续证明健康 | Vitest global setup、Playwright harness、probes、PM2 | 单一测试 owner、可复跑报告、进程/HTTP/DB 终态闭环 |

Autoplan 模式禁止在审查时为了降复杂度删掉用户要求，因此保留完整范围，但将生产扩容、真实外部 provider 认证和全局视觉重构留在独立轨道。

### 13.2 当前运行证据更新

第一次根级健康运行记录为 Main `1030 pass / 41 fail / 35 skip`。随后使用 JSON reporter 重跑 Main：

- 1,109 个测试中 `1,089 pass / 2 fail / 18 skip`。
- 两个真实 assertion failure 出现在 Character Performance/Portfolio；另有 generation catalog、production directions 在清理阶段发现 `public.main_outbox_events` 消失。
- focused 重试时，`db-push` 刚报告 schema 已同步，seed 随即报 `public.users does not exist`；同时系统中存在另一个 `bun run test` / Vitest 进程，共用 `idream_test.public`。
- `finite-state-authority-inventory` 21/21、`seed-data-truth` 3/3 单独通过，说明早期 41 个失败中存在大量环境级级联，但不能据此宣称全量绿色。

结论：测试基础设施 race 已被实际复现，优先级高于逐条修断言。当前 Health composite 仍为 8.8/10（typecheck 10、lint 10、tests 7），而不是“健康完成”。

### 13.3 双视角独立审查与共识

独立工程代理提出 8 项：非生产 auth fail-open、测试删库 race、Chat/Billing 非幂等、viewer 状态未隔离、Generation 轮询 fan-out、Chat 部署单点、DTO/error 边界。Codex 只读审查提出 6 项：public character 允许 legacy/null asset/null serving，release provenance 只检查前三个数组位置，authority state 过弱，Upgrade hero 抢主行动，feedback 仅凭 `sourceKey` 可公开，collection 只排 synthetic 而未排 archived/rejected。

两方没有共同要求改变“让主站完整健康”的方向；它们共同否定了原 CEO 阶段“无需扩大安全架构”的结论。13.5 的新证据覆盖 11.10 的旧结论。

| 维度 | 独立工程 | Codex | 共识结论 |
| --- | --- | --- | --- |
| Architecture | 5/10 | 3/10 authority | 权威链存在，但读 Gate、viewer scope、intent authority 未闭合 |
| Tests | 4/10 | 3/10 | 覆盖面广，但跨进程权威和关键 replay 场景缺失 |
| Performance | 3/10 | 6/10 | 最大当前热点是 Generation fan-out；公开 predicate 也需保持 DB 下推 |
| Security | 2/10 | 5/10 provenance | plaintext identity 与 destructive reset 是受控 beta 前阻断项 |
| Errors | 4/10 | 4/10 state | malformed、partial、unknown、stale 仍会被压扁 |
| Deploy | 3/10 | 4/10 | 无稳定全量证据，public cutover 也缺 backfill-before-gate 顺序 |

### 13.4 目标架构

```text
PUBLIC READ
  Official/User record
      -> provenance + publishable MediaAsset
      -> published ready CharacterRelease
      -> live CharacterServing
      -> public audience projection
      -> validated DTO
      -> Explore/Character/Official inspiration

PRIVATE READ
  session viewerScope + queryScope + requestId
      -> authority query
      -> valid | empty | partial | stale | error | permission
      -> late response accepted only for the captured scope

WRITE INTENTS
  Chat intent key -> Main BFF -> Chat transaction -> turn pair -> queue/SSE
  Checkout key    -> CheckoutIntent -> provider once -> session/subscription/ledger
  Generation key  -> job/reservation -> attempt -> artifact/finalizer/refund

TEST AUTHORITY
  workspace test DB + Redis prefix
      -> suite-lifetime PostgreSQL advisory lease
      -> reset/sync/seed once
      -> focused/full/E2E
      -> teardown + structured evidence
```

不建立第二套 public catalog 或第二套 UI truth store。公开资格在发布/回填时形成稳定、可查询的权威事实；浏览器只消费 DTO，不解析 release manifest 来决定是否公开。

### 13.5 Code Quality / Boundary Findings

| Sev | Finding | Evidence | Confidence | 处理 |
| --- | --- | --- | --- | --- |
| Critical | test DB guard 只看数据库名含 test，随后可删除任意 host/schema；多个进程共用同一 DB/Redis | `global-setup.ts:17-25,65-75,95-130`; `vitest.config.ts:17-36`; `test-database-url.ts:4-15` | High | loopback/default-safe + explicit CI reset capability + suite lease + workspace namespace |
| Critical | Main 在所有非 production 环境信任 user/role header；Chat 无 secret 时信任 plaintext user | `auth/index.ts:132-157`; `chat/web.ts:132-160,198-209`; `chat-proxy.ts:49-70` | High | 仅 `APP_ENV=test`；其他环境 cookie/signed BFF；role 只从 DB/permission authority |
| High | public character 允许 imageAsset/serving/currentRelease 为 null，并接受 legacy release | `public-content-audience.ts:25-92` | High | 先 inventory/backfill，再要求 publishable image + ready published release + live serving |
| High | release provenance 硬编码 placements[0..2]，不能证明动态 manifest 对齐 | `public-content-audience.ts:25-55`; `CharacterRelease:1457-1485` | High | 发布时验证 manifest 并持久化 qualification/readiness；query 不按数组位置猜 |
| High | Chat send 没有跨客户端/BFF/Chat DB 的 intent key | `ChatSessionClient.tsx:251-309`; `chat/router.ts:30-36,105-108`; `chat/service.ts:321-382` | High | Chat schema additive key；transaction dedupe 返回原 turn pair；queue/SSE 复用 |
| High | Billing 在任何 dedupe 之前创建 provider invoice；UI 不发 key且把 unknown entitlement 压成空 | `UpgradeWorkspace.tsx:87-165,267-281`; `service.ts:4127-4150`; `schema.prisma:864-875` | High | provider 前持久化 CheckoutIntent；provider idempotency；所有按钮 pending；unknown fail closed |
| High | authority reducer 不携带 viewer/query/request/checkedAt；Generator 多个 private request 无 serial/abort | `authority-state.ts:1-72`; `GeneratorWorkspace.tsx:361-379,451-557` | High | scoped reducer + discard/abort；同 scope stale，跨 scope clear |
| High | 每 1.8s 既刷新 job list 又逐 job 请求，无 in-flight/backoff/visibility guard | `GeneratorWorkspace.tsx:669-691,719-729`; `service.ts:2906-2936` | High | 单一 active refresh；terminal transition 才取 detail/assets；有界 backoff |
| Medium | missing DTO 字段被转成空数组，Chat raw unknown error message 返回客户端 | `UpgradeWorkspace.tsx:62-69`; `CreatorProfileClient.tsx:46-59`; `chat/router.ts:45-56` | High | touched contracts 用 shared schema/safeParse；malformed != empty；稳定 public code + requestId |
| Medium | collection 只排 synthetic；feedback 只凭非空 sourceKey 即可公开 | `public-content-audience.ts:98-132`; `media-asset-authority.ts:71-76` | High | collection item 用完整 publishability；feedback 要 official authority 或 active customer owner |
| Medium | Upgrade 先渲染通用 Create/Explore hero，削弱结算任务主行动 | `OurdreamRoutePage.tsx:122-153,808-813` | High | Upgrade 使用任务型 header；checkout/return 为唯一视觉主路径 |
| Low | Main package 仍是 website-cloner 模板元数据 | `packages/main/package.json:5-24` | High | 机械修正，不改变 runtime |

### 13.6 旧数据与冷启动的迁移顺序

不能通过直接收紧 where 把页面突然清空，也不能为了页面丰满继续承认无权威 legacy 数据。采用可回滚的四段式 cutover：

1. **Inventory only**：统计 official/user、legacy、null image、null serving、unpublishable asset、broken collection、weak feedback，并保存 ID + 原因；不修改任何记录。
2. **Additive authority**：为可证明的官方/用户公开内容建立或回填 canonical MediaAsset、Release、Serving/qualification；保留原主键、owner、时间、内容和用户历史，不覆盖用户生成记录。
3. **Repair queue**：无法自动证明的记录不删除，变为 personal/private 或 operator repair 项；页面不能把它们计入 public，但后台可修复后重新发布。
4. **Strict read Gate**：只有 pre/post 计数、抽样、迁移 idempotency、catalog probe 和页面空态都通过后才切换。若官方目录最终为零，页面显示真实平台空态 + Create，不制造假角色；若有合法官方内容，则继续作为冷启动供给。

这正面回答“之前的数据怎么办”：**数据保留，公开资格被迁移或隔离；个人历史不被官方内容替代，官方内容也不冒充个人历史。**

### 13.7 测试架构与缺口

```text
BOOTSTRAP
  unsafe URL --------> reject before connect
  owner A ------------> advisory lease -> reset -> sync -> seed -> run -> teardown
  owner B ------------> bounded wait / actionable conflict; never DROP during A

PUBLIC AUTHORITY
  official/customer -> canonical asset/release/serving -> visible
  legacy/null/broken -> inventory -> backfill or repair queue -> not visible

AUTH
  test header + APP_ENV=test -> allowed
  forged header in dev/preview/prod -> 401/403
  signed BFF + valid session -> allowed

CHAT
  intent key -> first commit -> lost response -> replay -> same message IDs/one queue effect

BILLING
  intent key -> durable pending -> provider once -> stored result -> replay

UI / GEN
  scope A request -> logout/login B -> A late response discarded
  one active-job refresh -> terminal transition -> detail/assets -> partial or complete
```

**已有高价值覆盖**：auth safe return、Create、Chat persistence、Generate、Upgrade/Profile、mobile Explore/Generator、empty/error、Main BFF/SSE/DB/outbox、generation artifact/ledger 等已有 E2E/integration 雏形。

**必须补齐**：

- 两个并发 Main Vitest bootstrap 与两次连续 full run。
- dev/preview/prod forged-header matrix。
- Chat lost response / two-tab / concurrent replay。
- Billing provider call-count / invoice / session / subscription / ledger 全链幂等。
- A → logout → B 的所有 private query late response。
- public legacy/null/dynamic manifest/archived-rejected/weak feedback 负例。
- Generation partial output、hidden tab、overlap、100 users × 4 jobs load gate。
- malformed 200、error redaction、390/768/1280、focus/IME/live-region。

详细测试产物：`/Users/kk/.gstack/projects/mliu62868-idream/kk-master-eng-review-test-plan-20260716-171818.md`。

### 13.8 Failure Modes Registry

| Path | Failure | Rescued | Test | User-visible | Critical |
| --- | --- | --- | --- | --- | --- |
| Vitest bootstrap | 第二进程删掉 active schema | 计划后是 | 两进程 collision | N/A | Yes |
| Vitest target | 远端 `*_test` 或错误 schema | 计划后是 | guard matrix | N/A | Yes |
| Public catalog | legacy/null/broken authority 被公开 | 计划后是 | predicate + catalog probe | 合法内容或真实空态 | Yes |
| Public backfill | 自动无法证明 provenance | 是 | dry-run/idempotency | 不公开；进入修复队列 | No |
| Auth | forged user/role header | 计划后是 | env matrix | 401/403 | Yes |
| Chat POST | commit 后响应丢失 | 计划后是 | replay/concurrency | 恢复原发送状态 | Yes |
| Chat SSE | stream 中断 | 部分已有 | cursor reconnect E2E | Reconnect，不丢已持久化消息 | Yes |
| Billing | invoice 已创建但响应丢失 | 计划后是 | provider counter | Resume checkout | Yes |
| UI refresh | A 的响应落入 B 的页面 | 计划后是 | delayed response | 不显示跨用户内容 | Yes |
| DTO | malformed 200 | 计划后是 | contract negative | Data unavailable/Retry | No |
| Generation | 2/4 成功、2 失败 | 计划后是 | partial integration | 保留 2 个真实结果并说明失败 | Yes |
| Probe | 上游无响应 | 计划后是 | deadline test | timed out + remediation | No |

计划关闭后不得存在 “silent + untested” 的 critical path。

### 13.9 Performance / 10× 检查

- 立即修复：Generation 从 `1 + N`/1.8s 轮询改为每 workspace 一个 non-overlapping active refresh；hidden tab 暂停，失败指数 backoff + jitter，terminal transition 再取 detail/assets。
- 立即修复：Main → Chat 普通请求设置 connect/header deadline；SSE 使用独立较长 stream policy 和 cursor reconnect，不能共用短 timeout。
- 公开 audience 仍由数据库分页/索引筛选；qualification 在发布/回填时计算，不能在浏览器或每次列表请求解析全部 manifest。
- 受控 beta 本轮不拆 Chat web/worker、不迁移本地 memory 文件。先加入 timeout、graceful drain 与 stream recovery；单实例/共享存储/多 web worker 是公开上线扩容轨道。
- 验收记录请求率、DB connection、p95、error rate；没有基线数字就不能写“性能已解决”。

### 13.10 Security / Deploy / Rollback

部署顺序：

1. test harness guard/lease（无产品 schema）。
2. auth header boundary 与负例 probe。
3. additive Chat idempotency、CheckoutIntent、public qualification migrations；临时 PostgreSQL 做 fresh/upgrade/repeat/drift。
4. public inventory/backfill dry-run → apply → pre/post evidence；尚不切 read Gate。
5. UI scoped state、polling、DTO/error、Upgrade header。
6. strict public Gate + catalog/empty-state E2E。
7. full tests ×2、workspace check、PM2/listener/HTTP/browser/DB terminal truth。

回滚只回代码或关闭 strict read feature gate；additive columns/tables 保留，避免旧代码读不到 schema。backfill 必须幂等且记录 before/after；不通过 destructive cleanup 回滚。Chat/Billing schema 先部署、双写兼容后再依赖新 key。

### 13.11 Worktree Lanes 与冲突顺序

实现时每个 teammate 使用独立 worktree，root 负责按下列顺序合并；当前 194-file 用户 WIP 不 reset/stash/clean：

| Lane | Scope | 主要冲突 |
| --- | --- | --- |
| A | test harness + auth boundary | `vitest.config.ts`、auth/BFF |
| B | public inventory/backfill/strict audience | Main schema、audience predicate、migration |
| C | Chat intent idempotency | Shared contract、Chat schema/service、Main client/BFF |
| D | Billing CheckoutIntent | Main schema/service/Upgrade |
| E | scoped UI state + Generation polling + a11y | authority reducer、Generator/Profile/Chat |

合并顺序为 A → shared/additive migrations（B/C/D）→ server authority → UI consumers（E）→ strict Gate/docs。schema 冲突由 root 合并为同一 additive migration 序列；不允许各 lane 重排或修改用户已有 migration。

### 13.12 NOT in scope / What already exists / TODOs

**NOT in scope**

- 本轮不拆分 Chat web/worker 或引入新的共享存储架构；这是公开上线 10× 轨道。
- 不接真实外部支付、存储、监控凭据，也不把 mock 当 production ready。
- 不大规模拆 7,524 行 service 或多个超大 Workspace；只抽取本轮需要的 pure authority/intent helper。
- 不给 164 个 route 各写一套 E2E；核心深测、共享模板 smoke 的 taste 决策保持。

**What already exists**

- Generation 创建已经发送 `idempotency-key`，ledger/finalizer 也有幂等基础；本轮复用而非重写。
- Chat queue 使用 message ID/attempt dedupe，缺的是“用户发送 intent → message ID”前半段。
- Admin mutation transport 已有成熟 idempotency 模式，可借用 contract/error 词汇。
- Playwright 已有 managed 多服务环境、独立 DB/Redis/port；应作为唯一 E2E authority。
- Character backfill/release executor/media publishability 已有可复用的验证与修复框架。

**TODO auto-decision**：不创建根级 `TODOS.md`。实施任务继续归入本计划与 `REMAINING_WORK_EXECUTION_PLAN.md`；Engineering 聚合 JSONL 产物为 `/Users/kk/.gstack/projects/mliu62868-idream/tasks-eng-review-20260716-173000.jsonl`。

### 13.13 Engineering Implementation Tasks

- [ ] **E1 P0** — test bootstrap single-owner/non-destructive：loopback/CI capability guard、suite lease、workspace DB/Redis、并发/连续 full run。
- [ ] **E2 P0** — auth boundary：headers test-only、Chat signed BFF、role DB authority、forged-header probe、BFF deadline。
- [ ] **E3 P1** — public authority cutover：inventory、additive backfill/qualification、repair queue、strict audience、catalog proof。
- [ ] **E4 P1** — Chat send idempotency：shared key、schema、transaction replay、queue/SSE/browser proof。
- [ ] **E5 P1** — CheckoutIntent：provider-before-side-effect dedupe、concurrent replay、unknown entitlement UI。
- [ ] **E6 P1** — scoped UI authority：viewer/query/request/checkedAt/stale/partial + safeParse。
- [ ] **E7 P1** — Generation bounded polling/partial truth/load gate。
- [ ] **E8 P1** — Next route error boundary + focus/live-region/390/768/1280 closure。
- [ ] **E9 P2** — package identity + one-command health/document truth。

### 13.14 Engineering Completion Summary

| 项目 | 结果 |
| --- | --- |
| Step 0 scope | 不缩减；从 UI 空态上溯到 authority + intent + test truth |
| Outside voices | independent 8 findings；Codex 6 findings |
| Architecture | one public authority、scoped private read、durable writes、single-owner tests |
| Code findings | 2 critical、6 high、3 medium、1 low |
| Test plan | 已写入 gstack artifact；critical/unit/integration/E2E/perf/deploy 全覆盖 |
| Failure registry | 12 paths；所有 critical 均有 rescue + test 计划 |
| Performance | polling/BFF 立即修；Chat topology 延至 public launch 轨道 |
| Security | 纠正 CEO 旧结论；auth/test reset 为 P0 |
| NOT in scope | 4 项 written |
| What exists | 5 个可复用 authority 模式 |
| TODO updates | 0 parallel TODO；任务保存在计划 + JSONL |
| Runtime status | 尚未健康；full suite race 已复现，必须实施后重认证 |
| Engineering plan score | 4/10 → 10/10 specification completeness |

## 14. Phase 3.5 — Developer Experience / 可复跑健康证据

### 14.1 Product Type、Mode 与 Developer Persona

- Product type：内部 Platform + CLI/脚本 + Documentation；不是对外 SDK。
- Mode：**DX POLISH**。功能入口已经很多，本轮目标是把正确路径变成默认且可信，而不是扩张新工具表面。
- Primary persona：正在现有大工作区中修主站的 iDream 工程师或 coding agent；会并行开多个终端/worktree，需要在 2 分钟内得到第一条可信反馈，在 30 分钟内获得可审计的受控 beta 结论。

```text
TARGET DEVELOPER PERSONA
========================
Who:       熟悉 TypeScript/Next/Prisma，但不应先理解全部 5 个 package 的产品工程师或 coding agent
Context:   接手现有 WIP，修一个主站缺陷，并判断改动是否破坏 DB、Chat、Gen、Billing 或浏览器旅程
Tolerance: 2 分钟得到首个可信信号；10–12 分钟 Main 认证；30 分钟受控 beta 认证
Expects:   一条命令准备/检查依赖；测试不会删错库；失败指出根因、修复和精确重跑；报告区分 beta 与 public launch
```

### 14.2 Developer Perspective（Empathy Narrative）

> 我打开 README，看见 `bun install`、`bun run test`、`bun run check`，但不知道 Postgres 5433、Redis、测试库和浏览器是不是已准备好。我想先跑一个纯函数测试，于是看到 `test:unit`，却发现它仍会重建整座数据库和 seed。第一次全量告诉我 41 个失败；第二次只剩两个 assertion 和若干缺表；再重试，`db-push` 刚说同步完成，seed 就说 `users` 不存在。此时我无法判断是我的代码、测试顺序还是另一个 agent 在删 schema。文档说 `fileParallelism:false` 已避免并发，但它只约束一个 Vitest 进程。随后我跑 E2E，文档让我先启动 dev server，实际 Playwright 却拒绝复用并自己启动四个服务，CI 又走第三条路径。我最终需要手工查进程、解析 JSON、拼接 probes，才能得到一个仍无法复查的结论。理想体验是：doctor 先告诉我依赖和 authority；秒级/两分钟 fast tests 不碰 DB；full Main 拿到清晰 lease；managed E2E 自己拥有环境；最后 `verify:beta` 给出 commit、环境指纹、每个 Gate、首个根因、精确重跑和 artifact 路径，并明确写着 public launch 未被认证。

该叙事与本轮实际失败路径一致，不需要假设新用户犯错；当前工具把系统不确定性转嫁给了开发者。

### 14.3 Competitive / Official Benchmark

| Benchmark | 行业/官方能力 | iDream 当前 | 计划后 |
| --- | --- | --- | --- |
| Vitest lifecycle | `globalSetup` 可返回 teardown，适合在整轮持有资源；Projects 可分 unit/integration | setup 只 reset/seed，不持跨进程 owner；所有测试共用一份 destructive config | lease 保持至 teardown；fast unit 与 leased integration 分开 |
| Playwright servers | `webServer` 原生支持一个或多个受测服务与 readiness | 本地 config 已管理 4 个服务，但 CI 又手工起 Main/DB | config 是唯一 authority，CI 只调用 test:e2e |
| Verification evidence | 一次运行应输出可机读状态、artifact 与明确失败 | `check`、tests、E2E、migration、probes、PM2 分散 | `verify:main` / `verify:beta` 汇总，public launch 单独 Gate |

参考：[Vitest globalSetup](https://vitest.dev/config/globalsetup.html)、[Vitest Projects / v4 migration](https://vitest.dev/guide/migration)、[Playwright webServer](https://playwright.dev/docs/test-webserver)。

独立 DX 代理与 Codex DX reviewer 各提出 8 项，7 个主题形成共识：跨进程 test authority、虚假的 unit 分层、CI/managed E2E 拓扑冲突、缺单一 beta verdict、testing docs 漂移、结构化证据不足、beta/public Gate 不够易发现。独立代理额外发现 probe deadline 缺口；Codex 额外指出已有 `launch:probe:pipeline` 会生成 `internal-pipeline-beta` 报告，应被复用而不是另造 aggregator，同时 README 的“local product flows pass”和 mock E2E 边界已经过时。两项均已进入 X4–X7。

### 14.4 TTHW 与 Magical Moment

当前 Time to Trusted Health：**>10 分钟且在并发 race 下无上界（Red Flag）**。目标分层：

| Signal | 目标 | 意义 |
| --- | --- | --- |
| `bun run doctor` | ≤30s | 依赖、端口、DB/Redis target、并发 owner、浏览器存在性 |
| `bun run test:main:fast` | ≤2min | 不访问 Postgres/Redis 的第一条可信代码反馈 |
| `bun run verify:main` | ≤12min | leased Main full tests + lint/typecheck/build + structured report |
| `bun run verify:beta` | ≤30min | migration + workspace tests + managed E2E + probes + process/DB terminal truth |

Magical moment 是一条命令后得到下面这种结论，而不是更多日志：

```text
CONTROLLED BETA VERIFICATION — 5f8098e
✓ doctor / authority targets
✓ Main full tests (run 1 + run 2)
✓ migrations fresh / upgrade / drift
✓ managed browser golden journey
✓ Chat + Gen persistent terminal facts
VERDICT: CONTROLLED_BETA_READY
PUBLIC_LAUNCH: NOT_EVALUATED
REPORT: .tmp/verification/5f8098e-20260716T.../report.json
```

失败时同一位置输出 `stage / code / cause / owner / remediation / exact rerun / artifact`。runner 绝不自动 kill 其他进程；stale lease 的回收必须显式且可审计。

### 14.5 Developer Journey Map

| Stage | 当前摩擦 | 计划后的默认路径 | Escape hatch |
| --- | --- | --- | --- |
| Discover | README 只有命令清单，无健康路径 | README 首屏指向 `doctor → fast → verify:main → verify:beta` | 各 package 仍可单独运行 |
| Prepare | 不知道 PG/Redis/Chromium 是否可用 | doctor 输出 target、版本、端口和修复命令 | 显式 `TEST_DATABASE_URL`/prefix，但通过安全 guard |
| First signal | `test:unit` 仍 reset/seed | fast project 完全无 infra | focused file/tag |
| Integrate | 第二进程可删除 active schema | lease owner + bounded wait + unique namespace | 显式独立 worktree DB/prefix |
| Browser | docs/CI/manual server 与 managed config 冲突 | Playwright config 统一管理 Main/Admin/Chat/fixture | 自定义 loopback port/base URL |
| Diagnose | info logs + terminal text淹没首因 | concise progress + JSON/JUnit + first-root-cause summary | `--verbose` 查看完整日志 |
| Certify | 手工拼 check/migration/probe/PM2 | verify runner 生成单一 evidence bundle | `--from-stage` 精确续跑；跳过项只能得到 partial，不得 ready |
| Launch | beta 与 public Gate 容易混淆 | 报告明确 `PUBLIC_LAUNCH: NOT_EVALUATED/BLOCKED` | 独立 `check:launch` 使用真实生产输入 |

### 14.6 First-time Developer Confusion Report

| Confusion | Evidence | Resolution |
| --- | --- | --- |
| 需要先起哪些基础设施 | README `Common Commands` 未给 prerequisite/doctor | doctor + copy-paste prerequisite |
| `test:unit` 是否真是 unit | `packages/main/package.json:37-41` 三个脚本同为 `vitest run` | 独立 fast config/project；命名与行为一致 |
| `fileParallelism:false` 是否防其他终端 | `vitest.config.ts:17-19` 只影响当前进程 | suite lease + 冲突 owner 提示 |
| E2E 要不要先起 server | testing doc `:125-135` 与 `playwright-environment.ts:40-53,157-210` 相反 | managed-only docs/CI |
| `check` 是否代表健康 | root `package.json:23-27` 不含 tests/E2E/migration/probes | verify:main/beta；check 保持快速静态 Gate |
| full test 为什么 41→2→缺表 | CI/本地缺结构化 root-cause 和 env fingerprint | JSON/JUnit、schema/seed fingerprint、lease owner |
| probe 卡住是否仍在工作 | probe fetch/spawn 无统一 deadline | request/step/aggregate deadline + duration |
| beta green 是否等于可公开 | README 与计划虽提示，但无单一 report 字段 | report 强制 public launch 状态独立 |

8/8 confusion 均进入实施或文档任务；没有用“工程师应该知道”搁置。

### 14.7 Eight DX Passes

| Pass | 当前 → 计划 | Gap to 10 / 决策 |
| --- | --- | --- |
| 1 Getting Started | 4 → 9 | doctor + 四级命令；10 分还差首次安装/infra 下载成本 |
| 2 API/CLI Design | 5 → 9 | 动词和层级稳定；默认正确、override 显式；不把 partial 命名 ready |
| 3 Errors & Debugging | 5 → 9 | 每错包含 problem/cause/fix/rerun/artifact；保留 verbose escape hatch |
| 4 Documentation | 4 → 9 | README 与 testing/operations 从实际 config 反推；删除旧规模/旧 E2E 路径 |
| 5 Upgrade & Migration | 6 → 9 | fresh/upgrade/repeat/drift 进入 verify:beta；additive migration 有 rollback 说明 |
| 6 Environment & Tooling | 3 → 9 | lease、workspace namespace、managed Playwright、fast unit；不再共享隐形 authority |
| 7 Community & Ecosystem | 6 → 8 | 对内部产品解释为可搜索 runbook、owner 与 agent-safe conventions；不造外部社区工作 |
| 8 Measurement & Feedback | 4 → 9 | duration、first failure、slow tests、flake/retry、artifact/commit/env fingerprint 可趋势化 |

### 14.8 DX Scorecard

```text
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                            |
+====================================================================+
| Dimension            | Score  | Prior  | Trend                     |
|----------------------|--------|--------|---------------------------|
| Getting Started      | 9/10   | 4/10   | +5                        |
| API/CLI/SDK          | 9/10   | 5/10   | +4                        |
| Error Messages       | 9/10   | 5/10   | +4                        |
| Documentation        | 9/10   | 4/10   | +5                        |
| Upgrade Path         | 9/10   | 6/10   | +3                        |
| Dev Environment      | 9/10   | 3/10   | +6                        |
| Community/Ecosystem  | 8/10   | 6/10   | +2                        |
| DX Measurement       | 9/10   | 4/10   | +5                        |
+--------------------------------------------------------------------+
| TTHW                 | <2 min | >10/unbounded | Champion target     |
| Competitive Rank     | Champion fast signal / controlled full gate  |
| Magical Moment       | designed via one evidence-bundle command      |
| Product Type         | Internal Platform + CLI + Docs                |
| Mode                 | DX POLISH                                     |
| Overall DX           | 8.9/10 | 4.6/10 | +4.3                      |
+====================================================================+
```

### 14.9 DX Implementation Checklist

- [ ] doctor 在 30 秒内给出依赖/authority/修复命令。
- [ ] fast test 不连接 Postgres/Redis，目标两分钟内。
- [ ] integration/full 持有 suite lease 并报告 owner/wait/timeout。
- [ ] 所有错误包含 problem + cause + fix + exact rerun + artifact。
- [ ] Main 与 beta 各有一个 opinionated command；partial 不能冒充 ready。
- [ ] Playwright local/CI 只有 managed environment 一条 authority 路径。
- [ ] probes 有 request/step/aggregate deadline 和可覆盖默认值。
- [ ] migration fresh/upgrade/repeat/drift 进入 beta Gate。
- [ ] JSON/JUnit/slow tests/logs/commit/env/schema fingerprint 可持续保留。
- [ ] README/testing/operations 与真实 scripts/config 同步。
- [ ] public launch 始终是独立严格 Gate。

### 14.10 DX Implementation Tasks

- [ ] **X1 (P0, human: ~6h / CC: ~50min)** — Test authority — 跨进程 deterministic lease/guard/namespace；与 E1 合并实施，不重复建第二套机制。
- [ ] **X2 (P1, human: ~5h / CC: ~40min)** — Test commands — 拆 `test:main:fast` 与 leased integration/full，修正 `test:unit` 语义。
- [ ] **X3 (P1, human: ~4h / CC: ~30min)** — Playwright/CI — 删除手工 E2E DB/server 路径，以 managed config 为唯一 authority。
- [ ] **X4 (P1, human: ~7h / CC: ~55min)** — Verification runner — 新增 doctor、`verify:main`、`verify:beta`；复用 `launch:probe:pipeline` 的 internal-beta aggregator，产出单一 evidence bundle。
- [ ] **X5 (P1, human: ~5h / CC: ~40min)** — Probe deadlines — HTTP/child/aggregate 分层 timeout、duration、remediation。
- [ ] **X6 (P2, human: ~4h / CC: ~30min)** — Docs — README/testing/operations 写成实际开发旅程并删除漂移数据。
- [ ] **X7 (P2, human: ~4h / CC: ~30min)** — Evidence — JSON/JUnit、first root cause、slow tests、fingerprint、CI artifact。

JSONL artifact：`/Users/kk/.gstack/projects/mliu62868-idream/tasks-devex-review-20260716-173001.jsonl`。

### 14.11 NOT in scope / What already exists / TODOs

**NOT in scope**

- 不把内部验证脚本包装成对外 CLI/SDK；目标用户是本仓库工程师/agent。
- 不建设外部 developer community、文档站或版本营销；内部 searchable runbook 足够。
- 不用远程缓存跳过 DB/E2E 真实性；只能缓存纯静态/纯 unit 的确定性输出。
- 不让 `verify:beta --skip-*` 仍返回 ready；skip 只产生 partial evidence。

**What already exists**

- Root scripts 已清楚分 package，Turbo 负责 workspace 调度。
- Main Playwright config 已能管理四个隔离 URL 服务与一个无端口的 Gen
  image/character-preview worker；后者使用 Playwright 1.61 原生
  `wait.stdout` readiness 与 graceful `SIGTERM`。五个进程受同一 run scope
  约束并共享隔离的 Redis/BullMQ 与 provider 配置；Main/Chat DB 和 Chat FS
  继续由该 run 独占。
- launch probes 普遍已有 `--report` 产物，适合被 runner 组合。
- migration/readiness/PM2/HTTP/Chat/Gen probes 已有各自权威，不需重写。
- Vitest 4.1.9 支持 global teardown 与 Projects/tags，可用于 lease 和 fast/integration 分层。

**TODO auto-decision**：不创建 `TODOS.md`。X1–X7 纳入本计划和 `REMAINING_WORK_EXECUTION_PLAN.md`；暂无未决 DX 问题。

### 14.12 DX Completion Summary

| 项目 | 结果 |
| --- | --- |
| Product type / mode | Internal platform + CLI + docs；DX POLISH |
| Persona | iDream engineer/coding agent；2m first signal / 30m beta proof |
| Empathy narrative | 基于本轮真实 41→2→missing-table 路径 |
| Benchmark | Vitest teardown/projects + Playwright managed servers |
| Magical moment | one-command evidence bundle，public launch 单独标记 |
| Journey | 8 stages，8 friction points 全部有 resolution/escape hatch |
| Outside voices | independent DX 8 findings；Codex DX 8 findings；7 个主题共识，2 个互补发现 |
| TTHW | >10m/unbounded → <2m first trusted signal |
| Overall | 4.6/10 → 8.9/10 plan completeness |
| Tasks | X1–X7；X1 与 Eng E1 去重 |
| TODO updates | 0 parallel TODO |
| Unresolved | 0 |

## 15. Cross-Phase Themes

| Theme | Phases / voices | High-confidence conclusion |
| --- | --- | --- |
| Truth before visual fullness | CEO + Design + Eng | 官方编辑内容是合法冷启动供给；个人空态必须诚实；legacy/synthetic/malformed 不能为了“好看”绕过 authority |
| Deterministic proof before completion claims | CEO + Eng + DX | 当前最大共同根因是测试/运行证据不可复跑；full suite lease、结构化 report、浏览器/DB 终态是完成前提 |
| Durable async intent and recovery | Design + Eng | Chat、Billing、Generation 必须区分 intent、persisted、streaming/processing、partial、terminal；写重试以服务端幂等为前提 |
| Scope identity prevents stale truth | Design + Eng | viewer/query/request scope 是 UI 权威的一部分；同 scope 可显式 stale，跨 scope 必须清空并丢弃 late response |
| Controlled beta is not public launch | CEO + Eng + DX | 本轮关闭本地/受控 beta 正确性；真实 provider、生产 metric、Chat 10× topology 保持独立严格 Gate |
| Preserve and migrate existing data | CEO + Design + Eng | 先 inventory，再 additive backfill/repair，最后 strict Gate；不删历史、不覆盖 owner、不把官方内容混入个人计数 |
| Risk-tier verification | CEO + Design + Eng | 核心交互深测；共享静态模板 smoke；避免 164 route 的重复 QA theater，同时不降低关键路径门槛 |

这些主题均在至少两个阶段或两种模型中独立出现；它们构成本计划的实施排序，而不是附加建议。

## Decision Audit Trail

| ID | Phase | Class | Decision | Principle | Result |
| --- | --- | --- | --- | --- | --- |
| D1 | CEO | mechanical | 以内部演示/受控 beta 为本轮完成口径 | completeness + explicit | accepted |
| D2 | CEO | taste | 核心交互深测、共享模板 smoke，不逐页深测 164 路由 | pragmatic + action | auto-decided; surface at gate |
| D3 | CEO | mechanical | 复用现有 provenance/audience/media/launch authorities | DRY | accepted |
| D4 | CEO | mechanical | 保留官方编辑内容，禁止虚构用户行为与指标 | completeness | accepted |
| D5 | CEO | taste | production metric certification 与 retention 实验进入下一独立轨道 | explicit + pragmatic | auto-decided; surface at gate |
| D6 | CEO | mechanical | 修正 main package 模板遗留元数据 | boil lakes | accepted |
| D7 | CEO | mechanical | 公开 launch Gate 不因内部演示而弱化 | completeness | accepted |
| D8 | Design | taste | Public character 以 Chat 为唯一主 CTA，Generate 为次级 | explicit + completeness | auto-decided; surface at gate |
| D9 | Design | taste | 个人空页保留独立官方灵感区，但不混入个人网格/计数 | completeness + truth | auto-decided; surface at gate |
| D10 | Design | mechanical | 初次 loading、同 scope refresh、跨 scope request 分开处理 | explicit | accepted |
| D11 | Design | mechanical | Chat/Generate 使用真实中间态与持久化终态 | completeness | accepted |
| D12 | Design | mechanical | 安全读请求可有界重试；写操作仅在幂等确认后重放 | explicit + pragmatic | accepted |
| D13 | Design | mechanical | WCAG 2.2 AA、390/768/1280、IME/safe-area/focus/live-region 成为硬验收 | completeness | accepted |
| D14 | Design | mechanical | 复用现有 shell、authority 和组件词汇，不创建新视觉系统 | DRY | accepted |
| D15 | Eng | mechanical | Main test DB 使用 suite-lifetime advisory lease；需要并行时显式唯一 namespace | explicit + completeness | accepted |
| D16 | Eng | taste | local/preview 默认不接受 plaintext auth header；仅 test 环境保留 | explicit | auto-decided; surface at gate |
| D17 | Eng | mechanical | 先 inventory/backfill 旧数据，再切 strict public audience Gate | completeness + reversibility | accepted |
| D18 | Eng | mechanical | public character 必须同时满足 publishable asset、published/ready release 与 live serving | explicit | accepted |
| D19 | Eng | mechanical | Chat/Checkout 以 durable intent key 覆盖 lost-response/concurrent replay | completeness | accepted |
| D20 | Eng | mechanical | private UI 状态以 viewer/query/request scope 隔离，malformed 不等于 empty | explicit | accepted |
| D21 | Eng | mechanical | Generation 使用单一有界 active refresh；terminal transition 才取 detail | pragmatic + completeness | accepted |
| D22 | Eng | taste | 本轮只加 Chat timeout/drain/recovery，不拆 web/worker；扩容进入 public launch 轨道 | pragmatic | auto-decided; surface at gate |
| D23 | Eng | mechanical | additive migrations 先部署并兼容，严格读 Gate 最后开启 | reversibility | accepted |
| D24 | Eng | mechanical | 不创建平行 TODOS；计划和 REMAINING_WORK 继续是 backlog authority | DRY | accepted |
| D25 | DX | mechanical | primary persona 为本仓库 engineer/coding agent，而非外部 SDK 用户 | explicit | accepted |
| D26 | DX | mechanical | 采用 DX POLISH：收敛现有入口，不扩张新平台表面 | pragmatic | accepted |
| D27 | DX | taste | `doctor → fast → verify:main → verify:beta` 成为默认健康旅程 | simplicity + completeness | auto-decided; surface at gate |
| D28 | DX | mechanical | unit/fast 不访问基础设施；integration/full 持有 suite lease | explicit | accepted |
| D29 | DX | mechanical | Playwright managed environment 是 local/CI 唯一 E2E authority | DRY | accepted |
| D30 | DX | mechanical | probe 使用 request/step/aggregate deadline，并允许显式 override | completeness | accepted |
| D31 | DX | mechanical | verification report 强制区分 controlled beta 与 public launch | explicit | accepted |
| D32 | DX | mechanical | partial/skip 永不返回 ready，runner 不自动 kill 竞争进程 | safety + truth | accepted |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR via `/autoplan` | 7 scoped decisions accepted；2 future tracks explicitly deferred |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 aggregated | CLEAR via `/autoplan` | 4 phase passes；25 concerns grouped and resolved in plan |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR via `/autoplan` | 12 findings；0 unresolved critical plan gaps；runtime still requires implementation |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR via `/autoplan` | score 5/10 → 10/10 specification completeness；7 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | CLEAR via `/autoplan` | score 4.6/10 → 8.9/10；TTHW >10m/unbounded → <2m first signal |

**CODEX:** Confirmed public authority bypasses, weak UI state semantics, E2E/CI topology drift, false unit lanes, and missing canonical beta verdict; all are mapped to E/U/X tasks.

**CROSS-MODEL:** Highest-confidence overlap is truthful cold-start data, deterministic test authority, scoped stale/partial UI state, idempotent async writes, and strict separation of controlled beta from public launch.

**VERDICT（实施前评审快照）:** CEO + DESIGN + ENG + DX PLAN REVIEWS CLEARED — ready for the user approval gate. 当时 runtime 尚未认证且实现未开始；当前执行事实与 pending Gate 以文档顶部 §0 为准。

NO UNRESOLVED DECISIONS
