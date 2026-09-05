# iDream 产品需求文档

更新日期：2026-09-01

> **本文档是目标产品规格参考（需求 / 信息架构 / 功能地图 / 转化漏斗），不描述实现进度。**
> 当前真实实现状态以 [`CURRENT_FUNCTIONAL_COVERAGE.md`](./CURRENT_FUNCTIONAL_COVERAGE.md) 为单一事实来源（SSoT），请勿在本文重新加入逐行实现状态列。

## 1. 文档目的

本文档定义 iDream 的产品定位、目标用户、功能优先级、页面信息架构、经济承诺和成功指标。**OurDream.ai 是 iDream 的主要产品对标：其公开可验证的发现、创建、聊天、生成、资产、社区、付费与内容体验共同构成完整度参考。**当前官方公开面证据见 [`OURDREAM_PRODUCT_PARITY_SNAPSHOT_2026-09-01.md`](../research/OURDREAM_PRODUCT_PARITY_SNAPSHOT_2026-09-01.md)；代码、数据和运行状态仍以 iDream 自己的 SSoT 为准。

## 2. 产品定位

iDream 是一个 **全面对标 OurDream.ai 的 18+ AI 角色扮演 / AI 伴侣平台**。目标不是只复刻页面外观，而是在一个完整产品中覆盖角色发现、深度创建、对话陪伴、图片/视频/语音生成、个人资产管理、社区分发、付费权益、联盟生态、帮助与公开内容入口。

**核心 JTBD**：用户可以从发现或创建一个 AI 角色开始，在同一平台内完成聊天、生成、编辑、保存、管理、分享和付费升级，不需要在割裂的工具之间切换，也不会遇到只有页面没有真实能力的假入口。

产品主张：

- **完整发现**：Explore、搜索、排序、筛选、角色详情、推荐、Feed、Community 与公开内容共同帮助用户找到角色和创作者。
- **完整创建**：对齐当前公开可验证的六步 Style → General → Face → Body → Details → Image 任务，覆盖身份/风格、外观、发型/面部、体型、名称、personality/Soul、Voice、Occupation、hobbies、fetishes、relationship type、custom details、视觉候选、私有保存和公开发布；快捷入口不能删减完整创建能力。
- **完整互动**：Chat 支持历史、Scene、记忆、编辑、重生成、举报以及已发布的图片/编辑/语音动作；Video 只有在独立 Chat capability 与 Product Action contract 发布后进入 Chat。
- **完整生成**：Image、条件 Video、Character/Freeplay、Presets、Image Edit、背景/姿势/服装、Prompt、Advanced Settings、异步状态与 Gallery 管理构成一条完整生成链。
- **完整资产与分发**：My AI、Created、Characters、Presets、Media、Feed、Community、Creator Profile、Like/Follow/Share/Remix/Report 都属于目标产品范围。
- **可靠且透明**：角色身份固定、生成可追踪、重试不重复执行或扣费；聊天历史和已交付媒体不因计划到期被锁回；定价与 dreamcoin 口径见 `ECONOMY_AND_PRICING.md`。

## 3. 用户与角色

| 用户类型 | 目标 | 核心需求 |
| --- | --- | --- |
| 首次访问者 | 快速理解平台并进入真实能力 | 年龄确认、清晰导航、精选角色、免费注册入口 |
| 角色探索用户 | 找到想互动的 AI 角色 | 搜索、排序、筛选、分类、角色详情、热度与创作者信息 |
| 角色扮演 / 伴侣用户 | 与角色进行持续对话 | 私密聊天、上下文记忆、Scene、历史、编辑与重新生成 |
| 角色创作者 | 创建完整的自定义角色 | 多步属性、Soul/高级资料、tags、预览、Visual/Voice Identity、私有或发布 |
| 图片 / 视频生成用户 | 围绕角色或 Freeplay 生成和管理媒体 | Presets、Image Edit、Prompt、Advanced Settings、可靠交付与图库管理 |
| Premium / Deluxe 用户 | 获得更多额度和高级能力 | 周期预付访问、dreamcoin、高级生成、语音/视频能力、到期时间与重新购买 |
| 社区与创作者用户 | 浏览、发布和传播公开内容 | Feed、Community、Creator Profile、Remix、Like、Follow、Share、Report |
| 内容与获客访问者 | 从长尾内容和比较页进入平台 | 指南、类型页、比较页、视频/生成器落地页与真实 CTA |
| 联盟伙伴 | 理解、申请并运营推广合作 | RevShare/CPA 条款、归因链接、素材、实时 dashboard 与佣金状态 |
| 支持用户 | 管理账号或处理问题 | Help Desk、Terms、举报、申诉、账号与数据控制 |

## 4. 产品目标

