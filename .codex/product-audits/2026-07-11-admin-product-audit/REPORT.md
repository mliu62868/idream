# iDream 管理后台产品审计

日期：2026-07-11

## 结论

当前后台已经覆盖大量控制面能力，但整体仍然是“功能入口和数据库表的集合”，还不是帮助团队持续经营产品的运营系统。

后台存在的第一性原理应当是：

> 把产品信号压缩成正确决策，把正确决策压缩成安全动作，再证明动作是否有效。

完整闭环应为：`信号 → 诊断 → 决策 → 动作 → 验证 → 学习`。

当前主要断点：

- Dashboard 有信号数量，但没有影响、紧急度、负责人、根因和 SLA。
- 角色工作区能执行动作，但发布状态与发布就绪度互相矛盾。
- 图片生产能发任务，但批次和任务状态不能可靠描述真实结果。
- 事故页能重试，但不能判断是否应该重试、回滚还是停用配置。
- Analytics 有数字，但口径无法衡量 AI 伴侣产品的核心价值。
- Performance 展示生命周期总数，不能支持内容组合、迭代或淘汰决策。

因此，当前后台的根问题不是 UI polish，而是缺少三个产品基础设施：

1. 统一的状态真相。
2. 统一的指标真相。
3. 围绕运营任务而非技术实体组织的工作流。

## 审计范围与证据

本轮在本地后台真实登录并只读走查了 Dashboard、官方角色列表、角色项目详情、视觉身份、素材生产、角色表现、图片生产、失败批次、任务事故、Analytics、Insights、新建角色、角色审核和举报队列。

未提交表单、未修改配置、未执行发布、审核、重试或删除动作。截图能证明界面与可见信息，不能单独证明键盘全流程、读屏器体验或生产数据质量。

## 关键流程

### 1. Dashboard — 健康度：黄

![Dashboard](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/01-dashboard.png)

优点：从冷冰冰的指标表升级成了“Needs your attention + Common tasks”，方向正确。

问题：所有待办都只有数量和 `Handle`。运营看不到严重度、影响用户、趋势、积压时长、负责人、是否重复发生，也没有从首页直接形成处置闭环。

### 2. 官方角色列表 — 健康度：黄偏红

![Official Characters](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/02-official-characters.png)

优点：列表已经从卡片墙变成带阶段、就绪度、视觉资产、表现和下一步动作的工作表。

问题：多个 `approved` 角色只有 17%–50% 就绪，且参考图为 0。`approved`、`public`、`release readiness` 同时存在但不一致，运营无法判断哪个状态是真相。表现列只有巨大生命周期计数，无法判断近期增长、转化或质量。

### 3. 角色项目总览 — 健康度：红

![Character Overview](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/03-character-overview.png)

Lola 已经 `APPROVED`、`public`，同时只有 50% release readiness，并明确缺 Persona、Visual direction、Reference images。页面还提供 Unpublish，说明它确实处于 live 状态。

这不是显示瑕疵，而是后台存在两套发布真相。代码中的新发布门槛只在 `draft → approved` 时触发，因此历史 approved 数据可以永久绕开新的完成度要求。

### 4. Visual Identity — 健康度：红

![Visual Identity](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/04-visual-identity.png)

视觉身份显示 active v1，但 Anchor images=0、Reference images=0、Quality score/Consistency score 均为空。Identity lock 主要复用了年龄、风格和角色自我介绍，并没有形成可验证的视觉身份。

对产品核心承诺“同一个角色持续出现”而言，`active` 在这里代表“数据库里有一个版本”，而不是“身份真的可用”。这是危险的语义污染。

### 5. 角色素材生产 — 健康度：黄偏红

![Character Assets](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/05-character-assets.png)

优点：角色上下文能够传入 Studio，cover/hero/chat 包和 placement 也被串起来了。

问题：Pregen、Creative Production Studio、Image Library、Placement 是多套相邻但分裂的产品模型。批次卡同时出现 loading、regenerate_requested、failed、generated、reviewing 等多级状态，缺少批次级结论、批量动作、质量基线和失败归因。

