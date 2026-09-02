# iDream 用户故事

更新日期：2026-09-01

> **本文档是目标用户旅程与验收规格，不描述实现进度。** 当前真实实现状态以 [`CURRENT_FUNCTIONAL_COVERAGE.md`](./CURRENT_FUNCTIONAL_COVERAGE.md) 为单一事实来源。

## 1. 主要用户旅程

### Journey A：发现角色并进入真实任务

1. 用户从首页、公开角色、分享链接、比较页或 SEO 页面进入并完成 18+ 年龄确认。
2. 用户使用分类、搜索、排序、性别/风格/年龄筛选浏览角色。
3. 用户查看角色详情、creator、热度与可用动作。
4. 用户选择 Chat、Generate 或创建账号；登录后回到原 intent。

### Journey B：完整创建一个角色

1. 用户进入六步 Create：Style → General → Face → Body → Details → Image，并可前进、后退和恢复草稿。
2. 用户编辑 Gender/Style、外观/race、发型/面部、体型、名称、年龄、简介、tags、personality/Soul、Voice、Occupation、hobbies、fetishes、relationship type、custom details 和开场信息。
3. 系统生成或刷新视觉候选，用户选择 Visual Identity anchor。
4. 用户保存私有角色并进入 My AI、Chat 或 Generate，也可提交公开审核。
5. Quick Start 可以预填向导，但不能替代完整字段、预览、编辑、可见性和发布流程。

### Journey C：聊天、历史与已发布动作

1. 用户从角色详情或 My AI 创建/恢复 Chat session。
2. Main 加载固定 Soul/Release、recent transcript、Scene 与可用 memory，用户可控制记忆状态。
3. 用户可编辑最近一轮、重新生成、重命名、删除或举报。
4. 用户明确要求图片、编辑或语音时，产品按 capability、entitlement、成本和 identity pins 建立可追踪 Product Action；Video 仅在独立 Chat capability 发布后适用。
5. 结果绑定当前 attempt 并进入 Chat/Gallery；重放不重复执行或扣费，未交付按权威状态退款。

### Journey D：独立生成并管理媒体

1. 用户进入 Generate，选择 Image；Video 进入发布范围后可选择 Video。
2. 用户选择 Character 或 Freeplay，并配置 Presets/Image Edit、背景、姿势、服装、Prompt 和 Advanced Settings。
3. 提交前看到成本、余额和 entitlement；提交后看到 Request/Attempt 状态。
4. 成功结果进入 Images/Liked/Videos，用户可筛选、下载、收藏、删除或批量管理。
5. Character 模式保持视觉身份；失败、取消或拦截按权威结算/退款。

### Journey E：My AI、Feed 与 Community

1. 用户在 My AI 访问 Recent、Characters、Presets、Created 和 Media，并继续对应任务。
2. 用户编辑、复制、删除或发布自建角色，管理 presets 和媒体。
3. 用户在 Feed/Community 浏览角色、媒体、Comics、Dreamers、Characters 和 Collections。
4. 用户进入 Creator Profile，并执行 Chat、Remix、Like、Follow、Share 或 Report。
5. Group Chats/Packs 进入 P1 对标交付前只显示明确 unavailable 空态。

### Journey F：理解成本、购买能力并保有历史

1. 用户在高阶能力或余额不足处进入 Upgrade。
2. 系统展示 Monthly/Yearly、Premium/Deluxe、一次性周期访问、明确到期时间和无自动续订。
3. 用户理解 dreamcoin、语音分钟与高阶生成 entitlement；基础 Chat 人格与上下文能力不按方案分级。
4. 支付成功后权益生效并返回原任务。
5. 到期后用户仍可查看既有聊天并下载已交付媒体，需要新能力时再购买。

### Journey G：联盟、帮助和内容治理

1. 联盟伙伴从 Affiliate 页了解 RevShare/CPA、申请、归因、素材和 dashboard 能力。
2. 用户在年龄门槛、footer 或 sidebar 打开 Terms、Safety Center 或 Help Desk，阅读规则、隐私和支持内容。
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
| US-EX-05 | 作为探索用户，我希望点击有实际公开内容的分类 chips，以便浏览 Romantic、Slow Burn 等主题。 | P0 | chip 有 active 状态；点击后结果和 URL/state 更新；再次点击或 All 可重置；未获发布 authority 或没有真实公开内容的域不以空结果 chip 出现 |
| US-EX-06 | 作为探索用户，我希望列表可以继续加载，以便浏览更多角色。 | P1 | 到达底部时加载下一批；加载中有 spinner；失败可重试 |
| US-EX-07 | 作为用户，我希望看到活动促销卡，以便了解付费访问优惠。 | P1 | 促销卡展示活动标题、说明、CTA；点击进入 Upgrade；可关闭浮层 |
| US-EX-08 | 作为探索用户，我希望在 All、Group Chats 和 Comics 等真实内容类型之间切换。 | P1 | 只显示有公开数据与目标页的类型；切换后结果、URL/state 和空态一致 |

