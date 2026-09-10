# Candidate 08 — 官方 ingest 定位与有界落盘缓冲

日期：2026-09-09。承接 [上一轮安全切片](memory-growth-safe-slice-20260909.md)。本轮保留 64 KiB transcript 缓冲；没有恢复已否决的跳过会话 ingest 快路径，也没有修改 igrep 的安装包、私有协议、记忆校验或恢复流程。

## 结论

10,002 条消息的真实 Main PG → Chat 导出落盘阶段由 **801.53 ms 降至 389.74 ms**，所有会话 transcript 的字节数与 SHA-256 前后相同。完整投影仅由 **13.41252 s 降至 13.10707 s**；单样本的 2.28% 总时间差不能作为稳定容量 SLA。主要耗时仍在官方 ingest 的全库扫描，本项没有解决上游瓶颈，更没有完成真实模型首字容量验收。

## 根因证据及边界

- 已安装 `igrep 0.1.137` 的公开 `mem ingest --help` 仅有单个 transcript / rows 输入与单个 session ID，没有 batch / manifest 入口；公开 `mem-api` 也没有多会话导入操作。
- [原样官方 CLI profiling](igrep-ingest-profile-20260909.json)：4 个会话、10,000 条合成可见消息、每条 1,000 字符。一次无变更 ingest 为 2.422 s、`events=2500/newEvents=0`。加上 cProfile 后，Python 总执行时间 2.489 s，其中 `_ensure_derived_secret_shield_locked` → `_unsafe_derived_source_classes` → `contains_secret_value` / 正则替换为 2.170 s，约 87.2%；四次调用扫描四个 dialogue，而非只处理当前会话。
- Profiling 的函数名和原始源位置来自已安装 Python code object；没有更改依赖实现。该计时用于定位，不能当作 PG 全链路或用户延迟。可复现脚本为 [igrep-ingest-profile-20260909.ts](igrep-ingest-profile-20260909.ts)，只执行官方 `mem ingest`，不执行 maintain / recall。
- 当前单次增量投影仍调用四次官方 ingest，保证其 session 文件与 cursor 修复职责继续执行。在项目侧以缓存或 dialogue 快照跳过这些调用，会重新引入上一轮已确认的恢复缺口。
- 若要进一步消除主成本，合理边界在 igrep 自身：由官方批量导入入口持有一次生命周期锁、完成所有会话恢复，并统一执行全库 secret-shield。此处只记录候选边界，不在 iDream 复制底层协议，也没有对外发布事项或修改上游。

## 保留的最小改动

`packages/chat/src/companion-memory.ts` 保持原来的私有 spool / NDJSON / 会话顺序契约，在同一实现内使用一个固定 64 KiB Buffer 合并零碎片段。满缓冲或会话结束时写入；短写循环补齐；零字节写入明确失败；会话内仍按 flush → fsync → close 顺序执行。模型、Main 权威、发布栅栏、官方 ingest 与恢复均未增加旁路。

新增 `packages/chat/src/companion-memory.test.ts`：512 条消息改动前实际 1,536 次 write，批量写入要求 ≤ 10 次的断言先红；最终通过。另覆盖跨协议片段 / 缓冲 / 会话的 Unicode 与 JSON 转义、真实文件短写、零进展写入、写入或 fsync 失败、缺失 complete 帧、源流断开及私有文件清理，验证原始数据完整和下游不接收残缺 spool。Request 的 AbortSignal 继续原样传入下游。

## 同机 A/B：真实 PG 与原样官方 CLI

两个测量均使用相同 benchmark、相同 100 / 1,000 / 10,000 消息 fixture，分布于 2 / 4 / 4 个交错会话。先临时还原本次独占的旧落盘写法运行基线，再恢复最终缓冲实现运行候选。均为实际 PG、Main 队列租约与合并、NDJSON、Chat parser、workspace 构建 / 发布、原样官方 ingest / doctor / status / wake；维护命令和完成时间戳明确拦截，模型 / embedding / rerank 请求数为 **0**。进程内 Request 适配不包含 TCP 延迟。

每次 prepare 在 stage 计时结束后增加完整 transcript 哈希；该观测额外耗时单列为 `benchmarkFingerprintMs`（10k 约 5 ms），不计入 `exportAndStageMs`。六阶段共 20 份会话快照的 SHA-256 / 字节数逐项相等，NDJSON 字节数也相等。

