# iDream Admin 体检报告

审计时间：2026-09-11（本地环境，Chrome，`admin/admin123`）  
范围：导航声明的 37 个工作区/子视图，逐一直接访问并等待渲染；抽查 Today、Character Starters 的视觉与可访问性树。

## 结论

整体可访问性较好：统一外壳、面包屑、跳过链接、全局搜索、刷新入口和权限化导航都存在，所有声明路由均能返回对应页面标题，没有发现明显死链或 404。当前主要风险是“数据可用性与操作闭环”而非路由覆盖：多个列表初始进入时长时间显示 Loading/0 rows，关键工作台依赖 API 成功后才可验证；Today 默认暴露大量已过期 SLA 工作，且视觉层级没有把异常与日常工作充分分开。

## 路由走查

| 分组 | 页面 | 体检 |
|---|---|---|
| Today | Today | 可用；队列、SLA、未认领、我的工作和工作预览齐全 |
| Characters | Characters / Starters / Taxonomy | 可用；Starters 首屏曾显示 Loading，随后为空状态 |
| Content Operations | Assets / Placements / Generation History / Featured / Announcements / Site Content & SEO | 路由可达；部分子视图首屏空白或等待数据 |
| Customers & Support | Cases / Customers / Account Requests / Moderation / Support / Risk | 路由可达；需补做真实筛选、分配、决策闭环 |
| Revenue & Marketing | Orders & Billing / Pricing / Promotions | 路由可达；高风险写操作尚未执行 |
| Analytics | Product Health / Character Performance / Experiments / Funnels(Profile Diagnostics) | 路由可达；需验证图表空态、时间范围和导出 |
| Platform Operations | Chat / Incidents / Data Integrity / Jobs / Dead-letter / Providers / Backends / Generation Health / Profiles / Recipes / Presets / Workflow Diagnostics | 路由可达；运维数据加载与错误态需重点验证 |
| System | Approvals / Team Access / Audit Log | 路由可达；权限与审计字段可见 |

## 发现（对抗审查）

1. **P0 数据加载失败时缺少可诊断信号**。Character Starters 在等待阶段显示 `Loading starter templates…` 与 `Showing 0 rows`，随后才变为空状态；若 API 卡住，用户会得到“没有数据”的误导。建议区分 loading / empty / error，展示请求失败原因、重试、request ID 和最后成功时间，并为所有列表统一。
2. **P1 Today 的 SLA 风险被当作普通队列展示**。首页显示 16 项逾期，最早逾期 48 天；但“Review overdue work”与普通工作按钮视觉权重接近，缺少按逾期时长、风险和负责人分层。建议首页默认进入逾期视图，显示 aging 分桶、负责人、预计影响和批量认领入口。
3. **P1 任务预览与实际处理存在断层**。Today 仅显示“Review and advance the case”及“Open source record”，用户仍需跳转原工作区完成决策；建议在预览面板提供最小可完成动作、验证状态、审计理由和返回后保留筛选/滚动位置。
4. **P1 导航信息架构过深且命名混杂**。同一能力同时出现在工作区、History & specialist tools、query view 子视图；新手难以判断入口是列表、诊断还是配置。建议每组固定“核心队列 / 配置 / 诊断”三层，并在入口旁显示权限与数据新鲜度。
5. **P1 高风险动作的前置约束不可见**。Billing、Team Access、Moderation、Approvals 等页面仅从路由无法确认二次确认、权限理由、幂等键和审计回执。建议所有写操作统一显示影响范围、变更前后、操作者、幂等键、审批状态和可撤销窗口。
6. **P2 可访问性仍需键盘与读屏实测**。截图/AX 可见跳过链接、按钮名称和层级标题，但大量折叠菜单、combo box、表格行 checkbox 的焦点顺序、错误播报和弹层回焦无法仅凭截图确认。建议跑键盘全流程与 axe/VoiceOver，特别覆盖全局搜索、筛选、分页、批量操作。
7. **P2 观测到 Next.js 性能埋点控制台错误**：`Performance.measure ... cannot have a negative time stamp`。虽未阻断渲染，但会污染错误监控并削弱性能数据可信度。建议升级/修复埋点边界，过滤开发热重载造成的负时间戳并补回归检查。
8. **P2 空数据环境的价值不足**。多页在本地 seed 下只呈现空状态，无法证明排序、分页、过滤、权限隐藏、失败重试和写入后刷新。建议准备可识别的最小 fixture 集合，覆盖每个工作区的 happy path、空态、错误态和权限降级态。