1. 建立可逐项验收的 OurDream 全功能对标矩阵，覆盖 Explore、Create、Chat、Generate、My AI/Profile、Feed/Community、Upgrade、Affiliate、Support 与公开内容页面族。
2. 让新用户在 30 秒内找到角色、开始创建或进入生成，并走完对应真实链路，而不是停在静态页面或假 CTA。
3. 提供完整多步角色创建、私有使用、公开发布、Release/Serving 与后续编辑管理，不用 Quick Create 替代完整创作能力。
4. 让 Chat、Image、Image Edit、Voice 和条件 Video 按各自已发布 capability 可靠交付；动作—文案一致，重复执行与重复扣费为 0。
5. 让 My AI、Gallery、Feed、Community 和 Creator Profile 构成完整的资产管理与发现/分发闭环。
6. 建立简单、透明、可恢复的经济契约：先报价，后执行；未交付自动退款；计划到期不夺走既有历史和媒体。
7. 公开路由只有在存在真实产品能力或已发布内容时才能上线；路由数量和模板占位不能冒充完整对标。

### 4.1 明确非目标

- 不做只有视觉相似、没有真实数据与副作用的静态仿站；完整对标按用户任务和端到端结果验收。
- 不复制 OurDream 的内部技术实现、供应商或数据模型；iDream 的 Main/Chat/Gen 权威边界继续由自身架构决定。
- 不把 sitemap 数量、空 tab、mock provider 或可点击按钮当作功能完成证据。
- 不让套餐切换改变角色人格、Chat 执行身份或基础记忆质量，也不以锁回历史资产推动重新购买。

### 4.2 完整对标的定量验收

“有这个控件”不等于完整对标。当前带日期的公开广度基线统一记录在 `ProductFeatureMap.md §1.1`；每个维度必须在 parity matrix 中被判定为 `matched`、`equivalent` 或 `intentional_divergence`，并绑定产品理由与真实证据。未分类、只有极少选项或只展示静态入口，一律仍算缺口。观察值用于对标验收，不写死为运行时 Catalog。

## 5. 信息架构

### 5.1 全局壳层

所有主要页面共享深色 app shell：

- 桌面左侧导航：Create、Explore、Chat、Generate、My AI、Feed、Community。
- 次级入口：Help Desk、Safety Center、Discord、More。
- 用户入口：Login、Join Free、Profile、Upgrade。
- Profile：余额、付费访问、兑换码、推荐奖励、偏好/通知、法律、账号管理；语言切换仅在未来接入真实 i18n 后启用。
- 移动端：顶部菜单和底部导航 Explore、Chat、Create、Generate。
- Footer：Learn、Popular、Help、公司信息和社交链接。
- 促销：桌面右下浮层和移动顶部 banner。
- 年龄门槛：18+ 访问确认，接受后写入本地状态，未确认前不应进入成人内容。

### 5.2 页面族

OurDream 公开可验证的页面族全部进入对标库存，但 iDream 只在对应产品能力或真实内容完成、且获得 dedicated/CMS publication authority 后公开发布该路由。在那之前，目标路由返回 404，不用模板占位或路由数量冒充完整对标。页面按以下模板归类：

| 模板 | 代表路径 | 产品职责 |
| --- | --- | --- |
| Home / Explore | `/` | 角色发现、搜索筛选、推荐流、SEO FAQ、转注册 |
| Marketing | `/chat`、`/ai-girlfriend`、`/ai-boyfriend`、`/create-ai-girlfriend`、`/create-ai-boyfriend`、`/virtual-girlfriend`、`/authors/*`、`/login`、`/signup` | 产品解释、转化 CTA、角色展示、创作者与功能价值说明 |
| Create | `/create` | 六步 Style → General → Face → Body → Details → Image；覆盖外观、personality/Soul、Voice、Occupation、hobbies/fetishes、relationship type、custom details、视觉候选、私有保存或公开发布；Quick Start 只能作为可选预填 |
| Generator | `/generate`、`/generate/*`、`/generator/*` | 图片生成器、条件启用的视频生成、preset 配置、图库管理和生成器 SEO 落地页 |
| Profile | `/custom`、`/profile` | 用户内容库、账号设置、余额、推荐和偏好 |
| Feed / Community | `/feed`、`/community` | 内容流、互动、举报、社区榜单和 collections |
| Library | `/resources-hub`、`/type`、`/videos`、`/images`、`/games`、`/romantasy`、`/glossary` | 内容、图片/视频、术语与分类入口 |
| Article | `/guides/*`、`/sex-chat/*`、`/ai-girlfriend/*`、`/videos/*`、`/type/*`、`/ai-instructions` | 长文指南、类型页、视频页、SEO 内容 |
| Comparison | `/comparison`、`/comparison/*`、`/*-alternatives` | 竞品对比、功能卖点、升级转化 |
| Affiliate | `/affiliate` | 公开联盟计划、RevShare/CPA、申请/归因、素材和 dashboard 入口 |
| Upgrade | `/upgrade` | 预付访问方案和权益 |
| Terms / Safety | `/terms`、`/terms/*`、iDream `/safety/*` | 条款、政策、隐私、退款、社区规则、举报/申诉与法律入口 |

## 6. 核心功能需求

### 6.1 年龄门槛与访问控制

| ID | 需求 | 优先级 |
| --- | --- | --- |
| AG-01 | 首次访问成人内容前必须展示 18+ 年龄确认。 | P0 |
| AG-02 | 用户点击确认后记录接受状态，后续访问不重复展示。 | P0 |
| AG-03 | 未确认用户不应看到成人角色内容、生成器或聊天内容。 | P0 |
| AG-04 | 年龄门槛需链接 Terms，并提供离站选项。 | P0 |
| AG-05 | 按司法辖区或风险触发第三方身份年龄验证，并与普通 age gate acceptance 分开存储。 | P0/P1 |

