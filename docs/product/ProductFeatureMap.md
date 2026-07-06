# Ourdream.ai Product Feature Map

更新日期：2026-07-03

> **本文档是目标产品功能地图（页面模板 / 导航图 / 功能模块矩阵），不描述实现进度。**
> 当前真实实现状态以 [`CURRENT_FUNCTIONAL_COVERAGE.md`](./CURRENT_FUNCTIONAL_COVERAGE.md) 为单一事实来源（SSoT），请勿在本文重新加入逐行实现状态列。

## 1. 资料来源

- `packages/main/src/lib/ourdream-data.ts`
- `packages/main/src/components/ourdream/*`
- `docs/research/INSPECTION_GUIDE.md`
- `docs/research/SERVICE_INTEGRATION.md`
- `docs/design-references/*.png`
- 对标站 Ourdream.ai 的产品调研：142 个 sitemap URL，加 `/terms`、`/helpdesk`、`/feed`、`/community`、`/profile`、`/login`、`/signup`

本文档以源码、保存截图和现存研究资料（`INSPECTION_GUIDE.md`、`SERVICE_INTEGRATION.md`）为准。

## 2. 路由覆盖总览

| 类别 | 数量/范围 | 页面目的 |
| --- | --- | --- |
| sitemap URL | 142 | 目标站公开页面覆盖 |
| 额外站内工具页 | 7 | Chrome 补充覆盖 `/terms`、`/helpdesk`、`/feed`、`/community`、`/profile`、`/login`、`/signup` |
| Safety Center 镜像路由 | 16 | `/safety/*` 本地镜像 |
| 本地非根路径 | 164 | 通过 `generateStaticParams` 静态生成 |
| robots 排除 | 4 类 | `/api`、`/chat/` 子路径、`/c/`、`/signup/1`，不作为静态 clone 后端范围 |

## 3. 页面模板与功能边界

| 模板 | 路由 | 目标产品功能 |
| --- | --- | --- |
| Explore Home | `/` | 真实搜索、排序、筛选、角色详情、聊天启动、无限加载 |
| Marketing | `/chat`、`/ai-girlfriend`、`/ai-boyfriend`、`/ai-girl`、`/affiliate`、`/authors/*`、`/site/*`、`/login`、`/signup`、`/helpdesk` | 产品说明、转注册、营销实验、登录/注册真实表单、帮助内容 |
| Create | `/create` | 性别/风格、外观、发型、体型、名称、高级详情、tag、预览生成、最终创建、审核 |
| Generator | `/generate`、`/generate/*`、`/generator/*` | 图片任务、条件启用的视频任务、角色选择、preset 库、Premium prompt、模型/比例/数量设置、图库管理 |
| Profile | `/custom`、`/profile` | My AI、最近角色、presets、created、media、余额、订阅、兑换码、推荐、偏好；group chats/packs 仅为明确 deferred 的无行动入口空态 |
| Feed | `/feed` | 推荐 feed、cursor、Chat、Remix、Like、Share、Report |
| Community | `/community`、`/creators/:id` | banner carousel、Dreamers/Characters/Collections、creator public profiles、leaderboards、Release/Gender/Style filters |
| Library | `/resources-hub`、`/type`、`/videos`、`/games`、`/romantasy` | 资源聚合、分类页、内容运营入口 |
| Article | `/guides/*`、`/sex-chat/*`、`/ai-girlfriend/*`、`/videos/*`、`/type/*`、`/ai-instructions` | 真实长文、FAQ、结构化 SEO、CTA |
| Comparison | `/comparison`、`/comparison/*`、`/*-alternatives` | 竞品差异、价格/功能对比、转化 |
| Upgrade | `/upgrade` | Premium/Deluxe、真实支付、权益、dreamcoin、账单管理 |
| Terms/Safety | `/terms`、`https://safety.ourdream.ai/*` | 法律条款、隐私、安全规则、年龄验证、审核、举报、申诉 |

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
| Help Desk | `/helpdesk` | 获取支持 | FAQ、提交 beta 支持请求（`SUP-...` 参考号）、外部/账号支持入口 |
| Safety Center | 外链 | 了解规则 | 年龄验证、审核、举报、申诉、隐私 |
| More | `/resources-hub` | 找资源内容 | 进入 guides、comparison、type、videos |
| Upgrade | `/upgrade` | 订阅 | checkout、权益激活 |

