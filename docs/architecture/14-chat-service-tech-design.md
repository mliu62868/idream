# 14. Chat Service 技术架构设计

更新日期：2026-07-31

> 本文是 `docs/product/CHAT_SERVICE_PRD.md`（产品/数据边界）和 `docs/research/SERVICE_INTEGRATION.md`（跨服务传输）的**落地技术设计**。
> PRD 定义 *what*，本文定义 *how*：服务拆分 → 物理拓扑、权限、热路径、可靠性、存储/记忆、事件 → 服务目录、服务间协议、进程管理。**拆分已落地**，本文是已实现的目标设计。

## 0. 决策记录（已拍板）

**为什么拆（第一性依据）**：按**执行时间 / SLA 分级**。主站 web 是**快**服务（毫秒级同步请求，面向用户页面，要低延迟高并发）；chat、image、video 是**慢**服务（秒级生成）。把慢的生成负载从快的 web 层剥离——否则慢生成会拖垮 web 的延迟和容量。三者之间**只用异步任务 + 事件**交互（job queue / outbox / inbox），**web 请求里绝不同步等生成**。下面所有边界、事件、队列设计都服务于这条。

| 决策 | 选择 | 影响 |
|------|------|------|
| 部署拓扑 | **现在就物理拆分**：独立 Chat Service（web + worker）部署 | Chat→Main 走 Chat outbox、Main→Chat 走 Main outbox + chat inbox（**两个 outbox**）；BFF 签名 day-1 上线；跨库无 FK |
| 记忆检索 | **按"谁读"分存**：账本(messages/usage/审核)入 Postgres，agent session.jsonl/记忆/关系/边界入**本地文件夹**（直接 fs 读写）+ igrep 索引 | 记忆权威=文件本身（agent 友好）；账本权威=PG（ACID/计费/查询）；同一事实只有一个 canonical；不做存储接口抽象（YAGNI），fs 读写集中在一个模块 |
| P0 第一刀 | **边界重构**：schema 隔离 + 双 role + 只读 view | 写权威成为 DB 层强约束，而非 code review 纪律；也是物理拆分前置 |

> 现状（as-built）：**拆分已落地**。Chat Service 是独立部署单元（`packages/chat`，pm2 `chat` 进程内同时起 HTTP/SSE + BullMQ worker），拥有自己的 `chat.*` schema 和两个数据库能力：`chat_service` 是请求/领域事务角色，只读 Main 的 core/billing/compliance 视图并创建 durable file intent；`chat_projector` 是独立文件投影角色，只有实际完成文件副作用后才能推进 mutation receipt。账本入 PG，记忆/会话日志入文件层（`packages/chat/src/chat-fs.ts`）。Main 不再同步 drain chat 生成；Chat ↔ Main 业务事件统一经 sender Outbox → HTTP durable ingest → receiver Inbox ACK，Redis 只承载 Chat 内部队列和 token Stream。

---

## 1. 物理拓扑

物理拆分，但**共用同一个 Postgres cluster**（用 schema + role 隔离写权威）。未来真要独立库再上 logical replication，协议不变。

```text
Browser
  └─ 同源 cookie → Main Site (Next.js)  ── 公开页/角色/billing/generation/library
                      │  /api/v1/chat/* 反代(BFF)：验 cookie，注入已签名内部用户上下文
                      ▼
                 Chat Service (单进程 chat = chat/web + chat/worker)
                      ├─ request pool, role = chat_service
                      │   ├─ chat/web: chat API + SSE；落 user msg/placeholder(PG TX) + 入队
                      │   ├─ 普通 worker domain/outbox/inbox/reconcile transaction
                      │   ├─ SELECT Main read-only views + normal chat tables
                      │   └─ INSERT durable file intent（不能标记 applied）
                      ├─ projector pool, role = chat_projector
                      │   └─ 执行 CHAT_FS_ROOT 副作用 → 完成/失败 mutation receipt
                      └─ Redis Stream: chat:stream:<assistantMessageId>

Postgres cluster (单实例, 多 schema)  ── 账本/事务/计费/查询
  core.*  billing.*  compliance.*   ← Main Site 拥有；对 chat 暴露只读 view
  chat.*                            ← Chat Service 拥有（会话/消息/usage/审核/outbox）

文件系统 (本地文件夹, CHAT_FS_ROOT；直接 fs 读写，集中在一个模块) ── agent 友好，igrep 索引
  sessions/{userId}/{sessionId}.jsonl  ← 完整 agent 执行轨迹（append-only，session.jsonl 权威）
  mem/{userId}/{charId}/memory.md   ← 长期记忆（从 PG 精确 turn 派生，记忆权威，非 PG）
  mem/{userId}/{charId}/relationship.md
  mem/{userId}/global/boundaries.md

Redis (Chat Service 专用, CHAT_REDIS_URL): BullMQ 内部队列 + token Stream
```

`CHAT_FS_ROOT` 是不可由 PostgreSQL 完整重建的权威层。运维 checkpoint 必须在静默写入后同时捕获 Main PostgreSQL、`CHAT_FS_ROOT` 与 local Blob（或远端版本化 object inventory），并以目录 manifest/checksum 做隔离恢复；数据库单项 dump 不是完整 Chat 恢复证据。