> **age gate ≠ age verification（用户视角区分）**
> - **age gate（年龄门槛，AG-01~04）= 自助确认 18+**：成人内容入口的 P0 基线，接受状态写入本地/会话并可恢复。
> - **age verification（身份年龄验证，AG-05）= 第三方身份核验**（如证件/活体）：按司法辖区或风险触发，与 age-gate acceptance 分开建模。
> - **发布 Gate**：需要身份年龄验证的区域，只有 provider、状态机、失败恢复与运行证据全部就绪后才能开放成人产品面；不需要时由明确 jurisdiction policy 判定 `not_required`，不能由客户端自行绕过。

### 6.2 探索首页

| ID | 需求 | 优先级 |
| --- | --- | --- |
| EX-01 | 展示角色卡片流，包括图片、名称、年龄、简介、likes、chat count、creator。 | P0 |
| EX-02 | 支持排序和 feed/ranking 模式，如 For You、Popular、Newest、Following，并保留当前 period label。 | P0 |
| EX-03 | 支持搜索角色、指南和生成器。 | P0 |
| EX-04 | 支持性别、风格、年龄筛选。 | P0 |
| EX-05 | 支持内容驱动的分类 chips，如 Romantic、Slow Burn、Cosplay 等；Group Chats/Packs 等未获发布 authority 的域不作为空结果死 chip 展示，只有存在公开可浏览内容时才曝光。 | P0 |
| EX-06 | 角色卡点击进入角色详情或聊天启动页。 | P0 |
| EX-07 | 支持无限加载、分页或虚拟列表。 | P1 |
| EX-08 | 在推荐流中插入促销卡或活动卡。 | P1 |
| EX-09 | 首页底部展示 SEO H1、指标、FAQ 和 Join Now CTA。 | P1 |
| EX-10 | Explore 支持 All、Group Chats、Comics 等内容类型；只有存在真实公开数据和目标页时才暴露对应入口。 | P1 |

角色内容要求：

- 所有角色必须明确为成年人，年龄不得低于 18。
- “Teen”等分类在产品语义上必须定义为 18+ young adult，不允许未成年人或未成年外观内容。
- 角色描述不得包含真实人物深度伪造、未成年人、非同意、违法或平台禁止内容。

### 6.3 角色详情与聊天

| ID | 需求 | 优先级 |
| --- | --- | --- |
| CH-01 | 角色详情页展示头像/封面、名称、年龄、简介、标签、热度、creator、Vivid 标识。 | P0 |
| CH-02 | 用户可从角色卡启动聊天。 | P0 |
| CH-03 | 同一 user-character relationship 跨会话使用 recent transcript、Scene 与 official igrep memory 延续关系；角色 Soul、Release 和 Visual Profile 必须固定到明确版本。 | P0 |
| CH-04 | 用户可看到当前 Turn 是否启用关系记忆，并可暂停、通过对话纠正后重建或清除该角色记忆；不建立第二套手工 memory 数据库。 | P0 |
| CH-05 | 用户可重新生成回复、编辑最近一轮或删除会话；修订必须保持同一产品 Turn 的版本与计费幂等。 | P1 |
| CH-06 | 已获发布 capability 的图片、编辑或语音请求被接受后必须形成可追踪的 Product Action；交付前不得声称完成，replay/regenerate 不得重复执行或重复扣费。Video 只在显式 Chat capability 与 Product Action contract 发布后进入同一链。 | P0 |
| CH-07 | 聊天内可交付图片和语音；只有显式 Chat video capability 与 Product Action contract 发布后才可交付视频，并把附件、Scene 与当前 attempt 精确绑定。 | P1 |
| CH-08 | 套餐可区分消息额度、速度和高成本媒体能力，但不得改变角色人格、基础关系连续性或用不同 Chat 模型冒充不同品质的同一个角色。 | P0 |
| CH-09 | 聊天必须接入既定内容策略、举报和账号边界。 | P0 |
| CH-10 | 计划到期后，用户仍可查看聊天历史，并查看、下载已交付媒体；只有新请求所需的高阶能力被关闭。聊天历史导出若进入范围，必须另行定义格式、范围与删除边界。 | P0 |
| CH-11 | 用户可管理 Auto Memory、Pinned Memories 和 Custom Instructions；所有持久上下文均有明确来源、可见性、修改和删除边界。 | P1 |
| CH-12 | 用户可调整 response length、scene generation、active messages 和互动强度；控制值版本化固定到 Turn snapshot，不静默改写 Soul。 | P1 |
| CH-13 | 支持最多 12 个角色的 Group Chat，用户可选择或 `@` 指定应答角色；编排、历史、memory、额度、Product Action 和权限均有权威契约。 | P1 |
| CH-14 | 支持与单条 Voice Clip 分开的双向 Voice Call，包含通话状态、中断恢复、语音身份、时长与结算。 | P1 |
| CH-15 | 提供版本化 conversation-profile Catalog；当前公开对标基线为 5 个用户可感知档位。每个档位在执行前明示能力与成本，底层 provider/model 仍由服务端权威选择，不因档位改变角色身份。 | P1 |

