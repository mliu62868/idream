# 10 · 运维：环境 · 部署 · 迁移 · CI · 可观测性

更新日期：2026-06-13

## 1. 环境矩阵

| 环境 | DB | provider 实现 | 用途 |
| --- | --- | --- | --- |
| **local dev** | SQLite 文件 | mock（AI/支付/存储/验证） | 零依赖快速开发；`db push` + seed |
| **local dev (高保真，可选)** | Docker Postgres | mock 或 sandbox | 验证 Postgres 迁移/搜索差异 |
| **preview**（Vercel PR） | Neon 分支库 | sandbox（BTCPay testnet / mock） | 每 PR 隔离预览 |
| **production** | Neon/Supabase Postgres | 真实（加密处理器 / 自托管模型流水线 / R2 / Upstash） | 线上 |

> dev→prod 的双库差异（搜索、SKIP LOCKED）收敛在 `lib/db/search.ts` 与 `jobs/queue.ts` 的 provider 分支，并在 CI 两库都跑测试（§5）。

## 2. 环境变量目录

`.env`（dev）/ Vercel 环境变量（preview/prod）。**全部经 `lib/env.ts` Zod 校验，缺失即 fail-fast**。提供 `.env.example`。

| 变量 | 环境 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | all | dev=`file:./dev.db`；prod=Neon **pooled** URL |
| `DIRECT_URL` | prod | Neon **direct** URL（迁移用，绕过 pooler） |
| `DB_PROVIDER` | all | `sqlite` / `postgresql`（驱动 §3 与搜索/队列分支） |
| `BETTER_AUTH_SECRET` | all | ≥32 字节随机 |
| `BETTER_AUTH_URL` | all | 站点 URL |
| `INTERNAL_TOKEN` | all | 保护 `/api/internal/*` |
| `CRON_SECRET` | prod | Vercel Cron 调用校验 |
| `UPSTASH_REDIS_REST_URL`/`_TOKEN` | prod | 限流（dev 可空走 DB 令牌桶） |
| `PAYMENT_PROVIDER` + 处理器密钥 | prod | 加密处理器（BTCPay：host+API key+store id+webhook secret / NOWPayments：API key+IPN secret） |
| `PIPELINE_API_URL` / `PIPELINE_API_TOKEN` | prod | 内部自托管开源模型流水线（chat/image/video/voice 共用，OpenAI 兼容；dev 可空走 mock） |
| `MODERATION_PROVIDER_*` | prod | 审核/CSAM 检测（**独立密钥/服务**，07 §3） |
| `BLOB_*`（R2/S3 endpoint, key, bucket） | prod | 私有对象存储 |
| `AGE_VERIFY_PROVIDER_*` | prod | Go.cam 等 |
| `SENTRY_DSN` | prod | 错误追踪 |

`prisma.config.ts`（Prisma 7）：

```ts
import "dotenv/config";
import { defineConfig, env } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },     // provider 在 schema，由脚本切换
});
```

## 3. 数据库与连接池

- **prod**：Neon（或 Supabase）—— Vercel Postgres 已下线，走 **Vercel Marketplace**。
- **连接**：app（serverless）用 **pooled** 连接（`DATABASE_URL`，PgBouncer/Neon pooler，防连接耗尽）；`migrate` 用 **direct** 连接（`DIRECT_URL`）。
- PrismaClient 单例（09 §4.1）防 HMR/函数复用泄漏。
- 规模上来可选 **Prisma Accelerate** 或 driver adapter 进一步池化/缓存。

## 4. 部署

### 4.1 Vercel（主）
- Fluid Compute（Node.js，非 edge-only；中间件/函数底层即 Functions）。
- `next.config.ts` 已 `output:"standalone"`（亦利于 Docker）。
- **Cron**（`vercel.ts` 或 `vercel.json`）：

```ts
// vercel.ts（Next 16 推荐）
import type { VercelConfig } from "@vercel/config/v1";
export const config: VercelConfig = {
  framework: "nextjs",
  crons: [
    { path: "/api/internal/cron/drain",   schedule: "* * * * *" },   // 每分钟 drain 队列
    { path: "/api/internal/cron/cleanup",  schedule: "0 * * * *" },   // 清理过期 session/软删媒体
    { path: "/api/internal/cron/usage",    schedule: "0 0 * * *" },   // 周期额度结算
  ],
};
```

