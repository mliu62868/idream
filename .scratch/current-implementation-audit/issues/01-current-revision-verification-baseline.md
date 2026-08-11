# 建立当前 revision 的可复现验证基线

Type: task

Status: resolved

## Question

在一个明确记录的当前 revision 上，仓库既有的 root test、lint、typecheck、production build、PM2 配置测试与静态完整性检查分别得到什么退出码、耗时、通过数、跳过数和失败证据？哪些失败是确定性回归，哪些是环境依赖，当前 revision 能否被诚实标记为“仓库验证通过”？只核验和归因，不在本票修复。

## Answer

结论：`master@1fb5d544fc8cd5630a8bcd33e1e8cc25cbb982cc` 可以在本票限定的意义上标记为**当前 revision 仓库验证通过**。所有要求的 gate 退出码均为 0，没有确定性回归；该结论不包含真实 PM2 运行态、launch readiness、Playwright／浏览器旅程、真实 provider 或生产 cutover。

### 环境与工作树

- 日期：2026-08-11。
- 主机：Darwin 25.5.0 arm64。
- Node：22.22.0；Bun：1.3.14。
- 开始与结束时 branch／HEAD 一致：`master` / `1fb5d544fc8cd5630a8bcd33e1e8cc25cbb982cc`。
- 工作树除本 Wayfinder 的 `.scratch/` 新文件外无改动；构建和测试没有产生 tracked 污染。

### Gate 结果

| Gate | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| 静态完整性 | `git diff --check`（开始与结束各一次） | exit 0 | 结束复验 0.02s，无 whitespace error |
| Root 全量测试 | `bun run test` | exit 0，205.64s | Turbo 6/6 tasks；五包测试任务均为本轮执行，只有 Shared 的 source-only build 命中缓存 |
| Lint | `bun run lint`；`bunx turbo run lint --force` | 两次 exit 0 | root cache 回放 2/2；强制冷执行 2/2、0 cached、9.96s |
| Typecheck | `bun run typecheck`；`bunx turbo run typecheck --force` | 两次 exit 0 | root cache 回放 6/6；强制冷执行 6/6、0 cached、2.62s |
| Production build | `bunx turbo run build --force` | exit 0 | 5/5、0 cached、26.38s；Main／Admin Next 16.2.1 standalone 均重新生成 |
| 组合检查 | `bun run check` | exit 0，23.41s | lint → typecheck → build 全链通过；Main／Admin build 再次实际执行 |
| PM2 配置 | `bun run test:pm2-config` | exit 0，0.07s | 25 passed、0 failed、0 skipped |

最后一次 `bun run check` 生成的 standalone 身份：

- Admin release：`idream-6a49f033-9867-4656-bec6-ba009bb6e8d8`。
- Main release：`idream-0d6ff8ad-6f21-4a4d-95b0-2e210baaefb5`。
- 两者 build ID：`build-TfctsWXpff2fKS`。

### 当前测试计数

| Package | Test files | Tests | Package duration |
| --- | ---: | ---: | ---: |
| Shared | 41 passed | 237 passed | 0.678s |
| Admin | 112 passed | 564 passed | 10.95s |
| Chat | 32 passed | 252 passed | 26.16s |
| Gen | 17 passed | 190 passed | 0.587s |
| Main | 279 passed + 2 skipped | 2,148 passed + 3 skipped | 166.23s |
| 合计 | **481 passed + 2 skipped** | **3,391 passed + 3 skipped** | root wall time 205.64s |

三个 skip 都是显式环境门控的真实进程 chaos 覆盖：dependency-chaos process、real command worker process chaos、real projector process chaos。它们不构成本轮失败，但也不能声称已执行。

### 非失败噪声与边界

- Admin mounted tests 会输出既有 React `act(...)` 与 Next Image fixture 布局 warning；suite 全部通过。这是测试噪声／潜在测试质量债，不是本轮 gate 失败。
- failure-injection 测试会记录 `simulated worker crash`、`injected ... failure`、冲突、forbidden 与 fallback 日志；对应测试均通过，不能把这些预期日志误报为运行回归。
- Turbo 对 Shared／Chat／Gen 的 source-only build 报 `no output files found` warning；这些 package 的 build script 本身声明为 source-only，5/5 build tasks 通过。
- PM2 配置测试中的“production runtime is not online”与 errored／missing process 文本来自 fail-closed fixture；本票没有读取真实 PM2 topology。真实 runtime、队列和数据库状态由“核验数据库、队列与部署就绪态”处理。
- Root 测试成功使用本地 `idream_test` PostgreSQL（localhost:5433）完成 schema sync 与 seed。它证明测试环境依赖可用，不证明开发库或生产库 migration 状态。
- Prisma 7.6.0 输出 7.9.1 可升级提示，不影响退出码。

因此，本票没有需要新建的修复票。Node 运行时口径、历史状态文档与当前代码是否一致，已由现有的“核对功能覆盖声明与当前代码权威”覆盖。
