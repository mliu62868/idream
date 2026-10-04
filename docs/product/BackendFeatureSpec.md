# iDream 后台功能规格

更新日期：2026-10-04

## 1. 目的

本文档定义完整对标 OurDream 的目标服务端契约：模块边界、产品实体、API、状态机、权限和 P0/P1 顺序。它不承担实现进度证明；目标态不得因写入本文就视为已落地。实现状态从 [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md) 定位，并以同一 source revision 的代码、数据库及运行证据核实；物理数据形状以 `packages/main/prisma/schema.prisma` 为准。下文实体是逻辑契约与字段清单，不要求另建同名物理表，也不把标为 P1 target 的实体误当已经实现。

产品分期与用户结果见 [PRD](PRD.md)，跨域验收见 [用户故事](UserStory.md) 与 [体检清单](ADMIN_PRODUCT_HEALTH_CHECKLIST.md)。费用承诺只在 [经济契约](ECONOMY_AND_PRICING.md) 维护；内容规则见 [内容政策](CONTENT_POLICY.md)。接口与持久化形状分别以 Main 路由、Shared 契约及当前 Prisma schema 为准。

### 1.1 从用户结果推导服务端责任

| 用户或运营要完成的事 | 成功结果 | 必须固定的权威事实 | 失败与恢复 |
| --- | --- | --- | --- |
| 找到并开始使用一个角色 | 发现、详情和新会话使用同一有资格的角色版本 | Main 的角色内容版本、公共 Serving/Release 与所有者边界 | 暂停、撤销或缺对象有明确结果，旧链接不能恢复公开资格 |
| 创建并持续维护角色 | 全部创建字段可恢复，私有角色可继续 Chat/Generate，图片留在同角色图库 | 内容版本、视觉身份、参考集和图片来源 | 未完成草稿保留；创作交接不创建 Release，不改变线上版本 |
| 发布角色 | 三个不同的合格产品槽位图片和内容版本形成不可变发布候选；发布后用户实际命中它 | 发布候选、校验记录、Release 与唯一 Serving 指针 | 缺图或来源漂移阻断发布；放弃候选后修复；回滚保留旧历史 |
| 完成一轮对话或媒体动作 | Main 接受选中回复，附件实际交付，用量和费用可核对 | Turn/attempt/Scene、工具效果、Delivery 和 ledger | 断流重连原 attempt；新重生成是显式命令；未知结果先核对原身份 |
| 收到图片、视频或语音 | 文件可用、归属正确、Gallery/Chat 可读，按接受的报价结算 | Request、Attempt、TerminalRecord、Artifact、Delivery、接受的费用条款 | 明确失败按契约退币；未知终态不得盲目再次调用 provider |
| 购买访问或充值 | provider 确认后恰好一次发放已购买权益或 coins | 不可变 offer、checkout、provider evidence、访问周期与 ledger | 回跳不证明收款；异常对账；正常访问退款与人工调币分别处理 |
| 求助、举报或申诉 | 原任务恢复、真实处置或退款与用户回执一致 | Case/Evidence、原领域命令、审计与验证结果 | 工单关闭不代替副作用；证据或权限失效时保留阻断原因 |

### 1.2 通用写入契约

接受命令前校验所有者、有效权限/权益、当前资格与版本；需要报价时固定服务端 quote/offer，客户端金额不构成授权。相同幂等身份和请求重放原结果，身份相同但参数不同返回冲突。领域变更、命令回执、账目与 Audit/Outbox 按对应事务边界提交。

响应区分拒绝、已接纳、执行中、明确终态、结果未知和投影延迟。超时或断网后先查原请求/命令；不得用新身份掩盖未知结果。成功验收包含消费面读回、持久化、唯一副作用及费用核对；HTTP 200、provider 成功和后台“已完成”标签均不能单独证明用户得到结果。敏感明文不进入通用日志或审计。

## 2. 后台模块边界

| 模块 | 负责范围 | P0 |
| --- | --- | --- |
| Identity & Session | 注册、登录、会话、受保护路由、账号状态 | 是 |
| Age & Compliance Gate | 年龄确认、成熟内容访问门、后续年龄验证预留 | 是 |
| Age Verification | 司法辖区/风险触发的第三方身份年龄验证、provider 状态、复验 | P0/P1 |
| Character Catalog | 角色资料、标签、筛选、搜索、排序、统计 | 是 |
| Character Detail | 角色详情、启动聊天、举报入口、公开/私有状态 | 是 |
| Chat | Main-owned Turn/附件/Scene、跨会话记忆、Pinned Memory/Custom Instructions、5 档或功能等价 conversation profiles、最多 12 角色 Group Chat、Voice Call、Product Action、消息/语音 entitlement 与账号边界 | P0 基础 / P1 深度 |
| Creator | 六步 Style/General/Face/Body/Details/Image 创建：Gender/Style/外观/发型/体型、personality/Soul、Voice、Occupation、hobbies/fetishes、relationship type、custom details、视觉候选/anchor、私有使用与公开发布；Quick Start 仅为可选预填 | 是 |
| Generation Presets | built-in/user/community presets、custom preset 创建、preset 分类 | P1 |
| Generation | 图片/视频 Request/Attempt、Create/Edit/Enhance、reference lineage、多 scene/voice video、队列、服务端报价与 dreamcoin、preset payload、交付资产、失败恢复 | 是，先图片 |
| Media Gallery | Images/Videos/Liked、filter、manage、download、delete、like | 是，基础 |
| Paid Access & Entitlements | 一次性周期访问、checkout、webhook、Premium/Deluxe 权益与 append-only ledger | 是 |
| Dreamcoin Coin Store | 与访问计划分开的 top-up offers、quote、一次性 checkout、provider confirmation、幂等 ledger 与购买历史 | P1 |
| Trust & Safety | 输入/输出审核、举报、审核队列、申诉、政策原因 | 是 |
| User Library | P0 Recent/Characters/Created/Presets/Media 完整资产与任务入口；Group Chats/Packs 为 P1 对标目标，未获发布 authority 时默认隐藏新任务入口，既有深链说明不可用原因与返回路径 | P0/P1 |
| Profile & Account | 余额、预付访问状态/重新购买、兑换码、推荐奖励、账号管理；偏好/通知 P1，语言仅在真实 i18n 后启用 | P0/P1 |
| Feed & Community | Feed actions、leaderboard、creator profile/levels、Creator Studio、collections/Packs、Dreamcoin/现金创作者收益 | P1 |
| SEO Content | sitemap 内容、文章、比较页、metadata | P1 |
| Support | P0 基础帮助、工单回执/客户回复/解决与信息隔离；P1 扩展反馈与内容 | P0/P1 |
| Affiliate & Partnerships | 公开 RevShare/CPA 条款、申请/审核、归因链接、素材、dashboard、佣金与对账 | P1 |
| Analytics | 产品事件、漏斗、风控指标 | P0 轻量 |
| Admin/Ops | 审核后台、用户/内容/任务管理、生成配置、产品配置、计费排障、审计 | P0 内部 |

