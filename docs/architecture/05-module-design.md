# 05 · 模块设计

更新日期：2026-10-04

本文维护逻辑业务域的职责和协作边界，不重复 schema、API 清单或实现进度。产品契约见[后台规格](../product/BackendFeatureSpec.md)，持久化形状以 Main Prisma schema 为准；实际状态见[当前覆盖](../product/CURRENT_FUNCTIONAL_COVERAGE.md)。

Main 保存产品事实并执行领域命令；Admin 是独立 UI/BFF；Chat 执行不可变 Turn 快照；Gen 执行图片/视频 workflow。Main 的实现分布在 `modules/ourdream`、`modules/chat`、`modules/admin-v2` 等现有模块，不把历史目录或大文件形状当作新的分层要求。目录与依赖规则见[工程约定](09-project-structure.md)。

## 1. identity

负责 better-auth 注册、登录、会话、账号状态及匿名身份关联。Main 聚合用户、已购访问、权益、余额和年龄状态，所有者与权限在服务端校验；客户端状态不能代替授权。

恢复码、会话撤销、账号删除和跨账号隔离保留独立身份与回执。角色或权限变更通过有权命令与审计，不伪造会话。协议见[API 设计](04-api-design.md)与[安全架构](07-security-and-compliance.md)。

## 2. compliance（age gate + age verification）

首访成人内容前确认 age gate；身份年龄验证另按已确定辖区/风险规则触发、存储和复验。当前身份验证 provider 未发布、默认 `not_required`，不能从历史国家示例推断已启用。

