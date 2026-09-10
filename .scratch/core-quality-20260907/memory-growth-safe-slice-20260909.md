# Candidate 08 — 真实历史导出与记忆增长安全切片

日期：2026-09-09。最终结论：修复两个正确性缺陷；确认全量历史投影的增长成本；拒绝了一项破坏恢复语义的提速实验。没有证明 10k 历史的真实模型首字容量，不能把本项写成完整容量验收通过。

后续：同日继续完成官方 ingest profiling 与 64 KiB 有界落盘缓冲，见 [定位、A/B 与最终局部改进](memory-ingest-profile-and-buffer-20260909.md)。旧版 4.651 秒快路径仍被否决；新的安全缓冲仅把完整 10k 增量投影从同机基线 13.413 秒降至 13.107 秒。

## 保留的实现

- `packages/main/src/server/modules/chat/companion-memory-authority.ts`：Main 历史按 `sessionId → createdAt → id` 导出，保证 Chat 所需的会话连续性，同时保持各会话内部时间顺序。原先全局时间排序使反复切换会话的历史被 Chat 拒绝。
- 同模块：破坏性 rebuild / clear 使 **pending 和 processing** 普通投影失效并撤销租约。否则旧投影已读出的待删除历史可能在破坏性操作后通过最终发布检查。继续复用现有 Main user 行锁和发布前 outbox 状态检查，没有新增权威或水位。
- 新增 `companion-memory-export.integration.test.ts`：真实 PostgreSQL + Main NDJSON + Chat decoder，模型/索引构建处受控停止。覆盖 402 个交错 Turn、804 条消息、跨 200 行数据库分页，以及 processing 投影与 clear / rebuild 的竞争。
- 新增 `companion-memory-growth.benchmark.test.ts`：默认跳过的可复用实测。真实 PG、队列租约、投影合并、NDJSON、Chat spool、workspace、igrep ingest / doctor / status / wake；模型实验必须显式启用并经过总请求计数器。
- 本轮不保留任何 `igrep.ts` / `igrep.test.ts` 快路径变更。队列时效隔离由独立 Main 调度切片负责，不由本文件代替其回归证据。

## 零模型基线：保留的全量投影实现

原始证据：[memory-pg-growth-20260909.json](memory-pg-growth-20260909.json)，记录 revision `idream-worktree-0cb56a9c5819673af92279d8ac0c91db48b7b7b9254f52684805ce0e88f27f2b`。单次样本、每条合成消息 1,000 字符，100 / 1,000 / 10,000 条分别分布于 2 / 4 / 4 个交错会话。维护命令及完成时间戳被明确拦截；没有模型和 embedding 请求。完整 NDJSON 的 HTTP 边界在进程内适配，字节数不是 TCP 吞吐证据。

| 原始消息数 | 首次投影 | 仅新增两条后的投影 | 新增投影：导出+落盘 | 新增投影：workspace/CLI/校验 | 实际 NDJSON 字节 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 | 1.112 s | 1.051 s | 20.96 ms | 1.008 s | 142,924 |
| 1,000 | 2.492 s | 2.648 s | 89.73 ms | 2.531 s | 1,403,034 |
| 10,000 | 11.609 s | 13.377 s | 810.97 ms | 12.501 s | 14,031,044 |

10k 新增投影仍执行四次真实 ingest：一个 `newEvents=2`，三个 `newEvents=0`。每次约 2.94–2.97 秒；瓶颈是官方 ingest 的重复全库工作，不是几毫秒的工作区复制。事件循环 p99 约 12 ms（10 ms 采样精度）；4 个并发 attempt 的复制+真实 wake 总时间 0.27–0.38 秒，wake 此时为空，**不是用户首字延迟**。原投影代码在撤回实验后恢复，因此不再次消费模型或重复三档测量来制造额外“通过”次数。

## 被否决的优化，不可作为交付成果

[memory-pg-growth-optimized-20260909.json](memory-pg-growth-optimized-20260909.json) 记录严格检查 v1 dialogue 后跳过未变会话 ingest 的实验，曾把 10k 新增投影降至 4.651 秒。但官方 ingest 还会修复 `memory/sessions` 和 cursor 的不一致；仅验证 dialogue 并不能证明这些恢复职责可省略，现有 doctor / probe 也不提供该完整保证。

因此生产实现和专属测试已撤回。4.651 秒只能证明重复扫描占比，不能引用为最终性能。合理后续方向是改进官方 ingest 内部扫描，同时保留其原生恢复不变量，而不是在 Chat 复制更多底层私有格式。

