# Ourdream.ai Product Feature Map

更新日期：2026-06-13

> 当前实现状态已在 2026-06-25 重新审计，见
> [CURRENT_FUNCTIONAL_COVERAGE.md](./CURRENT_FUNCTIONAL_COVERAGE.md) 和
> [LAUNCH_READINESS_AUDIT.md](./LAUNCH_READINESS_AUDIT.md)。本文保留 2026-06-13
> 对标站功能地图和早期缺口池；其中“未实现/静态实现”的状态不再代表当前代码态。

## 1. 资料来源

- `src/lib/ourdream-data.ts`
- `src/components/ourdream/*`
- `docs/research/SITEMAP_ROUTES.md`
- `docs/research/PAGE_TOPOLOGY.md`
- `docs/research/BEHAVIORS.md`
- `docs/research/components/*.spec.md`
- `docs/design-references/*.png`
- `docs/research/ONLINE_PRODUCT_SURVEY.md`
- `docs/research/CHROME_PRODUCT_EXPLORATION.md`
- 2026-06-13 Chrome 线上巡检：142 个 sitemap URL，加 `/terms`、`/helpdesk`、`/feed`、`/community`、`/profile`、`/login`、`/signup`

本文档以源码、保存截图、既有 `docs/research` 抽取结果、`ONLINE_PRODUCT_SURVEY.md` 和 2026-06-13 Chrome 实测为准。Chrome 探索过程中没有点击年龄确认、订阅购买、登录提交、举报提交或任何外部副作用动作。

## 2. 路由覆盖总览

| 类别 | 数量/范围 | 页面目的 |
| --- | --- | --- |
| sitemap URL | 142 | 目标站公开页面覆盖 |
| 额外站内工具页 | 7 | Chrome 补充覆盖 `/terms`、`/helpdesk`、`/feed`、`/community`、`/profile`、`/login`、`/signup` |
| Safety Center 镜像路由 | 16 | `/safety/*` 本地镜像 |
| 本地非根路径 | 164 | 通过 `generateStaticParams` 静态生成 |
| robots 排除 | 4 类 | `/api`、`/chat/` 子路径、`/c/`、`/signup/1`，不作为静态 clone 后端范围 |

## 3. 页面模板与功能边界

| 模板 | 路由 | 当前 clone | 目标产品功能 |
| --- | --- | --- | --- |
| Explore Home | `/` | 角色卡流、筛选视觉、促销、FAQ、footer | 真实搜索、排序、筛选、角色详情、聊天启动、无限加载 |
| Marketing | `/chat`、`/ai-girlfriend`、`/ai-boyfriend`、`/ai-girl`、`/affiliate`、`/authors/*`、`/site/*`、`/login`、`/signup`、`/helpdesk` | hero、角色展示、功能卡、相关页面 | 产品说明、转注册、营销实验、登录/注册真实表单、帮助内容 |
| Create | `/create` | 本地为静态表面；线上是多步向导 | 性别/风格、外观、发型、体型、名称、高级详情、tag、预览生成、最终创建、审核 |
| Generator | `/generate`、`/generate/*`、`/generator/*` | 本地为视觉表面；线上有完整配置弹窗 | 图片/视频任务、角色选择、preset 库、Premium prompt、模型/比例/数量设置、图库管理 |
| Profile | `/custom`、`/profile` | tabs 和空态；线上 profile 有账号设置 | My AI、最近角色、群聊、packs、presets、created、余额、订阅、兑换码、推荐、偏好 |
| Feed | `/feed` | 本地当前仍偏静态模板 | 推荐 feed、cursor、Chat、Remix、Like、Share、Report |
| Community | `/community` | 本地当前仍偏静态模板 | banner carousel、Dreamers/Characters/Collections、leaderboards、Release/Gender/Style filters |
| Library | `/resources-hub`、`/type`、`/videos`、`/games`、`/romantasy` | 卡片索引 | 资源聚合、分类页、内容运营入口 |
| Article | `/guides/*`、`/sex-chat/*`、`/ai-girlfriend/*`、`/videos/*`、`/type/*`、`/ai-instructions` | 目录、正文块、相关卡片 | 真实长文、FAQ、结构化 SEO、CTA |
| Comparison | `/comparison`、`/comparison/*`、`/*-alternatives` | 对比卡片和功能点 | 竞品差异、价格/功能对比、转化 |
| Upgrade | `/upgrade` | Yearly/Monthly 计划卡 | Premium/Deluxe、真实支付、权益、dreamcoin、账单管理 |
| Terms/Safety | `/terms`、`https://safety.ourdream.ai/*` | 静态条款表面和外链 | 法律条款、隐私、安全规则、年龄验证、审核、举报、申诉 |