当有效规则要求身份验证时，受限操作必须由服务端守卫拒绝未验证身份。provider、签名回调、结果与政策版本须独立取得资格；age gate 不代替真实身份验证。见[内容策略](../product/CONTENT_POLICY.md#6-分辖区年龄验证age-gate-vs-identity-verification)。

## 3. catalog（角色目录）

负责公开发现、详情、标签、搜索、排序、分页、收藏与可解释统计。公共读取使用有效 Character Serving/Release、受众和安全规则，不能只凭历史 `Character.status` 判断；私有角色依所有者授权使用。

查询、稳定游标、缓存和 DTO 遵守公开读取边界，角色变更与发布使对应投影失效。内部 prompt、私有资料和运营证据不进入公共 DTO；无内容、无资格与读取失败分别表达。发布边界见[素材权威](16-character-asset-studio-authority.md)。

## 4. chat

Main 保存 Session、产品 Turn、当前 attempt、selected reply、Scene、附件、用量与账目，向 Chat 交付不可变执行快照。Chat 内嵌 AgentRun、DSH/official igrep，只保留执行、恢复与未决 Main ACK 证据，不连接数据库。

终态候选经 Main exact-attempt CAS 接纳，才成为保存的回复；SSE 断流恢复原 attempt。编辑/重生成遵守最近 Turn 修订边界，旧结果不能覆盖新回复。长期记忆只派生自 Main committed Turns，删除/修订后的隔离与重建不召回已撤销来源。

Product Action 经 Main 接纳和计费，再由 Gen/Voice 交付；群聊、Input、Clip 与 Call 各有身份、权限和计量边界。执行与恢复协议只在[ADR-21](21-companion-chat-deep-runtime.md)维护，用户行为见[Chat 契约](../product/CHAT_SERVICE_PRD.md)。

## 5. creator

负责完整多步创建、可恢复草稿、Soul/外观/声音、视觉候选与身份确认、标签、编辑、复制和删除。Quick Start 只预填，不能代替完整创建；预览使用统一 Generation 执行与终态投影，不另建 provider 路径。

私有保存、创作交接、发布候选和线上 Serving 是不同事实。日常角色和图片经既定基础检查后准备并显式发布，无人工评分或逐图批准；草稿变化不改线上内容或已固定的会话版本。角色 age≥18 与基础未成年人拦截不可关闭。

图片库、身份/reference 来源、独立复制、依赖归档、三槽位编排与发布/回滚见[素材权威](16-character-asset-studio-authority.md)和[运营指南](../product/CHARACTER_ASSET_STUDIO_OPERATIONS_GUIDE.md)。

## 6. generation（图片/视频 + presets）

Main 接受前固定资格、角色/来源、recipe/profile/workflow、报价与幂等身份，在事务内预留费用并提交 Request/Attempt 与 dispatch Outbox。Gen 根据精确 workflow pins 调用 backend，先保存不可变 TerminalRecord，再重投 Main durable ingest；不直写产品数据库或余额。

Main 从终态记录投影 Artifact、Delivery 与 Settlement；provider 成功不等于用户收到作品。重放不再次调用 provider 或扣费；unknown 先 reconcile，明确失败/部分交付按原报价唯一退款。协议见[深模块边界](17-deep-module-authority-boundaries.md)和[异步执行](06-async-jobs-and-ai.md)。

Create、Edit、Enhance、Chat Animate 与 Generate 序列各保留 source、控制和交付契约；Video 按独立能力/权益开放。built-in/user/community presets 保留所有者与定义版本。产品结果见[图片契约](../product/CHARACTER_IMAGE_GENERATION_SYSTEM.md)，实际 backend 配置见[Gen 说明](../../packages/gen/README.md)。

## 7. media（图库）

负责资产列表、筛选、收藏、合集、批量管理、播放/下载与删除。资产所有者、来源、可见性、公开资格和文件授权分别判断；个人网格只读本人资产，社区公开读取另用有效公开规则。

签名文件 URL 有限时效并可按原权限恢复，不能变成永久公开地址。删除/归档先检查依赖，再按领域命令与异步清理收敛；不得复活已删除来源。到期不锁回既有交付，删资产不自动退款。存储与账务见[运行与恢复](10-operations.md)及[经济契约](../product/ECONOMY_AND_PRICING.md)。

## 8. billing（订阅/权益/dreamcoin）

一次性加密预付访问与独立 Coin Store 充值分别固定 offer、checkout 和 provider confirmation。唯一入账/激活后派生权益，不自动续费；物理 `Subscription` 名称不改变预付产品语义。

报价、append-only ledger、正常访问退款、精确 grant 冲销/恢复、人工调币与普通到期分别维护。唯一工程协议见[计费与权益](08-billing-and-entitlements.md)，价格与承诺见[经济契约](../product/ECONOMY_AND_PRICING.md)。

## 9. safety（信任与安全）

固定 `MODERATION_PROVIDER=mock`，保留 `underage/minor/csam` 与角色 age≥18，保留但不启用 safety-gateway。输入/输出基础检测记录真实拒绝与事件，不宣称覆盖全部语义分类，也不新增日常人工发布关卡。

举报、处置、申诉与政策版本独立维护；敏感明文仅在逐目标 consent/Legal Hold 及每次访问审计下可读。内容规则见[内容策略](../product/CONTENT_POLICY.md)，工程隔离见[安全架构](07-security-and-compliance.md)。

## 10. library（My AI）

聚合本人 Recent/Characters/Created/Presets/Media 与已开放的 Group Chats/Packs，不持有第二套资产或会话权威。继续、管理和删除调用所属领域命令，状态与数量来自真实查询。

未发布能力不展示空的死入口；既有深链给准确不可用原因和返回路径。本人空库、读取失败、官方灵感与既有 Grant 访问权分开。完整任务见[功能地图](../product/ProductFeatureMap.md)与[主站验收](../product/MAIN_SITE_HEALTH_CHECKLIST.md)。

## 11. profile & account

聚合本人资料、偏好、通知、兑换/推荐、余额与预付访问。语言入口仅在真实 UI 字典、路由内容和 locale persistence 齐备后发布；页面不借静态选项承诺能力。

兑换/推荐按已接受资格和稳定身份唯一追加奖励；登出全部撤销原会话。账号删除处理 Main 来源、公开/私有资产、Chat AgentRun/DSH 派生与必要保留记录，提供查询和恢复，不以一次按钮成功代表清理完成。工程要求见[安全架构](07-security-and-compliance.md)与[ADR-21](21-companion-chat-deep-runtime.md)。

## 12. feed & community（P1）

完整目标包括 Feed 发现和互动、榜单、创作者/Follow/Studio、合集、Packs、Comics 与创作者经济。公开对象、来源/Remix 权利、购买固定版本、immutable Grant、收益和 settlement 分别维护，不能用 UI 骨架代替结果。

读取及命令调用现行 Main 领域入口；权限、费用、幂等与恢复见[后台规格](../product/BackendFeatureSpec.md)。各能力实际证据由[当前覆盖](../product/CURRENT_FUNCTIONAL_COVERAGE.md#资产与社区)维护，不在此复制 MVP 顺序或待开发状态。

## 13. seo（路由内容）

RoutePage 运营库存不构成公开正文权威。只有有效 published authority 参与公开 SSR、metadata 与 sitemap，更新使对应缓存失效；专用产品页由精确 registry 授权，其余无公开资格的路径返回 404。

内容运营发布真实正文与版本，库存/发布数量从实际查询取得，具日期证据见[当前覆盖](../product/CURRENT_FUNCTIONAL_COVERAGE.md#发现与公开内容)。不以模板数量证明公开内容完整。

## 14. analytics（埋点）

分析事件作行为观察；经营指标使用 canonical Product Event、eligible fact 与版本化 Metric Registry。埋点发送成功不能代替持久事实或宣称全部已验收，客户端通用 track 不签发服务端成功。

来源/信任、唯一事件、投影恢复、cohort 成熟度、认证与实验边界见[运营系统 ADR](15-admin-operating-system-authority-adr.md)；产品口径见[后台规格](../product/BackendFeatureSpec.md#8-经营指标与实验)，日志约定见[工程约定](09-project-structure.md#6-可观测性约定埋点日志)。

## 15. admin（运营控制面）

负责角色/素材创作与发布、生成排障、Case/Incident、用户、计费、配置、指标、举报/申诉和审计。入口见[Admin 导航](../product/ADMIN_NAVIGATION.md)。

独立 `@idream/admin` 仅有 UI/BFF；Main `/api/v2/admin/*` 经 Shared manifest、签名 actor、细粒度权限与领域命令执行。有效 legacy 调用由其现有入口承接，不另维护平行 API。事务、确认、版本锁、未知接纳与恢复见[后台契约](../product/BackendFeatureSpec.md#510-adminops-control-plane)和[深模块边界](17-deep-module-authority-boundaries.md)。

运营从信号进入对象、执行有权命令、读回实际结果并核验费用/审计。人工补偿不覆盖余额或冒充 provider 退款；草稿采用不改变 Serving；工单关闭不代替副作用完成。实际用户/运营验收见[Admin 清单](../product/ADMIN_PRODUCT_HEALTH_CHECKLIST.md)，数据库开发工具不承担生产运营。
