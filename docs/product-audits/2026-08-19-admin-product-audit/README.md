# Admin 产品与运营闭环审计（2026-08-19）

## 结论

本地受控环境下，Admin 的 38 个导航目的地全部可达，核心用户与运营链路可用；本轮发现的 3 个高优先级问题和 4 个中优先级问题均已修复并回归。当前没有已知 P0，也没有遗留的本轮 P1/P2。

这个结论只代表本地受控环境闭环，不代表公网生产批准。

审计基线：`master@8a0d569d4`。运行身份：`seed-admin-user`（admin），界面语言：中文。开始前已有的未跟踪文件 `packages/admin/src/features/ssr-initial-state.guard.test.ts` 未修改。

## 第一性原理

Admin 不是“页面集合”，而是运营控制面。它必须始终满足四条边界：

1. Today 只聚合并排序下一步工作，不复制各领域的写入权威。
2. 高风险动作必须进入领域命令、审计与 outbox；按钮可见不等于状态可任意改写。
3. 角色发布保持 `生产 → 审核 → 草稿资产包 → QA → Release → Serving`，审批不等于上线。
4. 生成事实保持 `Request → Attempt → TransportExecution → TerminalRecord → Artifact / Delivery / Settlement`；界面不得把推测状态包装成终态。

本轮所有优化都围绕“当前任务更快完成、权威边界更难误用”展开，没有新增导航层级、审批层级或平行工作台。

## Chrome 审计步骤

| 步骤 | 页面 / 任务 | 实际检查 | 健康度 |
|---:|---|---|---|
| 1 | 登录与会话 | 本地登录、账号菜单、语言与角色身份 | 正常 |
| 2 | Today | 19 条待处理、4 条 SLA 超时、7 条无人认领；摘要、全部工作、筛选与首要动作 | 正常；信息层级清晰 |
| 3 | 全局壳层 | 侧栏、移动抽屉、全局搜索、刷新、面包屑、标签页标题 | 修复后正常 |
| 4 | 角色工作室 | 角色列表、详情、图片、预览、发布；阶段边界和来源信息 | 正常；保留现有发布模型 |
| 5 | 客户案件 | Mine / All / 筛选、深链接、证据、分配、决策、验证与协作 | 修复后正常 |
| 6 | 客户 360 | 列表、账户状态、订阅、余额、工单和运营历史 | 修复后正常 |
| 7 | 计费运营 | 订阅与退款对话框、金额与后果说明 | 正常；未提交退款 |
| 8 | 创意工作室 | 素材、锚位、生产批次与原始状态文案 | 修复后正常 |
| 9 | 平台运营 | 事故、生成任务、死信、供应商、后端、指标、配方、预设、工作流 | 修复后正常 |
| 10 | 增长 | 产品健康、角色表现、实验、陈列、内容、定价/促销、漏斗 | 正常；低样本状态如实呈现 |
| 11 | 系统 | 团队访问、审批、审计记录 | 修复后正常 |
| 12 | 响应式与恢复 | 1440 / 1200 / 768 / 390；键盘焦点闭环、横向溢出、粘性页头、未知路径 404 | 正常 |

38 个导航目的地逐一打开并核对标题、主内容和运行时错误：

```text
/admin/today
/admin/characters
/admin/characters/review
/admin/characters/starters
/admin/characters/taxonomy
/admin/creative/runs
/admin/creative/library
/admin/creative/placements
/admin/cases?view=mine
/admin/customers
/admin/customer-ops/billing
/admin/customer-ops/account-requests
/admin/growth/health
/admin/growth/characters
/admin/growth/experiments
/admin/growth/merchandising?view=featured
/admin/growth/merchandising?view=announcements
/admin/growth/content
/admin/growth/offers?view=pricing
/admin/growth/offers?view=promo
/admin/growth/funnels
/admin/ops/chat
/admin/ops/incidents
/admin/ops/jobs
/admin/ops/jobs?view=dead-letter
/admin/ops/profiles
/admin/ops/providers
/admin/ops/providers?view=backends
/admin/ops/providers?view=generation-metrics
/admin/ops/recipes
/admin/ops/recipes?view=presets
/admin/ops/recipes?view=workflows
/admin/moderation
/admin/risk
/admin/support
/admin/system/access
/admin/system/approvals
/admin/system/audit
```

## 发现与修复