## 4. 导航功能图

| 入口 | 目标页面 | 用户任务 | 后续动作 |
| --- | --- | --- | --- |
| Create | `/create` | 创建自定义角色 | 保存到 My AI、开始聊天、生成媒体 |
| Explore | `/` | 浏览角色 | 筛选、搜索、打开角色、注册 |
| Chat | `/chat` | 理解聊天能力或进入聊天 | 登录、选择角色、恢复会话 |
| Generate | `/generate` | 生成图片/视频 | 选择角色、配置参数、查看图库 |
| My AI | `/custom` | 管理个人角色和历史 | 继续聊天、编辑角色、查看 created |
| Feed | `/feed` | 浏览动态 | Chat、Remix、Like、Share、Report |
| Community | `/community` | 发现创作者和公开角色 | 关注、互动、分享 |
| Help Desk | `/helpdesk` | 获取支持 | FAQ、提交工单 |
| Safety Center | 外链 | 了解规则 | 年龄验证、审核、举报、申诉、隐私 |
| More | `/resources-hub` | 找资源内容 | 进入 guides、comparison、type、videos |
| Upgrade | `/upgrade` | 订阅 | checkout、权益激活 |

## 5. 功能模块矩阵

### 5.1 Discovery

| 功能 | 页面 | 数据 | 当前状态 |
| --- | --- | --- | --- |
| 推荐角色流 | `/` | `characterCards` | 静态实现 |
| 角色卡 metadata | `/`、marketing strip、generator gallery | Character | 静态实现 |
| 热度指标 | `/` | likes、chats | 静态实现 |
| 分类 chips | `/` | categoryFilters | 静态展示 |
| 搜索 | `/`、route topbar | search index | 视觉控件 |
| 排序 | `/` | ranking mode | Chrome 观察：`Popular · Month` label，菜单含 For You/Popular/Newest/Following |
| 筛选 | `/` | gender/style/age facets | Chrome 观察：Gender、Style、Age popover |
| 无限加载 | `/` | pagination cursor | loading 视觉 |
| 角色详情/聊天启动 | card click | Character detail 或 ChatSession | Chrome 观察：卡片是 pointer-clickable DOM，不是稳定 anchor |

### 5.2 Creation

| 功能 | 页面 | 数据 | 当前状态 |
| --- | --- | --- | --- |
| Gender | `/create` | Character.gender | Chrome 观察：Female/Male/Trans |
| Style | `/create` | Character.style | Chrome 观察：Realistic/Anime |
| Appearance/race | `/create` | Character.appearance | Chrome 观察：human/fantasy options + Custom |
| Hair | `/create` | Character.appearance.hair | Chrome 观察：style/color options + Custom |
| Body | `/create` | Character.appearance.body | Chrome 观察：body type/body-feature options |
| Name | `/create` | Character.name | Chrome 观察：generated default name input |
| Advanced details | `/create` | Character.extendedProfile | Chrome 观察：optional accordion/button |
| Tag manager | `/create` | Character.tags | Chrome 观察：tags can be managed before final submit |
| Appearance/Personality tabs | `/create` | draft profile sections | Chrome 观察：final screen exposes sections |
| Preview generation | `/create` | CharacterPreviewJob | Chrome 观察：preview image generation state |
| Bring to life action | `/create` | Character create API | 未实现 |
| Save to My AI | `/custom` | user library | 未实现 |

### 5.3 Chat

