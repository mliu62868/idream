# iDream 剩余工作执行计划

更新日期：2026-09-02

本文件只保留尚未完成的工作。已完成能力与历史运行证据见 `CURRENT_FUNCTIONAL_COVERAGE.md`。

2026-09-02 核心审计已真实完成 Create 私有保存/声音/聊天/图片、两条视频、Admin 三图审核发布/回滚和客服多轮闭环。最终串行测试、浏览器组合、恢复演练与重启后的同版本结果见 `.tmp/product-audit-20260902/FINAL_REPORT.md`；该报告未完成时仍不能把本轮早期证据当作公开上线签发。支付与年龄功能不在本轮修复范围。

## 当前状态

- 代码已把 Companion Chat 产品权威迁到 Main PostgreSQL：`RecentChat`、`ChatTurn`、`ChatTurnAttachment`。
- `packages/chat` 已移除 Prisma/PostgreSQL/BullMQ；其深模块内嵌执行 AgentRun、DSH/igrep，成功 run 在 Main ACK 后清理。
- 图片 ToolEffect 已进入 Main Generation/Ledger，不采用成功后普通 hook 扣费。
- Main migration 和旧 Chat 数据导入脚本已经存在，但本仓库修改不会替用户连接生产库执行。
- 2026-08-31 的实现审计已记录 Character/Admin 与 Companion 的当前证据；本文件不复述已完成项，任何运行态完成声明继续以 `CURRENT_FUNCTIONAL_COVERAGE.md` 和同 revision 验证为准。
- 2026-09-01 的产品决策是完整对标 OurDream；WPCU 保持 Metric Registry `official`，WSCU/WSCrU/WPSCU/WSR 保持诊断用途，不存在待执行的北极星切换。目标文档仍不能冒充已上线能力。

## 1. 收口完整 OurDream 对标缺口

1. 建立带观察日期的逐功能 parity matrix，覆盖 Explore、完整 Create、Chat、Generate、My AI/Profile、Feed/Community/Creator Economy、Upgrade、Affiliate、Support 与公开内容。每项绑定 OurDream 可验证契约、iDream 当前代码/运行证据、真实缺口和退出 Gate。
2. 区分“未实现空态”、“受 feature/provider/entitlement 条件限制”、“本地受控可用”和“公开生产已认证”，不用路由存在或历史截图代替能力证明。
3. Create 的完整五步输入、声音选择/试听、身份确认、保存、Chat 与 Character 图片已在 2026-09-02 核心审计实际走通；目录广度仍需独立对标：40+ personality、19 voice、135 occupation、29 relationship 的日期化观察应逐项记录 matched/equivalent/intentional divergence。继续复用现有五步与同一 Soul Markdown，不按对方的步骤数重构；Quick Start 只能预填这条链。
4. 将 Recent、Characters、Presets、Created 和 Media 共同作为 My AI P0 核心面；Group Chats/Packs/Comics 作为 P1 对标缺口，发布前只显示明确 unavailable 空态或不暴露入口。
5. 补齐 Generate 的 Presets、Create/Edit/Enhance、reference-guided lineage、Advanced Settings、Gallery 管理、多 scene/时长/比例/质量/AI voice Video 与 Chat Product Action 交接；持续保证 Character/Release/VisualProfile/Scene pins、quote、settlement/refund 和 replay 幂等。
6. 补齐 Feed、Community、Creator Profile/levels/Studio、Pack 收益、Dreamcoin/现金激励、Remix/Like/Follow/Share/Report、Affiliate RevShare/CPA/归因/佣金、Images/Videos/Glossary/Authors、SEO/Library/Article/Comparison 和 Support 的真实数据、副作用、权限与发布证据；分期受依赖和资源约束，不受 WSCU 或同角色留存 Gate 约束。
7. 保持 Chat 历史、Scene、official igrep memory、记忆控制、编辑/重生成、明确 Product Action 真实交付和角色身份连续性；补 Pinned Memories、Custom Instructions、conversation controls、5 档或功能等价 profiles、最多 12 角色 Group Chat 和双向 Voice Call。这些是完整 Chat 体验的能力，不是其他产品范围的 Gate。
8. 保持 Upgrade/Profile 的一次性预付、`benefitsEndAt`、重新购买、no-renewal 与既有历史/媒体不锁回承诺；补真实 provider checkout→activation→expiry→repurchase probe。另补独立 dreamcoin coin store 的 offer→quote→one-time checkout→provider confirmation→幂等 topup ledger→购买历史闭环，充值不得创建、延长或续订访问计划。
9. WPCU 保持 `official`；WSCU/WSCrU/WPSCU/WSR 保持 shadow/directional 诊断。补生产回放、成熟窗口和质量认证，但不执行指标 cutover。

