# Ourdream.ai User Stories

更新日期：2026-06-13

## 1. 主要用户旅程

### Journey A：首次访问并探索角色

1. 用户从首页或 SEO 页面进入。
2. 系统展示 18+ 年龄确认。
3. 用户确认后进入 Explore。
4. 用户使用分类、搜索、排序或筛选缩小范围。
5. 用户查看角色卡热度、简介、creator 和标签。
6. 用户点击角色卡进入详情或开始聊天。
7. 未登录用户被引导 Join Free。

### Journey B：创建自定义 AI 伴侣

1. 用户点击 Create。
2. 用户选择 Gender 和 Style。
3. 用户依次选择外观/race、发型、体型和名称。
4. 用户可打开 Advanced Details，并在最终页管理 tags、Appearance 和 Personality。
5. 系统生成或刷新角色预览图。
6. 用户点击 Bring Your AI To Life。
7. 系统完成安全校验。
8. 创建成功后角色进入 My AI，并可开始聊天、生成图片或发布到社区。

### Journey C：围绕角色生成图片或视频

1. 用户进入 Generate。
2. 用户选择 Image 或 Video。
3. 用户选择角色或 Freeplay。
4. 用户选择 Mode Presets、背景、姿势、服装和可用 prompt。
5. 用户按需打开 Advanced Settings 配置模型/风格、比例和数量。
6. 系统检查额度、订阅和内容安全。
7. 系统创建生成任务。
8. 用户在 Images、Videos、Liked 中查看结果。
9. 用户可筛选、批量管理、收藏、下载、删除或再次生成。

### Journey D：订阅升级

1. 用户在首页、促销卡、生成器高级字段或 footer 点击 Upgrade。
2. 系统展示 Yearly 和 Monthly 方案，以及 Premium 和 Deluxe 两档。
3. 用户查看权益、价格、账单周期、dreamcoin、图片/视频/语音额度、模型和记忆权益。
4. 用户进入 checkout。
5. 支付成功后系统激活 Premium 权益并返回原任务。

### Journey E：安全、帮助和内容治理

1. 用户在年龄门槛、footer 或 sidebar 打开 Terms、Safety Center 或 Help Desk。
2. 用户阅读规则、隐私和支持内容。
3. 用户在角色、聊天、生成资产、feed item、用户资料或社区内容上提交举报。
4. 用户可对 rejected/removed content、账号处罚或审核决定提交申诉。
5. 系统记录举报或申诉并进入审核队列。
6. 审核处理后，必要时隐藏内容、限制账户或通知用户。

## 2. 用户故事与验收条件

### 2.1 年龄门槛

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-AG-01 | 作为首次访问者，我希望先看到 18+ 年龄确认，以便知道平台只面向成年人。 | P0 | 首次访问成人内容前展示年龄门槛；包含 Terms 链接；包含确认和离开选项 |
| US-AG-02 | 作为已确认用户，我希望下次访问不用重复确认，以便快速进入产品。 | P0 | 确认后写入本地状态；刷新和重新访问不重复弹出；用户清除状态后重新弹出 |
| US-AG-03 | 作为平台运营者，我希望未确认用户无法看到成人角色内容。 | P0 | 未确认状态不渲染角色卡、聊天和生成器内容；直接访问深链也被拦截 |
| US-AG-04 | 作为平台运营者，我希望在司法辖区或风险要求时触发身份年龄验证。 | P0/P1 | age gate acceptance 与第三方验证状态分开；验证失败或未完成时限制对应功能 |

