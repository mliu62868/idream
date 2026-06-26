# Ourdream.ai Clone Product Requirements Document

更新日期：2026-06-13

## 1. 文档目的

本文档基于本地静态 clone、已保存截图、`docs/research` 检查资料、当前源码和 2026-06-13 Chrome 线上巡检，整理 Ourdream.ai 目标产品的完整产品功能、页面信息架构和后续实现范围。

本地 clone 当前主要是静态视觉还原：路由、导航、页面模板、角色卡片、营销内容、生成器表面和订阅表面已覆盖；登录、支付、真实聊天、角色创建持久化、图片/视频生成、搜索筛选、社区互动、审核等后台能力尚未实现。

## 2. 产品定位

Ourdream.ai 是一个 18+ AI 角色扮演与 AI 伴侣平台，核心价值是让用户发现、创建、聊天、生成和管理个性化 AI 角色。

产品主张：

- 海量 AI 角色和场景可探索。
- 用户可以通过多步向导创建自定义 AI 伴侣，定义性别、风格、外观、发型、体型、名称、tags 和高级设定。
- 用户可以与公开或私有角色进行长上下文角色扮演聊天。
- 用户可以围绕角色或 Freeplay 生成图片和视频，并管理 Images、Videos、Liked gallery。
- Premium/Deluxe 订阅通过无限消息、每月 dreamcoin、高级模型/记忆和高级控制提升体验。**生成（图片/视频/语音）统一消耗 dreamcoin，不设独立配额**，口径见 `ECONOMY_AND_PRICING.md`。
- 平台必须具备 18+ 年龄门槛、部分场景下的身份年龄验证、安全规则、隐私保护、内容举报、申诉和帮助支持。

## 3. 用户与角色

| 用户类型 | 目标 | 核心需求 |
| --- | --- | --- |
| 首次访问者 | 快速理解平台并开始探索 | 年龄确认、清晰导航、精选角色、免费注册入口 |
| 角色探索用户 | 找到想互动的 AI 角色 | 搜索、排序、筛选、分类、角色卡详情、热度指标 |
| 角色扮演用户 | 与角色进行持续对话 | 私密聊天、上下文记忆、聊天历史、场景延续、重新生成回复 |
| 创作者 | 创建自定义角色或故事场景 | 多步草稿、外观、tags、高级详情、预览、发布或私有保存 |
| 生成用户 | 为角色生成图片/视频 | 角色/Freeplay、模式切换、preset、背景、姿势、服装、自定义提示词、图库管理 |
| Premium/Deluxe 用户 | 获得更高额度和高级能力 | 订阅、dreamcoin、无限消息、高级生成、语音额度、模型/记忆增强、续费与取消 |
| 社区用户 | 浏览创作者和公共内容 | Feed、Community、Chat、Remix、Like、Share、Report、创作者榜单 |
| SEO 访问者 | 从长尾内容页进入平台 | 指南、类型页、比较页、视频/生成器落地页、CTA |
| 安全/支持用户 | 了解规则或处理问题 | Safety Center、Help Desk、Terms、举报、账号问题 |

## 4. 产品目标

1. 将探索、创建、聊天、生成和订阅串成完整转化链路。
2. 让用户在 30 秒内完成从首页到角色互动或创建入口的决策。
3. 通过 SEO 页面覆盖 AI companion、AI roleplay、生成器、比较和指南长尾流量。
4. 将成人内容限制、隐私、举报和禁止内容规则前置，降低合规和信任风险。
5. 为后续从静态 clone 进入真实产品开发提供清晰模块边界。

## 5. 信息架构

### 5.1 全局壳层

所有主要页面共享深色 app shell：

- 桌面左侧导航：Create、Explore、Chat、Generate、My AI、Feed、Community。
- 次级入口：Help Desk、Safety Center、Discord、More。
- 用户入口：Login、Join Free、Profile、Upgrade。
- Profile：余额、订阅、兑换码、推荐奖励、偏好/通知、语言、法律、账号管理。
- 移动端：顶部菜单和底部导航 Explore、Chat、Create、Generate。
- Footer：Learn、Popular、Help、公司信息和社交链接。
- 促销：桌面右下浮层和移动顶部 banner。
- 年龄门槛：18+ 访问确认，接受后写入本地状态，未确认前不应进入成人内容。