2026-07-18 最终 controlled-beta checkpoint 已执行该合同：artifact base 为 `/Users/kk/code/idream/local-backups/idream-main-final-20260718-60/idream-main-final-20260718-60`，bundle 目录 `0700`、23 files 全部 `0600`、171M，SHA checks 全部通过。源端 Chat 为 294 sessions / 818 messages / 4 attachments、outbox `1,552` / inbox `488`（pending/failed 均为 `0`）、file mutations `5`（pending `0`）；`CHAT_FS_ROOT` 为 429 files / 550,987 bytes。隔离恢复后的 Chat FS 与源端逐文件比较为 `0` difference，且与 Main DB、Blob 的 counts/schema/logical/目录比较一起全部 equal；恢复后 Chat health 为 `ok`。这证明当前本地 checkpoint 可恢复，不替代 public production Gate。

**部署单元**（完整 6 进程见 §10 服务目录）
- `main-web`：主站，含 `/api/v1/chat/*` BFF 反代（只验签 + 转发，不拼 prompt、不写 chat 表）。
- `chat`：**单进程**，进程内同时起 `chat/web`（chat API + SSE）和 `chat/worker`（消费 `chat.generate` 生成+落账本+**写 session.jsonl** / `chat.memory.extract` / `chat.outbox.deliver` / `chat.inbox.consume` / `chat.reconcile` / `chat.maintain`）。写本地文件 ⇒ `instances:1`。
- `main-event-consumer`：主站消费 Chat outbox 投递的事件，更新 library/stats/analytics/safety。
- **入站通路**：主站权威变更写主站自己的 outbox → 投递到 `chat.chat_inbox_events` → `chat.inbox.consume` 消费（缓存失效/阻断/删除）。所以是**两个 outbox**，不是"唯一通路"。

**代码组织**：monorepo packages（pnpm workspaces + Turborepo）——`packages/{shared,main,chat,gen}`，强模块边界 + 独立依赖树 + 清晰归属，为长期可维护。详见 §10。**不**拆独立 repo（单 CI、共享契约 `@idream/shared`）。

---

## 2. 权限模型（P0 第一刀）

物理拆分后有两个运行时 role。四类 role 分工：

| Role | 用途 | 权限 |
|------|------|------|
| `core_owner` | 主站迁移 | core/billing/compliance 全权 + 建只读 view + GRANT |
| `chat_owner` | chat 迁移 | `chat` schema DDL（建表/索引/迁移） |
| `chat_service` | 请求/领域事务运行时 | SELECT on Main read views；普通 `chat.*` domain transaction；对 `chat_file_mutations` 仅 SELECT + intent columns INSERT；不能直接完成/删除 intent，账户擦除只走校验 canonical intent 的窄函数；**无** Main base-table 写权 |
| `chat_projector` | durable file projector | 使用独立连接；普通 `chat.*` 投影事务，对 `chat_file_mutations` 仅 SELECT/UPDATE，不能直接 INSERT/DELETE；trigger 只允许合法 pending → applied/failed，擦除只走窄函数 |

```sql
-- 由 core_owner 执行（主站迁移）：建 schema、view、授权
CREATE SCHEMA IF NOT EXISTS chat AUTHORIZATION chat_owner;

GRANT SELECT ON core.chat_user_view              TO chat_service;
GRANT SELECT ON core.chat_character_view         TO chat_service;
GRANT SELECT ON billing.chat_entitlement_view    TO chat_service;
GRANT SELECT ON compliance.chat_user_eligibility_view TO chat_service;

-- 完整 grant/revoke 顺序以 db/sql/04_grants.sql 为准：
-- chat_service 可写普通 domain 表，但对 file ledger 只可读并插入 intent columns。
-- chat_projector 使用独立连接完成 file ledger UPDATE；直接 INSERT/DELETE 被拒，
-- 账户擦除只能调用校验 canonical intent 的 SECURITY DEFINER 窄函数。
```

> **数据库 SQL 由你执行**（schema 变更红线）。本文只给脚本。view DDL 见 PRD §5。

**Prisma 形态**：Main 与 Chat 两套独立 schema/client；Chat 同一 generated client shape 建两个连接池。
- 主站 Prisma：core/billing/compliance + view 定义 + outbox 消费侧读模型。
- Chat Service request Prisma：`chat.*` 模型 + Main views，连接串使用 `CHAT_DATABASE_URL` / `chat_service`。
- Chat file-projector Prisma：同一模型 shape，但连接串使用 `CHAT_PROJECTOR_DATABASE_URL` / `chat_projector`；仅由 projector seam 调用。

```prisma
// packages/chat/prisma/schema.prisma（节选）
datasource db { provider = "postgresql"; schemas = ["chat","core","billing","compliance"] }
generator client { provider = "prisma-client-js"; previewFeatures = ["multiSchema","views"] }

view ChatUserView { user_id String @id ... @@schema("core") @@map("chat_user_view") }
model ChatSession  { id String @id ... @@schema("chat") @@map("chat_sessions") }
```

