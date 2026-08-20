# 14. Chat Service 技术架构设计

更新日期：2026-07-31

> 本文是 `docs/product/CHAT_SERVICE_PRD.md`（产品/数据边界）和 `docs/research/SERVICE_INTEGRATION.md`（跨服务传输）的**落地技术设计**。
> PRD 定义 *what*，本文定义 *how*：服务拆分 → 物理拓扑、权限、热路径、可靠性、存储/记忆、事件 → 服务目录、服务间协议、进程管理。**拆分已落地**，本文是已实现的目标设计。

## 0. 决策记录（已拍板）

**为什么拆（第一性依据）**：按**执行时间 / SLA 分级**。主站 web 是**快**服务（毫秒级同步请求，面向用户页面，要低延迟高并发）；chat、image、video 是**慢**服务（秒级生成）。把慢的生成负载从快的 web 层剥离——否则慢生成会拖垮 web 的延迟和容量。三者之间**只用异步任务 + 事件**交互（job queue / outbox / inbox），**web 请求里绝不同步等生成**。下面所有边界、事件、队列设计都服务于这条。

| 决策 | 选择 | 影响 |
|------|------|------|
| 部署拓扑 | **现在就物理拆分**：独立 Chat Service（web + worker）部署 | Chat→Main 走 Chat outbox、Main→Chat 走 Main outbox + chat inbox（**两个 outbox**）；BFF 签名 day-1 上线；跨库无 FK |
| Companion runtime | **单一 DSH AgentLoop + official igrep plugin** | Chat 拥有 Soul/PreparedTurn/Scene/relationship/boundaries、workspace scope 与 terminal commit；official igrep 拥有通用记忆 lifecycle，不保留 native loop、自研 retrieval/extraction/item API 或 shadow executor |
| P0 第一刀 | **边界重构**：schema 隔离 + 双 role + 只读 view | 写权威成为 DB 层强约束，而非 code review 纪律；也是物理拆分前置 |

> 现状（as-built）：**拆分与 DSH cutover 已落地**。Chat Service 与 `chat-agent` sidecar 是独立部署单元。Chat 使用 `chat_service`/`chat_projector` 两个最小数据库能力维护账本与 Scene/relationship/boundaries 文件投影；每个生成 attempt 只调用 DSH sidecar。通用记忆仅存在于 official igrep workspace。Main 不再同步 drain chat 生成；Chat ↔ Main 业务事件统一经 sender Outbox → HTTP durable ingest → receiver Inbox ACK，Redis 只承载 Chat 内部队列和 token Stream。

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
                      ├─ Redis Stream: chat:stream:<assistantMessageId>
                      └─ authenticated HTTP → chat-agent sidecar
                           └─ DSH AgentLoop + official igrep plugin

Postgres cluster (单实例, 多 schema)  ── 账本/事务/计费/查询
  core.*  billing.*  compliance.*   ← Main Site 拥有；对 chat 暴露只读 view
  chat.*                            ← Chat Service 拥有（会话/消息/usage/审核/outbox）

文件系统 (本地文件夹, CHAT_FS_ROOT；直接 fs 读写，集中在一个模块) ── Chat 文件投影
  mem/{userId}/{charId}/relationship.md
  mem/{userId}/global/boundaries.md

DSH workspace root ── official igrep canonical memory（与 CHAT_FS_ROOT 不构成双 authority）
  relationships/<derived-scope>/

