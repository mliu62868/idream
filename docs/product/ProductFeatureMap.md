# iDream 产品功能地图

更新日期：2026-09-05

> **本文档是 iDream 目标产品功能地图（价值层级 / 页面模板 / 导航图 / 功能模块矩阵），不描述实现进度。**
> 当前真实实现状态以 [`CURRENT_FUNCTIONAL_COVERAGE.md`](./CURRENT_FUNCTIONAL_COVERAGE.md) 为单一事实来源（SSoT），请勿在本文重新加入逐行实现状态列。

## 1. 产品功能层级与资料来源

iDream 按 OurDream 的完整用户任务对标，而不是只比较视觉页面或单一聊天能力：

| 层级 | 功能 | 产品职责 | 扩展门槛 |
| --- | --- | --- | --- |
| P0 访问与发现主链 | 年龄门槛、Auth、Explore、搜索/排序/筛选、角色详情、注册恢复 | 用户能发现角色并进入真实任务 | 不能用静态卡片或假 CTA 代替 |
| P0 创建与聊天主链 | 完整多步 Create、Soul/Visual Identity、私有/公开、Chat、历史、Scene、memory、Product Action | 覆盖从创建/选择角色到真实互动的完整流程 | Quick Start 只能增强，不能取代完整 Create |
| P0 生成与资产主链 | Image、Character/Freeplay、异步交付、Gallery、My AI 全部核心 tabs、下载/管理 | 覆盖生成、保存和资产管理 | Video 按独立 capability Gate 发布 |
| P0 经济与支持主链 | Upgrade、预付访问、dreamcoin、entitlement、报价/结算/退款、Profile、Help/Report/Appeal | 覆盖付费和问题恢复 | 不锁回既有历史或资产 |
| P0 公开入口真相 | dedicated/CMS publication registry、404、sitemap/robots/canonical | 只发布有权威内容的入口 | 路由库存不能冒充内容完成 |
| P1 对标深度 | Presets/Image Edit/高级生成、Voice、条件 Video、完整角色精炼、Group Chats/Packs | 补齐对标站的深度控制和后续产品域 | 依赖各能力自己的交付与成本 Gate |
| P1 分发、生态与内容 | Feed、Community、Creator Profile、Remix/Like/Follow/Share、Affiliate、Images/Videos/Glossary/Authors、Library/Article/Comparison | 覆盖发现、分发、联盟合作和内容获客 | 属于完整对标范围，不受关系指标前置 |
| P2 规模优化 | 个性化排序、creator incentives 优化、内容规模化、本地化与运营自动化 | 提升效率和规模 | 按依赖、数据质量和资源分期 |