| 功能 | 页面 | 数据 | 当前状态 |
| --- | --- | --- | --- |
| Chat landing | `/chat` | marketing route | 静态营销模板 |
| Character chat | `/chat/*` 或角色详情 | ChatSession、Message | robots 排除，未 clone |
| Conversation memory | chat | memory summary | 未实现 |
| Message quota | chat | plan、usage | 未实现 |
| Safety moderation | chat | safety flags | 未实现 |
| Report chat/character | chat/detail | ContentReport | 未实现 |

### 5.4 Generation

| 功能 | 页面 | 数据 | 当前状态 |
| --- | --- | --- | --- |
| Image mode | `/generate` | GenerationJob.mode | 视觉 tab |
| Video mode | `/generate` | GenerationJob.mode | 视觉 tab |
| Mode presets | `/generate` | generationModePreset | Chrome 观察：Presets、Image Edit |
| Select character | `/generate` | characterId | Chrome 观察：dialog with search, filters, Freeplay, characters |
| Background | `/generate` | controls.backgroundPresetId | Chrome 观察：All/My Presets/Community/categories/Custom/Create a Preset |
| Pose | `/generate` | controls.posePresetId | Chrome 观察：Image mode only；preset categories |
| Outfit | `/generate` | controls.outfitPresetId | Chrome 观察：All/My Presets/Community/categories/Custom/Create a Preset |
| Premium custom prompt | `/generate` | prompt、plan | Chrome 观察：opens upgrade modal for non-entitled user |
| Advanced settings | `/generate` | model/style、negativePrompt、orientation、count | Chrome 观察：Dreamy/Vivid、premium negative prompt、ratio、2-256 images |
| Generate action | `/generate` | async job | 未实现 |
| Images/Videos/Liked | `/generate` | MediaAsset | Chrome 观察：gallery tabs |
| Gallery filter/manage | `/generate` | MediaAsset query、bulk selection | Chrome 观察：Filter、Manage、Select All、Like |
| Long-tail generator pages | `/generate/*`、`/generator/*` | SEO route content | 静态模板 |

### 5.5 Subscription

> **单一货币口径**：dreamcoin 是唯一消耗型货币，图片/视频/语音**无独立配额**。下表中「200 images / 10 videos / 20m voice」等均为「当月 dreamcoin ÷ 费率」的展示示意（动态算出），定价/费率/免费档 SSoT 见 `ECONOMY_AND_PRICING.md`。

| 功能 | 页面 | 数据 | 当前状态 |
| --- | --- | --- | --- |
| Upgrade plan cards | `/upgrade` | SubscriptionPlan | 静态实现 |
| Monthly/Yearly | `/upgrade` | billingPeriod | Chrome 观察：Monthly、Yearly Save 75% + free coins |
| Premium plan | `/upgrade` | plan=premium | Chrome 观察：$19.99/mo 或 $9.99/mo yearly；1,000 dreamcoins（卡面 200 images/20m voice/10 videos 为折算示意，见 economy） |
| Deluxe plan | `/upgrade` | plan=deluxe | Chrome 观察：$59.99/mo 或 $29.99/mo yearly；Premium models、3x memory、5,000 dreamcoins（卡面 images/voice/videos 为同一套费率折算示意，见 economy） |
| Promo surfaces | home toast/banner | campaign | 静态实现 |
| Checkout | `/upgrade` | payment provider | 未实现 |
| Premium entitlement | app-wide | plan flags | 未实现 |
| Dreamcoin balance | app-wide | DreamcoinTransaction | 未实现 |

### 5.6 Profile, Feed, Community