**验收测试（负向，P0 必须）**：除拒绝 `chat_service` 写 Main base table/read-only view 外，还必须拒绝请求角色完成/删除 intent、注入 sequence、修改 applied receipt，以及 projector 插入/删除 intent、越权 purge 或非法 lifecycle transition。2026-07-18 当前目标库已通过正向能力路径和 15 项负向拒绝检查；这道 migration-applied 测试是“边界有牙齿”的证明。

---

## 3. 热路径（取代同步 drain）

照 PRD §9，关键修正三处现状隐患：

1. **user msg + assistant placeholder 入同一事务**（现状两条 insert 不在事务内）。
2. **删掉同步 `drainLocalAiPipeline`**，换 `chat/worker`（同进程常驻 BullMQ 消费者）消费 `chat.generate`。
3. **finalize 按 message status 幂等**：assistant 已 `sent`/`blocked` → 幂等返回，不重复计 usage、不重复建 selected version。

```text
POST /api/v1/chat/sessions/:id/messages
  1. 验 BFF 签名：HMAC 覆盖 (userId, authTime, method, path, body-hash) → 请求绑定，短 TTL；
     传输层 mTLS/私网（签名只证 authn，authz 仍复查）
  2. 复查只读 view：user active? eligibility? entitlement? character 可读/成人/未下架?
     （不信任 BFF header，必复查 —— PRD §8.1）
  3. usage / rate limit（chat_service 本地判定；entitlement.unlimited_messages 短路；
     超额 → 拒绝，不入队）
  4. 输入审核
  5. TX（user + session advisory locks）: 原子校验 quota/rate reservation；
     insert user msg(sent) + insert assistant(pending, reply_to_message_id=<user>) + update session.last_message_at
  6. best-effort enqueue chat.generate(dedupeKey = chat-generate:<assistantMessageId>:<attempt>)；
     commit/enqueue 间崩溃或 Redis 暂不可用时，pending 行就是 durable intent，reconciler 补投
  7. 返回 { assistantMessageId, streamUrl }

chat/worker / chat.generate
  8. 原子转 pending→generating 并持有 generation lease（流式期间每 30s heartbeat）；构建上下文：
     recent msgs(PG，消息数+字符双预算) + session.memory_summary(PG) + persona(view) + policy(entitlement)
     + 若 session.memory_enabled：读记忆文件(boundaries 全量 + 结构化 top-K)
       —— 有超时预算，超时/出错 → 退化为"仅 recent msgs"，不阻断生成（见 §5 热路径降级）
     —— memory_enabled=false（no-memory/incognito）：完全不读长期记忆
  9. 调模型，token → Redis Stream(XADD)
 10. 输出审核
 11. TX(幂等, 只账本): update assistant(sent) + selected message_version + chat_usage++
                + session.memory_summary(会话滚动摘要,留 PG) + moderation_events + outbox_events
 12. finalize 成功后 SSE done；session.jsonl trace best-effort append（诊断事实，不反向破坏已提交账本）
 13. enqueue chat.memory.extract（异步：按 reply_to_message_id 精确回查 PG message 状态，
     派生记忆/关系写文件层）；message.memory_extracted_attempt 是 durable 水位，reconciler 补投遗漏任务
 14. chat.outbox.deliver 异步投递主站
```

> **regenerate**（`POST /messages/:id/regenerate`）：dedupeKey 必须带 attempt（`chat-generate:<assistantMessageId>:<attempt>`），否则同一 assistant message 重生成会被去重吞掉（**原 `:<assistantMessageId>` 是 bug**）。每次 regenerate 追加新 `message_versions`、翻转 `selected`、按 entitlement 决定是否再计 usage、session.jsonl 追加一轮。

**policy resolver（SSoT）**：`resolvePolicy(entitlement) → { model, maxContextMessages, maxMemories, rateLimit, voiceEnabled }`。热路径与 worker 共用一处，不散落。

---

## 4. 可靠性

物理拆分后，**Chat→Main 的副作用走 Chat outbox**（同事务写 `chat.chat_outbox_events`，再由 `chat.outbox.deliver` 投递）——这是"DB 已提交但事件没发"的防线。**Main→Chat 对称**：主站写自己的 outbox → `chat.chat_inbox_events` → `chat.inbox.consume`。

**幂等键**（队列名 + 键格式以 `@idream/shared` 为 SSoT，两侧对齐；统一 `chat-` 前缀）
```text
chat-generate:<assistantMessageId>:<attempt>     # 带 attempt，支持 regenerate
chat-outbox:<eventId>
chat-inbox:<eventId>
chat-memory-extract:<assistantMessageId>:<attempt>
chat-session-append:<assistantMessageId>:<attempt>
```

**reconciler（P0 必需）**：`chat.reconcile` 周期任务
- 扫未投递的 `pending` assistant message → 按确定性 job id 补投；同 id failed job 原地 revive。
- 扫长时间未 heartbeat 的 `generating` assistant message，以 attempt/status/lease compare-and-update → 标 `failed`。
- 扫 `sent` 且 `memory_extracted_attempt < attempt` 的消息 → 补投幂等 memory.extract。
- 扫已完成但 `outbox.status=pending` / `inbox.status=pending` 的事件 → 重投/重消费。