同一页面和路由可以覆盖多个层级；层级表示产品优先级，不等于删除已有功能。分期以 [PRD §12](PRD.md#12-交付阶段与完整范围) 为准；需求、故事、证据与退出条件的映射见 [对标矩阵](PRODUCT_PARITY_MATRIX.md)。

资料来源：

- `packages/main/src/lib/ourdream-data.ts`
- `packages/main/src/components/ourdream/*`
- `docs/research/INSPECTION_GUIDE.md`
- `docs/research/OURDREAM_PRODUCT_PARITY_SNAPSHOT_2026-09-01.md`
- `docs/design-references/*.png`
- 2026-09-01 对标站快照：官方 sitemap 共 212 条 URL，导航还包含不在 sitemap 中的 Feed、Community、Profile、Help Desk、Terms 等核心入口；它定义产品完整度参考，但不覆盖 iDream 的代码与运行事实

本文档以产品 SSoT、源码、保存截图和对标研究资料 `INSPECTION_GUIDE.md` 为准；`SERVICE_INTEGRATION.md` 是已被当前 Chat authority ADR 取代的历史设计，不作为产品边界来源。

### 1.1 带日期的公开广度基线

下表来自 2026-09-01 官方公开 UI/营销资料，仅作为历史 parity 验收输入，不写死运行时 Catalog。[2026-09-05 复核](../research/OURDREAM_PRODUCT_REVIEW_2026-09-05.md) 未重新完成登录态目录盘点；旧数量不代表今日实时参数。创建的分步数量允许任务等价，完整性以字段、预览、恢复和后续动作判定。每项必须在逐功能矩阵中标记 `matched`、`equivalent` 或 `intentional_divergence`；只有泛化控件、极少选项或静态文案不能判为完成。

| 维度 | OurDream 公开观察值 | iDream 对标验收 |
| --- | --- | --- |
| Create Catalog | 40+ personality、19 voice、135 occupation、29 relationship type，并公开 hobbies/fetishes/custom fields | Catalog 数据驱动；逐项记录覆盖数、custom 等价能力与明确偏离 |
| Chat 档位与群聊 | 5 个用户可感知 Chat models/modes；Group Chat 最多 12 个角色 | 提供 5 档或经批准的功能等价 profile；群聊容量目标 12，服务端仍持有 provider/model 与资源权威 |
| Generate 结构化素材 | 落地页宣称 570+ presets；主生成页宣称 100+ poses、40+ backgrounds、20+ outfits | 记录真实已发布 Catalog 数和来源；营销数字未被登录态验证，不能拿占位项凑数 |
| Generate 容量 | 最多 256 图/批；Video 最多 10 scenes、每 scene 60 秒；5 种比例、2 个质量档 | 每个 cap 单独记录 provider/profile/capacity/entitlement 证据；有意缩小必须明确说明 |
| My AI IA | Recent、Characters、Group Chats、Packs、Presets、Created 共 6 个任务面 | 六类用户任务都有真实数据/动作或明确未发布状态，不能用单一 Recent 替代 |
| 公开内容与政策 | sitemap 212 URL；14 个 `/terms/*` 政策页 | 按用户任务覆盖页面族与政策任务；不要求机械凑 URL 数，也不允许模板页冒充完成 |

## 2. 完整对标路由库存与发布边界

| 类别 | 数量/范围 | 页面目的 |
| --- | --- | --- |
| OurDream 官方 sitemap | 212 | 2026-09-01 互斥分类：15 核心顶层、16 generate 子页、20 sex-chat、20 guides、26 comparison/alternatives、53 videos 子页、20 images 子页、24 type 子页、5 AI-girlfriend 文章与 13 其他路由，全部进入 parity inventory |
| 导航补充入口 | 7 | sitemap 外还实测 `/feed`、`/community`、`/profile`、`/helpdesk`、`/terms`、`/type`、`/sex-chat` HTTP 200；HTTP 200 不等于功能已验证 |
| Terms 政策页 | 14 | `/terms/*` 官方政策页实测 200；iDream 可由 `/terms/*` 或版本化 `/safety/*` 提供等价用户任务，发布权威仍在自身 `policy_versions` |
| 公开发布边界 | 动态 | 只有完成真实能力或内容、且获得 dedicated/CMS publication authority 的页面可发布；未获授权的目标路由返回 404 |
| robots 排除 | 4 类 | `/api`、`/chat/` 子路径、`/c/`、`/signup/1`，不属于公开静态内容范围 |

## 3. 页面模板与功能边界

| 模板 | 路由 | 目标产品功能 |
| --- | --- | --- |
| Explore Home | `/` | 真实搜索、排序、筛选、角色详情、聊天启动、无限加载 |
| Marketing | `/chat`、`/ai-girlfriend`、`/ai-boyfriend`、`/ai-girl`、`/create-ai-girlfriend`、`/create-ai-boyfriend`、`/virtual-girlfriend`、`/authors/*`、`/site/*`、`/login`、`/signup`、`/helpdesk` | 产品说明、转注册、营销实验、登录/注册真实表单、帮助内容 |
| Create | `/create` | 六步 Style → General → Face → Body → Details → Image；覆盖 Gender/Style、外观、personality/Soul、Voice、Occupation、hobbies/fetishes、relationship type、custom details、视觉候选、Visual Identity、私有保存与公开发布；Quick Start 仅作可选预填 |
| Generator | `/generate`、`/generate/*`、`/generator/*` | 图片任务、条件启用的视频任务、角色选择、preset 库、Premium prompt、模型/比例/数量设置、图库管理 |
| Profile | `/custom`、`/profile` | My AI Recent/Characters/Presets/Created/Media、余额、预付访问/重新购买、兑换码、推荐、偏好与账号管理；Group Chats/Packs 是 P1 目标域 |
| Feed | `/feed` | 推荐 feed、cursor、Chat、Remix、Like、Share、Report |
| Community | `/community`、`/creators/:id` | banner、Dreamers/Characters/Collections、creator profiles、leaderboards 与 filters |
| Library | `/resources-hub`、`/type`、`/videos`、`/images`、`/games`、`/romantasy`、`/glossary` | 资源、图片/视频、术语与分类内容入口 |
| Article | `/guides/*`、`/sex-chat/*`、`/ai-girlfriend/*`、`/videos/*`、`/type/*`、`/ai-instructions` | 真实长文、FAQ、结构化 SEO、CTA |
| Comparison | `/comparison`、`/comparison/*`、`/*-alternatives` | 竞品差异、价格/功能对比、转化 |
| Affiliate | `/affiliate` | RevShare/CPA、申请、归因链接、推广素材、实时 dashboard 与佣金状态 |
| Upgrade | `/upgrade` | Premium/Deluxe、真实支付、权益、dreamcoin、账单管理 |
| Terms/Safety | `/terms`、`/terms/*`、iDream `/safety/*` | 法律条款、隐私、退款、社区/禁止内容规则、年龄验证、审核、举报、申诉 |

## 4. 导航功能图

| 入口 | 目标页面 | 用户任务 | 后续动作 |
| --- | --- | --- | --- |
| Create | `/create` | 创建自定义角色 | 保存到 My AI、开始聊天、生成媒体 |
| Explore | `/` | 浏览角色 | 筛选、搜索、打开角色、注册 |
| Chat | `/chat` | 理解聊天能力或进入聊天 | 登录、选择角色、恢复会话 |
| Generate | `/generate` | 生成图片；Video 启用时生成视频 | 选择角色、配置参数、查看图库 |
| My AI | `/custom` | 管理个人角色和历史 | 继续聊天、编辑角色、查看 created |
| Feed | `/feed` | 浏览动态 | Chat、Remix、Like、Share、Report |
| Community | `/community` | 发现创作者和公开角色 | 打开 creator profile、关注、互动、分享 |
| Help Desk | `/helpdesk` | 获取支持 | FAQ、提交支持请求（`SUP-...` 参考号）、外部/账号支持入口 |
| Safety Center | `/safety/*` | 了解规则 | 年龄验证、审核、举报、申诉、隐私 |
| More | `/resources-hub` | 找资源内容 | 进入 guides、comparison、type、videos |
| Upgrade | `/upgrade` | 购买预付访问 | checkout、权益激活 |

## 5. 功能模块矩阵

### 5.1 Discovery

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| 推荐角色流 | `/` | `characterCards` |
| 角色卡 metadata | `/`、marketing strip、generator gallery | Character |
| 热度指标 | `/` | likes、chats |
| 分类 chips | `/` | `/api/v1/tags` + public approved character counts（只展示有内容的非 muted tag） |
| 内容类型 | `/` | All、Group Chats、Comics 等对标内容类型；只在有真实数据与目标页时暴露 |
| 搜索 | `/`、route topbar | search index |
| 排序 | `/` | ranking mode（For You/Popular/Newest/Following，带 period label） |
| 筛选 | `/` | gender/style/age facets |
| 无限加载 | `/` | pagination cursor |
| 角色详情/聊天启动 | card click | Character detail 或 RecentChat |

### 5.2 Creation

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Six-step creator | `/create` | Style → General → Face → Body → Details → Image；任意步可回退修改并恢复草稿 |
| Gender / Style | `/create` | Female/Male/Trans、Realistic/Anime 等当前公开可验证选项 |
| Appearance / race | `/create` | human/fantasy 等选项与 Custom |
| Hair / Body | `/create` | 发型、颜色、体型与身体特征选项 |
| Name / age / core profile | `/create` | 名称、成年人年龄、简介与基本身份 |
| Personality / Soul / Advanced details | `/create` | personality、稳定角色承诺、Occupation、hobbies/fetishes、relationship type、Voice、custom details 与高级资料；当前广度基线为 40+ / 135 / 29 / 19，Catalog 数据驱动且不混入可变 transcript/memory/Scene |
| Tag manager | `/create` | 创建前后均可管理 Character tags |
| Draft recovery | `/create` | 自动保存、刷新恢复、注册回跳和逐步编辑 |
| Preview candidates | `/create` | CharacterPreviewJob 生成/刷新一个或多个可恢复候选 |
| Visual identity anchor | `/create` | 用户从候选中选择基准图，形成 CharacterVisualProfile active identity |
| Bring to life | `/create` | 创建 Character、保存到 My AI、开始 Chat 或继续编辑 |
| Visibility and release | `/create` / Character settings / Admin | 私有使用与公开提交分离；公开角色通过基础自动检查后进入发布准备、immutable Release 与 Serving，不增加日常人工批准 |
| Optional Quick Start | `/create` | 用一句描述预填完整向导；不得删除或隐藏上述完整创建能力 |

### 5.3 Chat

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Chat landing | `/chat` | marketing route |
| Character chat | `/chat/*` 或角色详情 | RecentChat、ChatTurn、ChatTurnAttachment |
| Conversation context | chat | Main committed Turns + Scene + official igrep memory 提供跨会话上下文 |
| Identity continuity | chat | immutable Soul、ContentVersion/Release、VisualProfile 与 VoiceProfile pins |
| Memory control | chat / profile | memory enabled 状态、暂停、纠正后重建、按角色清除；不建立第二套手工 memory authority |
| Pinned memories / custom instructions | chat / profile | 用户固定关键事实和自定义交互要求；必须投影到 Main committed context 与 official igrep authority，不建立无来源的第二套记忆 |
| Conversation controls | chat | 用户可配置 response length、scene generation、active messages 与成人互动强度；控制值进入版本化 Turn snapshot |
| Conversation profiles | chat | 2026-09-01 历史对标基线为 5 个用户可感知档位；用户在执行前看到能力与成本，执行 provider/model 仍由服务端权威选择，不改写 Soul 身份 |
| Group Chat | chat / My AI | 一个会话内最多 12 个角色参与，可显式选择或 `@` 指定应答角色；历史、memory、额度、Product Action 与权限有明确编排 |
| Voice Call | chat | 实时或近实时双向语音会话，与按消息播放的 Voice Clip 分开建模和计费 |
| Deterministic Product Action | chat | 已获发布 capability 的图片/编辑/语音请求形成 accepted effect、delivery、attachment、settlement/refund 与 replay identity；Video 仅在显式 Chat capability 与 Product Action contract 发布后进入该链 |
| Action truthfulness | chat | 未交付前不声称完成；regenerate/replay 不重复执行或重复扣费 |
| Message entitlement | chat | ChatTurnUsageFact + server-side Entitlement |
| Safety moderation | chat | safety flags |
| Report chat/character | chat/detail | ContentReport |

### 5.4 Generation

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Image mode | `/generate` | GenerationJob.mode |
| Video mode | `/generate` | GenerationJob.mode（仅在 `video_gen`、entitlement、video model/provider 同时满足时曝光；只接受满足已发布 I2V contract 且用户有权使用的 Character，含合格私有角色） |
| Mode presets | `/generate` | generationModePreset（Presets、Image Edit） |
| Create / Edit / Enhance | `/generate` | 新图创建、已有图编辑、质量增强分开契约；保留 source asset、accepted edit brief 与出图 lineage |
| Select source | `/generate` | Image 可选择 Character 或 Freeplay；Video 启用时选择符合已发布 I2V contract 且用户有权使用的 Character，含合格私有角色 |
| Character consistency | `/generate`、Chat image | CharacterVisualProfile（active identity version、anchor/reference assets、consistency mode；详见 `CHARACTER_IMAGE_GENERATION_SYSTEM.md`） |
| Background | `/generate` | controls.backgroundPresetId（All/My Presets/Community/categories/Custom/Create a Preset） |
| Pose | `/generate` | controls.posePresetId（Image mode only；preset categories） |
| Outfit | `/generate` | controls.outfitPresetId（All/My Presets/Community/categories/Custom/Create a Preset） |
| Premium custom prompt | `/generate` | prompt、plan（non-entitled user 触发 upgrade modal） |
| Advanced settings | `/generate` | model/style、negativePrompt、orientation、count；可选值与数量上限由已发布 GenerationModelProfile、entitlement、服务端 quote 和容量 Gate 决定，不在页面规格硬编码 |
| Reference-guided generation | `/generate` | 允许的 reference/source asset、身份约束、权限与 provenance；不把官方营销页对 upload 的冲突文案当成已确认边界 |
| Multi-scene video | `/generate` | 时长、scene 序列、每段输入、AI voice/audio、宽高比、质量档与逐段交付/结算；只在对应 provider/profile/capacity 已发布时暴露 |
| Generate action | `/generate` | async job |
| Images/Liked/Videos | `/generate` | MediaAsset（Images/Liked 默认可见；有既有视频时 Videos 仍可见，不受新视频生成功能停用影响） |
| Gallery filter/manage | `/generate` | MediaAsset query、bulk selection（Filter、Manage、Select All、Like） |
| Long-tail generator pages | `/generate/*`、`/generator/*` | SEO route content |
| Chat context handoff | Chat → Generation | exact Character/Release/VisualProfile/Scene/accepted visual brief，不由页面重新猜测 |
| Cost and delivery truth | Chat、`/generate`、Gallery | 预估成本、Request/Attempt/Delivery、settlement/refund、失败原因与幂等重试 |

### 5.5 预付访问与经济

> **经济契约**：dreamcoin 是唯一消耗型货币；语音按计划分钟额度优先、超出后再扣 dreamcoin。`/upgrade` 计划卡从权威数据展示 included dreamcoins、消息权益与生成模型权益；Chat provider/model、角色人格和基础记忆不按计划分级。若展示 images/videos/voice 媒体等价值，必须由 `includedDreamcoins ÷ 费率` 动态计算，且 `video_gen=false` 时不得展示视频承诺。定价/费率/免费档 SSoT 见 `ECONOMY_AND_PRICING.md`。

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Upgrade plan cards | `/upgrade` | SubscriptionPlan |
| Monthly/Yearly | `/upgrade` | billingPeriod；折扣与赠币只从有效 Plan/campaign 数据读取，不在功能地图硬编码 |
| Premium plan | `/upgrade` | plan=premium（30 日或 365 日一次性预付；included dreamcoins、image + voice enabled，videoGeneration=false；精确价格/赠币从 Plan 读取） |
| Deluxe plan | `/upgrade` | plan=deluxe（30 日或 365 日一次性预付；更多 dreamcoins、premium generation models、更多 voice minutes；video entitlement 需 `video_gen` + provider ready 才能曝光；精确价格/赠币从 Plan 读取；DSH Chat 不承诺模型或记忆倍率） |
| Promo surfaces | home toast/banner | campaign |
| Checkout | `/upgrade` | payment provider |
| Dreamcoin coin store | `/upgrade` / Buy Coins | 与访问计划分开的版本化 top-up offers、报价、一次性 checkout、provider confirmation、幂等 ledger 入账与购买历史 |
| Premium entitlement | app-wide | plan flags |
| Dreamcoin balance | app-wide | append-only DreamcoinLedger |
| Existing history ownership | Chat、My AI、Gallery | 到期/降级后既有聊天和已交付媒体仍可查看；媒体保持可下载 |

### 5.6 Profile, Feed, Community

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| My AI search | `/custom` | user library search |
| My AI core | `/custom` | Recent、Characters、Presets、Created、Media 共同构成 P0 资产面，支持 search、加载态、空态和继续操作 |
| My AI P1 tabs | `/custom` | Group Chats/Packs 属于 P1 完整对标目标；未发布时默认隐藏新任务入口，既有深链显示不可用原因与返回路径 |
| Profile settings | `/profile` | User、Preferences |
| Dreamcoin balance | `/profile`、app-wide | DreamcoinLedger |
| Access status and repurchase | `/profile#billing`、`/upgrade` | Entitlement + Subscription（legacy physical name） |
| Redeem code | `/profile/redeem-code` | RedeemCode |
| Referral program | `/profile`、`/signup?ref=` | 版本化邀请码/分享、signup 归因、双方奖励 quote 与 append-only ledger；每个 invitee 幂等一次，具体奖励只从有效 campaign 读取 |
| Preferences/notifications | `/profile/notifications` | UserPreferences |
| Language | `/profile` | 只有接入真实 i18n 字典、路由内容与 locale persistence 后才展示切换器；`user_preferences.locale` 不能单独冒充多语言能力 |
| Account management | `/profile/account-management` | User status/deletion |
| Feed cards | `/feed` | FeedItem |
| Feed actions | `/feed` | chatStart、remix、like、share、report |
| Community carousel | `/community` | CampaignBanner |
| Community tabs | `/community` | dreamers、characters、collections |
| Dreamers leaderboard | `/community` | CreatorRank（Featured、Top、followers/interactions） |
| Creator public profile | `/creators/:id` | Creator profile、public character grid、follow state |
| Community filters | `/community` | releaseWindow、gender、style（Last 30 Days/All Time、Any/Female/Male/Trans、Any/Realistic/Anime） |
| Creator levels | `/community` | 可版本化的等级、门槛、badge/frame、early access 与 approval 权益；资格从 canonical interaction/release facts 计算 |
| Creator Studio | `/community` / creator dashboard | 曝光、互动、公开角色、Pack 购买、Dreamcoin/现金收益和对账；资格、收益和 payout 有审计权威 |

### 5.7 SEO Content

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Resources hub | `/resources-hub` | route index |
| Type index | `/type` | type routes |
| Videos index | `/videos` | video routes |
| Comparison hub | `/comparison` | competitor routes |
| Images index | `/images`、`/images/*` | 已发布图片内容与相关产品 CTA |
| Glossary | `/glossary` | 可索引术语、相关内容和产品入口 |
| Authors | `/authors/*` | 作者身份、已发布内容和内部链接 |
| Affiliate | `/affiliate` | 公开条款、申请、归因、素材、dashboard 与佣金状态 |
| Article template | `/guides/*` 等 | article content |
| Related pages | 多数模板 | prefix routes |
| Metadata | all static routes | route title/description |

### 5.8 Help, Terms, Safety

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Help support tab | `/helpdesk` | support links（Account/Billing、Trust contact、Discord）、FAQ、登录+年龄门后提交支持请求（analytics 事件 + `SUP-...` 参考号） |
| Bugs/Features/Changelog | `/helpdesk` | feedback/changelog 区块 + Premium CTA；Roadmap 支持提交 feature/bug/improvement idea、Vote/Unvote 与持久计票 |
| Terms index | `/terms` | 版本化 policy routes；覆盖当前 14-page 对标库存中的等价用户任务，iDream 可在不丢任务的前提下合并呈现 |
| Age verification docs | `/safety/policies/age-verification` | AgeVerification（Go.cam、jurisdiction、stored verification info） |
| Moderation docs | `/safety/moderation/*` | moderation layers、appeals（input/output/metadata/human/community layers） |
| Reporting docs | `/safety/reporting/how-to-report` | reports、regulator/security paths（in-product/email/report types） |
| Privacy/safety tools | `/safety/your-account/*` | privacy、mute、delete、account controls |

新增故事对应功能：账号注册/登录恢复、会话失效与删除状态（AC）；基础帮助、客户工单回执/回复/解决（SF）；私有/链接可见/公开范围与 Remix 来源（PF）；联盟申请、归因、收益与结算（AF）。这些能力覆盖正常结果、异常恢复和权限，验收见 `UserStory.md §2.10–2.11`；基础客服属于 P0，不能被 Bugs/Features 的 Premium 门槛挡住。

### 5.9 完整对标后续域（P1）

以下功能属于完整对标的 P1 目标域。每个域都必须定义范围、数据模型、权限、额度/计费、交付与分发；在正式发布前遵守全局 unavailable/404 真相边界，不能用空 tab 或静态页面冒充完成。

| 域 | 出现位置 | 目标层级 | 一句话范围草图 |
| --- | --- | --- | --- |
| Group Chats | Chat / My AI tab（§5.3/§5.6） | P1 | 一个会话内多角色参与；需定义角色编排、`@` 选择、历史、额度、记忆、生成与权限。未发布时 Explore 不展示空结果 chip。 |
| Packs | My AI / Community | P1 | 单角色的图片/视频集合，可包含当前与未来内容；需定义 ownership、定价、购买/解锁、创作者收益、到期权益、分发和 moderation。 |
| Comics | Explore content type | P1 | 可发现、可阅读且可转入 Chat/Remix 的连续媒体内容；需定义 episode/page、creator、visibility、engagement 和分发。 |

## 6. 页面族摘要（用户任务）

### Explore `/`

用户任务：

- 发现热门、最新、关注和不同分类的公开角色。
- 通过搜索、排序、性别、风格、年龄和 tag 缩小范围。
- 查看角色详情、创作者与热度，并进入 Chat、Generate 或注册恢复。
- 从真实内容和 FAQ 理解平台的创建、聊天、生成、社区与付费能力。

### Create `/create`

用户任务：

- 通过完整向导选择 Gender、Style、外观/race、发型、体型、名称、tags、hobbies/fetishes 与高级资料。
- 自动保存草稿，生成或刷新预览候选，并选择 Visual Identity anchor。
- 保存私有角色后进入 My AI、Chat 或 Generate；也可提交公开发布。
- 后续继续编辑 Soul、Reference Set、Voice Identity 与分发信息；Quick Start 只负责预填。

### Generate `/generate`

用户任务：

- 默认选择 Image；Video 获得发布 capability 时可切换 Image / Video。
- Image 选择角色或 Freeplay；Video 启用时选择满足已发布 I2V/Serving contract 的角色。
- 配置 mode presets、背景、姿势、服装、custom prompt 和 advanced settings。
- 使用 Images、Liked、Filter 和 Manage 管理结果；Video 启用时可用 Videos。
- 在提交前知道成本，在完成后看到交付与结算；Character 模式保持同一角色身份。

### My AI/Profile `/custom`、`/profile`

用户任务：

- 平等访问 Recent、Characters、Presets、Created 和 Media，并搜索/继续相应任务。
- 管理已创建角色、会话、presets 与媒体资产。
- Group Chats/Packs 属于 P1 对标目标；未发布时默认隐藏新任务入口，既有深链显示不可用原因与返回路径。
- 从可创建域的空态进入创建；延期域不展示行动入口。
- 在 Profile 查看余额、预付访问/重新购买、兑换码、推荐奖励、支持、法律和账号管理；偏好/通知属于 P1。

### Feed/Community `/feed`、`/community`

用户任务：

- 浏览平台或用户发布的角色和媒体内容。
- 发现创作者。
- 进入 creator public profile 并关注/取消关注。
- Chat、Remix、Like、Share、Report。
- 按 Dreamers、Characters、Collections 和 Release/Gender/Style 维度浏览社区榜单。

### Upgrade `/upgrade`

用户任务：

- 比较月度/年度的一次性预付周期（周期标签不表示自动续订）。
- 比较 Premium/Deluxe。
- 需要额外余额时从独立 coin store 选择充值 offer；充值不隐式创建或续订访问计划。
- 查看 dreamcoin、条件启用的图片/视频/语音能力、消息与生成模型权益；Chat 人格和基础记忆不按方案分级。
- 理解一次性周期访问、到期时间、重新购买和“既有历史/媒体不锁回”的承诺。
- 购买对应计划并回到原聊天、创建或生成任务。

### Library/Article/Comparison

用户任务：

- 从长尾搜索进入具体主题。
- 阅读指南、类型、视频生成和竞品对比内容。
- 跳转到 Explore、Create、Generate 或 Upgrade。
