# iDream 产品功能地图

更新日期：2026-10-04

> **本文档定义目标产品的价值层级、页面入口和功能库存，不描述实现进度。**
> 当前实现与运行证据的汇总入口是 [`CURRENT_FUNCTIONAL_COVERAGE.md`](./CURRENT_FUNCTIONAL_COVERAGE.md)，实际状态由对应 source revision 的代码和运行记录证明；请勿在本文重新加入逐行实现状态列。

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

目标需求由 [PRD](PRD.md) 和专项产品契约定义；对标研究与保存截图解释需求来源，源码定位具体入口，运行证据证明是否交付。

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

### 1.2 从用户目标推导必要能力

用户需要的是可完成、可继续并可保有结果的任务。下表说明各功能域为何必要；§3–§5 定位页面与功能库存。长期陪伴、单次角色扮演、独立媒体创作和创作者经营分别成立，不能用其中一条路径的成功替代其他路径。

| 用户目标与必要性 | 输入与主要入口 | 正常结果 | 权限与成本边界 | 失败、退出与恢复 |
| --- | --- | --- | --- | --- |
| 进入并找回自己的任务：先知道适用条件，再保持账号与输入连续 | 年龄确认、注册/登录/恢复凭据；全站深链、`/login`、`/signup` | 返回原合法目的地，保留本人草稿；退出和删除状态可查 | 成年访问；身份核验按明确 jurisdiction policy；换号隔离私人数据 | 验证过期、发送受限、响应丢失有下一步；不自动重做付费动作 |
| 找到愿意互动的角色：减少选择成本，使介绍与实际角色一致 | 关键词、分类、排序、筛选；Explore、详情、公开内容 | 找到真实角色/作者，进入 Chat、Create 或 Generate | 只发现已发布公开内容；本人私有角色从个人库访问 | 无结果与读取失败分开；分页/返回保留条件；未发布入口不伪装可用 |
| 创造想象中的人物：把描述固定成可持续使用的身份 | 完整资料、Soul、视觉候选/引用、声音；Create、Created | 可恢复草稿→确认身份→私有角色；公开另行显式发布 | 角色年龄 ≥18；仅本人编辑；公开发布按权益与自动检查 | 回退/刷新/登录不丢输入；候选失败先恢复原请求；草稿不改 Serving |
| 展开并继续故事：保持角色、事实和用户自主权 | 文本或独立语音输入形成的明确消息、记忆/场景控制；Chat/My AI | Main 产品 Turn 与选中回复持久化，跨会话按允许的上下文继续 | 本人会话；群聊有参与者/记忆边界；套餐不改变基础人格或记忆质量 | 未知执行找回原 Turn；仅修订最近一轮；关闭、清除、隔离期不召回旧记忆 |
| 看到、听到并拥有作品：把意图变成真正可消费的结果 | 角色/Freeplay、源图、accepted brief、参数与报价；Chat/Generate | 图片、编辑、增强、视频、Voice Clip/Call 各自交付；结果进入资产库 | source/reference 授权；各能力独立发布；先报价，后接纳和结算 | 请求/attempt/交付可查询；失败、取消、部分与未知结果按权威状态收敛，不重复消费 |
| 找回和管理积累：历史与作品有持续价值 | 会话、角色、presets、媒体、已获 Pack；My AI/Gallery/Profile | 搜索、继续、编辑、下载与管理；资产归属、来源和版本明确 | 本人资产、明确分享范围和 immutable Grant；到期不锁回已交付/已购成果 | 加载失败不装空库；过期文件授权可恢复；删除说明影响并处理部分失败 |
| 分享、复用与创作者经营：获得反馈、分发或收益 | 显式发布、Follow/Like/Remix、合集、Comic/Pack；Feed/Community/Studio | 合法内容被发现，连续阅读或复用，作者与收益可核对 | 私有/链接可见/公开分别控制；Remix 保留来源；免费领取与购买分开 | 撤下阻止新公开访问/领取；既得权利按条款；收益争议有对账与支持入口 |
| 获得所需资源并理解费用：购买服务资源而保持已有权利 | Plan/offer/quote、付款确认、兑换/邀请；Upgrade/Coin Store/Profile | 预付访问激活或独立 coin topup 唯一入账，手动继续原任务 | 加密货币、一次性预付、不自动续订；消息/分钟/币分别计量 | 待确认先查询原订单；迟到/重复确认不重复授予；到期可重新购买 |
| 求助并控制内容与账号：问题得到可追踪结果 | 问题/原任务、工单、举报/决定/申诉；Help/Terms/Safety | 客户对话、处理状态和结果可回访，规则与实际承诺一致 | 基础客服不受高档计划限制；私人上下文访问须有明确范围 | 工单补充/继续跟进；内部备注不外泄；删除、申诉和退款状态分别说明 |
| 理解产品与经营推广：内容承诺通向真实能力 | 已发布正文、作者/术语、联盟条款与链接；Library/Article/Comparison/Affiliate | 内容→原意图→真实产品任务；伙伴能核对转化和结算 | dedicated/CMS 发布权威；联盟与普通 referral 分开；不制造收入或内容 | 未发布返回 404；失效 CTA/撤销转化可解释；推广与结算问题可求助 |