| 功能 | 页面 | 数据 | 当前状态 |
| --- | --- | --- | --- |
| My AI search | `/custom` | user library search | Chrome 观察：Search input |
| My AI tabs | `/custom` | recent、characters、groupChats、packs、presets、created | Chrome 观察：tabs + empty Create CTA |
| Profile settings | `/profile` | User、Preferences | Chrome 观察：账号设置入口 |
| Dreamcoin balance | `/profile`、app-wide | DreamcoinLedger | Chrome 观察：余额显示 |
| Subscription link | `/profile/subscription` | Subscription | Chrome 观察：profile entry |
| Redeem code | `/profile/redeem-code` | RedeemCode | Chrome 观察：profile entry |
| Referral program | `/profile` | Referral、RewardLedger | Chrome 观察：give/get dreamcoins、progress bonus |
| Preferences/notifications | `/profile/notifications` | UserPreferences | Chrome 观察：profile entry |
| Language | `/profile/language` | locale | Chrome 观察：language entry |
| Account management | `/profile/account-management` | User status/deletion | Chrome 观察：profile entry |
| Feed cards | `/feed` | FeedItem | Chrome 观察：card stream |
| Feed actions | `/feed` | chatStart、remix、like、share、report | Chrome 观察：Chat/Remix/Like/More -> Share/Report |
| Community carousel | `/community` | CampaignBanner | Chrome 观察：prev/next/dots |
| Community tabs | `/community` | dreamers、characters、collections | Chrome 观察：tabs present；Dreamers list readable |
| Dreamers leaderboard | `/community` | CreatorRank | Chrome 观察：Featured、Top、followers/interactions |
| Community filters | `/community` | releaseWindow、gender、style | Chrome 观察：Last 30 Days/All Time、Any/Female/Male/Trans、Any/Realistic/Anime |

### 5.7 SEO Content

| 功能 | 页面 | 数据 | 当前状态 |
| --- | --- | --- | --- |
| Resources hub | `/resources-hub` | route index | 静态实现 |
| Type index | `/type` | type routes | 静态实现 |
| Videos index | `/videos` | video routes | 静态实现 |
| Comparison hub | `/comparison` | competitor routes | 静态实现 |
| Article template | `/guides/*` 等 | article content | 模板正文 |
| Related pages | 多数模板 | prefix routes | 静态实现 |
| Metadata | all static routes | route title/description | 基础实现 |

### 5.8 Help, Terms, Safety

| 功能 | 页面 | 数据 | 当前状态 |
| --- | --- | --- | --- |
| Help support tab | `/helpdesk` | support links | Chrome 观察：Discord、FAQ、Contact Support |
| Bugs/Features/Changelog | `/helpdesk` | feedback/voting/changelog | Chrome 观察：Premium-gated |
| Terms index | `/terms` | policy routes | Chrome 观察：12 policy links |
| Age verification docs | `safety.ourdream.ai/policies/age-verification` | AgeVerification | Chrome 观察：Go.cam、jurisdiction、stored verification info |
| Moderation docs | `safety.ourdream.ai/moderation/*` | moderation layers、appeals | Chrome 观察：input/output/metadata/human/community layers |
| Reporting docs | `safety.ourdream.ai/reporting/how-to-report` | reports、regulator/security paths | Chrome 观察：in-product/email/report types |
| Privacy/safety tools | `safety.ourdream.ai/your-account/*` | privacy、mute、delete、account controls | Chrome 观察：privacy summary and safety tools |

### 5.9 未定义产品域（V1.1 / 暂不实现）

以下功能在 UI/路由/tab 中出现，但**产品语义尚未定义，不属于 MVP**，仅以空态或占位呈现。显式标注以免误读为已规划交付（对齐 12-roadmap V1.1 与 M8 「group-chats/packs 返回空态」）。

| 域 | 出现位置 | 状态 | 一句话范围草图 |
| --- | --- | --- | --- |
| Group Chats | My AI tab（§5.6）、Explore 分类 chip | V1.1 / 暂不实现 | 一个会话内多角色参与的群聊；MVP 仅保留 tab 空态，不实现多角色编排与额度。 |
| Packs | My AI tab（§5.6） | V1.1 / 暂不实现 | 角色/preset 的打包合集（可能可分享或购买）；MVP 仅空态，不实现打包模型与分发。 |
| Remix | Feed 动作（§5.6）、`/feed` | V1.1 / 暂不实现 | 基于他人公开角色/媒体派生再创作；MVP 不实现派生血缘、版权归属与计费。 |
| Creator public profile（`/creator/:id`） | Community leaderboard、角色卡 creator 字段 | V1.1 / 暂不实现 | 创作者公开主页（作品集/关注/统计）；MVP 不实现公开 profile 页与关注关系。 |

## 6. 当前页面族摘要

### Explore `/`

用户任务：

- 发现热门角色。
- 通过筛选和分类缩小角色范围。
- 从角色卡进入聊天或注册。
- 通过首页 FAQ 理解平台和价格。