### 5.2 页面族

本地路由覆盖来自 sitemap 的 142 个公开 URL，加上 7 个站内工具页和 16 个 Safety Center 镜像页，共 164 个非根路径。页面通过模板归类：

| 模板 | 代表路径 | 产品职责 |
| --- | --- | --- |
| Home / Explore | `/` | 角色发现、搜索筛选、推荐流、SEO FAQ、转注册 |
| Marketing | `/chat`、`/ai-girlfriend`、`/ai-boyfriend`、`/affiliate`、`/login`、`/signup` | 产品解释、转化 CTA、角色展示、功能价值说明 |
| Create | `/create` | 多步角色创建器、preview generation、final submit |
| Generator | `/generate`、`/generate/*`、`/generator/*` | 图片/视频生成器、preset 配置、图库管理和生成器 SEO 落地页 |
| Profile | `/custom`、`/profile` | 用户内容库、账号设置、余额、推荐和偏好 |
| Feed / Community | `/feed`、`/community` | 内容流、互动、举报、社区榜单和 collections |
| Library | `/resources-hub`、`/type`、`/videos`、`/games`、`/romantasy` | 内容索引和分类入口 |
| Article | `/guides/*`、`/sex-chat/*`、`/ai-girlfriend/*`、`/videos/*`、`/type/*`、`/ai-instructions` | 长文指南、类型页、视频页、SEO 内容 |
| Comparison | `/comparison`、`/comparison/*`、`/*-alternatives` | 竞品对比、功能卖点、升级转化 |
| Upgrade | `/upgrade` | 订阅方案和权益 |
| Terms | `/terms` | 条款、政策和法律入口 |

## 6. 核心功能需求

### 6.1 年龄门槛与访问控制

| ID | 需求 | 优先级 | 当前 clone 状态 |
| --- | --- | --- | --- |
| AG-01 | 首次访问成人内容前必须展示 18+ 年龄确认。 | P0 | 有视觉组件，默认未挂载 |
| AG-02 | 用户点击确认后记录接受状态，后续访问不重复展示。 | P0 | 原站行为已记录，clone 未实现 |
| AG-03 | 未确认用户不应看到成人角色内容、生成器或聊天内容。 | P0 | 未实现 |
| AG-04 | 年龄门槛需链接 Terms，并提供离站选项。 | P0 | 有视觉文案 |
| AG-05 | 按司法辖区或风险触发第三方身份年龄验证，并与普通 age gate acceptance 分开存储。 | P0/P1 | Chrome Safety Center 观察到 Go.cam 身份验证说明；clone 未实现 |

> **age gate ≠ age verification（用户视角区分）**
> - **age gate（年龄门槛，AG-01~04）= 自助确认 18+**：一个弹层，用户点「我已年满 18 岁」即放行，写入本地/会话状态。**P0，MVP 即有**，是今天用户真实经历的唯一年龄关卡。
> - **age verification（身份年龄验证，AG-05）= 第三方身份核验**（如 Go.cam，上传证件/活体）：**按司法辖区触发**，是**面向公众上线前的硬门槛**。**MVP 默认 `not_required` 直通**（保留数据表与守卫，不接 provider，见 `12-roadmap M1` 范围调整与暂缓项）。
> - **今天 vs 上线**：今天用户只经历一次自助 18+ 确认；上线后在受管辖区会被额外要求完成身份核验才能继续访问成人内容。

### 6.2 探索首页

