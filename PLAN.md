# 实施计划：Chat Service 拆分

> 本文是**执行计划**（做什么、什么顺序、验收标准）。架构与设计细节见 `docs/architecture/14-chat-service-tech-design.md`（how）与 `docs/product/CHAT_SERVICE_PRD.md`（what）。本文不重复 rationale，只指导落地。

## 1. 一屏架构

**拆分依据**：按执行时间分级——`main` 快（毫秒同步），`chat`/`gen` 慢（秒级生成）；慢负载从快 web 剥离，三者**只用异步任务 + 事件**交互。

**6 个进程**（pm2 管理）：`main-web`(cluster) · `chat`(单进程, **instances:1**) · `gen-image` · `gen-video` · `gen-finalizer` · `main-event-consumer`

**4 个 package**（pnpm workspaces + Turborepo）：`@idream/shared`（契约 SSoT）· `main`（core/billing 权威）· `chat`（chat_service role + 本地文件）· `gen`（只写 blob）

**三层存储，各有唯一权威（SSoT）**：
- PG `chat.*` —— 账本（messages/usage/moderation/outbox/inbox + session 状态/滚动摘要）
- 本地文件 `sessions/{u}/{s}.jsonl` —— agent 执行轨迹（append-only）
- 本地文件 `mem/{u}/{c}/*.md` —— 长期记忆/关系（从 session.jsonl 派生）

**贯穿规则**：可变/高频/跨租户查/是钱→PG；agent 直读/低频/按租户分区→文件；同一事实只一个 canonical，永不双写。

## 2. 阶段与验收

> 规则：**数据库 schema/role/view/migration SQL 由用户执行**，AI 只产出脚本。每阶段结束跑该阶段验收 + 不回归既有测试。

### P0 — 让拆分可运行

| 阶段 | 交付物 | 验收 |
|------|--------|------|
| **P0-1 边界** | ① `chat` schema 目标表（sessions/messages/message_versions/chat_usage/moderation_events/outbox_events/inbox_events，**不含** companion_memories/relationship_states）② 4 只读 view DDL（PRD §5）③ 3 role + grant 脚本（设计 §2）④ chat Prisma（multiSchema + view block）⑤ 负向权限测试 | `chat_service` 写 `core.*` / 写视图 均被 DB 拒绝；chat Prisma 正常 generate |
| **P0-2 抽服务** | ① pnpm workspaces + Turborepo ② `@idream/shared`：事件/payload/队列名/幂等键 schema ③ 现单体 app → `packages/main` ④ `packages/chat`（单进程入口起 web+worker）⑤ `packages/gen` ⑥ main-web BFF 反代 `/api/v1/chat/*` + HMAC 签名 ⑦ `ecosystem.config.js` | `pm2 start` 起全部 6 进程；主站不再写 chat 表 |
| **P0-3 热路径** | ① `chat/web` 发消息：单事务落 user+placeholder → 入队 → 返回 streamUrl ② 删同步 `drainLocalAiPipeline` ③ `chat/worker` 常驻消费 `chat.generate`：构上下文→模型流→Redis Stream→输出审核→**幂等** finalize 事务 ④ `policy resolver`（SSoT）⑤ SSE `XREAD BLOCK` + `Last-Event-ID` ⑥ regenerate 幂等键带 `:attempt` | 刷新/断流不丢最终消息；regenerate 不被去重吞 |
| **P0-4 可靠** | ① `chat_outbox_events` + `chat.outbox.deliver` → `main.inbound` → `main-event-consumer` ② `chat_inbox_events` + `chat.inbox.consume` ← `main.outbox` ③ `chat.reconcile`（扫 stuck `generating` + pending outbox/inbox） | 杀 chat 进程后消息可恢复；outbox 重投；下架 character 经 inbox 阻断新消息 |
| **P0-5 文件层** | ① `chat-fs.ts`（appendLine/writeAtomic/listPrefix/deletePrefix）② `chat.generate` 写 `session.jsonl` ③ `chat.maintain`（滚动/压缩/TTL，设计 §9-D3）④ 隐私删除跨 PG+文件 | 删会话清 jsonl；删账号清 `sessions/{u}/`+`mem/{u}/`+PG 行 |

### P1 — 记忆质量与控制

| 阶段 | 交付物 | 验收 |
|------|--------|------|
| **P1-1 记忆派生** | `chat.memory.extract`：读 session.jsonl + **回查 PG 状态** → `canMemorize` → 写 `mem/*.md`；`retrieveMemories`（文件解析 + recency）；构上下文读记忆文件（超时降级）；no-memory 检索门 | 删记忆后上下文不含；**不从 blocked/no-memory 派生** |
| **P1-2 关系 + igrep** | `relationship.md` 派生；igrep 索引 `mem/`+`sessions/`；`retrieveMemories` 内部换 igrep 语义检索（带超时退化）；历史对话检索 | 记忆召回相关性提升；调用方不变 |
| **P1-3 账号导出** | 跨 PG + 文件 + igrep 聚合导出 messages/memories/relationship（PRD §12） | 导出含三处数据 |
| **P1-4 清理** | 删旧 `ai.chat.generate → app.ai.finalize(chat.completed)`；保留 image/video finalize | 旧路径无引用 |

**P0 范围外（延后，非遗漏）**：group chat、voice、记忆向量检索（pgvector）、`chat_stream_events` DB replay 表。

## 3. 贯穿约定

- **契约 SSoT**：事件名/payload schema/队列名/幂等键格式只在 `@idream/shared` 定义，两侧 import。
- **幂等键**：`chat-generate:<amid>:<attempt>` · `chat-outbox:<eventId>` · `chat-inbox:<eventId>` · `chat-memory-extract:<amid>:<attempt>` · `chat-session-append:<amid>:<attempt>` · `generation:<jobId>` · `generation-finalize:<jobId>:<state>`
- **数据边界**：`chat_service` role 只读 core view、读写 `chat.*`，**无** core/billing/compliance 写权——靠 DB role 强约束，每阶段保留负向测试。
- **BFF 签名**：HMAC 覆盖 `(userId, authTime, method, path, body-hash)` + 短 TTL + mTLS/私网；chat 侧仍复查 view（签名只证 authn）。

## 4. 风险与约束（须正视）

| 风险 | 状态 | 应对 |
|------|------|------|
| `chat` 单写节点、无 HA（本地 FS） | 已接受（D1） | 容量上限文档化；扩容前改 `chat-fs.ts` 换共享存储，再拆 web/worker |
| igrep 0.1.x pre-1.0 喂记忆派生 | 受控 | P0 热路径**不依赖** igrep；P1 接入带超时 + 退化 |
| 跨 store（PG+文件）备份/恢复一致性 | 教义已定 | **PG 先恢复=存在集**；文件按 PG 对账：孤儿 GC、缺失记忆从 session.jsonl 重派生 |
| 两份治理文档冲突 | 已消解 | PRD §6.5/§6.6/§9 已改为文件层；本计划与设计 § 对齐 |

## 5. 完成定义（DoD）

- 每阶段：该阶段验收通过 + 既有测试不回归。
- 整体 P0：通过 PRD §14 测试矩阵（建会话→发消息→fake LLM token→断言 PG 落库→断言 mem/*.md 规则→删除后上下文不含）。
- 整体 P1：记忆跨会话生效、隐私删除彻底、no-memory 不留底。

## 6. 立即下一步

**P0-1 边界重构**。AI 产出：chat schema 目标 DDL + 4 view DDL + 3 role/grant 脚本 + chat Prisma + 负向权限测试。**SQL 交用户执行**，AI 跑 Prisma generate 与测试。
