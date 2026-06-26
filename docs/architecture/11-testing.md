# 11 · 测试策略

更新日期：2026-06-25

对齐 global rules（L1–L4、TDD、覆盖率门）与 web 规则（Vitest/Playwright）。当前实现以 **bun workspace + Postgres 测试库 + Redis + mock providers** 为基线；早期 SQLite 双库设想已不再是默认执行路径。

## 1. 工具与层级

| 层 | 范围 | 工具 | 周期 |
| --- | --- | --- | --- |
| L1 | lint + typecheck | eslint（含 import 边界 09 §2）+ `tsc --noEmit` | 秒级 |
| L2 | service/repository/lib 单元 | **Vitest** | 分钟 |
| L3 | API route 集成（含 DB、mock provider） | Vitest + 真实 Prisma（Postgres 测试库 + Redis） | 分钟 |
| L4 | 关键用户流 E2E | **Playwright** | 慢 |

已引入（devDependencies）：`vitest`、`@vitest/coverage-v8`、`@playwright/test`、`tsx`（seed/脚本）。主要 scripts：

```jsonc
{
  "check": "turbo run lint typecheck build",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:postgres": "vitest run",
  "test:e2e": "playwright test",
  "coverage": "vitest run --coverage"
}
```

## 2. Postgres 隔离测试（本项目特有，重点）

主站和 chat 服务测试都必须跑在隔离 Postgres 测试库上：

- `packages/main` 默认使用 `TEST_DATABASE_URL`，未设置时使用 `postgresql://postgres:postgres@localhost:5433/idream_test`；global setup 会重建 schema、执行 `db-push`、seed，并清空 Redis DB 15。
- `packages/chat` 是 Postgres-native，global setup 会 push 主 schema、应用 chat boundary SQL，并清空 Redis DB 14。
- 重点覆盖：`lib/db/search.ts` 的 `nameMatch`（大小写、模糊）、cursor 分页排序稳定性、队列认领并发、Json 字段读写、事务回滚、chat service DB 权限边界。
- 任何测试对开发库或生产库产生副作用都是阻断级问题。

## 3. Provider 测试替身

- AI/支付/存储/验证/审核**全部有 mock 实现**（06 §5），返回确定性数据，单测/集成默认用 mock（`NODE_ENV=test` 或 `*_PROVIDER=mock`）。
- **审核 mock 仍保留未成年硬规则**（关键词/年龄字段），保证安全用例可测（07 §3）。
- webhook 测试：构造带合法签名的事件 → 断言幂等（重复发只处理一次）。

## 4. 必测清单（按风险，P0）

**安全/合规（最高优先）**
- [ ] 角色 age<18 被拒（创建 + 审核）。
- [ ] 未成年/深伪/禁内容关键词在 input/output 审核被 `blocked` 且产生 `moderation_events`。
- [ ] age gate 未接受 → 成人内容/受限路由 403。
- [ ] 受限辖区未验证 → 受限路由 403。
- [ ] 举报落库进队列；举报人身份不泄漏。

**鉴权/授权**
- [ ] 未登录访问 user 端点 401；非 owner 改他人资源 403；非 admin 访问 admin 403。
- [ ] Premium 门：无 entitlement 用 custom prompt/video → 402。
- [ ] DTO 不泄漏 `systemPrompt`/他人隐私字段。

**计费/ledger**
- [ ] dreamcoin 余额 = SUM(ledger)；不足时拒绝且不扣。
- [ ] 生成 reserve→settle/refund 净额收敛；worker 重入不重复扣退。
- [ ] webhook 幂等：重复事件只改一次状态。

**异步/队列**
- [ ] 入队→worker→完成/失败/重试/死信 状态流转。
- [ ] dedupeKey 防重复入队；handler 可重入。

**核心流程**
- [ ] explore 搜索/筛选/排序/cursor 分页（双库）。
- [ ] 发消息→入队→assistant 落库→刷新仍在（历史）。
- [ ] 创建草稿→预览→提交→出现在 My AI。
- [ ] 图片生成→状态→完成媒体进 Images。

## 5. L4 E2E（Playwright）关键流（对齐 PRD §8 漏斗 / spec §9 验收）

1. age gate → explore 浏览 → 打开角色详情。
2. 注册/登录 → `/me` 反映状态。
3. 开始聊天 → 发消息 → 刷新页面历史仍在。
4. 创建多步草稿 → 预览 → 提交 → My AI 可见。
5. 图片生成（mock provider 或本地 pipeline/sdcpp）→ 看到完成媒体。
6. upgrade → checkout(sandbox) → webhook → 权益生效（dreamcoin/entitlement）。
7. 举报内容 → admin 队列可见 → 处置。

E2E 默认用 **seed 数据 + mock provider**，跑在 preview 或本地 `next dev`；本地高保真验证可把图片 provider 切到 `pipeline`，指向 `serve:sdcpp-image` 的 OpenAI-compatible endpoint。生成相关 E2E 会轮询 worker/job 状态，允许真实图片 pipeline 的秒级耗时。artifacts（截图/视频/trace）上传 CI。

## 6. TDD 工作流（global rule）

1. 写测试（RED）→ 2. 跑（失败）→ 3. 最小实现（GREEN）→ 4. 跑（通过）→ 5. 重构 → 6. 覆盖率 ≥80%。
- service 层逻辑（额度、ledger、审核、状态机）**先写测试**。
- 不确定的复杂边界（双库、并发认领、provider SDK）先做 `demos/`（global rule Demo 驱动）验证再合并。

