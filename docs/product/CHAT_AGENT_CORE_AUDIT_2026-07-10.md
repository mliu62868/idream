# Chat Agent Core Audit — 2026-07-10

## 结论

本轮从“一个用户 turn 必须最终得到唯一、连续、可恢复的 companion turn”出发，完整检查了 Chat API、PG ledger、BullMQ、worker、SSE、prompt/context、memory、relationship、文件层与 BFF 权威 view。原实现的功能面完整、基线测试全绿，但关键失败模式没有被测试：并发、commit/enqueue 裂缝、长生成 lease、长会话窗口、滚动摘要饱和、记忆任务重试和 private character 访问。

修复后的核心 module interface 仍保持小：HTTP/service 提交 turn，`processGenerate` 完成 turn，`processMemoryExtract` 派生长期状态，`reconcile` 负责最终收敛。复杂性被收进这些 seam，没有新增一套平行 job authority。

## 第一性不变量

1. 一个 user turn 只能有一个在途 assistant turn；同一 session 不并行推进叙事。
2. PG commit 之后，即使 Redis 不可用或进程退出，生成意图仍可恢复。
3. quota/rate limit 是并发下的权威 reservation，不是事务外的参考读。
4. worker 只回收没有 heartbeat 的生成，不能误杀健康长流。
5. assistant 必须显式指向它回答的 user message；不以相同时间戳猜关联。
6. finalize、usage、selected version 和 outbox 原子；派生 memory/relationship 至少一次但效果幂等。
7. prompt 中 runtime rules、persona 和派生数据必须分层；memory/summary 不能升级为持久化指令。
8. context、输入、文件记录、Redis key 数量均有硬上限。
9. Chat 自己复查 user、age gate、character visibility/status/age，不把 BFF 当授权权威。

## 已修复问题

- session create TOCTOU：事务 advisory lock 后 read/create。
- 同 session 双提交与 free quota 并发穿透：user/session lock + pending reservation + hourly limiter。
- commit 后 enqueue 丢失：assistant `pending` 是 durable intent；reconciler 补投，failed deterministic job revive。
- 长生成误回收：覆盖首 token、工具规划、流式停顿与审核阶段的独立 30s lease heartbeat + compare-and-update stale recovery。
- 派生任务丢失/重复：`reply_to_message_id`、`memory_extracted_attempt`、relationship turn key。
- 上下文顺序与分页：相同 TX timestamp 稳定排序；GET 返回最新 200 条且只查对应 attachments。
- 摘要冻结：预算优先保留最新 user/assistant turn。
- prompt hierarchy：新增 `prompt.ts`，派生 context 统一 JSON data block，tool planner 与主回复共享规则。
- 边界执行：global boundaries 与长期记忆解耦，无记忆/零记忆额度会话仍每轮 fail-closed 读取；tool planner 明确禁止规划越界调用。
- 队列契约漂移：`chat.generate` / `chat.memory.extract` payload schema 与类型统一到 `@idream/shared`，worker 入口做运行时解析，不再强制断言。
- 记忆输入权威：memory extractor 按 `reply_to_message_id` 精确读取 PG turn；session.jsonl 只作 best-effort 诊断轨迹，不进入记忆可用性链路。
- 资源无界：12k 单消息、64KiB HTTP body、recent transcript 字符预算、memory/relationship 上限、Redis Stream 24h TTL。
- 文件写覆盖：memory/relationship authority file 的 read-modify-write 按路径互斥。
- 权威遗漏：private character 与未接受 age gate 的用户在 Chat service 入口拒绝。

## 验证与部署

验证命令：

```bash
bun run --filter @idream/chat test
bun run --filter @idream/chat typecheck
```

部署顺序：

```bash
CHAT_DATABASE_URL=<chat_service-runtime-url> PGHOST=<host> PGPORT=<port> \
DB=<database> SUPER=<owner> bash db/sql/apply-validate.sh
bun run --filter @idream/chat db:generate
pm2 restart chat
```