Redis (Chat Service 专用, CHAT_REDIS_URL): BullMQ 内部队列 + token Stream
```

`CHAT_FS_ROOT` 是不可由 PostgreSQL 完整重建的权威层。运维 checkpoint 必须在静默写入后同时捕获 Main PostgreSQL、`CHAT_FS_ROOT` 与 local Blob（或远端版本化 object inventory），并以目录 manifest/checksum 做隔离恢复；数据库单项 dump 不是完整 Chat 恢复证据。

2026-07-18 最终 controlled-beta checkpoint 已执行该合同：artifact base 为 `/Users/kk/code/idream/local-backups/idream-main-final-20260718-60/idream-main-final-20260718-60`，bundle 目录 `0700`、23 files 全部 `0600`、171M，SHA checks 全部通过。源端 Chat 为 294 sessions / 818 messages / 4 attachments、outbox `1,552` / inbox `488`（pending/failed 均为 `0`）、file mutations `5`（pending `0`）；`CHAT_FS_ROOT` 为 429 files / 550,987 bytes。隔离恢复后的 Chat FS 与源端逐文件比较为 `0` difference，且与 Main DB、Blob 的 counts/schema/logical/目录比较一起全部 equal；恢复后 Chat health 为 `ok`。这证明当前本地 checkpoint 可恢复，不替代 public production Gate。

**部署单元**（完整 6 进程见 §10 服务目录）
- `main-web`：主站，含 `/api/v1/chat/*` BFF 反代（只验签 + 转发，不拼 prompt、不写 chat 表）。
- `chat`：**单进程**，进程内同时起 `chat/web`（chat API + SSE）和 `chat/worker`（消费 `chat.generate`、Scene/relationship 投影、outbox/inbox/reconcile）。写本地文件 ⇒ `instances:1`。
- `chat-agent`：唯一 companion execution engine，运行 DSH AgentLoop + official igrep；PM2 以直接 Node PID、精确 `exec_interpreter`/`node_args` 管理，禁止 shell wrapper 遗留 orphan listener。
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
| `chat_projector` | durable file projector | 使用独立连接；只读 sessions/messages/send receipts/file mutation/outbox，UPDATE 仅开放 message `memory_extracted_attempt` + Prisma 自动写入的 `updated_at` 与 file-mutation receipt 五列，outbox INSERT 仅开放 Prisma `recordOutbox` 实际写入的十列（含展开的三个默认列）；无 session UPDATE、sequence、DDL 或额外函数能力 |

```sql
-- 由 core_owner 执行（主站迁移）：建 schema、view、授权
CREATE SCHEMA IF NOT EXISTS chat AUTHORIZATION chat_owner;

GRANT SELECT ON core.chat_user_view              TO chat_service;
GRANT SELECT ON core.chat_character_view         TO chat_service;
GRANT SELECT ON billing.chat_entitlement_view    TO chat_service;
GRANT SELECT ON compliance.chat_user_eligibility_view TO chat_service;

-- 完整 grant/revoke 顺序以 db/sql/04_grants.sql 为准：
-- chat_service 可写普通 domain 表，但对 file ledger 只可读并插入 intent columns。
-- chat_projector 使用独立连接；file ledger completion、session/message
-- watermark 与 outbox insert 都是列级 grant，直接 INSERT/DELETE 和额外列被拒。
-- 账户/relationship 擦除只能调用校验 canonical intent 的 SECURITY DEFINER 窄函数。
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

**验收测试（负向，P0 必须）**：除拒绝 `chat_service` 写 Main base table/read-only view 外，还必须拒绝请求角色完成/删除 intent、注入 sequence、修改 applied receipt，以及 projector 插入/删除 intent、越权 purge 或非法 lifecycle transition。catalog 校验必须遍历所有 Chat relation/column/sequence/function/default ACL，拒绝 schema CREATE、TRUNCATE/REFERENCES/TRIGGER、额外 function EXECUTE 和任何 projector 非 allowlist 表/列；隔离库还要用真实 Prisma projector 链证明最小 grant 足够。PUBLIC schema/table posture 属数据库级共享权威，Chat apply 不得为自身收窄而全局改写；若其继承权限会扩大 Chat，必须在 DDL 前 fail closed 交由 DBA 修复。这道 migration-applied 测试是“边界有牙齿”的证明。

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
  8. 原子转 pending→generating 并持有 generation lease；冻结 PreparedTurn：
     released Soul + recent messages + Scene/relationship/boundaries + released knowledge + policy
  9. 为普通 turn 选择唯一持久 relationship workspace；private turn 创建 attempt-local 临时 workspace
 10. 调 authenticated DSH AgentLoop；official igrep 在 loop 内 wake/search，token → Redis Stream(XADD)
 11. 输出审核
 12. TX(幂等, 只账本): update assistant(sent) + selected message_version + chat_usage++
                + moderation_events + outbox_events
 13. Chat terminal commit ACK 后才确认 DSH effect/开放 official igrep ingest；再发送 SSE done
 14. enqueue chat.memory.extract（历史 wire name：只派生 Scene/relationship 投影）和 outbox.deliver
```

> **regenerate**（`POST /messages/:id/regenerate`）：dedupeKey 必须带 attempt（`chat-generate:<assistantMessageId>:<attempt>`），否则同一 assistant message 重生成会被去重吞掉（**原 `:<assistantMessageId>` 是 bug**）。每次 regenerate 追加新 `message_versions`、翻转 `selected`、按 entitlement 决定是否再计 usage，并在新 attempt 启动前重建 relationship workspace，确保旧 selected reply 不再可 recall。

**policy resolver（SSoT）**：`resolvePolicy(entitlement) → { model, maxContextMessages, rateLimit, voiceEnabled }`。不把 entitlement 翻译成自研 igrep cap/top-K。

---

## 4. 可靠性

物理拆分后，**Chat→Main 的副作用走 Chat outbox**（同事务写 `chat.chat_outbox_events`，再由 `chat.outbox.deliver` 投递）——这是"DB 已提交但事件没发"的防线。**Main→Chat 对称**：主站写自己的 outbox → `chat.chat_inbox_events` → `chat.inbox.consume`。

**幂等键**（队列名 + 键格式以 `@idream/shared` 为 SSoT，两侧对齐；统一 `chat-` 前缀）
```text
chat-generate:<assistantMessageId>:<attempt>     # 带 attempt，支持 regenerate
chat-outbox:<eventId>
chat-inbox:<eventId>
chat-memory-extract:<assistantMessageId>:<attempt>
```

**reconciler（P0 必需）**：`chat.reconcile` 周期任务
- 扫未投递的 `pending` assistant message → 按确定性 job id 补投；同 id failed job 原地 revive。
- 扫长时间未 heartbeat 的 `generating` assistant message，以 attempt/status/lease compare-and-update → 标 `failed`。
- 扫 `sent` 且 `memory_extracted_attempt < attempt` 的消息 → 补投幂等 memory.extract。
- 扫已完成但 `outbox.status=pending` / `inbox.status=pending` 的事件 → 重投/重消费。

**SSE 硬化**：`XREAD BLOCK` + `Last-Event-ID` 断点续读（取代现状 150ms 轮询/30s 超时，`src/server/ai/stream-store.ts`）；Stream 设 `MAXLEN`/TTL 自动裁剪；过期则前端退化拉 `GET /sessions/:id` 已落库消息。

---

## 5. 存储与 companion authority（多租户 SaaS）

| 事实 | 唯一权威 | 说明 |
|------|----------|------|
| 用户看到的消息、status、usage、moderation、outbox | Postgres `chat.*` | ACID、查询、reconcile 与计量 |
| Soul pin、PreparedTurn、Scene revision | Chat DB/编译结果 | attempt 开始后不可变 |
| relationship 与 boundaries | `CHAT_FS_ROOT` Chat 文件投影 | durable intent + projector；boundaries 每轮全量注入 |
| 通用 companion memory | DSH sidecar 的 official igrep workspace | Chat 不解析 item，不建 `memory.md`、summary、candidate、cap 或 retrieval fallback |
| execution trace | Message / MessageVersion `runtime_trace` | content-free identities/outcomes；不持久化 prompt/tool payload |

**workspace admission**：普通 turn 的 scope 只由 `(userId, characterId)` 派生。已有 canonical/proof 时原样复用；没有 workspace/proof 表示合法的新 relationship，sidecar 原生初始化为空。历史 cutover proof/marker 只供迁移审计，绝不读取旧 `memory.md`，也不作为新关系的 admission 前置。private turn 使用 attempt-local 临时 workspace，不产生 canonical workspace/proof。

**commit gate**：official igrep wake/search 在 DSH loop 内执行；只有 Chat terminal CAS、输出审核与账本提交 ACK 后才允许 ingest effect 被确认。tool result 只持久化 `attemptId/callId/name/outcome/effectId`，error/timeout/不明结果保持 `unknown`，不得切到 native 或自研 memory fallback。

**实际 execution composition Gate C**：证据来自 sidecar 代码实际装配并执行的 programmatic manifest/digest，而不是 installer profile dump。最终 manifest 必须只包含批准的 DSH/igrep 能力，并断言没有 `shell`、`fs/filesystem`、`subagent`、`goal`、`scheduler`。

**用户控制**：`memory_enabled=false` 只创建临时 workspace；whole-relationship reset 通过一个 durable mutation 同时清除 Chat relationship 投影与 purge canonical DSH workspace。official plugin 没有逐条 list/edit/delete seam，因此 `/memories` item API 与对应 UI 不存在。

**隐私删除**：删消息改变 Chat transcript 与后续 PreparedTurn/rebuild input；删会话清其 Chat session artifacts；删账号清 Chat DB/文件前缀并 purge 用户的 DSH workspaces。需要清除已 ingest 的通用记忆时使用 whole-relationship/account purge，不伪造 item 级撤销。

---

## 6. 跨服务事件契约

**Chat → 主站**（Chat outbox，至少一次，消费者按 eventId 幂等）
`chat.session.created` `chat.message.completed` `chat.message.blocked` `chat.session.deleted` `chat.relationship.updated` `chat.usage.incremented` `chat.safety.flagged` `chat.account_erasure.completed.v2`

账号删除 v2 不走普通异步 Chat outbox：Chat 同步消费精确 request，文件删除成功后生成
`status=request_bound` 的 v2 completion，再直投 Main 专属 endpoint。Main 在独立 receipt namespace
中原子投影 completion 后才 ACK；Chat 随后把 completion 记为 delivered、Inbox 记为
`consumed_v2`，最后才 ACK 原 Main request。旧 dispatcher 只选择 `pending`，因此不能吞掉
request-bound completion；前滚 reconciler 会重驱旧 binary 留下的 `consumed` no-op receipt。

> 相对 PRD §11.2 **故意不发** `chat.message.created`（主站只需 completed/blocked；每条 user 消息发事件无价值）。如有消费者依赖，再补。

**主站 → Chat**（Main outbox → `chat.chat_inbox_events` → `chat.inbox.consume`；缓存失效/阻断/补偿，非权威来源——权威仍读 view）
`user.suspended` `user.account_deletion.requested.v2` `character.updated` `character.removed` `character.visibility_changed` `entitlement.updated` `age_eligibility.updated` `policy.updated`

契约类型 + **队列名 + 幂等键格式**都以 `@idream/shared` 为 SSoT，两侧共享，避免漂移。

---

## 7. 落地路线

**P0 拆分已全部落地**。各阶段技术细节见：§2 权限、§3 热路径、§4 可靠性、§5 存储、§6 事件、§10–12 服务编排。

历史执行顺序：**P0 边界/抽服务/可靠文件投影 → Soul/PreparedTurn → DSH+igrep cutover → Phase 6 legacy deletion**（均已完成代码实现；公开生产发布仍由外部 Gate 决定）。

**明确范围外（延后，非遗漏）**：group chat、voice call、official igrep 未暴露的 item CRUD、`chat_stream_events` DB replay 表（当前仅 Redis Stream + `MAXLEN`/TTL）。

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
# Chat 文件投影（relationship/evidence/boundaries；Scene/session/message 在 PG）
CHAT_FS_ROOT=./data/chat
DSH_AGENT_URL=http://127.0.0.1:3101
DSH_AGENT_TOKEN=...
DSH_PROFILE_NORMAL=idream-companion-memory
DSH_PROFILE_PRIVATE=idream-companion-private
# chat-agent sidecar owns the DSH workspace root and official igrep configuration.
```

---

## 9. 复盘决策（已定）

| # | 决策 | 结论 |
|---|------|------|
| D1 | 本地 FS 与横向扩展（C1） | **已定：文件夹模式**（本地 FS，`chat` 进程 **instances:1 单写**，容量上限文档化）。chat 是慢异步层，单实例对当前吞吐够用。**不做 Store 接口抽象**（YAGNI）——fs 读写集中在 `chat-fs.ts`，将来要换共享存储改这一个模块即可。**约束**：仍用本地 FS 时**禁止**把 `chat` 扩多写实例（要扩先拆 web/worker + 换共享存储）。 |
| D2 | PRD 同步 | **已更新** PRD：Chat 拥有产品/关系边界，official igrep 拥有通用记忆 lifecycle；无 item API。 |
| D3 | 历史 session.jsonl 清理 | execution evidence 已迁到 content-free Message/MessageVersion trace；历史 raw log 只允许删除，不再新增。 |

### 历史 session.jsonl 清理（D3）

旧版本写过含 prompt/output/tool payload 的 session JSONL。Phase 6 后生产路径不再发出
raw session trace intent；Message 与 selected MessageVersion 上的严格 content-free trace 是唯一 execution
evidence。迁移时用受控清理命令删除 `CHAT_FS_ROOT/sessions` 下的历史活动段与归档段；它们
不是消息、Scene、relationship 或 official igrep memory 权威。清理完成后，运行时代码不再
认识该目录或 `trace_append` intent。

---

## 10. 服务目录

按执行时间分级（§0）。`chat` 现在是**单进程**（HTTP/SSE + BullMQ worker 同进程），因写本地文件 ⇒ `instances:1`。

| 服务 | 层 | 职责 | 入口 | 实例 | 主要依赖 |
|------|----|------|------|------|----------|
| `main-web` | 快·同步 | 公开页/角色/billing/library/提交 generation/**chat BFF 反代** | Next.js | cluster(max) | PG(core/billing/compliance RW)、Redis、Blob 签 URL |
| `chat` | 快I/O + 慢生成 | **单进程**：`chat/web` + `chat/worker`(chat.generate / Scene+relationship projector / outbox / inbox / reconcile) | node | **1（写本地文件 ⇒ 单写节点）** | PG、Redis、Chat 文件投影、`chat-agent` |
| `chat-agent` | companion execution | DSH AgentLoop + official igrep plugin；actual composition manifest/digest | node | 1 | DSH workspace、model provider |
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
  chat/     → chat/web + chat/worker（单进程入口同起）、prisma-chat、Chat 文件投影
  chat-agent/ → DSH AgentLoop + official igrep workspace
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