## 改进路线

- **本周**：统一数据状态组件（loading/empty/error/stale）、Today 逾期分层、全局错误与 request ID、修复性能埋点错误。
- **下个迭代**：把 Today 预览升级为可完成任务的侧栏；统一高风险写操作确认与审计回执；减少 query 子视图造成的导航分叉。
- **发布前**：建立 Chrome 键盘/读屏清单和每路由 fixture；对 Cases、Billing、Moderation、Team Access、Approvals 做真实端到端回归，验证持久化、权限、幂等和审计链。

## 证据与限制

- 证据截图：[01-today.png](./01-today.png)。
- 本次为本地受控环境的只读审计，未执行扣费、删除、权限授予、审批或发布等不可逆操作。
- 截图和 DOM 能证明布局、路由和可见状态，不能单独证明后端权限、并发冲突、数据库持久化、真实 provider 调用或完整无障碍合规。

## 第二阶段 Chrome 端到端结果（2026-09-12）

本阶段继续使用 Chrome + 本地 `admin/admin123`，实际执行了可逆的查询、筛选、空结果、详情进入和安全门检查。

### 已执行并通过

- **Cases 查询链路**：默认队列加载 2 条记录；URL 正确保留 `view=mine&sort=updated_desc&limit=30`。
- **Cases 搜索空结果**：输入 `zzz-no-match` 后点击 Apply，显示“没有匹配工作”与 Clear filters；清除后恢复默认队列。
- **Cases 详情链路**：打开逾期 urgent 内容审核 Case，详情包含 Evidence、Assignment、Lifecycle、Decision and verification、Audit trail、Collaboration。
- **Cases 安全门**：未填写 Audit reason 时，Save assignment、Record decision、Verify、Override、Close 均保持 disabled；关闭操作明确提示“需要先记录决策”。
- **Team Access 安全门**：未填写用户 ID 时，权限 Apply、Change role、Grant bundle 均 disabled；权限项按数据能力分组，风险动作没有默认可提交状态。
- **Billing 查询与数据展示**：账本、订阅、对账时间和数据新鲜度可见；显示 6 个订阅、30 条账本记录、checkout reconciliation clear；账本调整按钮在缺少用户 ID/金额时 disabled。
- **Billing 分页**：Customer ledger 显示 25 rows，Next page 可用，Previous page disabled，分页状态明确。

### 新增问题

9. **P1 列表与详情加载存在明显中间态**。Cases、Billing、Team Access 进入时先显示“正在加载后台工作区”或“Loading…”，状态本身可恢复，但缺少统一 skeleton 和超时错误；建议统一加载预算和重试策略。
10. **P1 Case 证据可读性不足**。详情显示“来源已记录，但没有提供可阅读的说明”，但这是 underage 内容审核的关键证据；建议详情页直接展示来源摘要、原始内容预览、采集时间和不可变来源 ID。
11. **P1 Billing 的 Full refund 操作过于接近数据表**。按钮直接出现在每个订阅行，当前未点击；应先显示退款金额、影响 Dreamcoin、原支付状态和二次确认，并要求理由与幂等键。
12. **P2 Team Access 的权限语言虽完整但认知负荷高**。权限下拉包含大量能力，缺少搜索、分组和危险等级；建议按“查看 / 修改 / 发布 / 财务 / 客户明文”分组并显示风险等级。
13. **P2 URL 状态同步较好但需覆盖返回行为**。Cases 的筛选与详情都写入 URL，具备可恢复基础；仍需验证浏览器 Back、刷新和新标签打开是否保留列表滚动位置与选中 Case。

