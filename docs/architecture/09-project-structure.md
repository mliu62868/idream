# 09 · 工程结构与约定

更新日期：2026-06-28

落地 01 的分层到目录结构，定义命名与"东西放哪"。原则：**按 feature/domain 组织，不按类型**；many small files；代码、测试、文档就近（global rules）。

## 1. 目录结构（as-built）

仓库是 npm workspaces monorepo（根 `package.json` 的 `workspaces: ["packages/*"]`）：

```
idream/
├─ packages/
│  ├─ main/                    # ★ 主站 Next.js 16 App（本架构主体）
│  │  ├─ prisma/
│  │  │  ├─ schema.prisma      # 主站形状 SSoT（Postgres-only）
│  │  │  ├─ migrations/        # Postgres 迁移（prod DDL SSoT）
│  │  │  └─ seed.ts            # 幂等 seed（03 §6）
│  │  ├─ proxy.ts              # Next 16 Proxy：安全头 + age-gate 乐观重定向 + anonymousId
│  │  └─ src/
│  │     ├─ app/
│  │     │  ├─ (public)/       # 公开 SEO 页（SSR/预渲染，Cache Components）
│  │     │  ├─ (app)/          # 鉴权产品页（dynamic, noindex）
│  │     │  └─ api/
│  │     │     ├─ v1/[...resource]/route.ts   # 唯一 catch-all → dispatchV1
│  │     │     ├─ auth/[...all]/route.ts      # better-auth handler
│  │     │     └─ internal/worker/route.ts    # Cron/after 触发，内部密钥保护
│  │     ├─ components/        # 前端（ourdream/*, admin/*, ui/*）
│  │     ├─ hooks/  lib/       # 前端工具（cn 等、lib/utils.ts）
│  │     ├─ processes/         # 常驻进程：event-consumer、finalizer
│  │     ├─ e2e/  types/       # e2e 用例 / 共享类型
│  │     └─ server/            # ★ 后台核心
│  │        ├─ modules/
│  │        │  ├─ ourdream/service.ts  # 产品域 mega-module（dispatchV1）+ 就近 *.test.ts
│  │        │  └─ admin/               # service.ts + characters/（official/templates/tags/review/assist）
│  │        ├─ jobs/queue.ts   # JobQueue + claim
│  │        ├─ providers/      # index.ts(按 env 注册含 mock) + chat/image/video/voice/moderation/payment/blob/verify
│  │        ├─ bff/chat-proxy.ts   # 签名 + 反向代理到 Chat Service
│  │        ├─ ai/             # local-pipeline、schemas
│  │        ├─ admin/          # permissions、effective-permissions、dev-login
│  │        └─ lib/
│  │           ├─ db.ts        # PrismaClient 单例
│  │           ├─ db/search.ts # provider 感知 nameMatch
│  │           ├─ env.ts       # Zod 校验的 env（SSoT）
│  │           ├─ constants.ts # DB_PROVIDER / enum 取值 / 价格 / 配置 SSoT
│  │           ├─ errors.ts    # AppError + Errors
│  │           ├─ logger.ts    # pino
│  │           ├─ better-auth.ts  prisma-adapter.ts
│  │           ├─ auth/        # getAuthCtx, guards
│  │           └─ http/        # envelope（ok/fail/empty）+ handle 包装器
│  ├─ chat/                    # Chat Service（独立服务，独立 prisma/ + Postgres schema/views）
│  ├─ gen/                     # 生成 worker（image/video/voice pipeline）
│  ├─ admin/                   # Admin 控制台（独立 Next App，src/app）
│  └─ shared/                  # 跨包契约/类型（bff/chat/contracts/media/moderation/storage）
└─ docs/architecture/          # 本目录
```

## 2. 分层与依赖规则（强约束）

| 谁 | 能 import 谁 |
| --- | --- |
| `app/api/v1/[...resource]/route.ts` | 仅 `modules/ourdream/service.ts` 的 `dispatchV1` |
| `modules/ourdream/service.ts`、`modules/admin/*` | `lib/db`（直接用 Prisma）、`lib/*`、`providers/*`、`server/bff`、`jobs/queue` |
| `providers/*` | SDK、`lib/*`（除业务模块） |
| `lib/*` | 仅彼此与基础库，**不 import 任何 modules** |
| 跨包 | 经 `packages/shared` 共享契约；chat 经 `server/bff/chat-proxy` 代理，不直连 |