## 5. 功能模块矩阵

### 5.1 Discovery

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| 推荐角色流 | `/` | `characterCards` |
| 角色卡 metadata | `/`、marketing strip、generator gallery | Character |
| 热度指标 | `/` | likes、chats |
| 分类 chips | `/` | `/api/v1/tags` + public approved character counts（只展示有内容的非 muted tag） |
| 搜索 | `/`、route topbar | search index |
| 排序 | `/` | ranking mode（For You/Popular/Newest/Following，带 period label） |
| 筛选 | `/` | gender/style/age facets |
| 无限加载 | `/` | pagination cursor |
| 角色详情/聊天启动 | card click | Character detail 或 ChatSession |

### 5.2 Creation

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Gender | `/create` | Character.gender（Female/Male/Trans） |
| Style | `/create` | Character.style（Realistic/Anime） |
| Appearance/race | `/create` | Character.appearance（human/fantasy options + Custom） |
| Hair | `/create` | Character.appearance.hair（style/color options + Custom） |
| Body | `/create` | Character.appearance.body（body type/body-feature options） |
| Name | `/create` | Character.name（generated default name input） |
| Advanced details | `/create` | Character.extendedProfile（optional accordion/button） |
| Tag manager | `/create` | Character.tags（final submit 前可管理） |
| Appearance/Personality tabs | `/create` | draft profile sections |
| Preview generation | `/create` | CharacterPreviewJob |
| Visual identity anchor | `/create` | CharacterVisualProfile（preview 候选图中选择基准图，生成 active identity profile） |
| Bring to life action | `/create` | Character create API |
| Save to My AI | `/custom` | user library |

### 5.3 Chat

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Chat landing | `/chat` | marketing route |
| Character chat | `/chat/*` 或角色详情 | ChatSession、Message |
| Conversation memory | chat | memory summary |
| Message quota | chat | plan、usage |
| Safety moderation | chat | safety flags |
| Report chat/character | chat/detail | ContentReport |

### 5.4 Generation

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Image mode | `/generate` | GenerationJob.mode |
| Video mode | `/generate` | GenerationJob.mode（仅在 `video_gen`、entitlement、video model/provider 同时满足时曝光） |
| Mode presets | `/generate` | generationModePreset（Presets、Image Edit） |
| Select character | `/generate` | characterId（dialog with search, filters, Freeplay, characters） |
| Character consistency | `/generate`、Chat image | CharacterVisualProfile（active identity version、anchor/reference assets、consistency mode；详见 `CHARACTER_CONSISTENT_IMAGE_GENERATION_PRD.md`） |
| Background | `/generate` | controls.backgroundPresetId（All/My Presets/Community/categories/Custom/Create a Preset） |
| Pose | `/generate` | controls.posePresetId（Image mode only；preset categories） |
| Outfit | `/generate` | controls.outfitPresetId（All/My Presets/Community/categories/Custom/Create a Preset） |
| Premium custom prompt | `/generate` | prompt、plan（non-entitled user 触发 upgrade modal） |
| Advanced settings | `/generate` | model/style、negativePrompt、orientation、count（Dreamy/Vivid、premium negative prompt、ratio、2-256 images） |
| Generate action | `/generate` | async job |
| Images/Liked/Videos | `/generate` | MediaAsset（Images/Liked 默认可见；Videos 仅 Video 启用时可见） |
| Gallery filter/manage | `/generate` | MediaAsset query、bulk selection（Filter、Manage、Select All、Like） |
| Long-tail generator pages | `/generate/*`、`/generator/*` | SEO route content |