### 2.2 探索与发现

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-EX-01 | 作为探索用户，我希望看到推荐角色卡流，以便快速选择感兴趣的角色。 | P0 | 首屏展示多张角色卡；卡片包含图片、名称、年龄、简介、likes、chat count、creator |
| US-EX-02 | 作为探索用户，我希望按 For You、Popular、Newest、Following 等模式排序，以便找到不同推荐集合。 | P0 | 排序控件可打开；选择后列表更新；URL 或状态可反映当前排序和 period label |
| US-EX-03 | 作为探索用户，我希望搜索角色和场景关键词，以便直接找到目标内容。 | P0 | 搜索框可输入；提交后返回匹配结果；无结果时展示空态 |
| US-EX-04 | 作为探索用户，我希望按性别、风格、年龄过滤，以便减少浏览成本。 | P0 | 每个筛选条件可选择、清除和组合；结果数量随条件变化 |
| US-EX-05 | 作为探索用户，我希望点击分类 chips，以便浏览 Group Chats、Romantic、Slow Burn 等主题。 | P0 | chip 有 active 状态；点击后结果和 URL/state 更新；再次点击或 All 可重置 |
| US-EX-06 | 作为探索用户，我希望列表可以继续加载，以便浏览更多角色。 | P1 | 到达底部时加载下一批；加载中有 spinner；失败可重试 |
| US-EX-07 | 作为用户，我希望看到活动促销卡，以便了解订阅优惠。 | P1 | 促销卡展示活动标题、说明、CTA；点击进入 Upgrade；可关闭浮层 |

### 2.3 角色详情与聊天

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-CH-01 | 作为用户，我希望点击角色卡查看角色详情，以便确认是否开始聊天。 | P0 | 详情页展示角色资料、标签、热度、creator、开始聊天 CTA |
| US-CH-02 | 作为用户，我希望从角色详情直接开始聊天，以便快速进入角色扮演。 | P0 | 登录用户直接创建或恢复会话；未登录用户进入 Join Free；成功后进入聊天界面 |
| US-CH-03 | 作为聊天用户，我希望角色记住当前会话上下文，以便故事连贯。 | P0 | 多轮对话能引用前文；会话有 memory summary；刷新后历史保留 |
| US-CH-04 | 作为聊天用户，我希望管理聊天历史，以便继续、删除或重命名会话。 | P1 | My AI 或 Chat 中可查看会话；支持继续、删除、重命名 |
| US-CH-05 | 作为聊天用户，我希望对不满意的回复重新生成，以便获得更合适的剧情推进。 | P1 | 最近一条 assistant 消息可 regenerate；保留版本或替换逻辑清晰 |
| US-CH-06 | 作为平台运营者，我希望聊天内容经过安全策略，以便阻止禁止内容。 | P0 | 消息发送前后有安全检查；命中禁止内容时给出安全提示；可举报 |

### 2.4 创建角色

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-CR-01 | 作为创作者，我希望选择角色基础属性，以便快速搭建角色。 | P0 | Gender、Style、外观/race、发型、体型、名称控件可用；每步选择后保存到草稿 |
| US-CR-02 | 作为创作者，我希望输入高级详情或自定义设定，以便精确定义角色和场景。 | P0 | Advanced Details 支持输入、字数限制、保存草稿和安全校验 |
| US-CR-03 | 作为创作者，我希望看到预览生成状态，以便确认角色效果。 | P1 | 选择或输入变化后可生成/刷新预览；生成中、失败、成功状态明确 |
| US-CR-04 | 作为创作者，我希望生成后保存角色到 My AI，以便后续聊天和生成。 | P0 | 创建成功后生成 Character 记录；出现在 Created 或 Recent Characters |
| US-CR-05 | 作为创作者，我希望选择角色公开或私有，以便控制分发范围。 | P1 | 创建/编辑时可选 visibility；公开角色进入审核或发布流程 |
| US-CR-06 | 作为创作者，我希望管理角色 tags，以便提升发现和分发。 | P1 | tag manager 可添加、移除和保存；tag 命中敏感规则时触发审核 |
| US-CR-07 | 作为平台运营者，我希望创建流程禁止未成年、真实人物、现有 IP、非同意框架和违法内容。 | P0 | prompt、图片、tags 和配置均触发安全校验；失败时阻止创建并说明规则 |