退出条件：parity matrix 中每个目标域都有明确状态、真实产品能力与同 revision 浏览器/运行证据；所有公开声明与当前实现状态一致；指标保持 WPCU official 与其他诊断指标的正确层级。

## 2. 执行数据库 cutover

以下动作由用户/CI在受控维护窗执行：

1. 备份 Main PostgreSQL、旧 Chat schema、Blob、`CHAT_FS_ROOT` 和 DSH workspace。
2. pause 新 Turn admission、Chat、Gen/finalizer，确认没有 active attempt 或未知 terminal。
3. 部署 Main migration `20260827120000_main_chat_turn_authority`。
4. 执行 `db/sql/2026-08-27-chat-turns-to-main.sql`。
5. 对账 session、Turn、selected reply、attachment、Scene、usage/billing 引用的数量与哈希。
6. 以新 Main history/BFF 启动；旧 Chat schema 保持只读观察。
7. 观察期后再单独批准旧 schema/roles 的不可逆删除。

## 3. cutover 后清理迁移兼容面

- production cutover 对账通过后再清理不再可恢复的旧 runtime trace；本轮不做不可逆删除。
- recovery producer/executor/launch gate 已升级为 schema 2；下一目标 revision 必须生成并核准一份新的 Main PG + AgentRun + DSH canonical/private + Blob + queue receipt bundle，历史 schema-1 bundle 只保留历史证据。

这些代码在实际 cutover 前保留是迁移保险；cutover 后继续长期保留才是结构债。

## 4. 目标 revision 的完整再验证

历史闭环证据见 `CURRENT_FUNCTIONAL_COVERAGE.md`；任何产品/代码切换后，目标 revision 仍必须重新覆盖：

- 创建会话、发消息、刷新恢复、编辑、重生成、取消。
- terminal exact replay；冲突 replay/旧 attempt 被拒。
- Chat 重启、SSE 重连、Main ACK fence、normal/private memory。
- 图片 create/edit ToolEffect、同 call replay、参数冲突、当前 attempt 附件过滤。
- Generation 成功 settle；失败/取消 refund；UI 与 ledger 一致。
- 账号删除对 Main Turn、Blob、AgentRun、DSH workspace 的顺序和幂等 completion。

记录实际 provider/model、request/attempt/artifact/delivery/settlement、耗时和费用。mock 或静态页面不替代真实链路证据。

## 5. 发布门

- PM2 实际进程、端口和 full readiness，不以 `online` 代替。
- 生产 domain/secret/Redis/BullMQ prefix/Blob/provider/Sentry 全部绑定同一 source revision。
- 在生产数据上重新执行备份与隔离恢复；旧本地 bundle 只算历史证据。
- 完整 authenticated Chrome 用户/运营旅程与观察窗通过后，再判断 public Go/No-Go。

## 完成定义

1. Main 是产品 Turn、附件、Scene、计费和展示的唯一权威。
2. Chat 只有 AgentRun/DSH 派生数据，没有数据库、queue、余额或产品消息副本。
3. 生成工具的 reserve/settle/refund 在 Main durable state machine 中幂等闭环。
4. 迁移专用兼容面在实际 cutover 后删除，文档、env、readiness 与运行拓扑一致。
5. 同一 revision 的 test/typecheck/build/lint、真实进程和产品 E2E 证据全部通过。