### 6.4 角色创建器

| ID | 需求 | 优先级 |
| --- | --- | --- |
| CR-01 | 创建器覆盖当前公开六步任务 Style → General → Face → Body → Details → Image；用户可前进、后退和回到任意步骤修改。 | P0 |
| CR-02 | 用户可配置 Gender、Style、外观/race、发型/面部、体型、名称、年龄、简介、tags、personality/Soul、Voice、Occupation、hobbies、fetishes、relationship type、custom details 和开场信息；稳定角色资料与可变 Scene/memory 分开。 | P0 |
| CR-03 | 草稿自动保存并可刷新/注册后恢复；用户能回到任一步修改，不能因预览或登录失败丢失输入。 | P0 |
| CR-04 | 系统生成一个或多个视觉候选，用户可刷新并选择 Visual Identity anchor；候选失败可重试且不丢失草稿。 | P0 |
| CR-05 | 用户完成创建后可保存为私有角色并立即聊天，也可选择公开提交；私有使用不被发布流程阻塞。 | P0 |
| CR-06 | 用户可继续编辑 Soul、视觉身份、Reference Set、Voice Identity 与分发信息；完整创建能力不因提供 Quick Start 而被移除。 | P1 |
| CR-07 | 公开角色通过基础自动检查后进入发布准备、Release 与 Serving 流程，不设置额外人工审核关卡；私有/公开状态和已发布版本边界清晰。 | P1 |
| CR-08 | 创建与编辑必须保持 Character、Soul、Visual Identity 和 Release 的版本边界，不能静默改写正在服务的角色。 | P0 |
| CR-09 | 创建流程使用既定内容策略和成年人角色底线。 | P0 |
| CR-10 | 可提供一句描述的 Quick Start 来预填完整向导，但它是入口优化，不是替代完整属性、预览、编辑和发布能力的新产品定位。 | P1 |
| CR-11 | 创建 Catalog 的广度进入 parity matrix；当前公开观察基线为 40+ personality、19 voice、135 occupation 与 29 relationship type，任何偏离都需显式标记 matched/equivalent/intentional divergence。 | P1 |

### 6.5 图片生成器与条件 Video

> Image 是基线发布能力；Video 是完整对标目标，但只有在 `video_gen` 功能位、entitlement、video model/provider 与 launch gate 同时满足时才暴露。关闭态不能显示不可点击的 `Video Beta` / `Videos` 死入口。

| ID | 需求 | 优先级 |
| --- | --- | --- |
| GN-01 | 支持 Image，并在 Video 获得发布 capability 时支持 Image / Video 模式切换。 | P0 |
| GN-02 | Image 生成前必须选择 Character 或 Freeplay；Video 启用时只允许满足已发布 I2V/Serving contract 的 Character，不把 Freeplay 自动外推到 Video。 | P0 |
| GN-03 | 支持 Mode Presets，并包含 Presets 和 Image Edit 模式。 | P1 |
| GN-04 | 支持 Background、Pose、Outfit preset，preset 来源包含内置、My Presets、Community、Custom。 | P1 |
| GN-05 | Video 启用时，Image 和 Video 模式字段不同：Video 模式不显示 Pose，并可标注 new model。 | P1 |
| GN-06 | Custom Prompt 和 Negative Prompt 为 Premium 或高级能力，应显示锁定/升级状态。 | P1 |
| GN-07 | Advanced Settings 支持模型/风格、orientation、数量等配置。 | P1 |
| GN-08 | 用户点击 Generate 后创建异步任务并展示 loading/progress。 | P0 |
| GN-09 | 生成结果进入 Images、Liked gallery；Video 启用时进入 Videos gallery。 | P0 |
| GN-10 | 用户可保存、喜欢、删除、下载、筛选或批量管理生成结果。 | P1 |
| GN-11 | 失败时展示原因、是否扣费和重试入口。 | P1 |
| GN-12 | 生成请求必须通过既定内容策略、服务端 entitlement、执行前 quote 与 dreamcoin 余额校验。 | P0 |
| GN-13 | Character 模式下默认使用角色视觉身份快照，保持同一角色在不同场景、姿势、服装和 Chat 上下文中的长相一致。详见 [`CHARACTER_IMAGE_GENERATION_SYSTEM.md`](./CHARACTER_IMAGE_GENERATION_SYSTEM.md)。 | P0 |
| GN-14 | 用户可将满意生成图设为角色主图，或加入角色 identity references，用于后续生成一致性。 | P1 |
| GN-15 | 从 Chat 发起的生成必须继承当前 Character、Release、Visual Profile、Scene 和已接受的视觉 brief；从 Generate 发起时明确区分 Character 与 Freeplay。 | P0 |
| GN-16 | 每个生成动作在提交前展示预估成本，在交付后展示结果与结算状态；失败、拦截、取消和未知结果按权威状态机收敛，绝不重复扣费。 | P0 |
| GN-17 | Create Image、Edit Image 和 Enhance 使用独立契约，固定 source asset、accepted edit brief、reference/provenance、quote 和结果 lineage。 | P1 |
| GN-18 | Reference-guided generation 只接受当前政策与模型能力允许的 source/reference；权限、归属、身份约束和 provenance 必须可证明。 | P1 |
| GN-19 | Video 目标支持多 scene 序列、时长、宽高比、质量档和可选 AI voice/audio；只在对应 workflow/provider/capacity/entitlement 全部就绪时暴露。 | P1 |