## 最小真实维护与检索：预算内完成部分

[memory-pg-growth-live-20260909.json](memory-pg-growth-live-20260909.json) 记录的是被否决快路径存在时的实验 revision `idream-worktree-a8b3ad22975381a254bfb842e60d8f228294059489922f232451ddd871c783b8`，不能归作最终源码性能。

- 100 条短重复事实、2 会话、16,400 字节 transcript：一次真实 maintain 5.507 秒，处理 100 行、pending 归零，产生两条 observation；完整 PG 到发布 6.624 秒。实际 `Qwen3.5-4B-MLX-4bit`，两次请求 `chatcmpl-13bfdc47` / `chatcmpl-a76e5aed`，输入 7,267 / 输出 31 tokens，无货币报价。
- 102 条历史的一次 fast recall 为 4.185 秒、6 hits。真实 embedding 为 `harrier-oss-v1-0.6b-MLX-8bit`（113 tokens）；真实 rerank 为 `Qwen3-Reranker-0.6B-mlx-4Bit`（27,066 tokens，`rerank-3614d9fe`）。都只到既定本地 `127.0.0.1:8061`。
- 计数代理硬上限为 **4 次转发 HTTP，总计包括 LLM、embedding、rerank 和重试**；每次 HTTP 60 秒、maintenance CLI 120 秒。第二档 recall 试图发出第 5 次 HTTP 时被拒绝，AbortController 终止 CLI，整个实测以非零退出。实际仅转发 4 次，没有继续重试；10k recall 和真实对话首字尚未验证。根任务随后确认 provider `active=0 / waiting=0 / loading=0`。
- 同次受控 PG 调度诊断中，旧串行 outbox 的 memory hold 为 122.15 ms，cancel 在 132.49 ms 才开始（释放后 10.34 ms）。这说明有真实 head-of-line 阻塞，修复与新回归见 Main 调度切片。

## 验证与复现

真实数据库：`localhost:5433/idream_memory_growth_test_20260909`；Redis：`127.0.0.1:6379/14`，BullMQ prefix 为 `idream:test:f75952aceac970c475ccac0e6e8a6026241ceeeb73b968b70299b453e40a5115`。独立于开发库、原测试库和其他 agent 的任务库。没有执行 PM2 启停。

真实回归（先红后绿，最终 3/3）：

```sh
bun --cwd packages/main -e 'import { defaultTestDatabaseUrl } from "./test-database-url"; const target=new URL(defaultTestDatabaseUrl()); target.pathname="/idream_memory_growth_test_20260909"; const child=Bun.spawn(["bun","run","test","src/server/modules/chat/companion-memory-export.integration.test.ts"],{env:{...process.env,TEST_DATABASE_URL:target.toString(),REDIS_URL:"redis://127.0.0.1:6379/14"},stdout:"inherit",stderr:"inherit"}); process.exitCode=await child.exited;'
```

零模型增长实测使用同一启动方式，把文件改为 `companion-memory-growth.benchmark.test.ts`，并仅增加 `RUN_MEMORY_GROWTH_BENCHMARK="1"` 与唯一绝对 `MEMORY_GROWTH_REPORT` 路径；不要设置 `MEMORY_GROWTH_LIVE`，不要覆盖现存 JSON。标准 Main 测试会按现有 global setup 重建该任务专用测试库。

最终局部验证：`bun run --filter @idream/chat test src/agent-runtime/igrep.test.ts src/agent-runtime/workspace.test.ts` 为 38/38；`bun run --filter @idream/chat typecheck` 与 `bun run --filter @idream/main typecheck` 均通过；Main 三个文件的 targeted ESLint 通过；`git diff --check` 通过。完整 Chat 验证由根任务记录，不在这里重复执行。

清理：受控用户、角色、Turn、outbox 行均复查为 0；临时 Chat spool / workspace 已由受控 finally 清理，计数代理关闭，任务专属四个 BullMQ 队列 metadata key 已精确 unlink。未 flush Redis DB 14、未触碰其他 prefix。任务专用数据库保留其测试框架 seed，证据 JSON / Markdown 保留。

账户删除无需新增绕路保护：`packages/chat/src/account-deletion.ts:58` 在完成 receipt 前执行 scope:user purge；`workspace.ts:194` 在 user 锁内先写持久 tombstone，`workspace.ts:315` 发布前拒绝已删除用户；现有 `workspace.test.ts:317` 精确覆盖进行中的 prepare 与 user purge 竞争后，旧 promote / 新 prepare 均被拒绝。