| 优先级 | 发现 | 产品影响 | 修复 |
|---|---|---|---|
| P1 | Case 深链接所选记录不在当前队列时，空列表分支会把详情一起隐藏 | 从 Today 进入具体案件却看不到目标 | 列表与详情解耦；详情始终按 URL 权威加载 |
| P1 | Case、客户、事故在 1200px 仍使用 `xl` 双栏 | 详情被完整列表推到折叠线下，运营无法边看边判 | 双栏提前到 `lg`，详情保持粘性 |
| P1 | 已删除账号仍显示状态切换命令，后端窄命令也未拒绝 | 可能绕过账号删除权威，形成意外“复活”路径 | UI 改为“由账号删除流程管理”；后端冲突拒绝并补集成测试 |
| P2 | `overflow-x-hidden` 创建滚动上下文，长页面全局页头失去 sticky | 深滚动后失去导航、搜索和刷新上下文 | 改为 `overflow-x-clip`，Chrome 键盘滚动后页头仍在 `top: 0` |
| P2 | 手机所选详情仅视觉提前，DOM 仍先读列表 | 键盘和读屏用户要穿过整段列表才能到当前目标 | DOM 直接按“所选详情优先”排列；桌面只用 `lg:order-first` 保持左列表右详情 |
| P2 | 手机刷新图标没有可访问名称 | 读屏只得到无名按钮 | 增加本地化 `aria-label` |
| P2 | `character_release`、`complete`、`not ready`、`unplaced`、路由标题和审批新鲜度混入英文 | 中文运营界面需要反复翻译状态 | 补齐领域字典，并把路由元数据纳入 i18n 完整性检查 |

## 保留的好设计

- Today 保持“一个下一步最佳操作”，不再造第二套任务状态机。
- 退款确认明确金额、后果和不可逆边界，没有缩成危险的一键动作。
- 角色审核、Release 与 Serving 仍是不同阶段，没有为了少点几次而合并权威。
- 生成任务详情继续展示不可变的 Attempt、TransportExecution、TerminalRecord、Artifact、Delivery 与 Settlement。
- 事故恢复工具仍在事故队列之后，不抢日常第一屏。

## 验证证据

- Chrome：38/38 导航目的地可达；Case / 客户 / 事故在 1200px 左列表右详情；Case 在 390px 先详情后筛选；768px 和 390px 无横向溢出。
- 键盘：移动抽屉打开后焦点落在关闭按钮，`Tab` 到“今日工作”，`Escape` 关闭并把焦点还给触发器。
- 滚动：角色长页面滚到 `scrollY=1550.5` 后，全局页头仍为 `position: sticky; top: 0`。
- 恢复：未知路径 `/admin/definitely-missing-audit` 返回 HTTP 404，并可点击“返回今日工作”恢复。
- Admin 测试：165 个文件、950 个用例通过。
- Main 访问边界：8 个集成用例通过；Main TypeScript 检查通过。
- Admin `check`：ESLint 0 错误（7 条既有警告）、TypeScript 通过、Next.js 16.2.1 生产构建通过。
- 最终重启后，关键页面请求为 200，Chrome 页面无非空运行时 alert；PM2 尾部日志没有新的运行时异常。

代表性截图：

- `39-today-1440-final.png`：桌面 Today 与持久侧栏
- `40-today-768-final.png`：平板 Today
- `41-today-mobile-nav-final.png`：手机导航抽屉
- `33-case-1200-final.png`：Case 双栏
- `34-case-mobile-390-final.png`：手机 Case 详情优先
- `35-customer-1200-final.png`：客户双栏
- `36-incident-1200-final.png`：事故双栏
- `37-access-deleted-boundary-final.png`：已删除账号边界
- `38-approvals-localized-final.png`：审批新鲜度中文化
- `43-admin-404-final.png`：未知路径与恢复出口

## 证据边界

- 这是本地 PM2 + 本地权威数据的受控验证，不是生产域名、生产密钥、生产流量或公网发布验证。
- 本轮没有提交退款、认领、重排队、丢弃、封禁、审批或发布等会改变真实运营状态的命令；只验证到确认边界。
- 截图不能单独证明完整 WCAG；本轮有语义树、焦点陷阱、Escape 恢复、可访问名称和响应式溢出检查，但没有宣称完成全量辅助技术认证。
- 38/38 证明路由、首屏读取和导航健康，不等于对每个写命令都做了破坏性实跑。