## 3. 产品对象与必须保留的事实

下列是领域契约，不是建表清单。已实现物理名称和字段由 schema/Shared 维护；P1 对象仍是有效目标，不因当前缺实现而删除。

### 3.1 身份与账号

| 对象 | 必须保留的事实 |
| --- | --- |
| User / Session | 账号、凭据及会话身份、有效期、撤销/冻结/删除状态；密码与 token 只存安全摘要 |
| Age Gate Acceptance | 用户或匿名身份、确认时间、入口、政策版本；成人内容读取前检查 |
| Age Verification（独立目标） | provider verification 身份、触发依据、状态、验证/复验有效期；仅保留二值年龄结论，不接收原始证件或自拍 |
| Preferences | muted tags、通知、安全偏好、locale 与版本；语言入口需真实 i18n 能力 |
| Redeem / Referral | 奖励定义版本、兑换/归因身份、资格与账本引用；唯一发奖，不能重复领取 |

### 3.2 角色创作与发布

| 对象 | 必须保留的事实 |
| --- | --- |
| Character Content Version | 所有者、name/age、简介、opening message、Style/Gender、外观/发型/体型、personality/Soul、Voice、Occupation、hobbies/fetishes、relationship、custom/advanced details、标签和精确版本 |
| Creator Draft | 所有者、当前步骤、上述全部创建字段、预览 Request、选定身份图与恢复版本；提交时标签和内容原子保存 |
| Character Option Catalog（P1） | personality/voice/occupation/relationship/hobby/fetish 的选项、定义版本、可见性、排序与公开广度 |
| Visual Identity / Reference Set | immutable 身份版本/hash、prompt/traits/anchors、来源；参考集有有序 manifest、revision/hash、每个身份唯一 active revision，替换需 CAS |
| Character Image Library | 同角色图片、上传或生成的真实来源、文件可用性、基础检查、依赖和归档状态；创作用途不锁定产品槽位 |
| Creation Handoff | 指定内容版本、身份、参考集、可选择图片与仍需修复的项；不产生 Release 或 Serving 变更 |
| Release Candidate / Release | 冻结内容、身份、参考集、三张不同槽位图片及各自精确来源、校验版本/结果；发布快照不可变 |
| Character Serving | 唯一线上 Release 指针、版本、live/paused/retired；决定新公共读取和执行资格，已有会话保留原 pin |
| Catalog / Character Stats | 标签、公开资格、可解释的 views/likes/interaction 口径；成功回复数不能冒充会话数 |

角色 `age >= 18` 与 `underage/minor/csam` 基础拦截不可关闭。日常创作不设人工评分或逐图批准。来源、采用与发布的详细不变量见 [角色素材权威](../architecture/16-character-asset-studio-authority.md)，操作见 [运营手册](CHARACTER_ASSET_STUDIO_OPERATIONS_GUIDE.md)。

### 3.3 Chat

| 对象 | 必须保留的事实 |
| --- | --- |
| RecentChat / ChatTurn | Main-owned session/Turn 身份、当前修订/attempt、所选回复、content/Release pin、Scene、状态、用量、幂等回执与终态证据 |
| ChatTurnAttachment | 当前 attempt 的 Product Action、Generation/Media 引用与 Delivery；Video 需显式 capability |
| Pinned Memory / Custom Instruction（P1） | 用户、角色/会话范围、内容版本与状态，由 Main 投影到 Turn context |
| Experience Preference（P1） | conversation profile、response length、scene generation、active messages、interaction intensity 与版本 |
| Group Chat / Voice Call（P1） | 最多 12 角色及各自内容/Release/Voice pin、参与顺序、call 状态、实际时长、用量/结算与终态证据 |
| AgentRun / DSH workspace | Chat 本地执行、接纳、恢复与 Main ACK 未定的候选证据；normal 记忆从已提交 Turn 派生，private 不加载长期记忆 |

Main PG 是产品聊天事实权威，Chat 无数据库。内部执行协议与内嵌 DSH/igrep 边界见 [ADR-21](../architecture/21-companion-chat-deep-runtime.md)。

### 3.4 生成、媒体与作品

| 对象 | 必须保留的事实 |
| --- | --- |
| Generation Request | 用户/角色/Release/身份/参考来源 pin、接受的 controls/brief、expected count、quote、幂等身份和最终业务结果 |
| Attempt / Transport Execution | 业务 attempt 身份/编号、路线与 workflow 版本、每次真实 provider invocation、provider request/idempotency、耗时/费用及单调事件序号 |
| TerminalRecord / Artifact | 不可变 checksum/产物/provider/usage；每项产物的有效性、归档与资产身份 |
| Delivery / Settlement | 每项产物是否交付到原目标；Request 与 append-only ledger 的扣退关联，结算不覆盖执行状态 |
| Media / Preset / Collection | 所有者、角色、生成或上传来源、可见性、安全/生命周期、真实文件、like/collection 关系；preset 定义版本与 built-in/user/community 范围 |
| Pack（P1） | creator/Character、catalog version、币价、future-items 条款、ordered media、发布资格；购买固定版本、报价、账本与永久访问权 |
| Comic（P1） | creator、内容版本、episodes/pages 的有序 manifest、媒体来源与发布状态 |

### 3.5 访问、购买与账目

| 对象 | 必须保留的事实 |
| --- | --- |
| Plan / Coin Offer | 周期访问或独立充值、价格/币种、币量、能力与定义版本/有效期 |
| Checkout / Provider Evidence | 用户、购买种类、不可变 offer、provider invoice/event、金额/币种、确认状态与回执 |
| Prepaid Access | 用户、原 checkout/offer、激活/到期/退款状态、权益周期和唯一 grant；物理 `Subscription` 名称不代表自动续订 |
| Entitlement | 原购买 offer 与独立授予派生的能力、范围和有效期；后续改 Plan 不改旧购买 |
| Dreamcoin Ledger | 唯一类型化写入、append-only delta/reason/source、幂等身份与派生余额；充值不创建或延长访问周期 |

费用、grant、失败退款、正常 provider 退款和人工补偿遵循 [经济契约](ECONOMY_AND_PRICING.md) 及 [账务权威](../architecture/08-billing-and-entitlements.md)，不在这里重复数值。

### 3.6 安全、客服与后台