- worker/cron handler 校验 `CRON_SECRET`/`INTERNAL_TOKEN`，`proxy.ts` matcher 排除 `/api/internal`。
- 长任务/流式 route 配 `maxDuration`（route segment config）。

### 4.2 Docker（备选自托管）
- 既有 `Dockerfile` + `docker-compose.yml`：app + Postgres。Cron 用容器内调度（如 `node-cron` 触发 drain，或外部 cron 调 `/api/internal`）。

## 5. CI/CD（`.github/workflows`）

流水线（对齐 global verify 体系 L1–L4）：

```
1. install (node 24, 缓存)
2. db:generate (DB_PROVIDER=postgresql)
3. lint (eslint，含 import 边界规则 09 §2)
4. typecheck (tsc --noEmit)
5. test:sqlite   (DB_PROVIDER=sqlite db push + vitest)        # L2/L3
6. test:postgres (docker postgres + migrate deploy + vitest)  # 双库都验证！
7. build (next build)
8. (PR) Vercel preview 自动部署 → e2e:preview (playwright)    # L4
9. (main) migrate deploy (prod, direct URL) → 部署
```

- **迁移在部署前于 CI 跑** `prisma migrate deploy`（prod direct URL），失败则阻断发布。
- `npm run check`（已存在 = lint+typecheck+build）作为本地最小门。
- 数据库迁移 SQL **只能由具备权限者/CI 执行**（global rule：模式变更 SQL 由用户/CI 跑，Claude 只产出）。

## 6. 迁移 Runbook

| 操作 | 命令 | 谁执行 |
| --- | --- | --- |
| dev 改 schema | `npm run db:push`（sqlite，无迁移文件） | 开发者 |
| 生成 prod 迁移 | `npm run db:migrate:dev`（Docker PG，产生迁移文件，提交 git） | 开发者 |
| 加 Postgres-only 索引 | 在迁移目录手写 raw SQL（pg_trgm 等，03 §5） | 开发者 |
| 部署迁移 | `npm run db:migrate:deploy`（prod direct URL） | CI |
| 回滚 | 写"down"迁移或新正向修复迁移（Prisma 不自动回滚） | CI + 评审 |

**破坏性变更**（删列/改类型）：分两步（先兼容加列/双写 → 迁移数据 → 再删旧），避免停机。

## 7. 备份与容灾

- Neon/Supabase 自带 PITR/快照；设保留期。
- 对象存储（R2）跨区/版本化。
- ledger/审核/CSAM 证据等审计数据**长期保留**（07 §6/§3）。
- 定期演练恢复。

## 8. 可观测性

### 8.1 日志
- `lib/logger.ts`（pino）结构化 JSON，带 `requestId`/`userId`(脱敏)/`route`；**禁 console.log**（global rule + hook）。
- 不记明文密码/token/敏感聊天内容（07 §6）。

### 8.2 错误追踪
- Sentry（prod），关联 requestId；`handle()` 兜底未捕获异常。

### 8.3 产品埋点（PRD §9）
- `events.track(name, props, ctx)` → `after()` 异步 → `analytics_events` 表 +/或外发分析平台。
- 覆盖事件：age_gate_viewed/accepted、signup/login_clicked、character_card_viewed/clicked、explore_filter/search、category_selected、chat_started、message_sent、character_create_started/created、generation_started/completed/failed、media_liked/managed、feed_*、upgrade_viewed、checkout_started、subscription_started、referral/redeem、content_reported、moderation_appeal_started。

### 8.4 运营指标 / 漏斗（PRD §9、§10）
- 转化漏斗：age gate 通过率、首页→注册、卡片点击率、搜索/筛选使用、首聊启动、创建完成率、生成成功率、免费→付费、举报处理时长。
- 系统健康：队列积压/死信、生成成功率与时延、provider 错误率、限流命中、DB 连接数。
- 仪表盘可先用 SQL/Studio 看 `analytics_events`+`jobs`，再接 BI。

### 8.5 告警
- `jobs.status=dead` 增长、生成成功率骤降、webhook 处理失败、CSAM 命中（高优先级人工通道）、错误率/延迟阈值。