**SSE 硬化**：`XREAD BLOCK` + `Last-Event-ID` 断点续读（取代现状 150ms 轮询/30s 超时，`src/server/ai/stream-store.ts`）；Stream 设 `MAXLEN`/TTL 自动裁剪；过期则前端退化拉 `GET /sessions/:id` 已落库消息。

---

## 5. 存储分层：账本入 PG，记忆入文件 + igrep（多租户 SaaS）

**核心原则——按"谁来读"切分**：

| 维度 | 谁读 | 放哪 | 为什么 |
|------|------|------|--------|
| sessions(状态/标题/last_message_at)、messages、message_versions、`chat_usage`、moderation、outbox、`session.memory_summary`(滚动摘要) | **系统**（事务/计费/查询/reconciler/审计） | **Postgres `chat.*`** | 要 ACID、不重复计费、可 SQL 查询、`chat_service` DB-role 边界、可证明删除 |
| agent session.jsonl、长期记忆、关系叙事、全局边界 | **agent**（续上下文/构上下文/语义检索） | **本地文件夹（直接 fs）+ igrep 索引** | agent 想 `cat`/append 不想 `SELECT`；可读/可 diff/可被 igrep 原生检索 |

> **记忆的权威 = 文件本身**（不是 PG 渲染出文件——那样 PG+文件+索引三处，更复杂）。这才兑现"agent 友好 + 简单"。`companion_memories` / `relationship_states` 两张 PG 表**退役**，迁到文件层。
>
> ⚠️ **本节 supersede PRD**：PRD §6.5/§6.6 把 memory/relationship 定义为 PG 表、PRD §9 step 12 把它们写进 finalize 事务——这两点以本文为准（改为文件层、移出 PG 事务）。需同步回改 PRD，否则两份文档对 finalize 事务的描述冲突。

**为什么 messages 不跟着进文件、也不双写**（贯穿全设计的 SSoT 规则）：

| | messages | 长期记忆 |
|---|---|---|
| 写频率 | 高频，热路径每轮 | 低频，异步派生 |
| 可变状态 | 有：pending→generating→sent、partial→final，SSE 期间并发改 | 基本只增改，无 in-flight |
| 跨租户查询 | reconciler 扫"卡住的 generating"、按 last_message_at 列会话 | 无，按 (user,char) 天然分区 |
| 是不是钱 | 是：usage 由 messages 派生 | 不是 |

→ messages 的访问模式要 **ACID + 索引 + 事务**，正是 PG 的活；放文件要自己造锁、造事务、全盘扫描，更复杂。**所以 messages 权威留 PG。**

把"同一份**用户可见消息**在 PG 和文件都当权威"= 双写漂移，违反 SSoT。但 `session.jsonl` 不是这种双写——它是**另一个事实**。

**三层记录，各有唯一权威**

| 层 | 是什么事实 | 权威在 | 读者 |
|---|---|---|---|
| PG `chat.messages` | **用户看到什么**：user 输入 + 最终 assistant 回复 + status/usage/safety | Postgres | UI 渲染、计费、审核、reconciler |
| `sessions/{user}/{session}.jsonl` | **agent 做了什么**：system prompt、注入了哪些记忆、tool 调用/结果、raw model 输出、候选、耗时 | 本地文件 | replay、可观测、故障诊断 |
| `mem/*.md` | **该长期记住什么**：从 PG 中 reply_to_message_id 指定的精确 turn 派生 + 过 `canMemorize` 的记忆/关系 | 本地文件 | 构上下文 |

- **谁写 session.jsonl**：`chat.generate` 进程**自己 append**（step 12，它已持有完整执行上下文）——**不是单独的 worker**。append-only，一会话一文件 `sessions/{userId}/{sessionId}.jsonl`，igrep `mem ingest` 正好吃 JSONL。
- **不算违 SSoT**：三者是三个不同的事实（"看到什么"/"做了什么"/"记住什么"），各有唯一 canonical。唯一重叠的是"最终回复文本"——它在 session.jsonl 里只是自包含的一份原始拷贝（含 raw/候选，可能与 PG 的 user-visible 版本不同），**用户可见版本一律以 PG 为准**（UI/计费/审核只认 PG）。
- **派生记忆的隐私铁律**：`chat.memory.extract` 按 assistant 的 `reply_to_message_id` 精确读取 PG user/assistant turn，并由 **PG message 的 `status`/`safety_status`**执行 `canMemorize`。session.jsonl 仅是 best-effort 诊断轨迹，缺失或 append 失败不能阻断记忆派生；每条记忆必须带 `source_message_ids` 回链 PG。
- **删除**：会话/账号删除必须连 `sessions/...jsonl` 一起清（见隐私删除）。

**一句话规则**：可变/高频/要跨租户查/是钱 → PG 权威；agent 直读/低频/按租户分区/叙事 → 文件权威；**同一事实只能有一个 canonical**，其余单向派生，永不双写。