### 6. 角色表现 — 健康度：红

![Character Performance](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/06-character-performance.png)

页面只有 chats、likes、views 的生命周期总数，并直接注明趋势与转化未来再做。示例数据为 504,510 chats、733 likes、35 views，本身已经无法解释。

这个页面不能回答任何关键经营问题：

- 角色曝光后有多少人进入详情、开始聊天、聊到 5/20 轮？
- 有多少用户第二天回来继续同一个角色？
- 新 Persona、首条消息或视觉版本上线后表现变好还是变差？
- 这个角色消耗多少推理成本，产生多少订阅或 Dreamcoin 收入？
- 应该继续投放、改造还是下架？

### 7. 图片生产工作台 — 健康度：黄

![Image Production](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/07-image-production.png)

优点：从故事 brief 出发、把模型参数放到 Advanced、支持方向探索，这些产品取舍正确。

问题：默认角色被当前环境中的测试/审计角色占据；相同角色名存在重复项并靠 ID 尾部区分；Step 2 disabled 而 Step 3 可直接进入；最近批次把 `completed · 0/4` 当作正常完成状态。

### 8. 失败生产批次 — 健康度：红

![Failed Production Set](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/08-production-failed-set.png)

批次显示 `completed · 0/4`，四个 item 全部 failed，错误只有 `internal`。每项只能分别 Retry，没有 retry all、错误聚类、配置回滚、provider/profile 关联或是否已退款的批次总结。

`completed` 被用来表示“流程停止了”，运营却会把它理解成“生产成功了”。状态命名破坏了数据、Dashboard 和人工决策。

### 9. Jobs & Incidents — 健康度：红

![Jobs and Incidents](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/09-jobs-incidents.png)

页面加载 50 条原始任务，多条重复失败都显示 `Unknown error · Share the error code with engineering`。没有按 error signature、provider、profile、workflow、character、版本或时间窗口聚类，也没有受影响用户、资金影响、最近成功时间和 recurrence。

任务详情进一步出现 status=failed，但 timeline 含 `job.completed`；provider error 只有 `{"code":"internal"}`。在这种信息下，Requeue 是一次赌博，不是运营决策。

### 10. Analytics — 健康度：红

![Analytics](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/11-analytics.png)

当前把 Activated 定义为“窗口内生成过至少一个 job”。这遗漏了产品最核心的聊天关系，也把失败生成和成功生成混在激活定义中。

更严重的是，conversion 使用“窗口内创建的订阅用户数 ÷ 窗口内注册用户数”，不是同一 signup cohort 的转化；它可能把老用户本月订阅放进分子，却不放进分母。这个 2% 不应作为决策指标。

Top events 是事件名计数，不是可行动的漏斗或分群。

### 11. Insights / Retention — 健康度：红

![Insights](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/12-insights.png)

所谓 D1 是注册后 24 小时内发生任意非 signup 事件，D7 是注册后 7 天内发生任意事件；它们是累计活动窗口，不是“第 1 天/第 7 天返回”。注册当天的后续动作可以直接计入 D1，因此不能代表留存。页面上 D1 与 D7 全部相同进一步说明这个指标没有决策价值。

Profile health 还要求运营手输 model profile id，而不是从异常、发布或模型列表上下文进入。

### 12. 新建角色 — 健康度：黄

![New Character](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/13-new-character.png)

优点：Brief → Persona → Visual direction → Review 的结构清楚，默认 private draft，能降低误发布。

问题：草稿只 autosave 在当前浏览器，不能支持多人协作、跨设备继续、负责人、评论、deadline 或审批；起始 brief 关注角色字段，却没有目标用户、内容假设、差异化、计划投放位、成功标准和参考表现。它在“制作角色”，没有在“经营角色供给”。

### 13. Character Review — 健康度：黄

![Character Review](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/14-character-review.png)