| ID | 需求 | 优先级 | 当前 clone 状态 |
| --- | --- | --- | --- |
| EX-01 | 展示角色卡片流，包括图片、名称、年龄、简介、likes、chat count、creator。 | P0 | 已静态实现 |
| EX-02 | 支持排序和 feed/ranking 模式，如 For You、Popular、Newest、Following，并保留当前 period label。 | P0 | Chrome 观察到菜单项；本地为视觉控件 |
| EX-03 | 支持搜索角色、指南和生成器。 | P0 | 视觉控件已实现 |
| EX-04 | 支持性别、风格、年龄筛选。 | P0 | 视觉控件已实现 |
| EX-05 | 支持分类 chips，如 Group Chats、Romantic、Slow Burn、Cosplay 等。 | P0 | 已静态展示 |
| EX-06 | 角色卡点击进入角色详情或聊天启动页。 | P0 | 未实现真实详情页 |
| EX-07 | 支持无限加载、分页或虚拟列表。 | P1 | loading row 视觉已实现 |
| EX-08 | 在推荐流中插入促销卡或活动卡。 | P1 | 已静态实现 |
| EX-09 | 首页底部展示 SEO H1、指标、FAQ 和 Join Now CTA。 | P1 | 已实现 |

角色内容要求：

- 所有角色必须明确为成年人，年龄不得低于 18。
- “Teen”等分类在产品语义上必须定义为 18+ young adult，不允许未成年人或未成年外观内容。
- 角色描述不得包含真实人物深度伪造、未成年人、非同意、违法或平台禁止内容。

### 6.3 角色详情与聊天

| ID | 需求 | 优先级 | 当前 clone 状态 |
| --- | --- | --- | --- |
| CH-01 | 角色详情页展示头像/封面、名称、年龄、简介、标签、热度、creator、Vivid 标识。 | P0 | 首页卡片有部分信息 |
| CH-02 | 用户可从角色卡启动聊天。 | P0 | 未实现 |
| CH-03 | 聊天应支持历史会话、上下文记忆和角色设定注入。 | P0 | 未实现 |
| CH-04 | 用户可重新生成回复、编辑上一条、删除会话。 | P1 | 未实现 |
| CH-05 | 支持聊天内生成图片或跳转生成器。 | P1 | 未实现 |
| CH-06 | 免费用户和 Premium 用户的消息额度、速度或模型能力需要区分。 | P1 | 未实现 |
| CH-07 | 聊天必须接入安全策略、举报和内容限制。 | P0 | 未实现 |

### 6.4 角色创建器

| ID | 需求 | 优先级 | 当前 clone 状态 |
| --- | --- | --- | --- |
| CR-01 | 用户可选择角色 Gender：Female、Male、Trans。 | P0 | Chrome 线上已观察；本地需实现真实状态 |
| CR-02 | 用户可选择 Style：Realistic、Anime。 | P0 | Chrome 线上已观察；本地需实现真实状态 |
| CR-03 | 用户可选择外观/race、发型、体型等多步属性，并支持 Custom。 | P0 | Chrome 线上已观察；本地未实现向导 |
| CR-04 | 用户可编辑或接受生成的角色名称。 | P0 | Chrome 线上已观察 name input |
| CR-05 | 用户可打开 Advanced Details 补充角色设定。 | P1 | Chrome 线上观察到入口；clone 未实现 |
| CR-06 | 用户可管理创建前 tags。 | P0 | Chrome 线上已观察 tag manager |
| CR-07 | 系统可在创建前生成/刷新预览图。 | P1 | Chrome 线上观察到 preview generation state |
| CR-08 | 用户点击 final CTA 后生成角色，保存到 My AI，并可设为公开或私有。 | P0 | 未实现 |
| CR-09 | 创建流程应校验年龄、禁止内容、真实人物、现有 IP、非同意框架和规避尝试。 | P0 | 未实现 |

### 6.5 图片与视频生成器