### 2.3 角色详情与聊天

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-CH-01 | 作为用户，我希望点击角色卡查看角色详情，以便确认是否开始聊天。 | P0 | 详情页展示角色资料、标签、热度、creator、开始聊天 CTA |
| US-CH-02 | 作为用户，我希望从角色详情直接开始聊天，以便快速进入角色扮演。 | P0 | 登录用户直接创建或恢复会话；未登录用户进入 Join Free；成功后进入聊天界面 |
| US-CH-03 | 作为聊天用户，我希望跨独立访问回到同一个角色时，TA 仍记得共同经历并延续上次场景。 | P0 | 加载同一 Soul/Release pins、recent transcript、Scene 与 official igrep memory；刷新和新会话不把上下文重置为初见 |
| US-CH-04 | 作为聊天用户，我希望知道记忆是否启用，并能暂停、纠正或清除，以便掌控这段历史。 | P0 | 显示当前 memory 状态；可关闭/开启、按角色清除；纠正后从 Main committed Turns 重建，不出现第二套手工 memory authority |
| US-CH-05 | 作为聊天用户，我希望管理聊天历史，以便继续、删除、重命名、编辑最近一轮或重新生成。 | P1 | My AI/Chat 可继续、删除、重命名；latest-only 修订边界明确；regenerate 保持同一产品 Turn 并正确更新 Scene |
| US-CH-06 | 作为聊天用户，我希望明确要求图片、编辑或语音后真正收到结果，而不是只得到口头承诺。 | P0 | accepted Product Action 有等待/失败/交付状态；交付附件与当前 attempt 精确绑定；未交付前回复不声称完成 |
| US-CH-07 | 作为付费用户，我希望重试或重新生成不会重复执行同一动作或重复扣费。 | P0 | 同一 effect identity 只产生一个权威 Generation/Media/settlement；replay 返回相同结果或明确冲突 |
| US-CH-08 | 作为用户，我希望角色不会因套餐或底层模型变化突然变成另一个人。 | P0 | Soul/Release/Visual/Voice identity 独立于执行模型；套餐只影响消息/语音 allowance、速度和高成本能力 |
| US-CH-09 | 作为平台运营者，我希望聊天遵循既定内容策略和账号边界。 | P0 | 命中禁止内容时按产品政策处理；用户可举报 |
| US-CH-10 | 作为聊天用户，我希望管理 Auto Memory、Pinned Memories 和 Custom Instructions。 | P1 | 固定事实/指令有明确来源、作用域、修改/删除状态；与 Main committed Turns + official igrep 一致 |
| US-CH-11 | 作为聊天用户，我希望配置 response length、scene generation、active messages 和互动强度。 | P1 | 控制值影响后续 Turn 且可恢复；版本固定到 snapshot；不静默改写 Soul |
| US-CH-12 | 作为聊天用户，我希望在一个 Group Chat 中让最多 12 个角色交互，并选择或 `@` 指定回复者。 | P1 | 角色编排、参与者容量、历史、memory、额度、Product Action 和权限在服务端权威收敛 |
| US-CH-13 | 作为聊天用户，我希望发起双向 Voice Call，而不只是播放单条语音。 | P1 | 通话建立/中断/恢复/结束状态、Voice Identity、时长、额度/结算可追踪 |
| US-CH-14 | 作为聊天用户，我希望从版本化 conversation-profile Catalog 选择体验档位，并在使用前知道能力和成本。 | P1 | 当前公开对标基线为 5 个用户可感知档位；档位不改变 Soul/Release 身份；服务端决定底层 provider/model；执行前 quote 与 entitlement 可见 |