**文件布局**（**本地文件夹**，按租户分区。直接 fs 读写，所有读写集中在一个 `chat-fs.ts` 模块——不做接口抽象；未来若换共享存储/S3，只改这一个模块）
```text
CHAT_FS_ROOT/
  sessions/{userId}/{sessionId}.jsonl     # agent 执行轨迹：append-only，单写者(chat.generate)
  mem/{userId}/{charId}/memory.md      # 长期记忆：每条 front-matter(type/scope/confidence/source_message_ids/status)
  mem/{userId}/{charId}/relationship.md# 关系：front-matter(stage/signals/version) + 叙事 summary
  mem/{userId}/global/boundaries.md    # 全局边界（最高优先级）
```

`chat-fs.ts` 提供几个直接的 fs 函数（**不是抽象接口**）：`appendLine` / `readFile` / `writeAtomic`（临时文件 + rename）/ `listPrefix` / `deletePrefix`。本地 FS 天然支持：append 用 `O_APPEND`，整文件改写用原子 rename。集中在一处，纯为将来好改，不为现在加抽象层。

**igrep-tme 的角色**（版本固定在 lockfile；注意 0.1.x pre-1.0，喂记忆派生的路径要容忍其行为变化，故 P0 不依赖、P1 带退化）
1. **检索索引**：索引 `mem/` 前缀，构上下文时 `igrep recall` / `mem-api memory-search` 取最相关记忆。索引可重建，丢了从文件重灌。
2. **离线派生**：`chat.memory.extract` worker 从 PG 精确 turn 提炼候选，用 igrep `mem derive`/`consolidate`（observation 模型 source-linked，正对 `source_message_ids`）合并 → 过 `canMemorize` 守卫 → 写入 memory 文件。派生移出热路径；诊断 trace 不参与可用性链路。
3. **知识 RAG**：角色 lore/世界设定（按角色数有界），igrep 语义检索。
4. **开发期 agent 记忆**：本项目跨会话记忆走 `igrep mem`（`.igrep/mem`，已初始化）。

**P0 检索（无向量）**：给定 (userId, characterId, scope)
```text
boundaries      → 全量注入（永不被相关度漏掉，最高优先级）
shared_event    → 按 session/character 取最近 N 条
user_fact/pref  → 按 character + recency + confidence 取 top maxMemories
```
检索这层留一个函数边界 `retrieveMemories(userId, charId, scope)`（不是存储抽象）。P0 走文件解析 + recency 排序；P1 内部换 igrep 语义检索，调用方不变。

**记忆守卫（SSoT）**：`canMemorize(source) → bool`，在 `chat.memory.extract` 入口统一拦截，**回查 PG message 状态**——blocked / deleted message / `memory_enabled=false` session 一律拒绝（PRD §7.2）。

**热路径降级（避免"记忆存储可用性 = chat 可用性"）**：构上下文读记忆文件有超时预算；超时/出错 → 退化为"仅 recent msgs(PG)"继续生成，不阻断回复。**P0 热路径只读本地文件（无 igrep 运行时依赖）**；igrep 检索是 P1，接入时同样带超时 + 退化。boundaries 文件每轮全量注入，进程内 LRU 缓存（按 updated_at 失效）避免每条消息一次磁盘读。

**一致性边界（诚实说明）**：两个存储 = 两套一致性。但分界干净——**钱/账本在 PG（强一致），轨迹/记忆在文件（最终一致）**。文件写异步、低频、丢最后一次可恢复（不是钱），可接受。并发：同一 session 的 session.jsonl 由单一 `chat.generate` 写者 append（不靠跨写者的 `O_APPEND` 原子性，单行可能 KB 级超过原子上限）；memory.md 整文件改写用原子 rename，同一 (user,char) 的派生串行（一个 `chat.memory.extract` 分区键）避免并发覆盖。

> ⚠️ **本地 FS 的硬约束（C1，已由 D1 定）**：本地文件夹是**节点本地**的。若写文件的进程扩到多节点，A 节点写的 `mem/` 文件 B 节点读不到 → 记忆会"随机消失"。所以**本地 FS ⇒ `chat` 进程 `instances:1`（单写）**，扩容前须先换共享存储（改 `chat-fs.ts` 一处）。详见 §9-D1。

**隐私删除**（PRD §12）：删消息→PG hard-delete；删记忆→改写/删 `mem/.../memory.md`；删会话→删 `sessions/{userId}/{sessionId}.jsonl`；删账号→删 `sessions/{userId}/` + `mem/{userId}/` 整个前缀 + PG 行 + igrep 重建索引。**删除落在权威层（文件/PG），再触发 igrep 重索引**，绝不只删索引。

---

## 6. 跨服务事件契约

**Chat → 主站**（Chat outbox，至少一次，消费者按 eventId 幂等）
`chat.session.created` `chat.message.completed` `chat.message.blocked` `chat.session.deleted` `chat.memory.updated` `chat.relationship.updated` `chat.usage.incremented` `chat.safety.flagged` `chat.account_erasure.completed`

> 相对 PRD §11.2 **故意不发** `chat.message.created`（主站只需 completed/blocked；每条 user 消息发事件无价值）。如有消费者依赖，再补。