| ID | 需求 | 优先级 | 当前 clone 状态 |
| --- | --- | --- | --- |
| GN-01 | 支持 Image 和 Video 模式切换。 | P0 | 视觉控件已实现 |
| GN-02 | 生成前必须选择 Character 或 Freeplay。 | P0 | Chrome 线上已观察 selector；未选时 CTA disabled |
| GN-03 | 支持 Mode Presets，并包含 Presets 和 Image Edit 模式。 | P1 | Chrome 线上已观察 |
| GN-04 | 支持 Background、Pose、Outfit preset，preset 来源包含内置、My Presets、Community、Custom。 | P1 | Chrome 线上已观察 |
| GN-05 | Image 和 Video 模式字段不同：Video 模式不显示 Pose，并可标注 new model。 | P1 | Chrome 线上已观察 |
| GN-06 | Custom Prompt 和 Negative Prompt 为 Premium 或高级能力，应显示锁定/升级状态。 | P1 | Chrome 线上已观察升级 modal |
| GN-07 | Advanced Settings 支持模型/风格、orientation、数量等配置。 | P1 | Chrome 线上已观察 |
| GN-08 | 用户点击 Generate 后创建异步任务并展示 loading/progress。 | P0 | 未实现 |
| GN-09 | 生成结果进入 Images、Videos、Liked gallery。 | P0 | 静态图库已实现 |
| GN-10 | 用户可保存、喜欢、删除、下载、筛选或批量管理生成结果。 | P1 | Chrome 观察到 Filter/Manage/Like；本地未实现 |
| GN-11 | 失败时展示原因、是否扣费和重试入口。 | P1 | 未实现 |
| GN-12 | 生成内容必须通过安全过滤、账户额度和 dreamcoin 校验。 | P0 | 未实现 |

### 6.6 My AI、Profile、Feed、Community

| ID | 需求 | 优先级 | 当前 clone 状态 |
| --- | --- | --- | --- |
| PF-01 | My AI 展示 Recent、Characters、Group Chats、Packs、Presets、Created，并支持 search。 | P0 | Chrome 线上已观察 |
| PF-02 | 用户可继续最近会话。 | P0 | 未实现 |
| PF-03 | 用户可管理自建角色：编辑、复制、删除、发布、设为私有。 | P1 | 未实现 |
| PF-04 | Profile 展示余额、订阅、兑换码、推荐奖励、偏好通知、语言、法律和账号管理入口。 | P0 | Chrome 线上已观察；本地未实现 |
| PF-05 | Feed 展示用户或平台推荐内容流，并提供 Chat、Remix、Like、Share、Report。 | P1 | Chrome 线上已观察；本地未实现 |
| PF-06 | Community 展示 banner carousel、Dreamers/Characters/Collections、Featured/Top leaderboard 和 release/gender/style filters。 | P1 | Chrome 线上已观察；本地未实现 |
| PF-07 | 支持点赞、收藏、关注、举报和分享。 | P1 | 未实现 |

> **未定义产品域（V1.1 / 暂不实现）**：Group Chats、Packs、Remix、Creator public profile（`/creator/:id`）在 UI/路由中出现但产品语义未定义，**不属于 MVP**，MVP 仅以空态/占位呈现。范围草图与边界见 `ProductFeatureMap §5.9`，落地节奏见 `12-roadmap V1.1`。

### 6.7 订阅、定价与 dreamcoin

> **单一货币模型**：dreamcoin 是平台**唯一**消耗型货币，图片/视频/语音统一按费率扣币，**不存在独立的图片/视频/语音配额计数器**。计划卡上的「200 images / 10 videos / 20 min voice」只是「当月币量 ÷ 对应费率」的**展示示意**，由代码动态算出。价格、费率、免费档、退款的单一事实来源（SSoT）为 `ECONOMY_AND_PRICING.md`，本节不重复费率卡。