空态、搜索和 saved view 基础结构合理。但英文语言状态下页面同时出现中文说明、英文控件和未格式化字段名 `submittedAt`，说明 i18n 不是完整产品能力。审核队列与官方角色项目又是两套独立工作模型，没有统一 review inbox、owner 和 SLA。

### 14. Moderation — 健康度：红

![Moderation](/Users/kk/code/idream/.codex/product-audits/2026-07-11-admin-product-audit/15-moderation.png)

100 条原始报告直接平铺，主要信息是内部 ID、targetType、targetId 和 category。当前环境还混入大量 E2E fixture。没有 case 聚类、同目标合并、上下文摘要、历史决定、举报者可信度、批量动作、分派或 SLA。

它更像数据库浏览器，而不是高吞吐处理队列。

## 最高优先级产品问题

### P0-1：状态真相不唯一

证据：live 角色 50% ready、active visual identity 无参考图/评分、production set `completed 0/4`、failed job timeline 含 `job.completed`。

建议：

- 所有发布/生产/任务状态由服务端统一派生，不允许页面各自解释。
- 为角色返回一个权威 `releaseState`，包含 lifecycle、visibility、checks、exemptions、owner、lastVerifiedAt。
- 对历史 approved 角色做 backfill；未达标者明确标为 `live_legacy_incomplete` 或进入修复队列，不能继续假装 ready。
- `active visual identity` 必须区分 `created`、`validated`、`release_ready`。
- 批次状态使用 `succeeded`、`partially_succeeded`、`failed`、`cancelled`，不要用含糊的 completed。
- 建立状态不变量测试，例如 failed job 不能再发 `job.completed`，0/4 成功不能成为 succeeded。

### P0-2：指标真相不可用于经营

建议先冻结并重写指标字典：

- Chat activation：首次进入有效对话，例如用户发送 ≥3 条消息且收到完整回复。
- Relationship activation：同一角色达到 ≥10 轮或产生首条长期记忆。
- Generation activation：至少一张成功、可展示的媒体，而不是创建过 job。
- Character conversion：impression → detail view → chat start → 5+ turns → D1 same-character return → paid conversion。
- Retention：按日历日或严格 24h bucket 定义返回，不使用“注册后累计窗口内任意事件”。
- Revenue：必须按 signup cohort、plan、character acquisition source 归因。

在口径修正前，当前 Conversion、Activated、D1/D7 应标为 `directional / invalid for decisions`，避免团队据此优化。

### P0-3：后台没有把信号变成工作队列

Dashboard 卡片应升级为排序后的 Action Inbox，每项至少包含：

- 发生了什么。
- 影响多少用户/收入/内容。
- 严重度与 SLA。
- 根因置信度。
- 推荐动作。
- owner。
- 动作后的验证状态。

任务事故应先按 error signature + profile/workflow/provider/version 聚类成 Incident，再进入单个 job。举报也应先按 target/case 聚类，而不是直接处理每条 report。

### P0-4：角色运营缺少内容组合管理

当前只管理单个角色项目。需要一个角色 Portfolio：

- 生命周期：idea → draft → production → QA → scheduled → live → iterating → retired。
- owner、目标受众、内容假设、差异化、计划上线时间和投放位。
- 角色漏斗、成本、留存、收入和版本变化。
- Continue / Improve / Promote / Retire 的组合决策。

### P0-5：图片生产不是一个统一业务对象

建议建立统一 `Creative Run`：brief、directions、jobs、assets、review decisions、placements、cost、quality、incident 全部属于同一 run。Pregen 只是预设模板，不应成为另一套批次系统。

## 信息架构问题

当前 34 个入口被分成 Daily + CharacterConfig / Operations / Media / Business / Insights / GenerationOps / Engineering / System。它主要反映代码域和组织域，不反映操作者的工作。

推荐 IA：