所有能力都要同时回答：**为何需要、输入什么、得到什么、谁有权操作、成本如何确定、失败如何继续**。字段广度、正常/异常/恢复与跨域验收见 [用户故事](UserStory.md)；对标判定和退出条件见 [矩阵](PRODUCT_PARITY_MATRIX.md)。新增页面不能代替这六项答案。

## 2. 完整对标路由库存与发布边界

对标数量均来自 2026-09-01 快照；实际发布与索引资格取自身环境的发布权威。

| 类别 | 数量/范围 | 页面目的 |
| --- | --- | --- |
| OurDream 官方 sitemap | 212 | 2026-09-01 互斥分类：15 核心顶层、16 generate 子页、20 sex-chat、20 guides、26 comparison/alternatives、53 videos 子页、20 images 子页、24 type 子页、5 AI-girlfriend 文章与 13 其他路由，全部进入 parity inventory |
| 导航补充入口 | 7 | sitemap 外还实测 `/feed`、`/community`、`/profile`、`/helpdesk`、`/terms`、`/type`、`/sex-chat` HTTP 200；HTTP 200 不等于功能已验证 |
| Terms 政策页 | 14 | 2026-09-01 `/terms/*` 官方政策页实测 200；iDream 可由 `/terms/*` 或版本化 `/safety/*` 提供等价用户任务，发布权威仍在自身 `policy_versions` |
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

## 4. 导航职责

导航让用户发现任务（Explore/More）、创作（Create/Generate）、继续与管理（Chat/My AI/Profile）、分发（Feed/Community）、购买资源（Upgrade）和求助（Help/Safety）。路由见 §3，具体动作见 §5；登录、付费或错误恢复后回到原合法任务，不自动重做写操作。

## 5. 功能模块矩阵

### 5.1 Discovery

职责：把有效公开目录转为可选择的角色与任务入口，列表和角色实际能力必须一致。

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| 推荐角色流 | `/` | `characterCards` |
| 角色卡 metadata | `/`、marketing strip、generator gallery | Character |
| 热度指标 | `/` | likes、chats |
| 分类 chips | `/` | `/api/v1/tags` + 有效公共 Serving/Release 的角色计数（只展示有内容的非 muted tag） |
| 内容类型 | `/` | All、Group Chats、Comics 等对标内容类型；只在有真实数据与目标页时暴露 |
| 搜索 | `/`、route topbar | search index |
| 排序 | `/` | ranking mode（For You/Popular/Newest/Following，带 period label） |
| 筛选 | `/` | gender/style/age facets |
| 无限加载 | `/` | pagination cursor |
| 角色详情/聊天启动 | card click | Character detail 或 RecentChat |

### 5.2 Creation