| ID | 需求 | 优先级 | 当前 clone 状态 |
| --- | --- | --- | --- |
| UP-01 | `/upgrade` 展示 Yearly 和 Monthly 计划。 | P0 | Chrome 线上已观察 |
| UP-02 | 展示 Premium 和 Deluxe 两档价格、账单周期、权益、促销和 dreamcoin bonus。 | P0 | Chrome 线上已观察 |
| UP-03 | 支持订阅 checkout、支付成功、失败、取消和续费。 | P0 | 未实现 |
| UP-04 | 明确 Premium 权益：每月 dreamcoin、无限消息、音频消息、custom/negative prompt、视频生成、发布角色。生成额度均以 dreamcoin 折算示意，非独立配额（见 economy §0/§2）。 | P0 | Chrome 线上已观察 |
| UP-05 | 明确 Deluxe 权益：Premium 全部 + Premium chat models + 3× chat memory + 更高每月 dreamcoin（同一套费率，见 economy §2）。 | P0 | Chrome 线上已观察 |
| UP-06 | 使用 dreamcoin 前展示余额、消耗和不足时的充值/升级入口（见 economy §5）。 | P1 | 未实现 |
| UP-07 | 用户可在账号页管理订阅。 | P1 | Chrome 观察到 profile Subscription entry；本地未实现 |

### 6.8 SEO 与内容页面

| ID | 需求 | 优先级 | 当前 clone 状态 |
| --- | --- | --- | --- |
| SE-01 | 每个 sitemap 路由应有可索引页面、title、description 和 canonical。 | P0 | 已实现基础 metadata |
| SE-02 | 指南页应包含目录、正文分区、FAQ、相关 CTA。 | P1 | 静态 article 模板已实现 |
| SE-03 | 比较页应解释平台差异、功能优势、价格对比和 CTA。 | P1 | 静态 comparison 模板已实现 |
| SE-04 | Library 页面应聚合类型、视频、比较和指南入口。 | P1 | 已实现 |
| SE-05 | 营销页应包含 hero、角色展示、功能区、相关页面和 footer。 | P1 | 已实现 |
| SE-06 | 文章内容不能只使用模板占位，需要补齐真实可读正文。 | P1 | 未完成，当前为模板文案 |

### 6.9 帮助、安全与法律

| ID | 需求 | 优先级 | 当前 clone 状态 |
| --- | --- | --- | --- |
| SF-01 | Safety Center 解释允许/禁止内容、举报、隐私和年龄规则。 | P0 | 外链保留 |
| SF-02 | Help Desk 支持账号、订阅、生成失败、聊天问题，并展示 Bugs/Features/Changelog premium gate。 | P1 | Chrome 线上已观察 |
| SF-03 | Terms 页面可访问，并从年龄门槛和 footer 链接。 | P0 | 已静态实现 |
| SF-04 | 所有用户生成内容必须可举报并进入审核流程。 | P0 | 未实现 |
| SF-05 | 平台必须禁止未成年人/未成年外观、真实人物、现有 IP、非同意框架、违法和规避内容。 | P0 | Safety Center 已说明；系统未实现 |
| SF-06 | 支持用户对角色、媒体、feed item、聊天消息、用户、moderation decision、安全问题和版权/肖像问题提交 report 或 appeal。 | P0/P1 | Safety Center 和 Feed More menu 已观察；系统未实现 |

## 7. 数据模型建议

| 实体 | 关键字段 |
| --- | --- |
| User | id、email、displayName、ageGateAcceptedAt、plan、dreamcoinBalance、createdAt |
| AgeVerification | id、userId、provider、status、jurisdiction、verifiedAt、expiresAt、metadata |
| CharacterDraft | id、ownerId、wizardStep、gender、style、appearance、hair、body、name、tags、advancedDetails、previewJobId |
| CharacterPreviewJob | id、draftId、status、resultAssetId、error |
| Character | id、name、age、description、creatorId、visibility、style、tags、advancedDetails、safetyStatus、imageUrl、stats |
| ChatSession | id、userId、characterId、title、memorySummary、lastMessageAt、visibility |
| Message | id、sessionId、role、content、model、safetyFlags、createdAt |
| GenerationPreset | id、ownerId、scope、type、category、label、controls、visibility |
| GenerationJob | id、userId、characterId、mode、prompt、controls、presetIds、model、orientation、count、status、cost、resultAssetIds、error |
| MediaAsset | id、ownerId、type、url、thumbnailUrl、prompt、liked、visibility、safetyStatus |
| Subscription | id、userId、plan、status、billingPeriod、providerCustomerId、renewalAt |
| DreamcoinTransaction | id、userId、amount、reason、generationJobId、createdAt |
| Referral | id、inviterId、inviteeId、code、status、rewardStatus、createdAt |
| RedeemCode | id、code、reward、status、redeemedBy、redeemedAt |
| ContentReport | id、reporterId、targetType、targetId、reason、status、reviewerId |
| Appeal | id、userId、targetType、targetId、decisionId、status、appealText、resolvedAt |
| RoutePage | path、template、title、description、canonical、contentStatus |