## 7. 覆盖率门

- 目标仍是业务核心 ≥80%，service/lib 优先；route 主要靠 L3 集成覆盖，前端组件不在本目录范围。
- `bun run --filter @idream/main coverage` 当前会执行 20 个测试文件 / 125 个测试；2026-06-25 基线为 Statements 77.89%、Branches 65.19%、Functions 83.44%、Lines 81.31%。
- CI 使用该基线作为 ratchet gate，防止覆盖率继续下降。后续目标是补齐 provider/admin/launch-readiness 分支测试，把 Statements/Lines/Functions 稳定提升到 80%+，Branches 再单独提高。

## 8. 实现现状（2026-06-15）

### 8.1 测试基础设施
- **隔离 test DB**：`vitest.config.ts` 的 `globalSetup`（`src/server/test/global-setup.ts`）在整轮测试前重置并 seed 一个专用 Postgres 测试库。与 dev/prod 数据库完全隔离。
- **顺序执行**：`fileParallelism:false` 避免多 fork 进程并发写同一测试库造成不稳定。
- **共享 helpers**（`src/server/test/helpers.ts`）：`api()` 直驱 `dispatchV1`（与 route handler 等价）、dev 认证头（`x-idream-user-id/role`，仅 `APP_ENV=test`）、fixtures（user/character/plan/media/preset/redeem code/coins）、按前缀 `purgeTestData()` 自隔离清理、`expectOk/expectError` 断言。

### 8.2 L2/L3 套件（Vitest，125 用例 / 20 文件）
| 文件 | 覆盖 |
| --- | --- |
| `modules/ourdream/safety.test.ts` | age gate / age<18 / input+output 审核 block + 事件 / 年龄验证门 / 举报+匿名+admin 处置 / underage 即时隐藏 |
| `modules/ourdream/authz.test.ts` | auth 生命周期(cookie) / 401 / 所有权 / admin 403 / DTO 不泄漏 systemPrompt / Premium 门 402 |
| `modules/ourdream/billing.test.ts` | checkout 激活权益+发币 / webhook 幂等 / ledger 不变量 |
| `modules/ourdream/flows.test.ts` | explore 搜索/筛选/排序/cursor / 聊天历史 / 创建生命周期 / 生成→图库 |
| `modules/ourdream/modules.test.ts` | age 验证 / profile / 偏好 / 语言 / redeem(恰好一次) / referral / account / library / tags / like / duplicate / preset / media bulk / feed / community / policies / events / appeals |
| `modules/ourdream/gaps.test.ts` | follow / preset PATCH / age-verification webhook / community collections |
| `modules/ourdream/chat-gen-extra.test.ts` | 聊天 list/regenerate/delete/archive / video 生成(Deluxe) / 媒体下载 / 生成 retry / billing portal |
| `jobs/queue.test.ts` | dedupe / claim / complete / fail / dead / 优先级 / backoff / 不重复认领 |
| `app/api/internal/worker/route.test.ts` | worker 端点鉴权 + `handle()` 包装 + 队列认领 |
| `lib/db/search.test.ts`、`providers/providers.test.ts` | 搜索 helper / provider mock |

覆盖率（v8，2026-06-25）：Statements 77.89% / Lines 81.31% / Functions 83.44% / Branches 65.19%。`vitest.config.ts` 以此作为 ratchet 门槛，后续只允许上调。

### 8.3 L4 E2E（Playwright，`src/e2e/*.e2e.ts`）
`flows.e2e.ts` 覆盖 §5 关键流：flow1 age gate→explore→详情、flow2 注册→鉴权(/me)（均走真实浏览器 UI）；flow3/4/5/6 聊天/生成/计费/审核走真实 Next server 的 `/api/v1`（`page.request` 共享浏览器 cookie，经真实 proxy+route handler）；外加 create/generate workspace 渲染 smoke 和 admin control-plane API smoke。
`ui-workflows.e2e.ts` 覆盖真实 UI 提交流：Create 表单提交→角色保存→`/custom` Created tab 可见；Generate 表单提交→内部 worker/job 轮询→图库出现完成媒体；Upgrade 点击 Premium monthly→订阅和 dreamcoins 生效→Premium prompt controls 解锁。
`public-routes.e2e.ts` 以成年已登录测试用户覆盖入口矩阵：`/`、`/explore`、`/create`、`/generate`、`/chat`、`/custom`、`/profile`、`/upgrade`、`/feed`、`/community`、`/terms`、`/safety/introduction`，逐页检查标题、`main`、404、坏图和 console/page error。匿名首访 age gate 由 `flows.e2e.ts` 的 flow1 单独覆盖。

> **运行方式**：E2E 默认连接已运行的 dev server（`bun run dev`，本地建议 tmux；CI 在 workflow 内后台启动并 `curl` 轮询就绪）。设 `PW_WEBSERVER=1` 可让 Playwright 自管 `next dev`。首次需 `bunx playwright install chromium`。

### 8.4 命令
```bash
bun run check                         # L1 + build（全 workspace）
bun run --filter @idream/main test    # 主站 L2/L3（Postgres + Redis）
bun run --filter @idream/chat test    # chat service + DB boundary
bun run --filter @idream/gen test     # generation/provider contracts
bun run --filter @idream/shared test  # shared contract helpers
bun run --filter @idream/main test:e2e # L4（需 dev server 在跑）
bun run --filter @idream/main coverage # coverage ratchet gate
```