职责：由用户确认稳定角色身份，再分别管理创作草稿、私有使用与公开发布；创建分步组织可以等价，字段与恢复能力不能减。

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Six-step creator | `/create` | Style → General → Face → Body → Details → Image；任意步可回退修改并恢复草稿 |
| Gender / Style | `/create` | Female/Male/Trans、Realistic/Anime 等当前公开可验证选项 |
| Appearance / race | `/create` | human/fantasy 等选项与 Custom |
| Hair / Body | `/create` | 发型、颜色、体型与身体特征选项 |
| Name / age / core profile | `/create` | 名称、成年人年龄、简介与基本身份 |
| Personality / Soul / Advanced details | `/create` | personality、稳定角色承诺、Occupation、hobbies/fetishes、relationship type、Voice、custom details 与高级资料；广度按 §1.1 带日期基线判断，Catalog 不混入可变 transcript/memory/Scene |
| Tag manager | `/create` | 创建前后均可管理 Character tags |
| Draft recovery | `/create` | 自动保存、刷新恢复、注册回跳和逐步编辑 |
| Preview candidates | `/create` | CharacterPreviewJob 生成/刷新一个或多个可恢复候选 |
| Visual identity anchor | `/create` | 用户从候选中选择基准图，形成 CharacterVisualProfile active identity |
| Bring to life | `/create` | 创建 Character、保存到 My AI、开始 Chat；后续可版本化精炼 Soul、Visual Identity、Reference Set、Voice Identity 与分发信息，不静默改写 Serving Release |
| Visibility and release | `/create` / Character settings / Admin | 私有使用与公开提交分离；公开角色通过基础自动检查后进入发布准备、immutable Release 与 Serving，不增加日常人工批准 |
| Optional Quick Start | `/create` | 用一句描述预填完整向导；不得删除或隐藏上述完整创建能力 |

### 5.3 Chat

职责：让用户与明确身份的角色持续互动，并掌控消息、场景、记忆及动作；输入、执行过程与已提交的产品 Turn 分开。

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Chat landing | `/chat` | marketing route |
| Character chat | `/chat/*` 或角色详情 | RecentChat、ChatTurn、ChatTurnAttachment |
| Microphone input | 单聊/群聊 composer | 仅英语、最多 60 秒的独立录音→ASR→可编辑草稿→用户明确 Send；转写前后不自动创建 Turn/memory/媒体，不消耗 dreamcoin、消息额度或 TTS 分钟；取消/中断/收件人变化守住录音与草稿边界 |
| Conversation context | chat | Main committed Turns + Scene + official igrep memory 提供跨会话上下文 |
| Identity continuity | chat | immutable Soul、ContentVersion/Release、VisualProfile 与 VoiceProfile pins |
| Memory control | chat / profile | memory enabled 状态、暂停、纠正后重建、按角色清除；不建立第二套手工 memory authority |
| Pinned memories / custom instructions | chat / profile | 用户固定关键事实和自定义交互要求；必须投影到 Main committed context 与 official igrep authority，不建立无来源的第二套记忆 |
| Conversation controls | chat | 用户可配置 response length、scene generation、active messages 与成人互动强度；控制值进入版本化 Turn snapshot |
| Conversation profiles | chat | 2026-09-01 历史对标基线为 5 个用户可感知档位；用户在执行前看到能力与成本，执行 provider/model 仍由服务端权威选择，不改写 Soul 身份 |
| Group Chat | chat / My AI | 一个会话内最多 12 个角色参与，可显式选择或 `@` 指定应答角色；历史、memory、额度、Product Action 与权限有明确编排 |
| Voice Clip | Chat 回复播放 | 用户明确 Play 并接受报价上限后合成；固定选中回复/attempt 和声音身份，时长、分钟/币用量与资产可核对；重播原交付不重新合成/扣费，独立于 Input/Call |
| Voice Call | chat | 实时或近实时双向语音会话，与按消息播放的 Voice Clip 分开建模和计费 |
| Chat Animate | Chat 已交付图片 | 用户描述运动并接受报价，固定 source、原 Turn/attempt、视频路线和价格；独立能力/权益门禁、交付与结算，不由 Generate Video 或自然语言视频工具推定可用 |
| Deterministic Product Action | chat | 已获发布 capability 的图片/编辑/语音请求形成 accepted effect、delivery、attachment、settlement/refund 与 replay identity；Video 仅在显式 Chat capability 与 Product Action contract 发布后进入该链 |
| Action truthfulness | chat | 未交付前不声称完成；regenerate/replay 不重复执行或重复扣费 |
| Message entitlement | chat | ChatTurnUsageFact + server-side Entitlement |
| Safety moderation | chat | safety flags |
| Report chat/character | chat/detail | ContentReport |