**禁止**：catch-all route 写业务逻辑或直接用 Prisma；provider/lib import 业务模块；主站直接读写 Chat Service 权威表；循环依赖（用事件/job 打破）。

> 可用 ESLint `no-restricted-imports` / `eslint-plugin-boundaries` 把以上规则**机器化**（10 §CI）。

## 3. 命名约定

- 文件：`kebab-case`；产品域聚合在 `ourdream/service.ts`，就近 `*.test.ts`；admin 子域按 `characters/<topic>.ts` + `<topic>.test.ts`。
- 导出：**命名导出**（不用 default，除 Next 约定的 page/route 文件）。
- 类型/接口：PascalCase；函数/变量：camelCase；常量枚举值：lower_snake（与 DB 字符串一致）。
- DTO 函数：`toPublicDTO` / `toOwnerDTO` / `toAdminDTO`（按可见层级）。
- Prisma model PascalCase 单数 + `@@map("snake_case")`（03）。

## 4. 关键单例与边界

### 4.1 PrismaClient 单例（serverless 必须）

```ts
// packages/main/src/server/lib/db.ts
import { PrismaClient } from "@prisma/client";
const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.prisma = prisma;   // 防 HMR/热重载连接泄漏
```

prod Postgres 连接走 **pooled URL**（PgBouncer/Neon pooled）；`migrate` 走 direct URL（10 §3）。

### 4.2 env（Zod，fail-fast）

```ts
// packages/main/src/server/lib/env.ts
import { z } from "zod";
import { DB_PROVIDER } from "./constants";   // DB_PROVIDER = "postgresql" as const
const Env = z.object({
  DATABASE_URL: z.string().url(),
  DB_PROVIDER: z.literal(DB_PROVIDER).default(DB_PROVIDER),   // Postgres-only
  BETTER_AUTH_SECRET: z.string().min(32),
  INTERNAL_TOKEN: z.string().min(16),
  CRON_SECRET: z.string().min(16),
  // providers（按需，dev 可空走 mock）
  CHAT_PROVIDER_URL: z.string().url().optional(),
  // ...支付/存储/审核/验证/Upstash 见 10 §2
});
export const env = Env.parse(process.env);   // 启动即校验，缺失即崩
```

### 4.3 constants（enum SSoT）

所有 `/// enum:` 取值在此单点定义并被 Zod / schema / DTO 复用：

```ts
// packages/main/src/server/lib/constants.ts
export const DB_PROVIDER = "postgresql" as const;   // Postgres-only（dev/prod 一致）
export const VISIBILITY = ["private","unlisted","public"] as const;
export const CHARACTER_STATUS = ["draft","pending_review","approved","rejected","removed","archived"] as const;
export const JOB_STATUS = ["queued","running","completed","failed","dead"] as const;
// ... gender/style/message status/report category/policy code 等
```

## 5. 加一个 endpoint（as-built）

不新建 `route.ts`，而是在 mega-module 里加 handler + 在 `dispatchV1` 注册一条分发规则：

```ts
// modules/ourdream/service.ts
import { prisma } from "@/server/lib/db";       // service 直接用 Prisma（无 repository 层）
import { ok } from "@/server/lib/http";
import { Errors } from "@/server/lib/errors";

// 1) 写 handler（自取 ctx、校验、直接读写 Prisma、统一 envelope 返回）
async function doThing(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const input = inputSchema.parse(await request.json());
  // 业务规则 + 事务 + 入队/埋点
  return ok(await prisma.thing.create({ /* ... */ }));
}

// 2) 在 dispatchV1Unsafe 里按 resource/id/action/method 注册
//    if (resource === "things" && !id && method === "POST") return doThing(request);
```

catch-all `app/api/v1/[...resource]/route.ts` 已固定（`GET/POST/PATCH/PUT/DELETE` 都转 `dispatchV1`），无需改动。错误由 `dispatchV1` 顶层 try/catch 统一转 envelope。

## 6. 可观测性约定（埋点/日志）

- 日志：`lib/logger.ts`（pino），结构化、带 requestId；**禁 `console.log`**（global rule，hook 检测）。
- 埋点：`events.track(name, props, ctx)` 经 `after()` 异步，覆盖 PRD §9 事件（详见 10 §可观测性）。
- 错误：service 抛 `AppError`，route `handle()` 统一处理，详情只进服务端日志（04 §3）。