## 8. 关键转化漏斗

1. SEO page 或首页访问。
2. 年龄确认。
3. 浏览角色或阅读产品卖点。
4. 点击 Join Free、Create、Explore characters、Generate 或角色卡。
5. 注册/登录。
6. 开始聊天、创建角色或生成媒体。
7. 遇到额度、高级控制或促销入口。
8. 进入 Upgrade。
9. 支付成功后回到聊天/生成器继续任务。

## 9. 分析与埋点

核心事件：

- `age_gate_viewed`
- `age_gate_accepted`
- `signup_clicked`
- `login_clicked`
- `character_card_viewed`
- `character_card_clicked`
- `explore_filter_opened`
- `explore_search_submitted`
- `category_selected`
- `chat_started`
- `message_sent`
- `character_create_started`
- `character_created`
- `generation_started`
- `generation_completed`
- `generation_failed`
- `media_liked`
- `media_managed`
- `feed_item_shared`
- `feed_item_report_clicked`
- `remix_clicked`
- `upgrade_viewed`
- `checkout_started`
- `subscription_started`
- `referral_invite_clicked`
- `redeem_code_started`
- `content_reported`
- `moderation_appeal_started`

核心指标：

- 年龄确认通过率。
- 首页到注册点击率。
- 角色卡点击率。
- 搜索/筛选使用率。
- 首次聊天启动率。
- 创建器完成率。
- 生成任务成功率。
- 免费到付费转化率。
- 内容举报处理时长。

## 10. 成功指标与北极星

> 本节为产品级度量定义。事件名引用 §9 埋点；货币/配额口径以 `ECONOMY_AND_PRICING.md` 为准。所有目标值标注「初始假设」，需经实测/A-B 校准（免费档参数本身可调，见 economy §3）。

### 10.1 北极星指标（North Star）

**周活跃付费陪伴用户（Weekly Paying Companion Users, WPCU）**：一个自然周内有有效订阅且至少完成一次核心陪伴行为（发消息或生成）的用户数。

选它的理由：本产品价值在「付费用户持续回来陪伴/创作」，而非一次性注册或纯浏览。WPCU 同时绑定了**变现**（付费）与**留存活跃**（每周回来用），比单看付费数或 DAU 更难被增长噱头刷高，是真正的健康度信号。

### 10.2 漏斗目标表（初始假设，待校准）

漏斗对齐 §8 转化链路，每级绑定 §9 既有事件，可直接 SQL 查询（见 12-roadmap M-Analytics）。

| 漏斗指标 | 目标区间（初始假设） | 关联事件（§9） |
| --- | --- | --- |
| 访问 → age gate 通过率 | 80–90% | `age_gate_viewed` → `age_gate_accepted` |
| 注册转化率（访问 → 注册） | 4–8% | `signup_clicked` → `auth/signup` 成功 |
| 注册 → 首次聊天 | 45–60% | `chat_started` / `message_sent` |
| 注册 → 首次生成（aha） | 30–45% | `generation_started` → `generation_completed` |
| 免费 → 付费转化率 | 3–6% | `upgrade_viewed` → `checkout_started` → `subscription_started` |
| 付费次月留存（M1 retention） | 55–70% | 周期内有 `subscription` active + 核心行为 |
| 生成成功率（红线） | ≥ 95% | `generation_completed` ÷（started − 主动取消） |
| 审核误杀率（红线） | ≤ 2% | `content_reported` / moderation 申诉翻案率（`moderation_appeal_started` 翻案占比） |