当前 operator entry 会在 DDL 前拒绝 `CHAT_DATABASE_URL` query 中的 target/credential override，
拒绝 `DB` 含 `=` 或 `postgres://` / `postgresql://` 而被 `psql -d` 解释成 conninfo/URI，拒绝 URL
database path 的多个前导 `/`，拒绝逗号
分隔的 multi-host `PGHOST`，并拒绝 ambient `PGHOSTADDR` / `PGSERVICE` / `PGSERVICEFILE` /
`PGDATABASE` / `PGUSER` / `PGOPTIONS`。
上述 URL 解析与 target 对比使用 runtime `node-pg` parser。入口检测到 shell xtrace 时会在 DDL 前
fail fast；调用者也不得把 secret 放入 `PS4`，因为 Bash 在脚本首条命令前就会展开该前缀。部署和
Chat test provision 的所有 `psql` 调用均带 `-X`、拒绝 ambient target override；测试角色密码只经
`psql` stdin 输入，不进入 argv 或异常文本。

Chat test provision 在任何 `DROP DATABASE` 前用两个独立真实 credential 分别认证为 `chat_service` 与
`chat_projector`；测试库重建持有按 cluster/database 标识的 PostgreSQL advisory lease，角色 bootstrap
另持有 cluster advisory transaction lock 并在得锁后重查姿态。与 runtime 指向同一 PostgreSQL cluster
时只复用已经 canonical 的四个角色；任一 Chat runtime URL 已配置时都禁止 bootstrap。只有显式确认的
非 runtime disposable cluster 才允许在锁内只创建缺失角色，绝不 `ALTER ROLE` 或轮换既有密码；姿态
漂移直接失败。`packages/chat/vitest.config.ts` 显式加载包内 `.env`，因此从 monorepo root 由 Turbo 启动
Chat test task 也使用相同 target authority；Turbo 的 `@idream/chat#test` 固定 `cache:false`，不会用历史
缓存冒充本次数据库边界测试已执行。

Chat readiness 不是单次启动探针：request 必须满足
`session_user=current_user=chat_service`，projector 必须满足
`session_user=current_user=chat_projector`，两边还要通过精确 least-privilege catalog grants 并指向
同一 PostgreSQL server address/port/database。DB/Redis/schema/capability 证据最多缓存 5 秒；真实
provider failure 只锁存新 turn/generate admission，读取与 internal/durable ingress 继续可用。恢复循环
按 5→60 秒退避 singleflight 执行完整 warmup，成功后自动恢复。每次 warmup 同时绑定递增 attempt 与开始
时的 invalidation epoch；只有当前 attempt 且 epoch 未变化的成功结果能恢复 admission，warmup 期间的新
provider failure 会推进 epoch，旧完成不能覆盖新失败。Recovery 重启后的 signed Chat 证据为
`.tmp/launch-chat-service-probe-2026-08-14-final-user-journeys.json`（`ok=true`），覆盖 unsigned
401、signed session/message/SSE/reload/regenerate Scene anchor/no-memory/blocked-input/cleanup。Gate 证据为
`.tmp/check-launch-2026-08-14-final-user-journeys.json`；`LAUNCH_SCOPE=core` 下为 44 pass / 23 fail /
0 warn / 67 total，支付与年龄验证不参与结论，公开上线仍是 NO-GO。Gate 的 Main/Admin/Chat/Gen env
authority 独立解析，跨服务 APP_ENV、token/BFF、BullMQ prefix 与 source revision 必须等值；非 Sentry 本地必需 probe
均绑定同一最终 revision。四包 Sentry probes 也以该 revision 诚实记录外部 canary 未完成；source-revision authority 已通过，剩余失败为 23 个 production-envelope 检查。

最终自动化证据为 Chat 37 files / 348 tests、全仓 537 passed files + 2 skipped / 3,869 passed tests +
3 skipped、Turbo test tasks 6/6（Chat `cache:false` 强制执行）、typecheck 6/6、lint 2/2、production build
tasks 5/5、PM2/operator/source-revision tests 84/84。最终后端补丁后真实 Chrome 复验 public character detail 的 1280 与
390×844 响应式状态、可见 Tab 焦点及 Chat CTA 的 401→signup 认证边界；Browser Back 捕获
`pageshow.persisted=true`，返回后 `checking=false`、heading=`Mara Vale Launch`、
`documentWidth=innerWidth=390`，无横向溢出。完整 authenticated 客户/Admin Chrome 旅程早于该补丁；
当前 signed Chat 是 authenticated runtime 全链证明，不能表述为 Chrome。

新增列均为向后兼容：`chat.messages.reply_to_message_id` nullable，`memory_extracted_attempt` 默认 0。旧行保留基于 timestamp 的只读回退；所有新 turn 使用显式关系。