### 2.5 图片与视频生成

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-GN-01 | 作为生成用户，我希望选择 Image 或 Video 模式，以便匹配输出类型。 | P0 | 模式切换状态明确；字段和消耗额度随模式变化 |
| US-GN-02 | 作为生成用户，我希望选择角色或 Freeplay，以便控制是否绑定角色一致性。 | P0 | 未选角色/Freeplay 时 Generate 不可提交或提示错误；选择后展示摘要 |
| US-GN-03 | 作为生成用户，我希望选择 Mode Presets 或 Image Edit，以便快速进入常用生成模式。 | P1 | Presets/Image Edit 可选；不同模式展示对应字段 |
| US-GN-04 | 作为生成用户，我希望选择背景、姿势和服装 preset，以便控制结果方向。 | P1 | 每个控件有内置、My Presets、Community、Custom、Create a Preset；组合值进入任务 payload |
| US-GN-05 | 作为 Premium 用户，我希望使用 custom prompt 和 negative prompt，以便获得更细粒度控制。 | P1 | 免费用户看到锁定和升级入口；Premium 用户可输入并提交 |
| US-GN-06 | 作为生成用户，我希望配置模型/风格、比例和数量，以便控制输出质量和成本。 | P1 | Advanced Settings 可保存到任务 payload；premium/experimental 选项受 entitlement 控制 |
| US-GN-07 | 作为生成用户，我希望看到生成进度，以便知道任务是否仍在运行。 | P0 | 点击 Generate 后出现任务状态；完成后进入图库；失败时可重试 |
| US-GN-08 | 作为生成用户，我希望查看 Images、Videos、Liked，以便管理历史结果。 | P0 | tab 可切换；按类型展示资产；liked 只展示收藏内容 |
| US-GN-09 | 作为生成用户，我希望筛选、批量选择、下载、收藏或删除生成结果，以便管理资产。 | P1 | Filter/Manage/Select All/Like/Download/Delete 操作成功后 UI 状态更新 |
| US-GN-10 | 作为平台运营者，我希望生成请求校验额度、dreamcoin、entitlement 和内容安全。 | P0 | 额度不足时阻止并引导升级/充值；禁止内容不创建任务 |

### 2.6 My AI、Feed 与 Community

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-PF-01 | 作为登录用户，我希望在 My AI 搜索和查看最近角色，以便继续互动。 | P0 | Recent/Characters 显示最近聊天或创建角色；空态引导 Create；搜索可过滤 |
| US-PF-02 | 作为登录用户，我希望查看 Group Chats、Packs、Presets、Created。 | P1 | 每个 tab 有内容列表、空态和加载态 |
| US-PF-03 | 作为创作者，我希望编辑或删除自己创建的角色。 | P1 | Created 列表支持 edit、duplicate、delete；危险操作二次确认 |
| US-PF-04 | 作为登录用户，我希望在 Profile 管理余额、订阅、兑换码、推荐、偏好、语言和账号，以便控制账户状态。 | P0 | Profile 显示对应入口；敏感操作二次确认或重新认证 |
| US-PF-05 | 作为社区用户，我希望浏览 feed，以便发现其他用户发布的角色或内容。 | P1 | Feed 有卡片流、Chat、Remix、Like、Share、Report |
| US-PF-06 | 作为社区用户，我希望浏览 Dreamers/Characters/Collections 榜单。 | P1 | Community tabs 可切换；release/gender/style filters 更新榜单 |
| US-PF-07 | 作为社区用户，我希望点赞、收藏和关注创作者。 | P2 | 操作需要登录；状态持久化；列表数据更新 |
| US-PF-08 | 作为用户，我希望举报不合规内容。 | P0 | 角色、聊天、媒体、feed item、用户资料均有举报入口；提交后进入审核 |

