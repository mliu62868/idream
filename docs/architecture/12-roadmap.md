# 12 · 实施路线图

更新日期：2026-08-28

本文件只记录当前可执行顺序。已完成范围和历史证据见 `CURRENT_FUNCTIONAL_COVERAGE.md`；产品优先级见 PRD/FeatureMap。

## 当前主链

```text
Character 内容与 Release 收口
  -> Main Chat Turn cutover
  -> 本地 AgentRun + DSH 稳定验证
  -> 图片/视频 ToolEffect 计费闭环
  -> 完整用户/运营 E2E
  -> production provider/envelope gate
```

## R1 · Character/Release 权威收口

- 完成当前 Character/Admin 合并中的 contract、migration、测试和 release/serving 一致性。
- 确保每个可聊天 Character 都有 immutable content version；已发布角色 pin 到 Release。
- 全仓 shared/main/admin typecheck 与测试恢复绿色。

退出：Character create → assets → review → draft → QA → Release → Serving 可运行，且 ChatSession 创建不能落到可变 persona fallback。

## R2 · Main Chat Turn cutover

- 用户/CI 应用 Main migration `20260827120000_main_chat_turn_authority`。
- 停止旧 Chat writer 后，由用户执行 `db/sql/2026-08-27-chat-turns-to-main.sql`。
- 比较 session、Turn、selected reply、attachment 数量和哈希；确认无 active/pending 旧执行。
- 运行观察期后，单独评审旧 `chat` schema/role 的物理删除；导入脚本不删除源数据。

退出：所有产品会话、消息、附件、Scene、额度和计费只从 Main 读写；运行环境无 Chat DB URL/role/queue。

## R3 · AgentRun/DSH 运行闭环

- 验证 admission、SSE 重连、取消、重生成、Chat 重启恢复和 terminal exact replay。
- 验证 Main ACK 前不发 `done`、不 ingest memory；终态后相同 idempotency key 不重跑模型。
- 完成账号删除对 AgentRun 和 DSH workspace 的精确 purge。
- 生产 cutover 后运行一次 legacy session trace purge，再移除迁移专用兼容代码。

退出：Chat 与 chat-agent isolated tests、typecheck、build 通过；本地真实进程 probe 绑定当前 source revision。

## R4 · 生成与计费

- 图片 ToolEffect：同 call replay 复用同一 Generation；参数漂移冲突。
- reserve/admit 在 Main durable ACK 之前；Delivery 成功 settle，失败/取消 refund。
- 当前 attempt 只展示自己的附件；旧 attempt 与内部 effect metadata 不泄漏。
- 视频工具仅在真实产品入口出现时复用同一端口，不预建通用 hook 框架。

退出：最低充分的真实图片生成记录 request/attempt/artifact/delivery/settlement、时延、成本和最终 UI 交付；异常重试不重复扣费。

## R5 · 发布验证

- 全包 test/typecheck/build/lint。
- Playwright 覆盖首聊、刷新历史、编辑、重生成、取消、图片工具、失败退款、删除和恢复。
- PM2 readiness 验证 Main/Admin/Chat/chat-agent/Gen/finalizer 的实际进程与端口。
- production 再验证真实 domain、secret、Redis、Blob、provider、Sentry、备份恢复和观察窗。

本地受控 beta 通过不等于公开生产批准；最终结论必须绑定同一 source revision 和同一环境证据。

## 明确不做

- 不恢复 Chat PostgreSQL、Prisma、BullMQ 或产品消息文件数据库。
- 不让 Chat 复制余额、entitlement、Generation ledger 或附件权威。
- 不以历史报告、mock、静态页面或 PM2 `online` 代替当前 revision 的运行证明。
- 不在当前没有第二个真实消费者时抽象通用 billing hook。