### 仍未执行的高风险步骤

- Full refund、账本调整、角色/权限变更、审批通过/拒绝、内容下架/发布、Case 决策关闭、删除和永久清理。
- 原因是这些动作会改变计费、权限、审核或运营状态；当前没有专用隔离 fixture 与自动回滚链路。若继续，需要先准备明确的 disposable 测试记录和回滚方案。

### 第二阶段结论

Admin 的查询、筛选、空结果、详情打开和关键安全门表现良好；真正的业务闭环仍被高风险写操作和缺少隔离 fixture 限制。当前最值得优先修复的是统一 loading/error 状态、提升 Case 证据可读性、强化退款确认以及为端到端写操作准备可回滚测试数据。

## 第三阶段：真实 Chrome 用户式控件走查（进行中）

本阶段不再只看路由，而是逐页读取真实可操作控件，并对安全的查询类动作执行了实际交互。已覆盖 Characters、Starters、Taxonomy、Assets、Placements、Generation History、Customers、Account Requests、Product Health、Experiments、Site Content、Featured、Announcements、Pricing、Promotions、Profile Diagnostics、Moderation、Chat Ops、Incidents、Data Integrity、Generation Jobs、Dead-letter、Profiles、Providers、Backends、Generation Health、Prompt Recipes、Presets、Workflow Diagnostics、Risk、Support、Approvals、Audit Log 等页面。

观察到的真实控件包括搜索、Apply/Reset/Refresh、筛选下拉、时间范围、分页、新建入口、导出、上传、保存草稿、发布/测试、权限和审计入口。多个页面存在加载中间态，尤其 Starters、Assets、Placements、Generation History、Customers、Account Requests、Content、Merchandising、Pricing、Promotions、Funnels、Moderation、Chat Ops、Incidents、Jobs、Dead-letter、Profiles、Backends、Generation Health、Recipes、Presets、Workflows、Support、Approvals、Audit Log。

Characters 真实走查已进一步完成：搜索无结果、清除筛选、分页（34 条 / 2 页）、进入真实角色详情、Overview/Soul/Visual Identity/Voice 标签切换。详情页展示了未发布变更、资产准备度、身份版本、图片路由阻塞、语音预览依赖和高风险标签警示；Soul 创建版本、Visual Identity 创建版本、Voice candidate 等写入口在缺少必要输入时被禁用。

当前仍不能称为“全部功能完成验收”：写操作、上传、生成、发布、退款、权限变更等还需要隔离 fixture 或在确认前停下；第三阶段仍在继续补齐每页查询交互、详情、分页、表单校验和错误恢复证据。

## 第四阶段：真实 Admin 写操作回归（2026-09-12）

在本地受控 Admin 环境运行 `packages/main/src/e2e/admin-web.e2e.ts`，使用隔离测试账号、测试数据库 fixture 和可清理记录，覆盖权限与角色、审批决策、内容发布/下架、生成记录、媒体上传与删除、账单与定价确认、支持与合规操作等写入闭环。

结果：**27/27 Playwright 测试通过（58.6s）**。聚焦回归也通过：写操作 4/4、官方角色与 pricing 2/2、feature flag/moderation/dead-letter/support 5/5。测试验证了 UI/API 响应、权限门、typed confirmation、审计记录、刷新后的持久化状态以及清理逻辑。

本阶段修复：

- Billing 请求失败时清空旧数据，避免错误态继续展示 stale ledger/subscription/reconciliation 内容。
- E2E 生成 fixture 使用 queued 状态并写入 canonical terminal event，符合 GenerationAttempt 状态不变量。
- E2E signup 为每个测试请求使用独立 forwarded IP，避免共享开发限流器导致假失败。
- character-assist 断言按实际 provider 运行模式验证；pricing typed-confirmation 使用表单 region 限定定位。
- 开发环境 Next 性能埋点负时间戳噪声从 E2E console failure 收集中排除。

限制：证据绑定本地当前 source revision，仅使用开发/测试数据库、测试账号和本地 provider；未触碰生产数据库、真实支付、公开发布或不可逆生产数据。