### 2.7 订阅与付费

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-UP-01 | 作为免费用户，我希望查看 Premium 和 Deluxe 升级方案，以便判断是否购买。 | P0 | Upgrade 展示 Yearly、Monthly、两档价格、权益、dreamcoin bonus 和 CTA |
| US-UP-02 | 作为免费用户，我希望在遇到高级功能锁时进入升级页。 | P0 | custom prompt、生成额度不足、Premium 功能都有升级入口 |
| US-UP-03 | 作为购买用户，我希望安全完成 checkout。 | P0 | 支持支付成功、失败、取消；状态回写 Subscription |
| US-UP-04 | 作为 Premium 用户，我希望支付后立即获得权益。 | P0 | 权益实时生效；原任务可继续；账号页显示当前方案 |
| US-UP-05 | 作为 Deluxe 用户，我希望获得更高生成/语音额度和模型/记忆能力。 | P0 | Entitlement 明确区分 Premium 与 Deluxe；服务端按 plan enforcement |
| US-UP-06 | 作为付费用户，我希望管理续费或取消。 | P1 | 账号或 billing portal 可进入；取消后状态和权益时间正确 |

### 2.8 SEO 内容页

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-SE-01 | 作为 SEO 访问者，我希望长尾页面解释主题并提供下一步入口。 | P1 | 页面有 H1、正文、相关页面、Create/Explore/Upgrade CTA |
| US-SE-02 | 作为内容运营，我希望每个 sitemap URL 有独立 metadata。 | P0 | title、description、canonical 按路径生成或配置 |
| US-SE-03 | 作为访问者，我希望比较页明确说明平台优势。 | P1 | 对比页列出核心功能、价格/权益差异和转换 CTA |
| US-SE-04 | 作为访问者，我希望资源 hub 聚合指南、比较、类型和视频入口。 | P1 | Library 页面最多展示 24 个相关入口；链接可访问 |

### 2.9 移动端

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-MB-01 | 作为移动用户，我希望底部导航固定显示，以便快速切换核心功能。 | P0 | Explore、Chat、Create、Generate 在移动端固定可见；active 状态正确 |
| US-MB-02 | 作为移动用户，我希望角色卡两列展示，以便高效浏览。 | P0 | 390px 视口下两列稳定；文字不溢出；底部导航不遮挡关键操作 |
| US-MB-03 | 作为移动用户，我希望顶部促销 banner 不影响筛选操作。 | P1 | banner 高度稳定；筛选横向滚动可用；首批卡片可见 |

## 3. 关键边界场景

- 未登录用户点击聊天、创建保存、生成或收藏时，应进入 Join Free，并在登录后返回原任务。
- 年龄未确认用户直接访问 `/generate`、`/chat`、角色详情或成人 SEO 页，应先看到 age gate。
- 年龄或司法辖区需要更强验证时，应触发身份年龄验证，不应只依赖 age gate acceptance。
- 角色或生成 prompt 含禁止内容时，应阻止提交而不是静默失败。
- 免费用户点击 Premium-only 字段，应看到升级说明，不应丢失当前输入。
- Video 模式不应提交只在 Image 模式支持的 pose 字段。
- preset 来源需要区分 built-in、My Presets 和 Community，用户不能编辑不属于自己的 preset。
- 生成任务失败时，应展示失败原因、是否扣费、重试入口。
- 删除角色时，如果有关联聊天、媒体或公开内容，需要说明影响范围。
- Feed Share/Report、Profile Invite/Redeem、Subscription 管理等操作必须有 auth 和 side-effect handling。
- 长尾 SEO 页面缺少真实正文时，不能误导为完整内容页，应进入内容补齐队列。

## 4. MVP 用户故事范围

MVP 必须包含：

- US-AG-01 到 US-AG-04
- US-EX-01 到 US-EX-06
- US-CH-01 到 US-CH-03、US-CH-06
- US-CR-01、US-CR-02、US-CR-04、US-CR-07
- US-GN-01、US-GN-02、US-GN-07、US-GN-10
- US-PF-01、US-PF-04、US-PF-08
- US-UP-01 到 US-UP-05
- US-SE-02
- US-MB-01、US-MB-02

MVP 之后实现：

- 公开视频生成。
- Community/Feed 的完整社交互动。
- creator profile 和关注系统。
- 高级 prompt presets。
- Profile referral、redeem code、preferences、language、account management。
- 大规模 SEO 正文运营和 A/B 测试。
