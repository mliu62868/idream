# OurDream 产品全面对标公开面快照

观察日期：2026-09-01（America/New_York）

范围：只核对 OurDream 官方第一方域名 `ourdream.ai`、`help.ourdream.ai`、`safety.ourdream.ai` 的公开页面、官方 `robots.txt` / `sitemap.xml`，以及未登录状态下可见、可重复的浏览器交互。新浏览器会先显示 18+ 年龄确认墙；公开 DOM、索引正文或已有年龄确认状态中可见的页面结构，不等于年龄墙后的任务已可用。没有注册、登录、付费、发送 Chat、生成媒体、点赞、Remix、提交角色或联系支持。

这份文档回答的是：**OurDream 当前公开呈现了哪些产品面，iDream 的“全面对标”目标不能漏掉什么。** 它不是 OurDream 后台实现证明，也不是 iDream 当前实现状态报告。

## 1. 证据口径

| 标记 | 含义 | 能支持什么 | 不能支持什么 |
| --- | --- | --- | --- |
| `公开 UI 已验证` | 未登录浏览器里实际看见页面、控件、空状态或公开数据 | 页面族存在、当前 IA、当前可见交互入口 | 登录后是否可用、请求是否成功、是否真实扣费或持久化 |
| `官方营销声称` | OurDream 官方产品页、FAQ、帮助文章里的文字 | OurDream 对外承诺与产品叙事 | 运行时行为、质量、隐私技术实现、吞吐和成功率 |
| `官方索引已验证` | 官方 `robots.txt`、`sitemap.xml` 的当前内容 | 抓取规则、公开索引页面族和 URL 规模 | 页面流量、排名、转化、页面内容质量 |
| `登录/状态墙后未验证` | 页面入口公开，但核心任务需要账号、已有资产、订阅、人机验证或真实请求 | 对标域存在 | 完整流程、异常路径、交付、账本和回滚 |

### iDream 权威边界

- 本快照只定义 **OurDream 目标对标输入**。
- [`ProductFeatureMap.md`](../product/ProductFeatureMap.md) 只描述 iDream 目标产品面；iDream 当前实现状态仍以 [`CURRENT_FUNCTIONAL_COVERAGE.md`](../product/CURRENT_FUNCTIONAL_COVERAGE.md)、代码、数据库与真实运行证据为准。
- iDream 剩余工作仍以 [`REMAINING_WORK_EXECUTION_PLAN.md`](../product/REMAINING_WORK_EXECUTION_PLAN.md) 为执行入口。
- OurDream 的营销文案、模型名、价格、币价和规模数字不能反向覆盖 iDream 的产品、账本、Provider 或运行时 SSoT。
- OurDream 当前公开的是月/年自动续期订阅，并在到期后重新模糊图片、视频与 Community Packs；这是竞品事实，不是 iDream 的需求。iDream 现行经济规则仍以 [`ECONOMY_AND_PRICING.md`](../product/ECONOMY_AND_PRICING.md) 为准：一次性预付周期访问、当前 Provider 不自动续订、既有聊天和已交付媒体到期后不锁回。

### 年龄墙与登录态边界

- 新浏览器访问首页、Chat、Generate、My AI、Feed、Community、Profile、Help Desk、Images、Videos、Resources Hub 等路由时，首先可见的是 `ADULTS ONLY / Age Verification Required / I'm over 18`。这是年龄确认墙，不应误写成登录墙。
- 本轮没有规避年龄确认、人机验证或登录。下文对这些路由的“公开 UI 已验证”只指公开 DOM、公开正文、已有年龄确认状态中的页面壳、控件或空状态；Chat、生成、保存、购买、发布、资产与结算仍是 `登录/状态墙后未验证`。

## 2. 核心结论

1. **OurDream 不是单一“长期伴侣关系产品”。** 当前公开产品骨架同时包含 Explore、完整 Create、Chat、Generate、My AI、Feed、Community、Upgrade、Profile、Support、Terms、Safety 与大规模 SEO 内容矩阵。
2. **iDream 的产品定位应是完整对标 OurDream 的 18+ AI 角色扮演 / AI 伴侣平台。** 关系记忆、角色一致性和跨会话连续性是 Chat 质量能力，不是压低 Create、Generate、资产、Feed、Community 或 SEO 范围的理由。
3. **完整对标应按用户结果对标，不应逐字复制动态参数。** OurDream 不同官方页面对角色创建币价、免费视频资格、视频币价和 Community Pack 币价存在同时可见的不一致；这些值必须由 iDream 自己的定价与能力 SSoT 决定。
4. **公开面足以证明产品域，不能证明登录后闭环。** Create 深层步骤、真实 Chat、媒体生成、资产持久化、Pack 购买、发布、结算与订阅操作仍需单独的登录态 E2E 取证。
5. **SEO/内容不是边角料。** 官方 sitemap 当前有 212 个 URL；Generate、Videos、Images、Types、Sex Chat、Guides、Comparison 构成持续获客与转化前置层。