### 2.4 创建角色

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-CR-01 | 作为创作者，我希望按 Style → General → Face → Body → Details → Image 完成创建，以便理解进度并随时返回修改。 | P0 | 六步均可前进、后退和刷新恢复；当前步与已填内容进入可恢复草稿 |
| US-CR-02 | 作为创作者，我希望配置外观/race、发型、体型和可选 Custom 字段，以便精确描述角色。 | P0 | 完整属性可组合、修改并持久化；已填内容不因切换步骤丢失 |
| US-CR-03 | 作为创作者，我希望编辑名称、年龄、简介、tags、personality/Soul、Voice、Occupation、hobbies、fetishes、relationship type、custom details 和开场信息。 | P0 | 稳定 Soul/Voice 与可变 Scene/memory 分开；草稿自动保存；用户可回到任意步骤修改 |
| US-CR-04 | 作为创作者，我希望从一个或多个视觉候选中选择角色基准形象。 | P0 | 候选逐步出现且可刷新；失败可重试且不丢草稿；选择后形成 active Visual Identity anchor |
| US-CR-05 | 作为创作者，我希望完成后将角色保存到 My AI，并继续 Chat 或 Generate。 | P0 | 私有 Character 立即进入 Characters/Created 与可用任务；不被公开发布流程阻塞 |
| US-CR-06 | 作为深度创作者，我希望继续精炼 Soul、Visual Identity、Reference Set、Voice Identity 和分发信息。 | P1 | 高级编辑支持版本化保存，不静默改写当前 Serving Release |
| US-CR-07 | 作为创作者，我希望选择角色公开或私有，以便控制分发范围。 | P1 | 私有角色可直接使用；公开角色进入审核、Release 与 Serving 流程 |
| US-CR-08 | 作为希望快速起步的用户，我希望用一句描述预填创建向导。 | P1 | Quick Start 只预填完整向导；用户仍可审阅和修改所有字段、预览、可见性与发布设置 |
| US-CR-09 | 作为平台运营者，我希望创建流程遵循既定内容策略和成年人角色底线。 | P0 | 失败时阻止创建并返回可理解的规则结果 |
| US-CR-10 | 作为 Product DRI，我希望创建 Catalog 广度可量化，以免少量选项被误判为完整对标。 | P1 | parity matrix 对 40+ personality、19 voice、135 occupation、29 relationship type 的公开基线逐项标记 matched/equivalent/intentional divergence |

### 2.5 图片生成与条件 Video

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-GN-01 | 作为生成用户，我希望使用 Image 生成，并在 Video 进入当前发布范围时选择 Image 或 Video 模式，以便匹配输出类型。 | P0 | Image 模式可用；Video 关闭时不显示不可用入口；Video 启用时模式切换状态明确，字段、执行前报价和扣币规则随模式变化 |
| US-GN-02 | 作为生成用户，我希望在 Image 中选择角色或 Freeplay，并在 Video 启用时只选择满足当前 I2V contract 的已发布角色。 | P0 | Image 未选 Character/Freeplay 时不可提交；Video 不提供无契约的 Freeplay，选择后展示 exact Character/Release 摘要 |
| US-GN-03 | 作为生成用户，我希望选择 Mode Presets 或 Image Edit，以便快速进入常用生成模式。 | P1 | Presets/Image Edit 可选；不同模式展示对应字段 |
| US-GN-04 | 作为生成用户，我希望选择背景、姿势和服装 preset，以便控制结果方向。 | P1 | 每个控件有内置、My Presets、Community、Custom、Create a Preset；组合值进入任务 payload |
| US-GN-05 | 作为 Premium 用户，我希望使用 custom prompt 和 negative prompt，以便获得更细粒度控制。 | P1 | 免费用户看到锁定和升级入口；Premium 用户可输入并提交 |
| US-GN-06 | 作为生成用户，我希望配置模型/风格、比例和数量，以便控制输出质量和成本。 | P1 | Advanced Settings 可保存到任务 payload；premium/experimental 选项受 entitlement 控制 |
| US-GN-07 | 作为生成用户，我希望看到生成进度，以便知道任务是否仍在运行。 | P0 | 点击 Generate 后出现任务状态；完成后进入图库；失败时可重试 |
| US-GN-08 | 作为生成用户，我希望查看 Images 和 Liked，并在 Video 启用时查看 Videos，以便管理历史结果。 | P0 | 可用 tab 可切换；按类型展示资产；liked 只展示收藏内容；Video 关闭时不显示空的 Videos 死入口 |
| US-GN-09 | 作为生成用户，我希望筛选、批量选择、下载、收藏或删除生成结果，以便管理资产。 | P1 | Filter/Manage/Select All/Like/Download/Delete 操作成功后 UI 状态更新 |
| US-GN-10 | 作为平台运营者，我希望生成请求校验 dreamcoin 余额、执行前报价、entitlement 和内容安全。 | P0 | 余额或 entitlement 不足时阻止并引导升级/充值；禁止内容不创建任务 |
| US-GN-11 | 作为聊天用户，我希望从当前 Chat 上下文发起的生成继承同一角色和场景。 | P0 | payload 固定 Character/Release/VisualProfile/Scene/accepted brief；结果回绑当前 Turn 与 Gallery |
| US-GN-12 | 作为付费用户，我希望执行前看到成本，失败后自动退款。 | P0 | 提交前显示 required/balance；Request/Attempt/Delivery/settlement 可追踪；未交付按幂等规则退款 |
| US-GN-13 | 作为生成用户，我希望分别使用 Create、Edit 和 Enhance，并在允许时使用 source/reference asset。 | P1 | 模式契约、source asset、accepted brief、权限/provenance、quote 和 result lineage 可追踪 |
| US-GN-14 | 作为视频生成用户，我希望配置多 scene、时长、比例、质量和可选 AI voice/audio。 | P1 | 只在精确 workflow/provider/capacity/entitlement 可用时显示；逐段状态、交付与结算可追踪 |