### 6.6 My AI、Profile、Feed、Community

| ID | 需求 | 优先级 |
| --- | --- | --- |
| PF-01 | My AI 展示 Recent、Characters、Presets、Created 和 Media，并支持 search、加载态、空态与恢复；这些核心资产入口共同属于完整对标范围。 | P0 |
| PF-02 | 用户可继续最近会话。 | P0 |
| PF-03 | 用户可管理自建角色：编辑、复制、删除、发布、设为私有。 | P1 |
| PF-04 | Profile 展示余额、预付访问状态/到期时间/重新购买、兑换码、推荐奖励、法律和账号管理入口。 | P0 |
| PF-05 | Feed 展示用户或平台推荐内容流，并提供 Chat、Remix、Like、Share、Report。 | P1 |
| PF-06 | Community 展示 banner carousel、Dreamers/Characters/Collections、Featured/Top leaderboard 和 release/gender/style filters。 | P1 |
| PF-07 | 支持点赞、收藏、关注、举报和分享。 | P1 |
| PF-08 | Group Chats 与 Packs 属于完整对标目标域；未获发布 authority 时只能显示明确 unavailable 空态，发布时需具备真实数据模型、操作和权限。 | P1 |
| PF-09 | 用户的聊天历史和已生成媒体在计划到期后仍可查看；媒体保持可下载，删除行为必须说明影响范围。 | P0 |
| PF-10 | Profile 支持偏好与通知；语言切换仅在未来接入真实 i18n 字典层后启用。 | P1 |
| PF-11 | Community 支持版本化 Creator levels、公开角色资格、Creator Studio 数据、Pack 收益、Dreamcoin/现金激励与对账；所有门槛、收益和 payout 都由 canonical facts 与账本权威支持。 | P1 |
| PF-12 | Explore/Feed 支持已发布 Comics 的发现、连续阅读、creator attribution，并可进入 Chat 或 Remix。 | P1 |

> **完整对标中的 P1 域**：Group Chats、Packs 与 Comics 都属于目标范围，不因任何关系留存指标降级为产品外选项。每一域都必须补齐真实语义、数据、权限、额度/计费、交付与分发；尚未发布的入口遵守全局 unavailable/404 真相边界。

### 6.7 预付访问、定价与 dreamcoin

> **单一货币模型**：dreamcoin 是平台**唯一**消耗型货币，图片/视频按费率扣币，语音优先消耗计划分钟额度、超出后按 clip 兜底扣币；**不存在独立的图片/视频配额计数器**。计划卡从权威数据展示 dreamcoins、消息权益与生成模型权益；Chat provider/model、角色人格和基础记忆不按计划分级。若展示「images/videos/voice」等价示意，必须由代码动态计算，且 `video_gen=false` 时不得展示视频承诺。价格、费率、免费档、退款的单一事实来源（SSoT）为 `ECONOMY_AND_PRICING.md`，本节不重复费率卡。

| ID | 需求 | 优先级 |
| --- | --- | --- |
| UP-01 | `/upgrade` 展示 Yearly 和 Monthly 计划。 | P0 |
| UP-02 | 展示 Premium 和 Deluxe 两档价格、账单周期、权益、促销和 dreamcoin bonus。 | P0 |
| UP-03 | 支持一次性周期访问 checkout、支付成功/失败、权益到期与到期后重新购买；只有 provider 真实支持自动续订时才发布取消/恢复续订能力。 | P0 |
| UP-04 | 明确 Premium 权益：每个已购买周期的 included dreamcoins、无限消息、音频消息、custom/negative prompt、发布角色；Video 启用时展示视频生成权益。图片/视频消耗只以 dreamcoin 报价，不建立独立配额（见 economy §0/§2）。 | P0 |
| UP-05 | 明确 Deluxe 权益：Premium 全部 + 更高每月 dreamcoin、premium generation models、语音分钟与条件视频权益（同一套费率，见 economy §2）。 | P0 |
| UP-06 | 使用 dreamcoin 前展示余额、消耗和不足时的充值/升级入口（见 economy §5）。 | P1 |
| UP-07 | 用户可在账号页查看付费访问档位、权益结束时间，并在到期前后选择新的周期/档位重新购买；有效 provider contract 无自动续订。 | P0 |
| UP-08 | 计划到期或降级只影响后续高阶能力、速度和新请求成本，不隐藏既有聊天或已交付媒体。 | P0 |
| UP-09 | 提供与预付访问计划分开的 dreamcoin coin store：版本化充值 offer、执行前报价、一次性 checkout、provider confirmation、幂等 ledger 入账和购买历史使用同一权威链。 | P1 |

### 6.8 SEO 与内容页面