| 对象 | 必须保留的事实 |
| --- | --- |
| Policy / Moderation Event | 已发布政策版本、目标/层/结果、实际机器码与必要证据；固定 mock 不宣称完整语义分类覆盖 |
| Report / Appeal / Typed Case | reporter/目标/类别、原决定、immutable Evidence、稳定 fingerprint、owner/SLA、允许动作、客户回复、处置与验证；申诉关联原决定 |
| Incident | 稳定故障 signature、每次 occurrence、影响/成本/退款、severity/owner/SLA、last-known-good、恢复计划与验证 |
| Admin Command / Approval / Audit | actor、effective permission、目标/预期版本、request hash/key、确认/理由、原子副作用与回执；Activity、Audit、经营 Decision 分别维护 |
| Config / Profile / Recipe | 已发布定义版本、能力/路线与报价边界、灰度、资格证据和回滚目标；生产密钥不进入后台 |
| Support Consent / Legal Hold | 逐目标授权、工单/案件、受权人、范围、时效或显式解除状态；明文访问另有每次审计 |
| Affiliate / Creator Economy（P1） | 发布条款/level 版本、申请/资格、链接归因、不可变来源、commission/earning、payout 与对账；重放不能重复计佣或结算 |

Affiliate、Creator Studio 的金额和效果只来自 canonical 归因、购买、ledger/settlement facts；数据不足时不伪造收益。平台配置不能覆盖成年硬边界、报价、原购买或历史账本。

## 4. Required State Machines

### 4.1 Character Lifecycle

```text
角色创作：草稿 → 内容/身份/角色图片库可交接 → 创作交接
发布运营：选择三个不同的产品槽位图片 → 不可变发布候选 → 自动检查/准备就绪 → 显式发布
线上服务：inactive | live | paused | retired
违规处置：举报 → 复核 → 限制/移除或无违规 → 申诉 → 保持或合法恢复
```

Rules:

- 私有保存、基础自动检查通过、创作交接、候选就绪与已发布是不同事实。私有使用仍受所有者、年龄、当前能力及基础拦截约束。
- 日常角色/素材没有人为打分或逐图审批关卡；候选的技术校验不等于公开发布，不改变“准备后显式发布”的边界。
- 公共可见性由 Main 的有效 Serving/Release 和受众规则决定，不能只读历史 `Character.status=approved`。
- 回滚从历史完整内容/身份/参考集/槽位快照创建新 Release，重新校验并记录 `rollbackOfReleaseId`，不改历史行。会话迁移另用显式高风险命令与影响预览，不能随线上回滚静默重绑。
- 下架与恢复分别执行领域命令；申诉翻案不能越过仍有效的其他限制。

### 4.2 Chat Message Lifecycle

```text
Main 接受产品 Turn → pending → Chat 接纳当前 attempt → generating
  → Main 接受 sent | blocked | failed | cancelled 终态
编辑/重生成 → 同一产品 Turn 的新修订/attempt → 重新核验资格和额度
传输断开 → 重连同一 attempt，不创建新的产品回复
```

Rules:

- Main PostgreSQL 是 Turn、当前 attempt、修订、Scene、用量与交付权威；Chat 的不可变终态候选只有通过 Main 的 exact-attempt CAS 才成为选中回复。
- 输入/输出基础检测与策略事件不构成第二套产品状态机；拦截返回明确产品原因并保留会话。
- 编辑/重生成遵循当前最后一个 Turn 的修订边界，保留原审计与 attempt 证据。
- 取消绑定用户观察到的 attempt；迟到命令或旧流不能取消/覆盖新 attempt。失败后重试恢复预留，已消费修订不再扣一份消息额度，详见 [ADR-21](../architecture/21-companion-chat-deep-runtime.md)。
- 陪伴记忆只由 Main 已提交 Turn 异步派生；删除/修订后的隔离期不召回被撤销内容，Agent 运行轨迹不写入记忆。

### 4.3 Generation Job Lifecycle

```text
Request：accepted → processing → succeeded | partially_succeeded | failed | blocked | cancelled | needs_reconciliation
Attempt：queued → running → succeeded | failed | cancelled | unknown
Artifact：produced → valid | invalid | archived
Delivery：pending → delivered | failed | suppressed
Settlement：按 ledger 关联派生，独立于上述执行状态
```

Rules:

- 接受前冻结 quote、路线、角色/来源与幂等身份；余额校验和负向扣币原子执行。
- Main 从不可变 TerminalRecord 接纳执行结果；成功必须包括有效资产和对应目标交付，未知结果不能伪装成失败退款后盲目重新调用。
- 部分成功保留已交付结果，未交付份额按原费用权威处理；失败、拦截、取消及晚到结果依当前状态机收敛，不能只凭 provider 回调决定扣退。
- 错误记录标准化原因、重试资格和操作者下一步。恢复已有终态只重投/修复交付；重新购买一次生成与恢复原请求必须区分。

### 4.4 Report Lifecycle

```text
open
  -> triaged
  -> reviewing
  -> actioned | no_violation | duplicate | escalated
  -> appealed
  -> closed
```

Rules:

- Underage reports are highest priority and may immediately hide target content.
- Reporter identity is not disclosed to the reported user.
- Every final decision needs a policy code and audit log.

### 4.5 预付访问与支付生命周期

```text
支付：invoice_created → awaiting_payment → confirming → settled
  或 underpaid | expired | failed | reconciliation_required
访问：可信结算 → active（至 periodEnd）→ expired
正常全额退款：active → refund_pending → refunded
provider 取消退款：在无冲突访问记录时恢复原周期、原权益与原 grant
```

Rules:

