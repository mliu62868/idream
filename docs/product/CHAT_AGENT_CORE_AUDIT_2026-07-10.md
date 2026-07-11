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
DB=<database> SUPER=<owner> bash db/sql/apply-validate.sh
bun run --filter @idream/chat db:generate
pm2 restart chat
```

新增列均为向后兼容：`chat.messages.reply_to_message_id` nullable，`memory_extracted_attempt` 默认 0。旧行保留基于 timestamp 的只读回退；所有新 turn 使用显式关系。
