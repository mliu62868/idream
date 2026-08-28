# iDream 剩余工作执行计划

更新日期：2026-08-28

本文件只保留尚未完成的工作。已完成能力与历史运行证据见 `CURRENT_FUNCTIONAL_COVERAGE.md`。

## 当前状态

- 代码已把 Companion Chat 产品权威迁到 Main PostgreSQL：`RecentChat`、`ChatTurn`、`ChatTurnAttachment`。
- `packages/chat` 已移除 Prisma/PostgreSQL/BullMQ，使用本地 AgentRun；`packages/chat-agent` 执行 DSH/igrep。
- 图片 ToolEffect 已进入 Main Generation/Ledger，不采用成功后普通 hook 扣费。
- Main migration 和旧 Chat 数据导入脚本已经存在，但本仓库修改不会替用户连接生产库执行。
- 当前工作树同时包含大规模 Character/Admin 重构；它造成 shared/main 全门禁仍未恢复，不能把 Chat isolated green 写成全仓完成。

## 1. 先完成当前 Character/Admin 合并

1. 修复 shared admin contract 的 permission/schema 漂移。
2. 完成 Character Project/Release 简化 migration 和相关 API/UI 测试。
3. 跑 shared、main、admin 的 focused tests，再跑全包 typecheck/test/build/lint。

退出条件：没有依赖旧 Character contract 的编译或测试失败；每个可聊天角色都有 immutable content pin。

## 2. 执行数据库 cutover

以下动作由用户/CI在受控维护窗执行：

1. 备份 Main PostgreSQL、旧 Chat schema、Blob、`CHAT_FS_ROOT` 和 DSH workspace。
2. pause 新 Turn admission、Chat、Gen/finalizer，确认没有 active attempt 或未知 terminal。
3. 部署 Main migration `20260827120000_main_chat_turn_authority`。
4. 执行 `db/sql/2026-08-27-chat-turns-to-main.sql`。
5. 对账 session、Turn、selected reply、attachment、Scene、usage/billing 引用的数量与哈希。
6. 以新 Main history/BFF 启动；旧 Chat schema 保持只读观察。
7. 观察期后再单独批准旧 schema/roles 的不可逆删除。

## 3. 清理迁移专用代码

- cutover 对账通过后运行 `chat:purge-legacy-session-traces`，清理不再可恢复的旧 runtime trace。
- 确认 production 不再需要 relationship workspace rebuild/cutover 兼容协议后，将该迁移 sidecar surface 与测试整组删除。
- 删除只服务于旧 Chat PG recovery bundle 的 schema/role/inbox/file-mutation检查，更新 recovery producer/launch gate 为 Main PG + AgentRun + DSH + Blob。

这些代码在实际 cutover 前保留是迁移保险；cutover 后继续长期保留才是结构债。

## 4. 当前 revision 的完整验证

最小闭环必须覆盖：

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