- checkout/invoice 与已激活访问周期分别表达；客户端支付回跳不发权益。
- 一次性加密预付，无自动续费；重新购买接受一份新的 offer。
- 权益由已购买不可变 offer 与有效独立授予派生；后来修改 Plan 不缩减原购买合同，客户端计划状态不能绕过门控。
- 正常预付访问退款走 provider 退款、冻结访问与精确 grant 冲销/恢复；人工补币只追加 `admin_adjust`，不能冒充真实退款。详见 [账务架构 §7](../architecture/08-billing-and-entitlements.md#7-正常预付访问退款争议到期)。
- 到期只影响新的高阶能力；既有聊天、已交付媒体和余额按经济契约保留。

## 5. API Surface

Use `/api/v1` for product APIs and keep public SEO pages server-rendered separately.

下表保留功能目标和当前可定位的 API 路线，不构成运行验收。用户浏览器 API 经 Main；路由以 [v1 dispatcher](../../packages/main/src/server/modules/ourdream/service.ts)、各领域 adapter 和 Zod 为准。尚无现行路线的目标用能力契约描述，不预造 URL。Admin 经独立 BFF 调 Main `/api/v2/admin/*`，以 §5.10 的 Shared manifest 为准；`Owner` 表示服务端核验当前用户及目标归属，Admin 身份不自动授予 v1 他人资源访问权。年龄、entitlement、公开可见性和当前版本仍须逐入口校验。

### 5.1 Auth & Session

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/auth/signup` | Public | Create user and session |
| `POST` | `/api/v1/auth/login` | Public | Login with email/password |
| `POST` | `/api/v1/auth/logout` | User | Revoke current session |
| `GET` | `/api/v1/me` | User | Current user, plan, entitlements, age gate |
| `PATCH` | `/api/v1/me/preferences` | User | Muted tags, notifications, locale |
| `POST` | `/api/v1/age-gate/accept` | Public/User | Store age gate acceptance |
| `POST` | `/api/v1/age-verification/sessions` | User | Start third-party identity age verification if required |
| `GET` | `/api/v1/age-verification/status` | User | Current verification requirement/status |
| `POST` | `/api/v1/age-verification/webhooks/:provider` | Provider signed | Verification provider callback |

### 5.2 Explore & Characters

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/characters` | Public after age gate | Search, filter, sort, paginate public characters |
| `GET` | `/api/v1/characters/:id` | Public after age gate | Character detail |
| `GET` | `/api/v1/characters/:id/voice-sample` | Public after age gate | Audio sample of the Character's bound voice (fixed text, synthesized once per voice profile version, free, rate limited); 404 when not visible or no bound voice |
| `POST` | `/api/v1/characters/:id/like` | User | Like character |
| `DELETE` | `/api/v1/characters/:id/like` | User | Unlike character |
| `POST` | `/api/v1/characters/:id/report` | User/Public optional | Report character |
| `GET` | `/api/v1/tags` | Public | Explore facets, category chips, and public character counts |
| `GET` | `/api/v1/search/suggest` | Public after age gate | Search suggestions |

Character list query:

```text
q, gender, style, age_min, age_max, tags[], sort, period, cursor, limit
```

### 5.3 Creator

完整 personality/voice/occupation/relationship/hobby/fetish Catalog、版本与对标数量是创建能力目标；当前模板与声音路线如下，不把它们等同于完整 Catalog 已兑现。

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/character-templates` | Public | Active creation templates |
| `GET` | `/api/v1/character-voices` | Public after age gate | Current draft voice Catalog |
| `POST` | `/api/v1/character-voices/preview` | User | Preview an eligible draft voice |
| `POST` | `/api/v1/character-drafts` | User | Create draft |
| `PATCH` | `/api/v1/character-drafts/:id` | Owner | Save draft fields |
| `POST` | `/api/v1/character-drafts/:id/preview` | Owner | Generate/update preview |
| `POST` | `/api/v1/character-drafts/:id/submit` | Owner | Save Character and prepare explicit publication after automatic checks |
| `POST` | `/api/v1/character-drafts/:id/tags` | Owner | Add/remove draft tags |
| `POST` | `/api/v1/characters/:id/duplicate` | User; eligible visible source | Create an independent private duplicate |
| `PATCH` | `/api/v1/characters/:id` | Owner | Edit own character; Admin management uses §5.10 |
| `DELETE` | `/api/v1/characters/:id` | Owner | Archive own character after dependency checks |

### 5.4 Chat

Browser Chat APIs enter Main. Main owns `RecentChat`、`ChatTurn`、`ChatTurnAttachment`、Scene、entitlement/usage 与 Generation/Ledger 写入；它把不可变产品执行快照交给 Chat。Chat 内部编译成 `PreparedTurn`，保存必要的本地恢复证据并回传终态候选，不拥有或直写产品聊天历史。下表描述面向浏览器的 Main API surface，内部执行端点可以不同；编辑、取消与流恢复必须同时满足 §4.2 的身份和修订边界。

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/chat/sessions` | User | Start or resume chat for a character |
| `GET` | `/api/v1/chat/sessions` | User | List user sessions |
| `GET` | `/api/v1/chat/sessions/:id` | Owner | Session detail and messages |
| `POST` | `/api/v1/chat/sessions/:id/messages` | Owner | Send message and stream/return assistant reply |
| `POST` | `/api/v1/messages/:id/regenerate` | Owner | Regenerate assistant message |
| `DELETE` | `/api/v1/messages/:id` | Owner | Delete message |
| `POST` | `/api/v1/chat/sessions/:id/archive` | Owner | Archive session |
| `DELETE` | `/api/v1/chat/sessions/:id` | Owner | Delete session |

Streaming can use SSE:

```text
POST /api/v1/chat/sessions/:id/messages
GET  /api/v1/messages/:assistantMessageId/stream?attempt=:attempt
```

编辑、取消、Group Chat、Voice Input/Call、记忆与 experience 设置的当前路线由 [Main Chat adapter](../../packages/main/src/server/bff/chat-proxy.ts) 维护；完整能力仍须满足 §4.2，不由上表的基础路线缩减。

### 5.5 Generation & Media

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/generation/quote` | User | Quote exact supported intent before acceptance |
| `POST` | `/api/v1/generation/jobs` | User | Create image/video generation job |
| `GET` | `/api/v1/generation/jobs/:id` | Owner | Poll job status |
| `POST` | `/api/v1/generation/jobs/:id/retry/quote` | Owner | Quote an eligible derived retry |
| `POST` | `/api/v1/generation/jobs/:id/retry` | Owner | Retry eligible failure |
| `GET` | `/api/v1/generation/video-sequences/capabilities` | User | Published sequence duration, orientation, quality and audio options |
| `POST` | `/api/v1/generation/video-sequences/quote` | User | Quote scene authorities, total cost and audio configuration |
| `POST` | `/api/v1/generation/video-sequences` | User | Accept exact quote and scene jobs atomically |
| `GET` | `/api/v1/generation/video-sequences/:id` | Owner | Sequence, scene jobs, composition and delivery status |
| `POST` | `/api/v1/generation/video-sequences/:id/stop` | Owner | Stop unstarted work and settle eligible refunds |
| `POST` | `/api/v1/generation/video-sequences/:id/retry-composition` | Owner | Retry packaging of completed scenes without regenerating them |
| `GET` | `/api/v1/generation/presets` | User/Public after age gate | Presets by `type`, `scope`, `category`, `q` |
| `POST` | `/api/v1/generation/presets` | User | Create user preset |
| `PATCH` | `/api/v1/generation/presets/:id` | Owner; built-in/community Admin | Edit own preset or governed shared preset |
| `DELETE` | `/api/v1/generation/presets/:id` | Owner | Archive own preset; governance uses §5.10 |
| `GET` | `/api/v1/media` | User | Gallery with `type=image\|video`, `liked=1`, cursor |
| `POST` | `/api/v1/media/:id/like` | Owner | Like own media |
| `DELETE` | `/api/v1/media/:id/like` | Owner | Unlike own media |
| `POST` | `/api/v1/media/bulk` | Owner | Bulk delete/visibility/collection operations |
| `DELETE` | `/api/v1/media/:id` | Owner | Delete own media after dependency checks |
| `GET` | `/api/v1/media/:id/download` | Owner | Download own media with current authorization |

Generation 浏览器 intent 包含模式、角色或 Freeplay、明确来源、prompt/controls/presets、输出数量与接受的服务端报价；合法字段与能力组合以当前 Shared/Zod 为准。客户端不传 provider payload 或伪造谱系。

Main 接受该 intent 后必须先锁定 exact Character/Release/VisualProfile、recipe/profile/workflow、服务端 quote 与 idempotency，再创建 Request aggregate 和 ledger reserve。Gen 随后通过 Attempt → TransportExecution → immutable TerminalRecord 执行，Main 只依据终态记录投影 Artifact → Delivery → Settlement；provider response 本身不能把 Job 直接标成已交付或已结算。

`POST /generation/jobs` 约束（目标行为；精确 Zod、费率与状态机分别以代码、`ECONOMY_AND_PRICING.md` 和 Generation deep module 为准）：

- `characterId` 与 `freeplay` 二选一；`prompt` / `negativePrompt` / premium model 服务端 entitlement gate。`outputCount` 复用 [Shared count schema](../../packages/shared/src/contracts/payloads.ts) 与 [请求 Zod](../../packages/main/src/server/modules/ourdream/generation-request-schema.ts)，实际可选数量由所选 profile 的 `maxCount` 和 quote 返回的 `costs` 决定；不另维护“默认 profile”上限。画幅、视频时长与质量同样按已发布 recipe/profile 校验，不把请求 schema 的宽范围当作已支持选项。
- **报价/扣费**：服务端按当前 recipe/profile、数量、pricing version 与 entitlement 生成 quote，公式只在 [经济契约 §1.2](ECONOMY_AND_PRICING.md#12-乘数在基础单价上叠加) 定义；客户端不得自算 cost。接受后负向扣币，交付与退款沿原费用事实收敛，未知终态先核对。
- **幂等**：客户端传 `Idempotency-Key` header，按 `(userId, key)` 去重，重复请求返回同一 job，不双建不双扣。
- **在途并发**：以 [服务端 admission](../../packages/main/src/server/modules/ourdream/generation-job-authority.ts) 的非终态计数和当前 entitlement 为准。当前实现读取 `MAX_INFLIGHT_JOBS_PER_USER`（有效正整数，否则默认 3），Deluxe 下限为 6；这是运行配置，不是固定计划权益承诺。超限返回 `429 rate_limited` 和 `active/max`，客户端不得绕过该事务边界。
- **余额**：`balance ≥ cost` 校验与 `-cost` reserve 在同一事务内（ECONOMY §1.3）；不足返回 `402 payment_required` 及结构化费用/余额，不入队；[错误码](../../packages/main/src/server/lib/errors.ts) 为响应权威。
- **video gate**：`video_gen` flag OFF 时 video 请求直接 402/403，不创建 job、不扣费。
- **retry**：资格由错误、交付、结算及当前来源/路线共同判定；用户显式重新生成按新报价接受 derived job，并保留 `derivedFromJobId`。系统恢复原 request/attempt 只重放其接受的事实，不借重试追溯改价；`blocked` 不自动重试，unknown 先对账。

普通视频与序列场景的时长/质量选择由 [production profile](../../packages/main/src/server/modules/generation/production-video-profile.ts) 和 [Shared sequence contract](../../packages/shared/src/contracts/video-sequence.ts) 维护；序列 quote 接受后冻结每场景 authority 与音频配置，总价归属经济契约。composition 失败保留完成场景，只重试合成；unknown 场景先核对，停止仅退尚未启动且合格的份额，不能把整个序列一概退币并重跑。

### 5.6 My AI / User Library

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/library/recent` | User | Recent characters and sessions |
| `GET` | `/api/v1/library/characters` | User | Saved/private characters |
| `GET` | `/api/v1/library/group-chats` | User | Owned Group Chats with cursor/search and participant summary |
| `GET` | `/api/v1/library/packs` | User | Created/claimed Packs and exact release access; paid purchases remain a target |
| `GET` | `/api/v1/library/presets` | User | Presets |
| `GET` | `/api/v1/library/created` | User | Created characters |

### 5.7 Profile & Account

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/profile` | User | Profile settings, balance, prepaid-access summary |
| `PATCH` | `/api/v1/profile` | User | Display name/avatar/profile settings |
| `GET` | `/api/v1/profile/preferences` | User | Preferences and notifications |
| `PATCH` | `/api/v1/profile/preferences` | User | Update preferences and notifications |
| `PATCH` | `/api/v1/profile/language` | User | Reserved target; enable only after a real i18n dictionary layer exists |
| `POST` | `/api/v1/redeem-codes/redeem` | User | Redeem code to ledger/entitlement reward |
| `GET` | `/api/v1/referrals` | User | Referral code, progress, rewards |
| `POST` | `/api/v1/referrals/invite` | User | Create/share referral invite payload |
| `POST` | `/api/v1/account/sign-out-all` | User | Revoke sessions |
| `POST` | `/api/v1/account/delete-request` | User | Start account deletion flow |

### 5.8 Billing

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/plans` | Public | Monthly/yearly prepaid-term offers; period labels do not imply renewal |
| `GET` | `/api/v1/billing/coin-offers` | Public/User | Published versioned coin-store offers and viewer eligibility |
| `POST` | `/api/v1/billing/checkout` | User | Create checkout session |
| `POST` | `/api/v1/billing/coin-checkout` | User | Create one-time top-up checkout from an exact offer version |
| `GET` | `/api/v1/billing/coin-purchases` | User | Own top-up purchase/confirmation history |
| `POST` | `/api/v1/billing/coin-purchases/:id/reconcile` | Owner | Reconcile original top-up provider evidence |
| `POST` | `/api/v1/billing/webhooks/:provider` | Provider signed | Payment and paid-access lifecycle webhooks |
| `GET` | `/api/v1/dreamcoins` | User | Current balance and ledger page |

### 5.9 Trust & Safety

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/reports` | User/Public optional | Report character, media, chat, user, or issue |
| `GET` | `/api/v1/reports/:id` | Authenticated reporter | Own report status; Admin triage uses §5.10 |
| `POST` | `/api/v1/appeals` | User | Appeal a moderation decision |
| `GET` | `/api/v1/policies` | Public | Current policy versions |

### 5.10 Admin/Ops Control Plane

Admin 通过独立 BFF 调 Main `/api/v2/admin/*`。真实 endpoint、Zod、读写权限与确认规格由 [Shared API manifest](../../packages/shared/src/admin/api-manifest.ts) 和 [权限契约](../../packages/shared/src/admin/permissions.ts) 维护，不另列一套旧 API。入口归属见 [导航](ADMIN_NAVIGATION.md)，逐项验收见 [体检清单](ADMIN_PRODUCT_HEALTH_CHECKLIST.md)。

| 运营任务 | 必须具备的能力与结果 |
| --- | --- |
| 今日工作 | Mine/Unassigned/Watching/All、服务端计数/排序/游标、排序原因、影响/owner/SLA、对象深链；验证失败重新入队 |
| 角色供给 | 角色/起始模板的一句话 AI 辅助预填及可编辑草稿、内容与身份创作、图片库/handoff、三槽位编排、preview、显式发布/暂停/回滚、结果监测及小样本提示；辅助结果不代替成年字段与基础校验 |
| 内容运营 | 外部制作后上传、图库搜索/tag/归档、展示位草稿/预览/验证/撤下、精选、CMS/SEO、公告、campaign/collection；保留来源与投放历史 |
| 用户与客服 | Customer 360、typed Case/Evidence、领取/转派、举报/申诉/账单争议、客户回复、解决/重开、账号请求和授权访问 |
| 生成与事故 | Request/Attempt/Transport/Artifact/Delivery/settlement 下钻、错误分类/建议、Incident occurrence 聚类、恢复/reconcile、合格重试/弃单与补偿 |
| 能力配置 | 工程提供候选 profile，运营 dry-run/样本/资格/发布/灰度/禁用/回滚；recipe 拼接预览、版本、sample matrix、preset 治理与 provider 健康 |
| 收入与营销 | offer/费率/权益的版本发布、checkout 对账、正常退款、独立人工调币、活动资格/唯一 grant 和兑换/推荐；费用规则引用经济契约 |
| 经营学习 | §8 的指标定义/质量/成熟度、角色与创作两条漏斗、实验/rollout 区分、Decision Record 和复查；无可信数据不能给因果结论 |
| 团队治理 | role 与逐用户 grant/revoke、审批、敏感访问、审计、脱敏导出；无权 UI/深链/API 均拒绝 |
| 平台扩展（P1） | 社区/Pack/Comic 发布与权益争议、Affiliate 申请/条款/归因/计佣/payout、Creator 资格与收益对账 |

**查询。** search/filter/sort/facet/cursor 在服务端执行，稳定 sort key + id 保证翻页，summary 基于完整查询。URL 与 typed query/saved view 对应，版本失效可修复；读回提供 asOf、freshness、projection version/lag，缓存按 effective permission/environment/query 隔离并随授权变化失效。异步导出固定授权、query snapshot、有效期与审计。

**命令与确认。** effective permission、目标版本、幂等 hash/key、资格与接受的报价统一在服务端校验。原回执先于可变 preflight；成功重放不因后来改价/改身份失效，同 key 不同请求冲突。批量先 preview 固定 eligible/skipped 目标、影响/费用、版本、集合 hash 和有效期，再按该 plan execute；过期或漂移重新 preview。写入事务同步保存领域变化、Audit/Activity 与 Outbox；长任务返回已接纳，完成需验证消费面。running/verifying 的 lease/heartbeat/attempt 有限，worker 崩溃由 reconciler 安全恢复或转需核对，不永久卡住。

非破坏单项使用 confirm；资金、发布/回滚、封号、权限及敏感访问使用理由和键入实体名称确认，并展示效果/可撤销性。具体 UI 由 `ConfirmSpec` 驱动。需要双人审批时 requester 与 approver 不同，审批人持实际操作权限，approval 绑定 commandType/目标/payloadHash/expectedVersion/有效期，双方留审计；这不增加日常角色或图片审核。

**恢复。** 浏览器发送前保存 actor/environment/resource 绑定的精确 intent/key；刷新、断网、两 tab 不换身份重复写。401/403 不是命令终态。未知接纳不能无限自动重放：超过 24h 或精确请求不能安全重放时保留 receipt/key 并进入显式 reconcile；已提交只读回精确投影，未提交由原授权/同一资源锁产生取消 tombstone，防迟到写。同角色互斥发布/暂停/回滚命令由服务端协调锁限制，浏览器不独占权威。每个 Character 恢复先授权该角色，回执 target/result 必须匹配；bootstrap 核对身份/参考集/anchor/草稿，采用核对实际槽位与 asset 后才解锁。

**明文与审计。** 通用日志、Audit before/after、DTO 与导出不含 prompt/chat/私有媒体或密钥。`support.plaintext.view` 必须再叠加用户显式逐目标 consent（默认 72h、只读、最小必要）或有案件依据的 Legal Hold；hold 由授权人员显式解除，留存依案件规则。每次查看有 reason、ticket/hold、actor、目标和时间审计；即使有 Admin 权限也不能泛读他人内容。客户回复与内部备注分开。

**Today / Case / Incident。** Today 是可重建的领域 projection，owner/SLA/priority/verification 来自源对象，watch/snooze/pin 只属个人偏好，不新增第二套任务状态。Case 以 subtype + target + fingerprint 保证 active 唯一，原请求/举报为不可变 Evidence；关闭需 resolution 与系统验证，无法自动验证的 override 必须有理由/审计。Incident 稳定 signature 使用 provider/profile/workflow key 和错误版本，不把时间/部署版本写入 signature；join-gap 版本化，split/merge/recur 保留原归属。resolved 需持续验证恢复率、错误增长、积压及受影响请求/账目，不由一次按钮成功决定。

**能力与投放发布。** profile/recipe 的资格、sample matrix、真实 provider/workflow、身份匹配、有效期与成本证据先于灰度；文件存在或 JSON 合法不等于可发布。模型评估独立于日常选图。关闭能力仍可读取历史产物/任务/账目；新报价和执行失败关闭。非角色投放仅提供有真实 runtime verifier 的槽位；候选 verifying 不覆盖上一条 passed 投放，验证通过后原子切换，失败保留旧投放。图库不是发布权威；任何归档/删除/改私有必须先检查角色身份/参考集、草稿、Look、Release、Run、Campaign/投放等依赖，锁后重读，批量全成功或全拒绝。复制角色创建独立私有媒体/bytes，不继承公开资格。Featured 配置顺序经版本 CAS 保存，实际 Feed 还须通过 public-audience predicate。

### 5.11 Feed & Community P1

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/feed` | User/Public after age gate | Recommended feed cursor |
| `POST` | `/api/v1/feed/restart` | User/Public after age gate | Reset recommendation cursor |
| `POST` | `/api/v1/feed/items/:id/like` | User | Like feed item |
| `DELETE` | `/api/v1/feed/items/:id/like` | User | Unlike feed item |
| `POST` | `/api/v1/feed/items/:id/share` | User/Public after age gate | Create/share link and log share |
| `POST` | `/api/v1/feed/items/:id/remix` | User | Start remix draft or generation flow |
| `POST` | `/api/v1/feed/items/:id/report` | User/Public optional | Report feed item |
| `GET` | `/api/v1/community/leaderboards` | Public after age gate | Dreamers/Characters/Collections rankings |
| `GET` | `/api/v1/community/collections` | Public after age gate | Public collections |
| `GET` | `/api/v1/packs` | Public after age gate | Published Pack catalog and exact release access summaries |
| `POST` | `/api/v1/packs` | User | Create own Pack draft from eligible sources |
| `PATCH` | `/api/v1/packs/:id` | Owner | Edit saved draft metadata and item manifest |
| `POST` | `/api/v1/packs/:id/publish` | Owner; public creator eligibility | Publish exact saved version after automatic/source checks |
| `POST` | `/api/v1/packs/:id/claim` | User | Claim exact release once; current grant does not charge coins |
| `GET` | `/api/v1/comics` | Public after age gate | Published Comics discovery cursor |
| `GET` | `/api/v1/comics/:id` | Public after age gate | Comic episodes/pages, creator and Chat/Remix provenance |
| `POST` | `/api/v1/comics` | User | Create own Comic draft |
| `PATCH` | `/api/v1/comics/:id` | Owner | Edit Comic metadata and ordered episode/page manifest while draft |
| `POST` | `/api/v1/comics/:id/submit` | Owner; public creator eligibility | Submit exact manifest for automatic checks and publication |
| `GET` | `/api/v1/creator-studio` | User; own creator state | Performance, level and available earning/payout summaries |
| `POST` | `/api/v1/users/:id/follow` | User | Follow creator |
| `DELETE` | `/api/v1/users/:id/follow` | User | Unfollow creator |

当前 Pack/Comic 路线以 [Pack adapter](../../packages/main/src/server/modules/ourdream/packs.ts) 和 [Comic adapter](../../packages/main/src/server/modules/ourdream/comics.ts) 为准。收费 Pack 仍是 P1 目标：Character/creator/price/version 摘要、精确报价与版本接受、幂等扣币/退款、购买访问和创作者收益对账均须兑现；现行免费 `claim` 不是已实现付费 purchase 的证明，不为未定义的购买接口编造 URL。

### 5.12 Affiliate & Partnerships P1

公开 RevShare/CPA 条款由已发布 CMS 版本提供，申请固定接受的条款版本。现行申请、dashboard 与归因路线如下；完整合作伙伴能力仍包含合格 affiliate 的 campaign link 创建/修改/归档、营销素材访问、佣金与 payout 对账，尚无当前路由的能力不另指定假端点。

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/affiliate/application` | User | Submit own application against published terms |
| `GET` | `/api/v1/affiliate/dashboard` | User | Own application/links/attribution/commission/payout state; actions require their qualification |
| `POST` | `/api/v1/affiliate/click` | Public, rate limited | Record deduplicated referral attribution |

## 6. Authorization Matrix

这是产品访问边界；实际操作由 §5.10 的逐权限校验决定。客服/审核对私有内容的访问仍须逐目标 consent 或 Legal Hold，普通 role 不授予明文访问或日常创作审批。

| Resource | Public | User | Owner | Admin/Moderator |
| --- | --- | --- | --- | --- |
| Public route content | Read | Read | Read | Manage |
| Age gate acceptance | Create anonymous | Create user-bound | N/A | Audit |
| Age verification | None | Create/read own status | N/A | Audit provider status |
| Public characters | Read after age gate | Read/like/report | Edit own if creator | Remove/review |
| Private characters | None | None | CRUD | Review if escalated |
| Character drafts | None | Create | CRUD own | Escalated support under consent/hold |
| Chat sessions | None | Create | Read/write/delete own | Review only if flagged/legal |
| Media assets | Public assets only | Own gallery | CRUD own | Remove/review |
| Generation presets | Built-in/community read | Create user preset | CRUD own preset | Manage built-in/community |
| Packs/Comics | Published catalog/read | Purchase/read access | Manage own drafts/releases | Review/remove/settlement support |
| Billing | Plans only | Own purchase/history | Own paid-access/receipt records | Authorized support/ledger view |
| Dreamcoin top-up | Offers only | Own checkout/history | N/A | Support/ledger audit |
| Profile/account | None | Read/update own | N/A | Support view limited |
| Referral/redeem | None | Own code/redeem | N/A | Audit |
| Feed/community | Read after age gate | Like/share/remix/report | Own content only | Remove/review |
| Affiliate | Published program terms | Apply/read own state | Manage own links/assets view | Approve/settle/audit |
| Reports | Submit | Submit/read own | N/A | Triage/decision |
| Admin queue | None | None | None | Granted scopes only |

## 7. 异步交付与恢复

| 边界 | durable 成功与恢复要求 |
| --- | --- |
| Main → Chat | Main 先提交 Turn/attempt 和执行快照；Chat 持久接纳，终态候选经 Main exact-attempt CAS/ACK；断流恢复原身份 |
| Main → Gen → Main | dispatch Outbox 固定 Request/Attempt；Gen 先保存不可变 TerminalRecord，再重投至 Main durable ingest；ACK 丢失不重新调用 provider |
| Main → Memory / projection | 只投影已提交产品事实；各 projector 独立 checkpoint、幂等、纠错与可重建，不阻塞 ingress 大事务 |
| Payment / reward | 签名与 provider event/offer 核验、receipt、唯一 ledger 与权益；异步重放不重复发币或激活 |
| Analytics | source key/hash、occurredAt/trust、canonical receipt 与本地 projection Outbox；冲突 quarantine，不静默覆盖或丢弃 |

接纳、执行、交付、持久化与结算分开。非幂等 provider 的调用结果未知时进入 reconcile，不盲目重试。队列名、producer/consumer 和内部格式由 Shared/package 契约维护，Chat 不使用数据库或 BullMQ。

## 8. 经营指标与实验

### 8.1 统一事实口径

经营指标只计算 production/customer、非 internal 的 eligible facts；canonical eventId 与 `(sourceService, sourceEventId)` 唯一，业务时间用源 `occurredAt`，产品日固定 UTC。`0/null/unknown/stale/invalid` 不互换。浏览器通用 track 是 untrusted；曝光采用有签发 context 的 typed client，成功交付/付费/Turn outcome 用 canonical 服务端事实。

Typed exchange 对逻辑 user Turn 稳定；重生成不增加 exchange，edit/delete/selection correction 只让当前 eligible selection 入指标。Main 固定 exchange/engagement/content/Release pins，不读取当前角色猜历史版本。缺上下文的历史标 partial/unavailable，不伪精确 backfill；历史与实时使用同一 transform 和幂等键。

### 8.2 指标定义

| 指标 | 定义与边界 |
| --- | --- |
| WPCU（official） | 自然周内有有效付费访问，且完成一次 eligible Main committed exchange 或成功 Generation Delivery 的独立用户 |
| QCE v1 | 同 user-character、UTC 日、engagement session 至少 5 个成功 exchange；blocked/error/cancelled/internal 排除 |
| Engagement Session v1 | 同 user-character 成功互动间隔达到 30 分钟后开启新窗口，不等于多日 ChatSession |
| WSCU / WSR（diagnostic） | rolling 7d 同 pair 在不同 engagement session/UTC 日完成两次 QCE，第二次开始距第一次完成至少 12h；分别计用户/pair |
| WPSCU（diagnostic） | WSCU 中至少一次 qualifying episode 发生时有有效付费访问的用户 |
| WSCrU（diagnostic） | rolling 7d 不同 Request、不同 UTC 日两次成功 Delivery，至少相隔 12h 的用户 |
| Chat/Relationship/Generation Activation | 同 signup cohort 的 24h 首次 QCE / 7d 达到 WSCU / 7d 首次有效 Delivery，分母须成熟 |
| Same-character D1/D7 / W1 return | 首次 QCE pair cohort 在 D0+1 / D0+7 的精确日返回；W1 为 D0+7 至 D0+13，不能累计冒充点回访 |
| Paid Conversion D7/D30 | 同已成熟 signup cohort 在 7/30d 首次有效付费；老用户的新购买不进入新用户分子 |
| Eligible Impression / Detail CTR / Chat-start | 卡片至少 50% 可见 500ms；journey+Character+placement 去重，exposure chain 关联 detail/首次成功 exchange，归因最长 24h |
| Exchange depth | 首次成功、5 次、20 次 distinct exchange 里程碑；重生成不累加 |
| QCE rate | 同版本 pair/session 的 QCE 数 / 首次成功 exchange 的 pair/session 数 |
| Full Fulfillment / Delivered Output | 全量 delivered valid count=expected 的 Request / accepted−user_cancelled；及 delivered valid outputs / expected outputs，partial/blocked/unknown 分列 |
| Business Attempt / Provider Invocation Success | terminal known Attempt 与 terminal TransportExecution 分别作分母，真实 invocation 成本可下钻，unknown 单列 |
| Incident Impact | 去重 affected eligible users、失败成本、退款和恢复覆盖 |
| Contribution Margin | 归因净现金收入减 Chat/Gen/Voice 可变成本、退款和 credits；币消费不是现金收入 |

陪伴归因固定 checkout 前 7d 的最后/其他 QCE Characters，创作归因同窗口成功 Delivery 的 route/purpose/可选 Character，Freeplay 单列，无证据保留 unattributed。非随机数据仅称 attribution/correlation。创作与陪伴漏斗分别追踪，角色漏斗固定 release/placement 版本。

### 8.3 Registry、认证与实验

Metric Registry 保存 business question、grain、分子/分母、source/trust/exclusion、cohort/window/timezone/maturity、dedupe/attribution、owner/version/queryHash、freshness、quality 和验证证据；后台只读核心公式。指标卡显示这些关键口径、样本量、成熟度和更新时间，缺覆盖或 freshness 则 invalid/stale，不造漂亮数字。

认证至少核验 outcome join coverage ≥99%、duplicate effect=0、版本 freshness SLO、无 fixture/internal 泄漏、成熟 cohort 和 impossible-state=0。阈值可经证据与版本决策调整；QCE 等定义更改保留旧版本报表。WPCU 的产品地位不因运行认证不足而换成诊断指标。

只有明确 hypothesis/primary metric/guardrails、稳定 subject+assignmentVersion、实际 exposure、control/variant、同 eligible cohort 的 certified 指标及成熟样本，才展示 experiment lift/区间；否则只展示 rollout monitoring。Decision Record 记录问题、证据/因果级别、owner、决定、成功标准、复查日和结果。

### 8.4 角色与创作运营效果

角色组合展示定位、服务版本、曝光→开聊→QCE→跨日关系、净现金/退款/成本及 Promote/Maintain/Improve/Pause/Retire 建议。默认比较 7d/28d、上一 Release 与同类 baseline，显示样本量/成熟度；`insufficient_data` 不自动淘汰角色。低 CTR 高留存检查包装/分发，高开聊低 QCE 检查 opening/Persona，高 QCE 低 D7 检查连续性/记忆，跨角色同期失败转 Incident。

创作衡量首个合格素材、创作交接、交接至上线时间、选用/变体选用比例、实际采用成本、发布校验失败率和操作次数；从版本/来源/交付事实派生，不以旧人工批准率替代日常结果。建立受控基线再设分层目标。

## 9. P0 Acceptance Criteria

- A first-time visitor must accept age gate before seeing adult Explore content or using Create/Generate/Chat.
- If identity age verification is required, the user cannot use gated routes until verification state is valid.
- An authenticated user can search/filter public characters and open a character detail page.
- An authenticated user can start a chat, send messages, refresh or return later, and continue the same Character/Soul/Scene/memory relationship from Main-owned history.
- An accepted explicit image/voice action has a truthful waiting/failure/delivery state, and replay/regenerate cannot duplicate execution or settlement.
- An authenticated user can complete the multi-step creator, recover every field, review visual candidates, select an identity anchor, save a private character into My AI, and continue to Chat or Generate; Quick Start may prefill but never replaces the full flow.
- An authenticated user can start an image generation job with selected character/Freeplay and presets, see status, and view completed media in Images.
- Premium/Deluxe-only controls are enforced server-side via entitlements.
- Dreamcoin changes are append-only ledger entries.
- Users can report characters, chat messages, and media; reports appear in an admin queue.
- Feed items expose report/share/remix/like APIs without leaking reporter identity.
- 既定 mock 的基础拦截产生正确拒绝与事件；举报/申诉按产品政策处置，不宣称未启用分类器覆盖所有类别。
- 目标 revision 通过仓库既有 `bun run check` 与相关 backend/service focused tests；公开完成声明还需对应 runtime/browser probe。

## 10. 性能与完成证据

下表是有效的首版验收目标，不是已测结果；任何调整须有基线与 Decision Record。

| 目标 | 验收门 |
| --- | --- |
| 首屏列表 / 详情 / Today | API p95 <500ms / <750ms / <1s |
| 命令接纳 / 搜索 | p95 <750ms / <800ms；长动作异步接纳 |
| Inbound/Outbox / 运维健康 / cohort freshness | p95 <60s / <2min / <15min |
| 高影响 Incident 检测 | 首次出现后 <5min |
| 状态违例 / 未知失败分类 | 0 / <5%，未知执行结果仍独立表达 |
| 大列表与故障容量 | 100k Jobs/Cases、1m Events 的服务端查询；DB/Redis outage、dispatcher/projector 重启与并发命令 |

监测 command outcome/lease、Audit 原子失败、durable ACK/outbox/projector lag、TerminalRecord replay、Incident/SLA 与 metric quality；日志只留身份、版本、结果、错误与耗时，不留敏感 payload。验收覆盖并发/重放/断流/迟到、partial delivery/refund、锁后依赖漂移、来源 hash 冲突、权限撤销、projector rebuild、成熟度/跨日/correction 反例和桌面/移动可访问性。核心界面目标为 WCAG 2.2 AA。


本文只定义目标后台契约，不维护逐项实现状态。当前代码、数据、运行证据和真实缺口分别以 [`CURRENT_FUNCTIONAL_COVERAGE.md`](./CURRENT_FUNCTIONAL_COVERAGE.md)、代码/数据库与 [`REMAINING_WORK_EXECUTION_PLAN.md`](./REMAINING_WORK_EXECUTION_PLAN.md) 为准。

任何目标域只有同时具备真实数据模型、权限、副作用、幂等/结算语义和同 revision 的 API/runtime/browser 证据，才能从 parity matrix 的 gap 升级为 `matched` 或 `equivalent`；本文件中的实体、API 或验收条目本身不构成完成声明。