1. **Today / Inbox**：按角色和权限个性化的待办、异常和 SLA。
2. **Character Studio**：Portfolio、Projects、Launch calendar、Review。
3. **Creative Studio**：Creative Runs、Asset review、Library、Placements。
4. **Customer Operations**：Users、Support、Billing。
5. **Growth**：Funnel、Retention、Character performance、Experiments。
6. **Platform Operations**：Incidents、Jobs、Providers、Profiles、Workflows。
7. **System**：Approvals、Audit、Team access。

导航必须按 permission key 和角色过滤。当前 UI 对所有 actor 渲染同一套 nav，权限只在 API 端阻止写/读，会把无权限用户送进错误页。

## 实现结构问题

- `AdminConsoleClient.tsx` 已达 7,305 行，一个组件持有导航、路由解释、34 个 section 的取数、状态、动作和大量视图。
- `fetchSection`、`renderSection`、`nav-config`、filter 需要同步维护，新增模块容易出现入口存在但取数/渲染/权限不一致。
- 全局 Filter 只是对已经加载到客户端的 rows 做 `JSON.stringify` 搜索；它不是全量服务端搜索，会搜索隐藏字段，并且 self-fetch 页面行为不同。
- admin 包通过 `@/* -> ../main/src/*` 直接编译 main 的 server/components 源码，独立部署名义下仍是源代码级强耦合。
- 单 catch-all 页面和巨型 client-only bundle 限制独立加载、错误隔离、页面级权限和团队并行迭代。

建议：

- 每个业务域使用独立 route + module shell + typed admin API SDK。
- 权限、面包屑、搜索、分页、saved view、loading/error 采用共享框架。
- 所有列表改为服务端分页、筛选和 URL 可恢复状态。
- 把 incident、character project、creative run、review case 建成深模块，不再围绕任意 Row/JSON 表格扩展。
- admin 只依赖 shared contract 和 API，不直接 include main server 源码。

## 90 天行动顺序

### 0–7 天：停止制造错误真相

1. 修复角色、visual identity、production batch、generation job 的状态不变量。
2. 标记并隔离 fixture/audit 数据；后台始终显示环境和数据类型。
3. 暂停把当前 Conversion、D1/D7 当作决策指标；建立 metric dictionary。
4. Dashboard 待办加入 age、impact、owner 和 deep link。
5. 导航按角色/permission 过滤。

### 8–30 天：打通三条关键闭环

1. Character release：项目 → 资产 → 真实前台预览 → 发布 → 发布后监测。
2. Creative run：brief → directions → jobs → review → placement → performance。
3. Incident：异常聚类 → 影响评估 → retry/rollback/disable → 恢复验证 → postmortem。

### 31–60 天：建立经营能力

1. Character Portfolio 和版本化表现漏斗。
2. 重新实现 activation、retention、conversion、unit economics。
3. 服务端草稿、owner、assignment、comment、deadline、approval。
4. 角色/视觉/首条消息实验与版本归因。

### 61–90 天：降低迭代成本

1. 拆解巨型 AdminConsoleClient。
2. admin 与 main 改成契约/API 依赖。
3. 统一 server-side search、pagination、saved views、case/incident framework。
4. 建立角色化 Dashboard 与可配置工作队列。

## 不应先做的事情

- 不要先全面换视觉风格。
- 不要先加更多 Dashboard 卡片。
- 不要先继续扩充 nav item。
- 不要先为现有错误指标画更漂亮的图。
- 不要用更多确认弹窗代替正确的状态模型和上下文。

先修真相，再修工作流，最后修表现层和架构。

## 可见优势

- 默认 private draft、独立发布、发布检查的方向正确。
- 高风险操作有 reason、审计和确认机制。
- 模型/profile/template 版本化和回滚意识较强。
- 角色工作区的 Overview / Persona / Visual Identity / Assets / Preview / Performance / History 已经形成合理骨架。
- Creative Production 从 story/brief 出发而不是直接暴露模型参数，符合运营用户心智。
- 导航已尝试 progressive disclosure，Dashboard 也开始从指标转向行动。

这些基础值得保留。下一阶段不是推倒重做，而是把已有骨架从“功能可达”升级为“决策闭环”。