### 5.5 Subscription

> **当前上线口径**：dreamcoin 是唯一消耗型货币；语音按计划分钟额度优先、超出后再扣 dreamcoin。当前 `/upgrade` 计划卡展示 included dreamcoins 与聊天/模型权益，不展示 images/videos/voice quota 示意；未来若恢复媒体等价展示，必须由 `includedDreamcoins ÷ 费率` 动态算出，且 `video_gen=false` 时不得展示视频承诺。定价/费率/免费档 SSoT 见 `ECONOMY_AND_PRICING.md`。

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Upgrade plan cards | `/upgrade` | SubscriptionPlan |
| Monthly/Yearly | `/upgrade` | billingPeriod（Monthly、Yearly Save 75% + free coins） |
| Premium plan | `/upgrade` | plan=premium（$19.99/mo 或 $99.90/yr；1,500 dreamcoins/月或 18,000/年；image + voice enabled，videoGeneration=false；卡面展示 dreamcoins + chat entitlements） |
| Deluxe plan | `/upgrade` | plan=deluxe（$59.99/mo 或 $299.90/yr；6,000 dreamcoins/月或 72,000/年；Premium models、3x memory、voice 120 min/月；video entitlement 需 `video_gen` + provider ready 才能曝光） |
| Promo surfaces | home toast/banner | campaign |
| Checkout | `/upgrade` | payment provider |
| Premium entitlement | app-wide | plan flags |
| Dreamcoin balance | app-wide | DreamcoinTransaction |

### 5.6 Profile, Feed, Community

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| My AI search | `/custom` | user library search |
| My AI tabs | `/custom` | recent、characters、presets、created、media；groupChats/packs 仅显示无行动入口的延期空态 |
| Profile settings | `/profile` | User、Preferences |
| Dreamcoin balance | `/profile`、app-wide | DreamcoinLedger |
| Billing management | `/profile#billing`、`/upgrade` | Subscription |
| Redeem code | `/profile/redeem-code` | RedeemCode |
| Referral program | `/profile`、`/signup?ref=` | 已接线：邀请码生成/分享 + signup 读 `?ref` 归因 + give/get dreamcoins（被邀请人 +150、邀请人 +150，按 ledger idempotencyKey 每被邀请人一次）。前端 AuthWorkspace 捕获 `?ref` 随 signup 提交 |
| Preferences/notifications | `/profile/notifications` | UserPreferences |
| Language | — | 受控 beta 仅英文；Profile 语言切换器已移除（无 i18n 字典层，曾为"假成功"死控件）。`user_preferences.locale` 字段保留，待未来接入 next-intl 等再启用 |
| Account management | `/profile/account-management` | User status/deletion |
| Feed cards | `/feed` | FeedItem |
| Feed actions | `/feed` | chatStart、remix、like、share、report |
| Community carousel | `/community` | CampaignBanner |
| Community tabs | `/community` | dreamers、characters、collections |
| Dreamers leaderboard | `/community` | CreatorRank（Featured、Top、followers/interactions） |
| Creator public profile | `/creators/:id` | Creator profile、public character grid、follow state |
| Community filters | `/community` | releaseWindow、gender、style（Last 30 Days/All Time、Any/Female/Male/Trans、Any/Realistic/Anime） |

### 5.7 SEO Content

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Resources hub | `/resources-hub` | route index |
| Type index | `/type` | type routes |
| Videos index | `/videos` | video routes |
| Comparison hub | `/comparison` | competitor routes |
| Article template | `/guides/*` 等 | article content |
| Related pages | 多数模板 | prefix routes |
| Metadata | all static routes | route title/description |