| 消息数 / 阶段 | 导出+落盘：前 → 后 | 完整投影：前 → 后 | 候选 workspace / CLI / 校验 |
| --- | ---: | ---: | ---: |
| 100 首次 | 28.35 → 27.73 ms | 1.14721 → 1.10091 s | 1.03052 s |
| 102 增量 | 23.07 → 20.10 ms | 1.05402 → 1.04874 s | 1.00355 s |
| 1,000 首次 | 96.34 → 70.87 ms | 2.46448 → 2.46515 s | 2.36700 s |
| 1,002 增量 | 106.78 → 62.10 ms | 2.66042 → 2.63758 s | 2.54262 s |
| 10,000 首次 | 763.59 → 372.78 ms | 11.60029 → 11.53401 s | 11.10801 s |
| 10,002 增量 | 801.53 → 389.74 ms | 13.41252 → 13.10707 s | 12.64538 s |

10,002 条消息仍为 14,031,044 字节 NDJSON / 10,947,189 字节 transcript；四次官方 ingest 分别约 2.987 / 3.001 / 2.989 / 2.997 s，新增事件为 `[2, 0, 0, 0]`。该阶段四个并发 attempt 的复制与真实 wake 总用时 318.34 ms，但 wake 为 empty，不是对话模型首字延迟。

原始报告保持不可覆盖：

- [未缓冲基线](memory-pg-growth-unbuffered-ab-20260909.json)：起始 revision `idream-worktree-3dad8a2f791c901cbea9eae65fff82f6b604856a76fc2d06cfff854865695a36`，结束 `idream-worktree-7b750c6dfed00e12e2168d10d0ec5f9378a808b9dd49a8e9c1f99881a081338c`。运行中新增的失败清理测试导致全树 revision 改变；被测生产路径没有随之改变。
- [最终缓冲候选](memory-pg-growth-buffered-ab-20260909.json)：起止 revision 均为 `idream-worktree-559b26ad165e9f0ac00e1be7ee96b47baf0136b1f4da507821980a684903d0d7`。

本次恢复缓冲前、最终测量后核对的文件 SHA-256：

| 被测生产文件 | 基线与候选 |
| --- | --- |
| Chat `companion-memory.ts` | `0127923e950c2497b805a2345535d593de7e243bd7b8f55fd748dccdf3547f92` → `affb55d9e56550b92b49554c59a2e6a23ae42ff12d31518a1d4e02ed82b848a2` |
| Chat `agent-runtime/igrep.ts` | 不变：`5a24edf891b87148c4ad28d58a6a9f3b42528ee32cfca77b18571a13f76ca89d` |
| Chat `agent-runtime/workspace.ts` | 不变：`8470ec00185cba4f7b98e98a01f4ea42dbad57a2da565eaf7128d6e17554df20` |
| Main `companion-memory-authority.ts` | 不变：`6b3238ef0e41b1cd10b4707c8450464192484a69513c47051b34d65bc3267180` |
| Main `chat-outbox.ts` | 不变：`762f4c123b99225556fda59df161ff54458651674f1df6c023d7634526a93a9c` |
| Shared `companion-runtime.ts` | 不变：`2da94296a85308001d844c0ef48c0efb09e767ace25c62ed2b5763bb7b2e433c` |

## 验证与清理

- Chat 相关 4 个文件，47/47 测试通过；Main 实际 PG 导出 / 破坏性 fence 3/3 及完整三档 benchmark 通过。
- Main / Chat typecheck 通过；Main benchmark targeted ESLint 通过；`git diff --check` 通过。未重复执行完整仓库构建或真实模型请求。
- 数据库仅 `localhost:5433/idream_memory_growth_test_20260909`，重建前再次确认没有其他连接。Redis 仅 `127.0.0.1:6379/14` 的 DB-hash 专属 prefix，没有 flushdb / flushall。
- 运行后用户、角色、Turn、outbox、memory authority 受控 fixture 数量均为 0；临时 spool / workspace 由 finally 清理；四个精确任务队列 metadata key 已 unlink（可由队列重新生成），没有删除其他 Redis prefix。任务数据库及框架 seed 保留；未操作 PM2。

本轮按 diagnosing-bugs 的红灯与单变量验证、codebase-design 的协议所有权约束推进；igrep 技能用于确认官方公开入口，未触发语义搜索或模型请求。