| ID | 需求 | 优先级 |
| --- | --- | --- |
| SE-01 | 每个获得 dedicated registry 或 CMS publication authority 的公开路由必须有可索引页面、title、description 和 canonical；未获授权的模板库存返回 404。 | P0 |
| SE-02 | 指南页应包含目录、正文分区、FAQ、相关 CTA。 | P1 |
| SE-03 | 比较页应解释平台差异、功能优势、价格对比和 CTA。 | P1 |
| SE-04 | Library 页面应聚合类型、视频、比较和指南入口。 | P1 |
| SE-05 | 营销页应包含 hero、角色展示、功能区、相关页面和 footer。 | P1 |
| SE-06 | 文章内容不能只使用模板占位，需要补齐真实可读正文。 | P1 |
| SE-07 | Images、Videos、Glossary、Authors 与 Resources Hub 应作为真实内容索引，卡片、分类和 CTA 均指向已发布内容或产品能力。 | P1 |
| SE-08 | Affiliate 公开页展示真实 RevShare/CPA 条款、申请入口、归因链接、推广素材、dashboard 和佣金状态；未获发布 authority 的权益不可先行宣称。 | P1 |

### 6.9 帮助、安全与法律

| ID | 需求 | 优先级 |
| --- | --- | --- |
| SF-01 | Safety Center 解释允许/禁止内容、举报、隐私和年龄规则。 | P0 |
| SF-02 | Help Desk 支持账号、付费访问/账单、生成失败、聊天问题，并展示 Bugs/Features/Changelog premium gate；Roadmap voting 支持提交 idea、Vote/Unvote 与持久计票。 | P1 |
| SF-03 | Terms 页面可访问，并从年龄门槛和 footer 链接。 | P0 |
| SF-04 | 所有用户生成内容必须可举报并进入审核流程。 | P0 |
| SF-05 | 平台必须禁止未成年人/未成年外观、真实人物、现有 IP、非同意框架、违法和规避内容。 | P0 |
| SF-06 | 支持用户对角色、媒体、feed item、聊天消息、用户、moderation decision、安全问题和版权/肖像问题提交 report 或 appeal。 | P0/P1 |

## 7. 产品实体与权威映射

本节名称表达目标产品的职责和唯一权威，不声称每个名称都已按同名物理表落地。当前 schema、代码和 legacy compatibility 的真实状态仍以 `packages/main/prisma/schema.prisma`、`packages/*/src` 与 `CURRENT_FUNCTIONAL_COVERAGE.md` 为准。

| 实体 | 关键字段 |
| --- | --- |
| User | id、email、displayName、ageGateAcceptedAt、createdAt；只承担账号与身份权威 |
| Entitlement | userId、plan/offer snapshot、capability、limit/usage window、validFrom、benefitsEndAt；不得改变 Chat 人格或基础记忆 |
| AgeVerification | id、userId、provider、status、jurisdiction、verifiedAt、expiresAt、metadata |
| CharacterDraft | id、ownerId、brief、coreIdentity、soulDraft、visualDirection、candidateAssetIds、selectedAnchorAssetId、step |
| CharacterPreviewJob | id、draftId、status、resultAssetId、error |
| Character | id、name、age、description、creatorId、visibility、style、tags、currentContentVersionId、status、imageAssetId、stats |
| CharacterContentVersion | id、characterId、version、personaSnapshot、openingSnapshot、appearanceSnapshot、contentHash、sourceType |
| CharacterVisualProfile | id、characterId、version、status、identityPrompt、anchorAssetIds、referenceAssetIds、defaultSeed、adapterRefs、qualityScore、consistencyScore |
| CharacterRelease / Serving | immutable content/visual/reference/voice snapshot 与唯一 runtime pointer |
| RecentChat | sessionId、userId、characterId、memoryEnabled、content/release/visual pins、openingMessage、lastMessageAt |
| ChatTurn | id、sessionId、attempt、userContent、assistantContent/status、Scene、memoryEnabled、terminalEvidence、identity pins |
| ChatTurnAttachment | id、turnId、kind、status、generationJobId、mediaAssetId、errorCode、metadata |
| CompanionMemoryAuthority | user-character aggregateId、monotonic version；Main committed Turns 可重建 official igrep workspace |
| GenerationPreset | id、ownerId、scope、type、category、label、controls、visibility |
| GenerationJob（Request aggregate） | id、userId、characterId、mode、accepted brief/controls、identity pins、status、reserved cost |
| GenerationAttempt / Artifact / Delivery | requestId、attempt/transport lineage、immutable terminal evidence、artifact、target、delivery status |
| MediaAsset | id、ownerId、type、url、thumbnailUrl、prompt、liked、visibility、safetyStatus |
| Subscription（legacy physical name） | id、userId、plan、status、billingPeriod、provider、providerSubscriptionId、currentPeriodStart、currentPeriodEnd（公开映射为 benefitsEndAt，不代表 renewsAt） |
| DreamcoinLedger | id、userId、delta、reason、sourceId/idempotencyKey、createdAt；append-only balance authority |
| Referral | id、inviterId、inviteeId、code、status、rewardStatus、createdAt |
| RedeemCode | id、code、reward、status、redeemedBy、redeemedAt |
| ContentReport | id、reporterId、targetType、targetId、reason、status、reviewerId |
| Appeal | id、userId、targetType、targetId、decisionId、status、appealText、resolvedAt |
| RoutePage | path、template、title、description、canonical、contentStatus |