产品缺口：

- 缺角色详情。
- 缺搜索/筛选真实状态。
- 缺卡片点击行为。
- 缺登录转化闭环。

### Create `/create`

用户任务：

- 通过多步向导配置 AI companion。
- 选择性别、风格、外观、发型、体型、名称和 tags。
- 使用高级详情补充角色设定。
- 生成预览图，确认后 Bring Your AI To Life。

产品缺口：

- 本地 clone 仍是单页静态表面，未实现真实向导状态。
- 未实现草稿保存、预览任务、tag 管理和最终提交。
- 未实现创建前 moderation、私有/公开发布和 My AI 回写。

### Generate `/generate`

用户任务：

- 选择 Image 或 Video。
- 选择角色或 Freeplay。
- 配置 mode presets、背景、姿势、服装、custom prompt 和 advanced settings。
- 使用 Images/Videos/Liked、Filter 和 Manage 管理结果。

产品缺口：

- 不能创建真实生成任务。
- preset 弹窗、premium gates、advanced settings 和 gallery 管理未完整实现。
- 没有额度、dreamcoin、下载、删除、收藏和批量操作。

### My AI/Profile `/custom`、`/profile`

用户任务：

- 查看最近角色和已创建角色。
- 管理群聊、packs、presets。
- 从空态进入创建。
- 在 Profile 查看余额、订阅、兑换码、推荐奖励、偏好、语言、支持、法律和账号管理。

产品缺口：

- 本地 clone 没有账号数据和 profile 设置数据。
- tabs 不能切换真实内容。
- 不能编辑或继续会话。
- 没有 referral、redeem code、notification preference、language 和 account management 后端。

### Feed/Community `/feed`、`/community`

用户任务：

- 浏览平台或用户内容。
- 发现创作者。
- Chat、Remix、Like、Share、Report。
- 按 Dreamers、Characters、Collections 和 Release/Gender/Style 维度浏览社区榜单。

产品缺口：

- 当前本地 clone 对 `/feed` 和 `/community` 的真实线上差异覆盖不足。
- Feed cursor、Chat/Remix/Like/Share/Report、leaderboard、community filters、carousel 和 collections 未实现。
- 社交数据和互动未实现。

### Upgrade `/upgrade`

用户任务：

- 比较 monthly/yearly。
- 比较 Premium/Deluxe。
- 查看 dreamcoin、图片、视频、语音、消息、模型/记忆等权益。
- 购买对应计划。

产品缺口：

- 计划权益与 Chrome 观察不完全一致。
- checkout 未接入。
- 订阅状态未回写。

### Library/Article/Comparison

用户任务：

- 从长尾搜索进入具体主题。
- 阅读指南、类型、视频生成和竞品对比内容。
- 跳转到 Explore、Create、Generate 或 Upgrade。

产品缺口：

- 当前多数页面是模板正文。
- 需要真实长文、FAQ、结构化数据和细分 CTA。

## 7. 后续开发任务池

P0：

- 挂载 AgeGate 并实现状态持久化。
- 实现 auth、session 和受保护路由。
- 实现角色详情页。
- 实现 Explore 搜索、筛选、排序和卡片点击。
- 实现基础聊天。
- 实现 Create 多步草稿、tag、预览任务、提交审核和保存到 My AI。
- 实现 Generate 异步任务、preset 服务、premium gates、额度校验和结果 gallery。
- 实现 Upgrade checkout、Premium/Deluxe entitlement 和 dreamcoin ledger。
- 实现安全策略、举报和 Terms/Safety 入口闭环。

P1：

- 补齐 SEO 文章真实内容。
- 实现 Feed 的 Chat/Remix/Like/Share/Report 和 cursor。
- 实现 Community leaderboards、filters、creator profile、collections。
- 实现生成资产下载、喜欢、删除、批量管理。
- 实现 creator profile 和公开/私有角色发布。
- 实现 profile 的兑换码、推荐奖励、通知偏好、语言、账号管理。

P2：

- 推荐算法和个性化。
- A/B 测试促销。
- 多语言。
- 高级角色 presets、packs 和 group chat 模板。