### 5.8 Help, Terms, Safety

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Help support tab | `/helpdesk` | support links（Account/Billing、Trust contact、Discord）、FAQ、登录+年龄门后提交支持请求（analytics 事件 + `SUP-...` 参考号） |
| Bugs/Features/Changelog | `/helpdesk` | beta feedback/changelog 区块 + Premium CTA；Roadmap voting 已支持提交 feature/bug/improvement idea、Vote/Unvote 与持久计票 |
| Terms index | `/terms` | policy routes（12 policy links） |
| Age verification docs | `safety.ourdream.ai/policies/age-verification` | AgeVerification（Go.cam、jurisdiction、stored verification info） |
| Moderation docs | `safety.ourdream.ai/moderation/*` | moderation layers、appeals（input/output/metadata/human/community layers） |
| Reporting docs | `safety.ourdream.ai/reporting/how-to-report` | reports、regulator/security paths（in-product/email/report types） |
| Privacy/safety tools | `safety.ourdream.ai/your-account/*` | privacy、mute、delete、account controls |

### 5.9 未定义产品域（V1.1 / 暂不实现）

以下功能在 UI/tab 中出现，但**产品语义尚未定义，不属于当前 beta**，仅以明确空态呈现。显式标注以免误读为已规划交付（对齐 12-roadmap V1.1 与 M8 「group-chats/packs 返回空态」）。Creator public profile 与 Feed Remix 已从本节移出：`/creators/:id`、follow 状态、Remix -> Generate、`feed_remix` provenance 与 Gallery 回链均已落地并纳入当前实现覆盖。

| 域 | 出现位置 | 状态 | 一句话范围草图 |
| --- | --- | --- | --- |
| Group Chats | My AI tab（§5.6） | V1.1 / 暂不实现 | 一个会话内多角色参与的群聊；MVP 仅保留无 CTA 空态，不实现多角色编排与额度；Explore 不展示空结果 chip，未来只有在有公开可浏览内容时才作为内容 tag 出现。 |
| Packs | My AI tab（§5.6） | V1.1 / 暂不实现 | 角色/preset 的打包合集（可能可分享或购买）；MVP 仅保留无 CTA 空态，不实现打包模型与分发。 |

## 6. 页面族摘要（用户任务）

### Explore `/`

用户任务：

- 发现热门角色。
- 通过筛选和分类缩小角色范围。
- 从角色卡进入聊天或注册。
- 通过首页 FAQ 理解平台和价格。

### Create `/create`

用户任务：

- 通过多步向导配置 AI companion。
- 选择性别、风格、外观、发型、体型、名称和 tags。
- 使用高级详情补充角色设定。
- 生成预览图，确认后 Bring Your AI To Life。

### Generate `/generate`

用户任务：

- 默认选择 Image；Video 进入当前发布范围时可切换 Image / Video。
- 选择角色或 Freeplay。
- 配置 mode presets、背景、姿势、服装、custom prompt 和 advanced settings。
- 使用 Images、Liked、Filter 和 Manage 管理结果；Video 启用时可用 Videos。

### My AI/Profile `/custom`、`/profile`

用户任务：

- 查看最近角色和已创建角色。
- 管理 presets；群聊和 packs 在当前 beta 仅作为明确延期空态展示。
- 从可创建域的空态进入创建；延期域不展示行动入口。
- 在 Profile 查看余额、订阅、兑换码、推荐奖励、偏好、支持、法律和账号管理。

### Feed/Community `/feed`、`/community`

用户任务：

- 浏览平台或用户内容。
- 发现创作者。
- 进入 creator public profile 并关注/取消关注。
- Chat、Remix、Like、Share、Report。
- 按 Dreamers、Characters、Collections 和 Release/Gender/Style 维度浏览社区榜单。

### Upgrade `/upgrade`

用户任务：

- 比较 monthly/yearly。
- 比较 Premium/Deluxe。
- 查看 dreamcoin、图片、条件启用的视频、语音、消息、模型/记忆等权益。
- 购买对应计划。

### Library/Article/Comparison

用户任务：

- 从长尾搜索进入具体主题。
- 阅读指南、类型、视频生成和竞品对比内容。
- 跳转到 Explore、Create、Generate 或 Upgrade。