## 8. 关键转化漏斗

1. 用户从首页、公开角色、分享链接或内容页进入并完成年龄确认。
2. 用户通过 Explore 找角色、进入完整 Create，或直接进入 Generate。
3. 用户注册/登录后回到原 intent，完成首次聊天、角色创建或媒体生成。
4. 用户在 Chat 中持续互动，或在 Generate 中使用 Character/Freeplay、Presets、Image Edit 与高级控制；Video 按独立 capability Gate 暴露。
5. 用户在 My AI/Gallery 管理会话、角色、presets 和媒体，并可通过 Feed/Community/Creator Profile 发现、分享或复用内容。
6. 用户遇到消息/语音 allowance、高阶媒体、模型或创作控制时理解成本与权益并进入 Upgrade。
7. 支付成功后回到原聊天、创建或生成任务；计划到期后既有历史和媒体仍可访问。

Explore、Create、Chat、Generate、My AI、Feed/Community/Creator Economy、Upgrade、Affiliate、Support 与内容入口共同组成完整产品循环，不把任何一条价值路径降级为关系功能的附属品。

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
- `qualified_conversation_episode_completed`
- `same_character_returned`
- `relationship_memory_toggled`
- `relationship_memory_cleared`
- `product_action_accepted`
- `product_action_delivered`
- `product_action_failed`
- `character_create_started`
- `character_created`
- `generation_started`
- `generation_completed`
- `generation_failed`
- `generation_refunded`
- `media_liked`
- `media_downloaded`
- `media_managed`
- `feed_item_shared`
- `feed_item_report_clicked`
- `remix_clicked`
- `upgrade_viewed`
- `checkout_started`
- `subscription_started`（legacy event name；表示一次预付访问激活，不表示自动续订）
- `benefits_ended`
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
- 24 小时 QCE 激活率与 7 日关系激活率。
- 同角色 D1/D7/W1 回访率。
- Product Action 接受→交付成功率、动作—文案矛盾率、重复扣费率。
- 创建器完成率。
- 生成任务成功率。
- 免费到付费转化率。
- 内容举报处理时长。

## 10. 成功指标与北极星

> 本节为产品级度量定义。事件名引用 §9 埋点；货币/配额口径以 `ECONOMY_AND_PRICING.md` 为准。所有目标值标注「初始假设」，需经实测/A-B 校准（免费档参数本身可调，见 economy §3）。

### 10.1 北极星指标（North Star）

**产品北极星：周活跃付费陪伴用户（Weekly Paying Companion Users, WPCU）**。

在自然周内，用户拥有有效付费访问，并至少完成一次 eligible 核心行为：Main committed Chat exchange 或成功 Generation Delivery。内部/测试/fixture、blocked/failed/cancelled、重复 effect/request 和不可归因事实不计入。

选它的理由：完整对标平台同时服务陪伴、创作与生成。WPCU 把真实付费状态与至少一条核心产品链绑定，既覆盖 Chat，也覆盖 Image/Video/Voice 创作，不把平台成功缩窄为长期关系这一种使用方式；同时与当前 checked-in Metric Registry 的 `official` 定义保持一致。

配套指标：

| 角色 | 指标 | 用途 |
| --- | --- | --- |
| 关系留存诊断 | **WSCU — Weekly Sustained Companion Users** | 衡量跨 session/跨日回到同一角色的用户；保留 shadow/directional，不取代平台北极星 |
| 付费关系诊断 | **WPSCU — Weekly Paying Sustained Companion Users** | WSCU 中拥有有效付费访问的用户；用于理解关系留存与商业交集 |
| 关系对数诊断 | **WSR — Weekly Sustained Relationships** | 满足持续关系条件的独立 user-character pair 数 |
| 创作留存诊断 | **WSCrU — Weekly Sustained Creation Users** | 跨日获得不同 Generation Request 成功交付的用户；与 Chat 留存并列观察 |
| 可靠性护栏 | Product Action / Generation delivery | 接受→交付成功率、失败退款率、重复执行/扣费率 |

**NS-01 最终决策**：保留 WPCU 为 `official` 产品北极星；WSCU、WPSCU、WSCrU 与 WSR 保留为关系/创作诊断，不发起“WSCU 替换 WPCU”的 Registry cutover。

### 10.2 漏斗目标表（初始假设，待校准）

漏斗对齐 §8 转化链路，每级绑定 §9 事件。只有 canonical event、immutable definition version 与 certified snapshot 完成发布后才可作为正式 SQL 指标查询；当前剩余工作是补齐度量覆盖、成熟度与生产认证，不是切换北极星。