## 3. 全站导航与产品身份

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [首页 / Explore](https://ourdream.ai/) | 未登录浏览器 DOM + 官方页面正文 | 主导航同时列出 Explore、Chat、Create、Generate、My AI；扩展导航列出 Feed、Community、Help Desk、Safety Center、Profile、Upgrade。首页自称 AI roleplay & companion platform / Unlimited AI Roleplay Platform。 | 公开 UI 已验证；产品身份文字是官方营销声称 |
| 2026-09-01 | [首页 / Explore](https://ourdream.ai/) | 未登录浏览器 DOM | 全站还有 Login、Join Free、Language、Buy Coins/Upgrade、Discord，以及 2026 OURDREAM.AI / Dream Studio USA, Inc. 品牌归属。 | 公开 UI 已验证 |
| 2026-09-01 | [首页 FAQ](https://ourdream.ai/) | 官方页面正文 | 官方把产品描述为可自定义角色外观、人格、声音，并提供聊天、图片、视频、语音与记忆。 | 官方营销声称 |

因此，正确的产品级对标范围是：

```text
发现内容 → 创建角色 → Chat/行动 → 图片/视频/语音生成
        ↘ My AI/资产 ↔ Feed/Community/Creator
                     ↘ Upgrade/Dreamcoins
SEO/内容 → 获客与教育        Support/Terms/Safety → 信任与运营闭环
```

## 4. 核心产品页面族

### 4.1 Explore / 发现

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Explore](https://ourdream.ai/) | 未登录浏览器 DOM | 可见 `Popular · Month` 排序、Gender、Style、Age 筛选；内容类型有 All、Group Chats、Comics；还有大量主题标签。 | 公开 UI 已验证 |
| 2026-09-01 | [Explore](https://ourdream.ai/) | 未登录浏览器 DOM + 官方页面正文 | 角色卡公开展示角色名、年龄、场景介绍、Creator handle 和两组互动计数；公开角色列表可直接浏览。 | 公开 UI 已验证 |
| 2026-09-01 | [Explore](https://ourdream.ai/) | 官方页面正文 | 页面包含文本搜索输入，示例提示为按外观关键词搜索。 | 公开 UI 已验证 |
| 2026-09-01 | [Chat 产品页](https://ourdream.ai/chat) | 官方页面正文 | 官方称用户可从公开角色开始 Chat，且无需账号即可开始前几条消息。 | 官方营销声称；真实发送未验证 |

**对标含义：** Explore 不是静态首页陈列，而是搜索、排序、结构化筛选、多内容类型、角色卡社会证明与 Chat 转化入口的组合。

### 4.2 Create / 完整角色创建器

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Create](https://ourdream.ai/create) | 未登录浏览器 DOM | 创建向导公开显示六步顺序 `Style → General → Face → Body → Details → Image`；首步真实可见 Female / Male / Trans、Realistic / Anime 与 `Begin`。 | 公开 UI 已验证；六步后的字段提交未验证 |
| 2026-09-01 | [Create](https://ourdream.ai/create) | 官方页面正文 | Step 1 宣称支持 ethnicity、skin tone、eye colour、hair colour/style、body type、breast size、butt size 与自定义外观 prompt。 | 官方营销声称；深层向导字段未逐项验证 |
| 2026-09-01 | [Create](https://ourdream.ai/create) | 官方页面正文 | Step 2 宣称有 40+ personality types、自定义 personality、19 voice options、135 occupations、hobbies 与 fetishes。 | 官方营销声称 |
| 2026-09-01 | [Create](https://ourdream.ai/create) | 官方页面正文 | Step 3 宣称有 29 种 relationship types，并提供自定义 prompt 的权重/语法指导。 | 官方营销声称 |
| 2026-09-01 | [Create](https://ourdream.ai/create) | 未登录浏览器交互 | 点击 `Begin` 后出现 `Verifying you are human…`；未绕过人机验证，因此后续预览、保存、发布与计费未验证。 | 登录/状态墙后未验证 |

**对标含义：** Quick Start 可以是附加快捷入口，但不能替代 Gender、Style、外观、身体、人格、职业、兴趣、声音、关系、Advanced/custom prompt、预览、保存和发布等完整创建能力。

### 4.3 Chat / 历史、模型、记忆与多模态行动

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Chat](https://ourdream.ai/chat) | 未登录浏览器 DOM | 无会话状态显示 `DREAM CHATS`、`You don't have any chats yet!` 与返回 Explore 的 CTA。 | 公开 UI 已验证 |
| 2026-09-01 | [Chat](https://ourdream.ai/chat) | 官方页面正文 | 官方公开列出 5 个 Chat 模型：Balanced、Muse、Genius、Muse Genius、Mastermind；部分高级模型按回复计 Dreamcoin。 | 官方营销声称；模型切换/扣费未验证 |
| 2026-09-01 | [Chat](https://ourdream.ai/chat) | 官方页面正文 | 记忆面公开列出 Auto Memory Log、Pinned Memories、Custom Instructions。 | 官方营销声称；真实跨会话召回未验证 |
| 2026-09-01 | [Chat](https://ourdream.ai/chat) | 官方页面正文 | 控制面公开列出 Lust Level、Response Length、Scene Generation、Active Messages。 | 官方营销声称；设置持久化未验证 |
| 2026-09-01 | [Chat](https://ourdream.ai/chat) | 官方页面正文 | 官方宣称支持 Voice Calls、最多 12 角色的 Group Chats、会话内图片、编辑/删除消息、重新生成回复。 | 官方营销声称；真实任务未验证 |
| 2026-09-01 | [Chat](https://ourdream.ai/chat) | 官方 FAQ | 官方称未登录可试 5 条公开角色消息，登录可保存 Chat；免费用户按消息付币，付费计划包含 unlimited messages。 | 官方营销声称；计费与保存未验证 |
| 2026-09-01 | [Community Written FAQs](https://help.ourdream.ai/en/articles/8993665) | 官方帮助文章 | Group Chat 可点角色头像或输入 `@` 选择应答角色；官方同时说明没有原生 App，可安装 PWA。 | 官方帮助声称；群聊路由与 PWA 安装未验证 |

**对标含义：** Chat 对标不能只做到文本输入输出；目标域包含历史、继续会话、模型选择、记忆控制、行为控制、消息编辑/删除/重试、会话内媒体、语音与群聊。

### 4.4 Generate / 图片、编辑、视频与 Gallery

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Generate](https://ourdream.ai/generate) | 未登录浏览器 DOM | 顶部真实可见 Image / Video、Create Image / Edit Image；图片创建器显示 Presets、Character 必填、Pose/Outfit/Scene 可选、Custom Prompt Premium、Settings、数量与 Generate 币价按钮。 | 公开 UI 已验证；真实生成未执行 |
| 2026-09-01 | [Generate](https://ourdream.ai/generate) | 未登录浏览器 DOM | 角色选择器公开展示 Gender、Style 筛选和公共角色列表。 | 公开 UI 已验证 |
| 2026-09-01 | [Generate](https://ourdream.ai/generate) | 官方页面正文 | 官方把生成入口分为公共角色、自建角色、Free Play；Scene 由 Pose、Background、Outfit 与 custom prompt 组成，并明确列出 negative prompt。 | 官方营销声称 |
| 2026-09-01 | [Generate](https://ourdream.ai/generate) | 官方页面正文 | 结构化 Catalog 宣称 100+ poses、40+ backgrounds、20+ outfits；这些是公开广度基线，不是登录态 Catalog 计数证据。 | 官方营销声称；运行时未验证 |
| 2026-09-01 | [Generate](https://ourdream.ai/generate) | 官方页面正文 | 官方列出 Dreamy 与 Vivid 1.0 图片模型；Video 宣称多模型、最长 60 秒/scene、最多 10 scenes、可加 AI voice、多个宽高比与质量档。 | 官方营销声称；实际视频表单/生成未验证 |
| 2026-09-01 | [Generate](https://ourdream.ai/generate) | 官方页面正文 | 页面正文列出 All / Images / Videos / Liked Gallery 分类，以及批量、视频时长和生成耗时的产品宣称。 | 官方营销声称；Gallery 账户数据未验证 |
| 2026-09-01 | [Generate](https://ourdream.ai/generate) | 官方页面 FAQ | 宣称单批最多 256 张图片；Video 支持 4:5、5:4、9:16、1:1、16:9 五种比例，以及 Balanced / Ultra 1080p 两个质量档。 | 官方营销声称；真实上限、成本与交付未验证 |
| 2026-09-01 | [AI Porn Generator 落地页](https://ourdream.ai/generate/ai-porn) | 官方公开营销页 | 宣称 570+ presets、negative prompt、reference upload、Enhance、still → video、23 languages，并把生成角色接回 Group Chat；这些是落地页叙事，不是登录后表单或成功生成证据。 | 官方营销声称；运行时未验证 |

**对标含义：** Generate 是独立创作工作台，不只是 Chat 的附件按钮；目标域包含角色模式与 Free Play、Presets、结构化场景、custom/negative prompt、图片编辑、图片/视频模式、参数设置、批量和 Gallery。

### 4.5 My AI / 资产与集合

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [My AI](https://ourdream.ai/custom) | 未登录浏览器 DOM | 当前公开标签为 Recent、Characters、Group Chats、Packs、Presets、Created。 | 公开 UI 已验证 |
| 2026-09-01 | [My AI](https://ourdream.ai/custom) | 未登录浏览器 DOM | 空状态显示 `You haven't created a character yet :(` 与 Create new character CTA。 | 公开 UI 已验证 |
| 2026-09-01 | [Community Pack 说明](https://help.ourdream.ai/en/articles/8968257) | 官方帮助文章 | 官方称 Pack 是单一角色的图片/视频库，购买后覆盖现有及未来内容，并在 My AI 的 Collections tabs 查找。 | 官方营销/帮助声称；购买和资产解锁未验证 |
| 2026-09-01 | [Community Written FAQs](https://help.ourdream.ai/en/articles/8993665) | 官方帮助文章 | 分享角色路径是 My AI → 角色 → Edit → Unlisted/Public → 复制 Chat URL；只有 Premium 可提交 Public bots，文章称人工审核通常需 3–5 天。 | 官方帮助声称；提交、审核与分享链接未验证 |

**对标含义：** My AI 不是单一“最近关系首页”；Recent、Characters、Group Chats、Packs、Presets、Created/创作资产共同构成目标资产面。

### 4.6 Profile / 账户设置

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Profile](https://ourdream.ai/profile) | 未登录浏览器 DOM | 页面显示 Account Settings、Dreamcoins、Subscription、Preferences & Notifications、Language、Support & Feedback、Legal。 | 公开 UI 已验证；账户数据和保存操作未验证 |

### 4.7 Feed / 社交分发

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Feed](https://ourdream.ai/feed) | 未登录真实浏览器 DOM | Feed 成功加载纵向媒体卡；每张卡有 `Tap to unmute`、角色名、场景介绍，以及 Chat、Remix、Like。 | 公开 UI 已验证；Like/Remix 未点击 |
| 2026-09-01 | [Feed](https://ourdream.ai/feed) | 官方 HTTP 页面与浏览器对照 | 静态抓取一度只返回 `Something went wrong`，真实浏览器随后加载动态内容，说明该面依赖客户端数据而非纯 SEO 正文。 | 公开 UI 已验证 |

**对标含义：** Feed 是“内容消费 → Chat / Remix / Like”的转化与再创作入口，不能只实现静态瀑布流。

### 4.8 Community / Creator Program

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Community](https://ourdream.ai/community) | 未登录浏览器 DOM | 页面公开展示 Dreamer Program、当前 Level、Creator Studio、Dreamcoin 与现金收益解锁路径，以及创建并公开首个角色的 CTA。 | 公开 UI 已验证 |
| 2026-09-01 | [Community](https://ourdream.ai/community) | 未登录浏览器 DOM | Rising Dreamer 以 100k interactions 为门槛，公开列出 badge/frame、Discord、early access、Creator Studio stats。 | 公开 UI 已验证；资格计算未验证 |
| 2026-09-01 | [Community](https://ourdream.ai/community) | 未登录浏览器 DOM | Lucid Dreamer 以 500k interactions 为门槛，公开列出 verified badge、priority approval 和每次 Pack 购买 100 Dreamcoins。 | 公开 UI 已验证；收益未验证 |
| 2026-09-01 | [Community](https://ourdream.ai/community) | 未登录浏览器 DOM | Dream Architect 为 invite only，公开列出直接联系团队和“每 10k premium Dreamcoins 消费赚 $1”的现金收益文案。 | 公开 UI 已验证；现金结算未验证 |
| 2026-09-01 | [Community](https://ourdream.ai/community) | 未登录浏览器 DOM | 页面还展示 Trending characters、Top Dreamers leaderboard、Release/Gender/Style 过滤、Featured Dreamers，以及 referral、merch、public submission guide 等入口。 | 公开 UI 已验证 |

**对标含义：** Community 不是普通排行榜；它把角色公开、审核、影响力、Creator Studio、Pack 收益、Dreamcoin 与现金激励连成创作者飞轮。

### 4.9 Upgrade / Dreamcoins

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Upgrade](https://ourdream.ai/upgrade) | 未登录浏览器，切换 Monthly / Annual | Monthly：Premium `$19.99/month`；Deluxe `$59.99/month`。Annual：Premium `$9.99/month`、一次 billed `$119.88/year`；Deluxe `$29.99/month`、一次 billed `$359.88/year`。 | 公开 UI 已验证；未进入支付 |
| 2026-09-01 | [Upgrade](https://ourdream.ai/upgrade) | 未登录浏览器 DOM | Premium 显示 1,000 monthly Dreamcoins、20 分钟 voice、10 videos、unlimited messages/audio、image/video generation、voice calls、publish characters。 | 公开 UI 已验证；权益执行未验证 |
| 2026-09-01 | [Upgrade](https://ourdream.ai/upgrade) | 未登录浏览器 DOM | Deluxe 显示 5,000 monthly Dreamcoins、100 分钟 voice、50 videos、free premium chat models、3x chat memory，以及 Premium 的通用权益。 | 公开 UI 已验证；权益执行未验证 |
| 2026-09-01 | [Upgrade](https://ourdream.ai/upgrade) | 未登录浏览器 FAQ 交互 | 官方称 Dreamcoins 用于 generation；约 1,000 coins 对应 200 images / 20 voice minutes / 10 videos；付费计划含 unlimited messages。 | 官方营销声称；成本换算未实测 |
| 2026-09-01 | [Upgrade](https://ourdream.ai/upgrade) | 未登录浏览器 FAQ 交互 | 官方称不足时可从 coin store 以 card、crypto 或 local payment method 充值；可随时取消，并保留权益到已付周期结束。 | 官方营销声称；购买/取消未执行 |
| 2026-09-01 | [订阅帮助文章](https://help.ourdream.ai/en/articles/8757441) | 官方帮助文章 | Standard 月度/年度价格与 Premium UI 一致；年度为一次支付全年，并逐月发币。 | 官方帮助声称 |

**对标含义：** Upgrade 必须有清晰档位、月/年切换、权益对比、币充值、FAQ、支付状态和订阅设置；动态价格与权益必须来自 iDream 自己的 Catalog/Entitlement SSoT。

## 5. Support、Terms 与 Safety 页面族

### 5.1 Support

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Help Desk](https://ourdream.ai/helpdesk) | 未登录官方页面 | 有 Support / Bugs / Features 标签、Help resources、Discord、FAQ 与 Contact Support 入口。 | 公开 UI 已验证；提交工单未执行 |
| 2026-09-01 | [Help Center](https://help.ourdream.ai/) | 官方帮助中心首页 | 公开分类覆盖 Payments & Refunds、Account & Login、Generation Quality + Prompt Improving、Features & Products、Moderation、Resource Links；顶部有 Requests 与 Contact Us。 | 公开 UI 已验证 |
| 2026-09-01 | [What costs coins?](https://help.ourdream.ai/en/articles/10808513) | 官方帮助文章 | 成本指南按 Chat、Voice、Image generation/edit、Video generation/edit、Chatbot/Community 分组，说明支持面与计费面是一体化运营域。 | 官方帮助声称；动态币价见第 7 节冲突 |
| 2026-09-01 | [What costs coins?](https://help.ourdream.ai/en/articles/10808513) | 官方帮助文章 | 当前文章写明：免费用户 Chat 1 coin/message；Genius/Lively Genius 1 coin/response；in-chat image 5/image；premium narration 5/paragraph；voice 50/min；standard image 10/2 images；enhance 10/image；edit 10/20；standard video 100/5s、最多 1,200/60s；video enhance 50/5s；audio 20/s；Create chatbot 10；Pack 250/750/1,000。 | 官方帮助声称；未登录运行时未验证，且动态值不能作为 iDream 规格 |
| 2026-09-01 | [Subscription expiry](https://help.ourdream.ai/en/articles/8832193) | 官方帮助文章 | 官方称订阅到期后图片、视频与 Community Packs 会重新模糊/阻断，重新激活后恢复；coins 不过期，但无活跃订阅不能购买 coins。 | 官方帮助声称；实际到期状态未验证 |

### 5.2 Terms / Legal

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Terms & Policies](https://ourdream.ai/terms) | 未登录官方页面 | Policy Hub 分为 Core Policies、Content Policies、Legal & Compliance。 | 公开 UI 已验证 |
| 2026-09-01 | [Terms & Policies](https://ourdream.ai/terms) | 未登录官方页面 | 可见文档包括 Terms of Service、Privacy、Refund、Acceptable Use、Community Guidelines、Prohibited Content、Content Removal、Content Moderation、Pre/Post-Screening、Complaint、2257 Exemption、Underage、AML/Anti-Fraud、Sex Trafficking。 | 公开 UI 已验证 |
| 2026-09-01 | [Terms of Service](https://ourdream.ai/terms/terms-of-service) | 官方正文 | 当前页面标注 Last Modified August 26, 2026，并明确服务由 Dream Studio USA, Inc. 运营、账户覆盖 `ourdream.ai` 与 `ourdream.io`。 | 公开 UI 已验证 |

本轮逐一核对的 14 个 `/terms/*` 公开政策页为：[Terms of Service](https://ourdream.ai/terms/terms-of-service)、[Privacy Policy](https://ourdream.ai/terms/privacy-policy)、[Refund Policy](https://ourdream.ai/terms/refund-policy)、[Acceptable Use](https://ourdream.ai/terms/acceptable-use)、[Community Guidelines](https://ourdream.ai/terms/community-guidelines)、[Prohibited Content](https://ourdream.ai/terms/prohibited-content-policy)、[Content Removal](https://ourdream.ai/terms/content-removal-policy)、[Content Moderation](https://ourdream.ai/terms/content-moderation-policy)、[Pre/Post-Screening](https://ourdream.ai/terms/screening-policy)、[Complaint](https://ourdream.ai/terms/complaint-policy)、[2257 Exemption](https://ourdream.ai/terms/2257-exemption)、[Underage](https://ourdream.ai/terms/underage-policy)、[AML/Anti-Fraud](https://ourdream.ai/terms/aml-anti-fraud-policy)、[Sex Trafficking](https://ourdream.ai/terms/sex-trafficking-policy)。观察日均为 2026-09-01，验证方式为直接访问官方 URL；均返回公开页面，不代表政策后端工作流已验证。

### 5.3 Safety

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Safety Center](https://safety.ourdream.ai/introduction) | 官方公开文档 | 独立 Safety 站点的 IA 覆盖 Principles、Prohibited content、Age verification、IP、Moderation、Appeals、Reporting、Safety tools、Wellbeing、Privacy summary、Contact。 | 公开 UI 已验证 |
| 2026-09-01 | [Safety `llms.txt`](https://safety.ourdream.ai/llms.txt) | 官方文本索引 | 官方提供 Safety 文档索引及 OpenAPI specification 入口，说明 Safety/Reporting 是独立可导航的产品与运营面。 | 官方索引已验证 |
| 2026-09-01 | [Your safety tools](https://safety.ourdream.ai/your-account/safety-tools.md) | 官方 Markdown 正文 | 公开说明可在 Settings 静音 Explore tags；Chat 消息三点菜单可 Delete，并从对话和模型上下文移除；还提供 in-product report、change email 与 delete account。 | 官方帮助声称；实际账户操作未验证 |

**对标含义：** iDream 不需要复制 OurDream 的具体政策文案，但完整平台必须有可到达的 Help/Support、账户反馈、Terms/Policy Hub、举报/申诉/联系路径，并且公开文案与真实能力一致。

## 6. SEO 与内容分发矩阵

### 6.1 robots 与 sitemap

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [`robots.txt`](https://ourdream.ai/robots.txt) | 直接读取官方文本 | `Allow: /`；`Disallow: /api`、`/chat/`、`/c/`、`/signup/1`；声明 sitemap 为 `https://ourdream.ai/sitemap.xml`。 | 官方索引已验证 |
| 2026-09-01 | [`robots.txt`](https://ourdream.ai/robots.txt) | 直接读取官方文本 | `Content-Signal` 为 `search=yes, ai-input=yes, ai-train=no`。 | 官方索引已验证 |
| 2026-09-01 | [`sitemap.xml`](https://ourdream.ai/sitemap.xml) | 直接读取并统计 `<loc>` | 当前共有 212 个 URL。 | 官方索引已验证 |
| 2026-09-01 | [`sitemap.xml`](https://ourdream.ai/sitemap.xml) | 互斥页面族分类统计 | 212 个 URL 分为：核心顶层 15、`/generate/*` 子页 16、`/sex-chat/*` 20、`/guides/*` 20、comparison/alternatives 26、`/videos/*` 子页 53、`/images/*` 子页 20、`/type/*` 子页 24、AI Girlfriend 文章 5、其他 13；合计 212。 | 官方索引已验证 |
| 2026-09-01 | [`sitemap.xml`](https://ourdream.ai/sitemap.xml) | 读取 `<lastmod>` | 观察发生在 America/New_York 的 2026-09-01；站点 UTC 已进入 2026-09-02，多数动态条目的 `lastmod` 为 `2026-09-02T02:31:59.899Z`。 | 官方索引已验证；不把 UTC 日期差误写为未来观察 |
| 2026-09-01 | [`sitemap.xml`](https://ourdream.ai/sitemap.xml) | 精确 URL 查找 | 产品路由 `/`、`/chat`、`/create`、`/generate`、`/custom`、`/upgrade` 在 sitemap；`/feed`、`/community`、`/profile`、`/helpdesk`、`/terms` 当前不在 sitemap。 | 官方索引已验证 |

### 6.2 SEO 页面族

| 观察日 | 官方 URL | 验证方式 | 可见事实 | 证据等级 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | [Resources Hub](https://ourdream.ai/resources-hub) | 官方页面正文 | Hub 聚合 Generators、Character Types、Guides、Common Questions，并把内容页导向 Create、Chat、Generate。 | 公开 UI 已验证 |
| 2026-09-01 | [AI Girlfriend Types](https://ourdream.ai/type) | 官方页面正文 | 类型目录聚合大量 companion/persona 长尾页，每页有明确的创建转化文案。 | 公开 UI 已验证 |
| 2026-09-01 | [Comparisons](https://ourdream.ai/comparison) | 官方页面正文 | 独立竞品 comparison/alternative 内容中心。 | 公开 UI 已验证 |
| 2026-09-01 | [Videos](https://ourdream.ai/videos) | 官方页面正文 + sitemap | 视频分类首页及 53 个 `/videos/*` 子页形成公开媒体内容矩阵。 | 公开 UI / 官方索引已验证 |
| 2026-09-01 | [Images](https://ourdream.ai/images) | 官方页面正文 + sitemap | 图片分类首页及 20 个 `/images/*` 子页形成公开媒体内容矩阵。 | 公开 UI / 官方索引已验证 |
| 2026-09-01 | [AI Instructions](https://ourdream.ai/ai-instructions) | 官方页面正文 | 独立 AI instructions / information 内容入口，与 Guides、Comparison 一起覆盖信息型搜索意图。 | 公开 UI 已验证 |
| 2026-09-01 | [Glossary](https://ourdream.ai/glossary) | 官方页面正文 | 公开 Glossary 定义 19 个 companion、roleplay、character、memory、LLM、image/video 与 Dreamcoin 术语，并链接更深指南。 | 公开 UI 已验证 |
| 2026-09-01 | [Affiliate](https://ourdream.ai/affiliate) | 官方页面正文 | 公开 Affiliate 获客面宣称最高 40% RevShare 或 $60 CPA，并提供申请、实时 dashboard、归因、营销素材、结算方式与专属支持。 | 官方营销声称；申请、归因与付款未验证 |

**对标含义：** SEO 目标不是“补几篇博客”，而是建立 `搜索意图 → 内容页 → 对应产品任务` 的路由矩阵：类型词进入 Create，Chat 词进入角色/Chat，生成词进入 Generate，媒体词进入公开 Gallery，竞品词进入 Comparison。

## 7. 官方第一方材料中的当前不一致

这些冲突不等于某一方一定错误；可能来自页面更新不同步、档位/模型差异或旧帮助文章。它们证明：**不能把 OurDream 的单页数字直接抄成 iDream 规格。**

| 观察日 | 主题 | 官方来源 A | 官方来源 B | 准确处理 |
| --- | --- | --- | --- | --- |
| 2026-09-01 | 创建角色币价 | [Create FAQ](https://ourdream.ai/create) 写 5 Dreamcoins / character | [What costs coins?](https://help.ourdream.ai/en/articles/10808513) 写 Create a Chatbot 10 Dreamcoins，含前 2 张图 | 只记录“创建可能计币”；确切值必须用 iDream Catalog，不把任一数字当永久事实 |
| 2026-09-01 | 免费币/免费生成 | [Create](https://ourdream.ai/create) 与 [Chat](https://ourdream.ai/chat) 写注册送 55 coins、可免费试消息/角色/图片 | [Help Center](https://help.ourdream.ai/) 的旧文章摘要写当前不提供免费 coins，另有文章写无订阅不能生成图片/视频 | 标注官方公开材料不一致；登录态实测前不宣称完整免费额度 |
| 2026-09-01 | 视频币价 | [Generate](https://ourdream.ai/generate) 写 Spicy 1.0 的 10 秒视频从 100 coins 起 | [What costs coins?](https://help.ourdream.ai/en/articles/10808513) 写 Standard Video 100 coins / 5 seconds | 可能是模型档位差异；对标能力，不复制单一数字 |
| 2026-09-01 | Community Pack 币价 | [Community Pack Explanation](https://help.ourdream.ai/en/articles/8968257) 写 1,000 coins / character | [What costs coins?](https://help.ourdream.ai/en/articles/10808513) 写 250 / 750 / 1,000，取决于 Pack 大小 | 以 iDream 自己的 Pack Catalog 为准，前台/帮助/结算共用一个 SSoT |
| 2026-09-01 | 高级 Chat 档位命名 | [Chat](https://ourdream.ai/chat) 列出 `Muse Genius` | [What costs coins?](https://help.ourdream.ai/en/articles/10808513) 写 `Lively Genius` | 记录为同一官方公开面中的命名漂移；iDream 使用自身版本化 conversation-profile catalog，不复制名称 |
| 2026-09-01 | Reference upload 边界 | [AI Porn Generator](https://ourdream.ai/generate/ai-porn) 广泛宣称可上传 reference photo、custom upload 与 own images，并用于一致人脸或 image → video | [Community Written FAQs](https://help.ourdream.ai/en/articles/8993665) 明确回答不能上传自己的照片让 AI 复制；同一落地页又称真实人物影像被禁止 | 官方材料没有把“允许的参考图”边界讲清；登录后未验证，不据此声称真人照片或任意上传可用 |
| 2026-09-01 | 隐私承诺 | [首页](https://ourdream.ai/) 与 [Chat FAQ](https://ourdream.ai/chat) 宣称 Chat 端到端加密且平台不能读取 | [Terms of Service](https://ourdream.ai/terms/terms-of-service) 保留访问、审查、修改和删除内容的权利 | 这是“营销声称”，不是公开页面就能验证的技术事实；iDream 只能宣传已被架构与运行证据证明的隐私能力 |

## 8. iDream 的完整对标目标矩阵

| 目标域 | OurDream 公开基准 | iDream 目标结果 | 不能用什么替代 |
| --- | --- | --- | --- |
| Explore | 搜索、排序、结构化筛选、标签、Group Chats/Comics、角色卡 | 用户能发现并进入真实角色/内容任务 | 固定假卡片、只有性别筛选 |
| Create | Gender、Style、完整外观、人格、声音、职业、兴趣、关系、自定义 prompt | 完成角色草稿、预览、保存、发布/私有并可进入 Chat/Generate | 只有 Quick Create 或最少字段 |
| Chat | 历史、模型、记忆、控制、编辑/删除/重试、媒体、语音、群聊 | 可恢复、有上下文、可行动的完整会话 | 只有一次性文本流 |
| Generate | 角色/Free Play、Presets、场景字段、custom/negative prompt、Edit、Image/Video、Gallery | 真实生成、交付、持久化、重试与账本闭环 | 静态表单或 mock 成功 |
| My AI | Recent、Characters、Group Chats、Packs、Presets、Created | 统一管理会话、角色、集合、预设和创作资产 | 单一 Recent 关系入口 |
| Feed | 动态媒体、Chat、Remix、Like | 内容消费能转化为会话和再创作 | 只有瀑布流展示 |
| Community | Creator levels、公开角色、leaderboard、Creator Studio、Pack/现金激励 | 创作、发布、分发、影响力和收益闭环 | 只有排行榜 |
| Upgrade | 多档位、月/年、权益、币充值、FAQ、订阅设置 | 权益、币、支付、到期与重新购买状态一致；保持 iDream 的 no-renewal / no-lockback 契约 | 写死价格、前后端不同口径 |
| Profile/Support | 偏好、语言、订阅、反馈、FAQ、工单 | 用户自助与人工支持闭环 | 只放邮箱文本 |
| Terms/Safety | 可导航政策、报告、申诉与联系 | 公开入口与实际产品行为一致 | 不可达或与产品不一致的静态页 |
| SEO/Content/Affiliate | 212 URL 的类型/生成/媒体/指南/对比/术语矩阵与 Affiliate 渠道 | 搜索意图和合作流量进入对应产品任务 | 零散博客、没有产品 CTA 或归因闭环 |

## 9. 仍需登录态验证的对标清单

本轮没有证据支持以下任务已真正可用；下一轮若要把“公开目标”升级为“运行时对标事实”，至少要逐项取证：

1. Create：完整向导字段、候选预览、重生成、草稿恢复、私有/公开、审核、角色发布。
2. Chat：公共角色首次 5 条、注册后历史、模型切换、Auto/Pinned memory、Custom Instructions、edit/delete/regenerate、主动消息、会话内图片、Voice Call、12 角色 Group Chat。
3. Generate：角色/Free Play、Presets、custom/negative prompt、Image Edit、Video 各档、批量、失败重试、交付、Gallery、Liked。
4. My AI：六个标签的数据口径、搜索/筛选、Pack/Collections、资产删除/可见性、订阅到期行为。
5. Feed：Chat 转化、Remix 是否带来源、Like 幂等与计数、无尽加载和错误恢复。
6. Community：角色提交、互动阈值、Creator Studio 数据、Pack 购买、Dreamcoin/现金结算。
7. Upgrade：Checkout、支付方式、币充值、权益生效、年付逐月发币、取消、到期、恢复、退款。
8. Profile/Support：偏好保存、语言、通知、Subscription settings、工单提交与 Requests 历史。

## 10. 产品定位定稿

基于 2026-09-01 的官方公开面，建议以这句话作为 iDream 的产品总定位：

> **iDream 是全面对标 OurDream.ai 的 18+ AI 角色扮演 / AI 伴侣平台：覆盖角色发现与完整创建、沉浸式 Chat、多模态生成、个人资产、社区分发、创作者经济、统一消费体系，以及支持与内容获客闭环。**

关系连续性、身份一致性、记忆与跨模态一致性应继续作为重要质量能力，但不应改写为排除其他产品面的总定位，也不应成为 Feed、Community、Generate、完整 Create、My AI 或 SEO 是否建设的 Gate。