**主站 → Chat**（Main outbox → `chat.chat_inbox_events` → `chat.inbox.consume`；缓存失效/阻断/补偿，非权威来源——权威仍读 view）
`user.suspended` `user.deleted` `character.updated` `character.removed` `character.visibility_changed` `entitlement.updated` `age_eligibility.updated` `policy.updated`

契约类型 + **队列名 + 幂等键格式**都以 `@idream/shared` 为 SSoT，两侧共享，避免漂移。

---

## 7. 落地路线

**P0 拆分已全部落地**。各阶段技术细节见：§2 权限、§3 热路径、§4 可靠性、§5 存储、§6 事件、§10–12 服务编排。

历史执行顺序：**P0-1 边界 → P0-2 抽服务 → P0-3 热路径 → P0-4 可靠 → P0-5 文件层 → P1 记忆/关系/导出/清理**（均已完成）。

**明确 P0 范围外（延后，非遗漏）**：group chat、voice call、记忆向量检索（pgvector/igrep 语义）、`chat_stream_events` DB replay 表（P0 仅 Redis Stream + `MAXLEN`/TTL）。

---

## 8. 配置

```env
# main-web
CHAT_SERVICE_URL=https://chat.internal
CHAT_BFF_SIGNING_SECRET=...        # 与 chat 侧一致，签内部用户上下文
# chat（单进程：chat/web + chat/worker）
CHAT_DATABASE_URL=postgres://chat_service:...@.../app
CHAT_PROJECTOR_DATABASE_URL=postgres://chat_projector:...@.../app
CHAT_REDIS_URL=redis://...
CHAT_BFF_SIGNING_SECRET=...
CHAT_MODEL_PROVIDER=pipeline
BULLMQ_PREFIX=idream:chat:prod
# 文件层（本地文件夹；sessions/ + mem/ 的根；直接 fs，读写集中在 chat-fs.ts）
CHAT_FS_ROOT=./data/chat
# 记忆/知识检索（igrep-tme）—— chat/worker 通过 mem-api / igrep-mcp 调用，不在 TS 热路径 spawn CLI
IGREP_MEM_API_URL=...                 # JSON-RPC: memory-search/get/write/status
IGREP_KNOWLEDGE_ROOT=...              # 角色 lore / persona 知识包语料根
```

---

## 9. 复盘决策（已定）

| # | 决策 | 结论 |
|---|------|------|
| D1 | 本地 FS 与横向扩展（C1） | **已定：文件夹模式**（本地 FS，`chat` 进程 **instances:1 单写**，容量上限文档化）。chat 是慢异步层，单实例对当前吞吐够用。**不做 Store 接口抽象**（YAGNI）——fs 读写集中在 `chat-fs.ts`，将来要换共享存储改这一个模块即可。**约束**：仍用本地 FS 时**禁止**把 `chat` 扩多写实例（要扩先拆 web/worker + 换共享存储）。 |
| D2 | PRD 同步 | **已更新** PRD §6.5/§6.6/§9-step12：memory/relationship 标为文件层、移出 finalize 事务。 |
| D3 | session.jsonl 保留策略 | 见下「session.jsonl 保留策略」。 |

### session.jsonl 保留策略（D3）

session.jsonl append-only 会无限增长，且含 raw/敏感内容——按"数据最小化 + 派生够用 + 可检索"分级：

1. **派生水位线**：`chat.memory.extract` 每成功处理一个权威 PG turn 就推进 `chat_sessions.log_extracted_seq`，用于观测派生进度；它不是 JSONL 行号，trace 裁剪不依赖该值。
2. **滚动压缩**：单会话 session.jsonl 超过阈值（如 5MB / 30 天）→ 滚动为 `sessions/{user}/{session}.{seq}.jsonl.gz`，活动文件保持小、append 快。
3. **TTL 硬过期**：原始 session.jsonl 最长保留（如 180 天）后**删除**——长期记忆已蒸馏进 `mem/*.md` 独立存活，删旧 session.jsonl 不丢记忆。法务 hold 例外。
4. **no-memory/incognito**：`memory_enabled=false` 会话**不落 session.jsonl**（或仅 ephemeral 短 TTL），既不派生也不留底，贴合隐私意图。
5. **隐私耦合**：会话/账号删除清掉**全部** session.jsonl 段（活动 + 归档 .gz）。
6. **执行者**：`chat.maintain` 周期任务做滚动/压缩/TTL + 清过期 Redis Stream；切对象存储后，TTL/分层可直接交给 bucket lifecycle，GC 逻辑不变。

---

## 10. 服务目录

按执行时间分级（§0）。`chat` 现在是**单进程**（HTTP/SSE + BullMQ worker 同进程），因写本地文件 ⇒ `instances:1`。