### 2.6 My AI、Feed 与 Community

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-PF-01 | 作为登录用户，我希望在 My AI 查看 Recent、Characters、Presets、Created 和 Media，以便继续聊天、创作或资产管理任务。 | P0 | 所有核心 tab 均有真实数据、加载态、空态、搜索和后续操作 |
| US-PF-02 | 作为登录用户，我希望从 Recent 继续最近会话，也能从其他 tab 直接进入对应任务。 | P0 | Recent 可继续 Chat；Characters/Created 可进入编辑、Chat 或 Generate；Presets/Media 有对应管理动作；Group Chats/Packs 未获发布 authority 时只显示明确 unavailable 空态 |
| US-PF-03 | 作为创作者，我希望编辑或删除自己创建的角色。 | P1 | Created 列表支持 edit、duplicate、delete；危险操作二次确认 |
| US-PF-04 | 作为登录用户，我希望在 Profile 管理余额、预付访问/重新购买、兑换码、推荐和账号，以便控制账户状态。 | P0 | Profile 显示对应入口；敏感操作二次确认或重新认证 |
| US-PF-05 | 作为社区用户，我希望浏览 feed，以便发现其他用户发布的角色或内容。 | P1 | Feed 有卡片流、Chat、Remix、Like、Share、Report |
| US-PF-06 | 作为社区用户，我希望浏览 Dreamers/Characters/Collections 榜单。 | P1 | Community tabs 可切换；release/gender/style filters 更新榜单 |
| US-PF-07 | 作为社区用户，我希望点赞、收藏和关注创作者。 | P1 | 操作需要登录；状态持久化；列表数据更新 |
| US-PF-08 | 作为用户，我希望举报不合规内容。 | P0 | 角色、聊天、媒体、feed item、用户资料均有举报入口；提交后进入审核 |
| US-PF-09 | 作为用户，我希望计划到期后仍能查看和下载既有历史与媒体。 | P0 | Chat/My AI/Gallery 不因 entitlement 到期隐藏既有内容；新高阶动作仍受当前 entitlement 控制 |
| US-PF-10 | 作为登录用户，我希望管理偏好和通知。 | P1 | 偏好持久化；语言切换器仅在未来接入真实 i18n 字典层后启用 |
| US-PF-11 | 作为创作者，我希望查看自己的 Creator level、公开角色表现、Pack 收益、Dreamcoin/现金激励与对账。 | P1 | 等级门槛版本化；Creator Studio 从 canonical facts 计算；收益/payout 有可审计状态 |
| US-PF-12 | 作为内容用户，我希望发现和连续阅读 Comics，并从作品进入 Chat 或 Remix。 | P1 | Comic、episode/page、creator、visibility、engagement 与来源关系可恢复；Chat/Remix 保留作品 provenance |