红线说明：生成成功率与审核误杀率是**体验/合规护栏**而非增长指标——低于/高于红线应触发告警与排障（见 09-observability、admin 后台），不以牺牲它们换转化。

### 10.3 度量原则

- **单一事实来源**：付费/币消耗口径以 `ECONOMY_AND_PRICING.md` 为准，指标不另立货币定义。
- **可调参数入实验**：免费赠币、日消息额度等直接影响 aha 与转化的参数，应进 A-B（economy §3.note），不写死。
- **护栏先于增长**：成功率、误杀率、举报处理时长（§9 末）为硬约束，优先保障。

## 11. 非功能需求

- 性能：首屏应快速展示 app shell 和首批角色卡；图片使用响应式格式和 lazy loading。
- 移动端：底部导航必须始终可用，卡片两列布局不得遮挡内容。
- 可访问性：按钮、链接、筛选和 modal 需要明确 accessible name，键盘可操作。
- 隐私：聊天默认私密，敏感信息不得出现在公开 feed。
- 安全：成人内容访问前置年龄门槛，所有生成和用户内容走安全校验。
- SEO：公开内容页必须服务端可渲染，metadata 完整。
- 国际化：当前 clone 为英文内容，后续如进入多语言，需要分离路由内容和 UI 文案。
- 可靠性：生成任务应异步处理，可恢复、可重试、可展示失败原因。

## 12. 当前 clone 覆盖状态

已覆盖：

- 深色 app shell、桌面 sidebar、移动 bottom nav、footer。
- 首页探索流、角色卡、分类 chips、排序/筛选/search 的视觉状态。
- 促销 banner/toast、SEO FAQ、指标区。
- 164 个本地非根路径的静态路由覆盖。
- Create、Generate、Profile、Library、Article、Comparison、Marketing、Upgrade、Terms 模板。
- 图片资产、角色样例、基础 metadata。

未覆盖：

- 真实年龄门槛挂载和状态持久化。
- 账号注册、登录、profile 数据、推荐奖励、兑换码、偏好和语言。
- 搜索、筛选、排序的真实状态。
- 角色详情页和真实聊天。
- 角色创建多步向导、预览生成、保存、发布、编辑。
- 图片/视频生成任务、preset 服务、gallery filter/manage。
- 支付、订阅、Premium/Deluxe entitlement、dreamcoin。
- Feed/Community 动态、点赞、收藏、关注、分享、举报、榜单。
- 后台安全审核、内容策略执行、身份年龄验证、申诉。
- 长尾文章的真实正文内容。

## 13. MVP 建议

MVP 应优先实现：

1. 年龄门槛、注册登录、用户会话。
2. 探索页搜索、筛选、角色详情和聊天启动。
3. 角色创建器多步草稿、预览、提交审核并保存到 My AI。
4. 基础聊天体验和聊天历史。
5. 图片生成 MVP：选择角色/Freeplay、preset、prompt、生成历史、gallery。
6. Upgrade 页面接入真实支付、Premium/Deluxe 权益校验和 dreamcoin ledger。
7. Safety/Terms/Report/Appeal 基础闭环。

V1.1 再实现：

- 视频生成。
- Feed 的 Chat/Remix/Like/Share/Report。
- Community leaderboards、creator profile、collections。
- creator profile。
- 高级 prompt 控制。
- 生成资产下载、收藏、筛选和批量管理。
- Profile referral、redeem code、preferences、language、account management。
- 文章正文补齐和 SEO 内容运营系统。

## 14. 验收标准

- 所有 `docs/research/SITEMAP_ROUTES.md` 中覆盖的页面族都有明确产品职责。
- 首页、Create、Generate、Profile、Upgrade、Article、Comparison、Library、Marketing、Terms 都有功能需求。
- 每个 P0 需求都能映射到页面、数据实体和用户故事。
- 当前 clone 的已实现/未实现边界清晰，不误导为完整生产功能。
- 成人内容安全、年龄确认、隐私和举报要求被列为 P0。