| 漏斗指标 | 目标区间（初始假设） | 关联事件（§9） |
| --- | --- | --- |
| 访问 → age gate 通过率 | 80–90% | `age_gate_viewed` → `age_gate_accepted` |
| 注册转化率（访问 → 注册） | 4–8% | `signup_clicked` → `auth/signup` 成功 |
| 注册 → 首次聊天 | 45–60% | `chat_started` / `message_sent` |
| 注册 → 24h QCE | 待基线 | `qualified_conversation_episode_completed` |
| 注册 → 7d 任一核心留存 | 待基线 | eligible Chat / Generation / Create return |
| 注册 → 首次生成（aha） | 30–45% | `generation_started` → `generation_completed` |
| 免费 → 付费转化率 | 3–6% | `upgrade_viewed` → `checkout_started` → `subscription_started` |
| 付费用户 30 日核心留存率 | 待基线 | 首次付费 cohort 在 D30 窗口完成 eligible Chat 或 Generation |
| 到期后重新购买率 | 待基线 | `benefits_ended` → 后续 `checkout_started` / `subscription_started` |
| 生成成功率（红线） | ≥ 95% | `generation_completed` ÷（started − 主动取消） |
| 明确动作交付率（红线） | ≥ 95% | `product_action_delivered` ÷ `product_action_accepted` |
| 重复执行/重复扣费（红线） | 0 | 同一 effect identity 的重复 Generation / ledger settlement |
| 审核误杀率（红线） | ≤ 2% | `content_reported` / moderation 申诉翻案率（`moderation_appeal_started` 翻案占比） |

红线说明：生成成功率与审核误杀率是**体验/合规护栏**而非增长指标——低于/高于红线应触发告警与排障（见 09-observability、admin 后台），不以牺牲它们换转化。

### 10.3 度量原则

- **单一事实来源**：付费/币消耗口径以 `ECONOMY_AND_PRICING.md` 为准，指标不另立货币定义。
- **多路径完整性**：消息、创建、生成、资产管理、社区与内容转化分别度量；任何单一路径都不能代表完整对标已完成。
- **产品决策与发布认证分离**：WPCU 保持顶层指标；Metric Registry 的质量、成熟度和运行证据决定它何时可用于经营决策。
- **可调参数入实验**：免费赠币、日消息额度等直接影响 aha 与转化的参数，应进 A-B（economy §3.note），不写死。
- **护栏先于增长**：成功率、误杀率、举报处理时长（§9 末）为硬约束，优先保障。

## 11. 非功能需求

- 性能：首屏应快速展示 app shell 和首批角色卡；图片使用响应式格式和 lazy loading。
- 移动端：底部导航必须始终可用，卡片两列布局不得遮挡内容。
- 可访问性：按钮、链接、筛选和 modal 需要明确 accessible name，键盘可操作。
- 隐私与控制：聊天默认私密；用户可暂停/清除关系记忆，删除/导出边界必须清晰，敏感信息不得出现在公开 feed。
- 安全：成人内容访问前置年龄门槛，所有生成和用户内容走安全校验。
- SEO：公开内容页必须服务端可渲染，metadata 完整。
- 国际化：默认英文；只有具备完整 UI 字典、路由内容与 locale persistence 时才发布其他语言。
- 可靠性：生成任务应异步处理，可恢复、可重试、可展示失败原因。
- 所有权：计划变化不得隐藏既有聊天历史或已交付媒体。

## 12. MVP 建议

MVP 应优先实现：

1. 年龄门槛、注册登录与可恢复的用户会话。
2. 真实角色目录的发现、搜索、筛选、详情与一键开始聊天。
3. 完整多步创建：身份/风格/外观/发型/体型、名称、tags、Soul/高级资料、预览 anchor、私有保存和公开提交；Quick Start 只作可选预填入口。
4. Chat 的历史、Scene、official igrep memory、编辑、重生成、举报和已发布 Product Action。
5. Image/条件 Video Generate：Character/Freeplay、Presets、Image Edit、Prompt、Advanced Settings、任务状态、结算/退款和 Gallery。
6. My AI/Profile：Recent、Characters、Created、Presets、Media、余额、预付访问、兑换码、推荐、偏好与账号管理。
7. Feed/Community/Creator Profile 的基础浏览、Chat、Remix、Like、Follow、Share、Report。
8. Upgrade 的一次性周期访问、Premium/Deluxe entitlement、透明 dreamcoin 成本与既有资产持续可访问。
9. 已获 publication authority 的 Marketing、Library、Article、Comparison、Terms、Help 与 Support/Appeal 闭环。

V1.1 再实现：

- 视频生成进入默认可见发布范围。
- Group Chats 与 Packs 的完整产品语义、数据模型、额度和分发（属于完整对标目标，不是产品外能力）。
- 多语言 UI（真实 i18n 字典层、路由内容和 locale 切换）。
- Feed/Community 个性化、创作者激励和大规模 SEO 内容运营按依赖与资源分期推进，不以 WSCU 达标作为是否属于产品范围的 Gate。

## 13. 验收标准

- §5.2 列出的每个页面族都有明确产品职责。
- 首页、Create、Generate、Profile、Upgrade、Article、Comparison、Library、Marketing、Terms 都有功能需求。
- 每个 P0 需求都能映射到页面、数据实体和用户故事。
- 成人内容安全、年龄确认、隐私和举报要求被列为 P0。