### 2.7 预付访问与付费

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-UP-01 | 作为免费用户，我希望查看 Premium 和 Deluxe 升级方案，以便判断是否购买。 | P0 | Upgrade 展示 Yearly、Monthly、两档价格、权益、dreamcoin bonus 和 CTA |
| US-UP-02 | 作为免费用户，我希望在遇到高级功能锁时进入升级页。 | P0 | custom prompt、dreamcoin 余额不足或 Premium entitlement 缺失时都有升级/充值入口 |
| US-UP-03 | 作为购买用户，我希望安全完成 checkout。 | P0 | 支持支付成功、失败、取消；状态回写 Subscription |
| US-UP-04 | 作为 Premium 用户，我希望支付后立即获得权益。 | P0 | 权益实时生效；原任务可继续；账号页显示当前方案 |
| US-UP-05 | 作为 Deluxe 用户，我希望获得更多 included dreamcoins、更多 voice minutes 和条件视频权益。 | P0 | Entitlement 明确区分 Premium 与 Deluxe；服务端按 plan enforcement；DSH Chat 不按方案切换模型或承诺记忆倍率 |
| US-UP-06 | 作为付费用户，我希望查看当前档位、权益结束时间并在需要时重新购买。 | P0 | Profile 显示 benefitsEndAt 与无自动续订；到期前后均可选择新周期；不展示不存在的 Cancel/Resume renewal |
| US-UP-07 | 作为付费用户，我希望计划变化不会夺走已有聊天历史和媒体。 | P0 | 到期/降级只关闭未来高阶能力；既有聊天仍可查看，已交付媒体仍可查看与下载 |
| US-UP-08 | 作为需要额外余额的用户，我希望单独购买 dreamcoin，而不购买或续订访问计划。 | P1 | coin store offer 版本化；执行前显示币量/价格；一次性 checkout 成功后幂等入账；失败/重放不重复入账；购买历史可查 |

### 2.8 SEO 内容页

| ID | 用户故事 | 优先级 | 验收条件 |
| --- | --- | --- | --- |
| US-SE-01 | 作为 SEO 访问者，我希望长尾页面解释主题并提供下一步入口。 | P1 | 页面有 H1、正文、相关页面、Create/Explore/Upgrade CTA |
| US-SE-02 | 作为内容运营，我希望每个获准发布的公开路由有独立 metadata。 | P0 | dedicated registry 或已发布 CMS 才可索引；title、description、canonical 按路径配置；未授权模板返回 404 |
| US-SE-03 | 作为访问者，我希望比较页明确说明平台优势。 | P1 | 对比页列出核心功能、价格/权益差异和转换 CTA |
| US-SE-04 | 作为访问者，我希望资源 hub 聚合指南、比较、类型和视频入口。 | P1 | Library 页面最多展示 24 个相关入口；链接可访问 |
| US-SE-05 | 作为联盟伙伴，我希望查看 RevShare/CPA 条款、申请、归因链接、推广素材、dashboard 和佣金状态。 | P1 | 公开条款与后台计算一致；归因和佣金有可审计状态；未开放时不显示假申请或假 dashboard |
| US-SE-06 | 作为内容访问者，我希望从 Images、Videos、Glossary 和 Authors 索引进入真实内容或产品任务。 | P1 | 索引只展示已发布条目；内部链接、metadata 和 CTA 可用 |

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
- 明确 Product Action 已被接受但尚未交付时，聊天只能显示等待/失败事实，不得用自然语言伪装成已完成。
- 同一 Product Action 的 SSE 重连、worker replay 或 regenerate 必须复用 effect identity，不得产生第二次生成或第二笔扣费。
- Chat 记忆关闭或清除期间，新 Turn 不得读取旧 relationship workspace；清除完成状态以 durable ACK 为准。
- 套餐到期后，用户仍可访问既有聊天和媒体；只有新请求的高阶 entitlement 被关闭。
- Video 启用时，Video 模式不应提交只在 Image 模式支持的 pose 字段。
- preset 来源需要区分 built-in、My Presets 和 Community，用户不能编辑不属于自己的 preset。
- 生成任务失败时，应展示失败原因、是否扣费、重试入口。
- 删除角色时，如果有关联聊天、媒体或公开内容，需要说明影响范围。
- Feed Share/Report、Profile Invite/Redeem、访问周期购买等操作必须有 auth 和 side-effect handling。
- 长尾 SEO 页面缺少真实正文时，不能误导为完整内容页，应进入内容补齐队列。

## 4. MVP 用户故事范围

MVP 必须包含：

- US-AG-01 到 US-AG-04
- US-EX-01 到 US-EX-06
- US-CH-01 到 US-CH-04、US-CH-06 到 US-CH-09
- US-CR-01 到 US-CR-05、US-CR-09
- US-GN-01、US-GN-02、US-GN-07、US-GN-10 到 US-GN-12
- US-PF-01、US-PF-02、US-PF-04、US-PF-08、US-PF-09
- US-UP-01 到 US-UP-07
- US-SE-02
- US-MB-01、US-MB-02

MVP 之后实现：

- 公开视频生成进入默认可见发布范围。
- Group Chats 与 Packs 的完整产品语义、数据模型、额度和分发。
- 多语言 UI（真实 i18n 字典层、路由内容和 locale 切换）。
- Community/Feed 个性化、创作者激励和大规模 SEO 正文运营按产品依赖和资源分期，不由单一 Chat 留存指标决定是否属于产品范围。