### 5.4 Generation

职责：固定用户接受的来源、方向、身份、规格与报价，将结果交付为可消费和可管理的作品。可下载文件与身份/场景质量分别验收。

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

职责：个人库保存和继续本人任务；公开分发只传播明确授权的内容。收藏、复制或加入合集均不自动取得所有权或公开权限。

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

职责：回答访客的实际问题，并把所承诺的下一步连到真实能力；库存、正文、发布与可索引是不同条件。

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

职责：说明实际规则，并把用户问题推进到有回执、可补充和可追踪的处理结果。既定 mock 配置及未启用的 `safety-gateway` 不构成新产品缺口。

| 功能 | 页面 | 数据 |
| --- | --- | --- |
| Help support tab | `/helpdesk` | support links（Account/Billing、Trust contact、Discord）、FAQ、登录+年龄门后提交并回访 SupportRequest（`SUP-...` 回执、客户回复与处理状态）；事件记录不替代工单 |
| Bugs/Features/Changelog | `/helpdesk` | feedback/changelog 区块 + Premium CTA；Roadmap 支持提交 feature/bug/improvement idea、Vote/Unvote 与持久计票 |
| Terms index | `/terms` | 版本化 policy routes；覆盖 §1.1 的 2026-09-01 政策任务基线，iDream 可在不丢任务的前提下合并呈现 |
| Age verification docs | `/safety/policies/age-verification` | AgeVerification（Go.cam、jurisdiction、stored verification info） |
| Moderation docs | `/safety/moderation/*` | moderation layers、appeals（input/output/metadata/human/community layers） |
| Reporting docs | `/safety/reporting/how-to-report` | reports、regulator/security paths（in-product/email/report types） |
| Privacy/safety tools | `/safety/your-account/*` | privacy、mute、delete、account controls |

账号注册/登录恢复、会话失效与删除状态（AC）；基础帮助、客户工单回执/回复/解决（SF）；私有/链接可见/公开范围与 Remix 来源（PF）；联盟申请、归因、收益与结算（AF），均覆盖正常结果、异常恢复和权限，验收见 `UserStory.md §2.10–2.11`；基础客服属于 P0，不能被 Bugs/Features 的 Premium 门槛挡住。

### 5.9 完整对标后续域（P1）

以下功能属于完整对标的 P1 目标域。每个域都必须定义范围、数据模型、权限、额度/计费、交付与分发；在正式发布前遵守全局 unavailable/404 真相边界，不能用空 tab 或静态页面冒充完成。

| 域 | 出现位置 | 目标层级 | 一句话范围草图 |
| --- | --- | --- | --- |
| Group Chats | Chat / My AI tab（§5.3/§5.6） | P1 | 一个会话内多角色参与；需定义角色编排、`@` 选择、历史、额度、记忆、生成与权限。未发布时 Explore 不展示空结果 chip。 |
| Packs | My AI / Community | P1 | 单角色的图片/视频集合，可包含当前与未来内容；需定义 ownership、定价、购买/解锁、创作者收益、到期权益、分发和 moderation。 |
| Comics | Explore content type | P1 | 可发现、可阅读且可转入 Chat/Remix 的连续媒体内容；需定义 episode/page、creator、visibility、engagement 和分发。 |