| 服务 | 层 | 职责 | 入口 | 实例 | 主要依赖 |
|------|----|------|------|------|----------|
| `main-web` | 快·同步 | 公开页/角色/billing/library/提交 generation/**chat BFF 反代** | Next.js | cluster(max) | PG(core/billing/compliance RW)、Redis、Blob 签 URL |
| `chat` | 快I/O + 慢生成 | **单进程**：`chat/web`(API+SSE+落 user msg/placeholder+入队) + `chat/worker`(chat.generate / memory.extract / file projector / outbox.deliver / inbox.consume / reconcile / maintain) | node | **1（写本地文件 ⇒ 单写节点!）** | PG(`chat_service` request + `chat_projector` projector)、Redis、**本地 fs(sessions/mem)**、igrep(P1)、LLM |
| `gen/image` | 慢·异步 | ai.image.generate → Blob（纯生成，无 DB 权威） | node | N 可扩 | Redis、Blob、图像模型 |
| `gen/video` | 慢·异步 | ai.video.generate → Blob（纯生成，无 DB 权威） | node | N 可扩 | Redis、Blob、视频模型 |
| `gen-finalizer` | 中·异步 | app.ai.finalize：输出审核 + 落 MediaAsset + 结算 dreamcoin | node | 1–2 | PG(core RW)、Redis、Blob |
| `main-event-consumer` | 中·异步 | 消费 chat→main 事件 → library/stats/analytics/safety | node | 1–2 | PG(core RW)、Redis |

> `gen-finalizer` 写 core/billing 权威表 → 归**主站侧**（`packages/main`），**不**进 `packages/gen`；`gen/image`、`gen/video` 只写 blob、payload 自包含，保持无 DB 权威、可任意扩。

**代码组织：monorepo packages（pnpm workspaces + Turborepo）**

强模块边界、独立依赖树、清晰归属——为长期可维护。各 package 独立 `package.json`/`tsconfig`，`@idream/shared` 被各服务 import。

```text
packages/
  shared/   → @idream/shared：contracts(事件/payload/队列名/幂等键 SSoT)、providers 接口、moderation、db helpers
  main/     → main-web (Next.js) + main-event-consumer + gen-finalizer   (core/billing 权威)
  chat/     → chat/web + chat/worker（单进程入口同起）、prisma-chat、chat-fs、memory   (request/projector 双 role + 本地文件)
  gen/      → gen/image + gen/video                                       (只写 blob，无 DB 权威)
```

- 依赖隔离：`gen` 不装 Next.js，`main` 不装图像 SDK——各 package 只装自己的依赖，部署产物天然瘦。
- 边界enforce：跨 package 只能走 `@idream/shared` 的公开契约，禁止 import 对方内部（workspace 边界 + eslint）。
- 当前单体 Next.js app 收进 `packages/main`（P0-2 做）。

> **为什么不拆 web/worker 两进程**：一个 Node 进程能同时跑 HTTP/SSE 和 BullMQ worker；生成是 I/O 密集（等模型流式 token），不堵事件循环。拆是扩容优化，非现在必需。代价：`chat` 整体 `instances:1`、HTTP 无 HA——当前阶段可接受。
> **逻辑边界仍保留为模块** `chat/web`、`chat/worker`：将来要给 HTTP 加 HA，把 `chat/worker`（写文件、单实例）与 `chat/web`（不写文件、可扩）拆成两进程即可，纯运维动作。`gen/image`、`gen/video` payload 自包含、不回查主站 DB，可任意扩。

---

## 11. 服务间协议

三类通道：**HTTP(同步、薄)** / **BullMQ（服务内部或 Main↔Gen 异步任务）** / **事务 Outbox → HTTP durable ingest → Inbox ACK（Main↔Chat 业务事件）**。媒体字节只走 Blob。原则：**web 请求里绝不同步等生成**；所有跨服务**至少一次 + 消费者幂等**；服务间**不共享可变表写权**。

| 交互 | 通道 | 方向 | 内容 | 幂等键 |
|------|------|------|------|--------|
| 页面/API | HTTPS + cookie | Browser ↔ main-web | — | — |
| 提交 chat 消息 | HTTP + BFF 签名头 | main-web → `chat/web` | sendMessage | PG message id |
| chat token 流 | SSE | `chat/web` → Browser | start/delta/done | `Last-Event-ID` |
| chat 生成 | BullMQ `chat.generate`（同进程入队/消费） | `chat/web` → `chat/worker` | {sessionId, assistantMessageId, attempt} | `chat-generate:<amid>:<attempt>` |
| **chat → main 事件** | Chat Outbox → HTTP `/api/internal/events/ingest` → Main Product Event receipt/Inbox ACK → 本地 projector | `chat/worker` → main | `chat.message.completed`/`usage.incremented`/`safety.flagged`… | `chat:<eventId>` |
| **main → chat 事件** | Main Outbox → HTTP `/internal/events/ingest` → `chat_inbox_events` ACK → receiver-local `chat.inbox.consume` | main → `chat/worker` | `user.suspended`/`character.removed`/Chat 图片回调… | `main:<eventId>` |
| 提交图片/视频生成 | BullMQ `ai.image.generate` / `ai.video.generate`（payload 自包含） | main-web → `gen/image`·`gen/video` | prompt/controls/seed/outputPrefix | `generation:<jobId>` |
| 生成完成回收 | BullMQ `app.ai.finalize` → `gen-finalizer` | `gen/image`·`gen/video` → main | generation.completed / failed | `generation-finalize:<jobId>:<state>` |
| 媒体交接 | Blob `putPrivate` / `signGetUrl` | worker → Blob → main 签发 | object key | — |

**契约 SSoT**：所有 payload schema + 队列名 + 幂等键格式放 `@idream/shared`，两侧 import 同一份。image/video 的 payload 细节沿用 `docs/research/SERVICE_INTEGRATION.md` §4/§6，本表只补 chat 侧并统一口径。

**协议不变量**
- chat：HTTP 立即返回 `{assistantMessageId, streamUrl}`，生成走 `chat.generate`；断线带 `Last-Event-ID` 续读，过期退化拉 PG。
- Main↔Chat：只有接收方持久化 receipt 后返回的 ACK 才算交付成功；本地 queue 只唤醒已持久化 Inbox，不是第二条跨服务通路。
- image/video：提交返回 `{jobId}`，前端**轮询** `GET /generation/jobs/:id`（无 SSE）。
- 失败：retryable 让 BullMQ 重试；耗尽 → 终态 finalize（退款/标记）。reconciler 兜底。
- 安全：worker 写 Blob 默认 private，仅 main 能签读 URL；chat 只读 core view，不写 core/billing/compliance。

---

## 12. 进程管理（pm2）

多服务用 pm2 统一启停。`ecosystem.config.js` 默认是开发模式：web 走
`next dev`（Fast Refresh），服务/worker 走 `tsx` node 入口并由 PM2 监听源码；
日常改代码不需要 build。设置 `IDREAM_PM2_MODE=production` 后，web 改为
Next standalone 不可变发布，服务/worker 继续源码直跑但关闭 watch：

```js
// ecosystem.config.js（节选；以实际文件为准）
const path = require("path");
const dir = (rel) => path.join(__dirname, rel);
module.exports = {
  apps: [
    // 快·同步层 — 开发默认 next dev；生产改为 standalone（以实际文件为准）
    { name: 'main-web',  cwd: dir('packages/main'), script: 'node_modules/next/dist/bin/next',
      args: 'dev', exec_mode: 'fork', instances: 1, env: { PORT: 3000 } },
    { name: 'admin-web', cwd: dir('packages/admin'), script: 'node_modules/next/dist/bin/next',
      args: 'dev', exec_mode: 'fork', instances: 1, env: { PORT: 3001 } },
    // chat：单进程 = HTTP/SSE + BullMQ worker 同进程；写本地文件 ⇒ instances:1
    { name: 'chat', cwd: dir('packages/chat'), script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/main.ts', exec_mode: 'fork', instances: 1 },  // ⚠️ 禁止 >1（本地 FS 单写节点）
    // 慢·异步层（gen：纯生成，只写 blob，可扩）
    { name: 'gen-image', cwd: dir('packages/gen'), script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/image.ts', exec_mode: 'fork', instances: 2 },
    // gen-video 延后，不在当前 PM2 拓扑中。
    // 中·异步层（主站侧权威写回 / 事件消费）
    { name: 'gen-finalizer',       cwd: dir('packages/main'), script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/processes/finalizer.ts', exec_mode: 'fork', instances: 1 },
    { name: 'main-event-consumer', cwd: dir('packages/main'), script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/processes/event-consumer.ts', exec_mode: 'fork', instances: 1 },
    { name: 'admin-command-worker', cwd: dir('packages/main'), script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/processes/admin-command-worker.ts', exec_mode: 'fork', instances: 1 },
    // 图片由 gen-image 的 workflow-native backend 直连 ComfyUI 8188；
    // 当前没有 sdcpp-image PM2 app 或 serve:sdcpp-image 脚本。
  ],
}
```

> ⚠️ script 指向真实 node 入口（`.cjs` / `tsx` 的 `cli.mjs`），**不能**指向 pnpm `.bin/*` shell shim——pm2 的 node 解释器无法解析 shim，且 cluster 模式要求可被 node 加载的脚本。
> 将来要给 chat HTTP 加 HA：把 `chat` 拆成 `chat-web`(cluster, 可扩) + `chat-worker`(fork, instances:1)——加一个 app、改个入口即可。

常用命令：
```bash
pm2 start ecosystem.config.js          # 全部启动
pm2 stop chat                           # 停 chat
pm2 restart main-web                    # 开发态重启并直接读取最新源码
pm2 restart chat                        # chat 单实例用 restart（有秒级空窗，可接受）
pm2 status / pm2 logs chat              # 状态 / 日志
pm2 save && pm2 startup                 # 开机自启
```

> 注：`chat` 是单实例（写本地文件），**不能** `reload`（cluster 才支持），只能 `restart`（有秒级生成空窗）；in-flight 那轮活在 Redis Stream + PG placeholder，重启后 reconciler 收敛，不丢消息。生产模式的 `main-web` 是 cluster，可 `reload` 零停机。
> `main-web` 只在 `IDREAM_PM2_MODE=production` 时是 cluster；默认开发态是
> 单实例 fork，由 Next dev 自己完成 HMR。模式切换会改变 PM2 进程定义，需要
> delete/start 一次；同一模式内的源码或启动配置变化只需 watch/HMR/restart。
