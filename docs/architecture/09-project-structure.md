# 09 · 工程结构与约定

更新日期：2026-06-13

落地 01 的分层到目录结构，定义命名与"东西放哪"。原则：**按 feature/domain 组织，不按类型**；many small files；代码、测试、文档就近（global rules）。

## 1. 目录结构（在现有基线上新增）

```
idream/
├─ prisma/
│  ├─ schema.prisma            # 形状 SSoT（可拆 schema/*.prisma 多文件）
│  ├─ migrations/              # Postgres 迁移（prod DDL SSoT）
│  └─ seed.ts                  # 幂等 seed（03 §6）
├─ prisma.config.ts            # Prisma 7 配置：schema 路径 + datasource.url=env()
├─ proxy.ts                    # Next 16 Proxy：安全头 + age-gate 乐观重定向 + anonymousId
├─ scripts/
│  ├─ db-provider.mjs          # 切 datasource.provider（03 §7）
│  └─ ...                      # 既有资产脚本
├─ src/
│  ├─ app/
│  │  ├─ (public)/             # 公开 SEO 页（SSR/预渲染，Cache Components）
│  │  ├─ (app)/                # 鉴权产品页（dynamic, noindex）
│  │  ├─ api/
│  │  │  ├─ v1/<resource>/route.ts
│  │  │  └─ internal/{worker,cron}/route.ts
│  │  ├─ layout.tsx page.tsx globals.css   # 既有
│  ├─ components/              # 既有前端（ourdream/*, ui/*）——不在后台范围
│  ├─ hooks/  lib/utils.ts     # 既有前端工具（cn 等）
│  ├─ types/                   # 既有共享类型
│  └─ server/                  # ★ 后台核心（本架构主体）
│     ├─ modules/
│     │  └─ <domain>/          # identity, compliance, catalog, chat, creator,
│     │     ├─ <domain>.service.ts        #   generation, media, billing, safety,
│     │     ├─ <domain>.repository.ts     #   library, profile, feed, community,
│     │     ├─ <domain>.schema.ts         #   seo, support, admin
│     │     ├─ <domain>.types.ts
│     │     └─ <domain>.service.test.ts   # 就近单测
│     ├─ jobs/
│     │  ├─ queue.ts           # JobQueue 接口 + DB 实现 + claim(pg/sqlite)
│     │  └─ handlers/<queue>.ts# 各队列 handler
│     ├─ providers/
│     │  ├─ index.ts           # 按 env 注册（含 mock）
│     │  ├─ chat/ image/ video/ voice/ moderation/
│     │  ├─ payment/ blob/ verify/
│     ├─ events/               # analytics 事件总线（track）
│     └─ lib/
│        ├─ db.ts              # PrismaClient 单例
│        ├─ env.ts             # Zod 校验的 env（SSoT）
│        ├─ constants.ts       # 全部 enum 取值 / 价格 / 配置 SSoT
│        ├─ errors.ts          # AppError + Errors
│        ├─ pricing.ts         # dreamcoin 价格表
│        ├─ pagination.ts      # cursor 编解码
│        ├─ ratelimit.ts       # RateLimiter（dev DB / prod Upstash）
│        ├─ logger.ts          # pino
│        ├─ auth/              # getAuthCtx, guards, better-auth 配置
│        ├─ http/              # envelope, handle 包装器
│        └─ db/search.ts       # provider 感知 nameMatch（双库收敛）
└─ docs/architecture/          # 本目录
```

## 2. 分层与依赖规则（强约束）

| 谁 | 能 import 谁 |
| --- | --- |
| `app/api/**/route.ts` | 本资源对应模块的 `*.service.ts`、`lib/http`、`lib/auth` |
| `modules/X/*.service.ts` | 本模块 repository/schema/types、其它模块的 **service**、`lib/*`、`providers/*`、`jobs/queue` |
| `modules/X/*.repository.ts` | `lib/db`、本模块 types |
| `providers/*` | SDK、`lib/*`（除业务模块） |
| `lib/*` | 仅彼此与基础库，**不 import 任何 modules** |

**禁止**：route 直接用 Prisma；跨模块 import 对方 repository；repository import service；lib import modules；循环依赖（用事件/job 打破）。

> 可用 ESLint `no-restricted-imports` / `eslint-plugin-boundaries` 把以上规则**机器化**（10 §CI）。

## 3. 命名约定

- 文件：`kebab-case` 或 `<domain>.<role>.ts`（service/repository/schema/types/test）。
- 导出：**命名导出**（不用 default，除 Next 约定的 page/route 文件）。
- 类型/接口：PascalCase；函数/变量：camelCase；常量枚举值：lower_snake（与 DB 字符串一致）。
- DTO 函数：`toPublicDTO` / `toOwnerDTO` / `toAdminDTO`（按可见层级）。
- Prisma model PascalCase 单数 + `@@map("snake_case")`（03）。

## 4. 关键单例与边界

### 4.1 PrismaClient 单例（serverless 必须）

```ts
// src/server/lib/db.ts
import { PrismaClient } from "@prisma/client";
const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.prisma = prisma;   // 防 HMR/热重载连接泄漏
```

prod Postgres 连接走 **pooled URL**（PgBouncer/Neon pooled）；`migrate` 走 direct URL（10 §3）。

### 4.2 env（Zod，fail-fast）

```ts
// src/server/lib/env.ts
import { z } from "zod";
const Env = z.object({
  DATABASE_URL: z.string().url(),
  DB_PROVIDER: z.enum(["sqlite","postgresql"]).default("postgresql"),
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
// src/server/lib/constants.ts
export const VISIBILITY = ["private","unlisted","public"] as const;
export const CHARACTER_STATUS = ["draft","pending_review","approved","rejected","removed","archived"] as const;
export const JOB_STATUS = ["queued","running","completed","failed","dead"] as const;
// ... gender/style/message status/report category/policy code 等
```

## 5. 模块骨架模板（新模块照抄）

```ts
// modules/<domain>/<domain>.service.ts
import { prisma } from "@/server/lib/db";
import { getAuthCtx, requireUser } from "@/server/lib/auth";
import { Errors } from "@/server/lib/errors";
import * as repo from "./<domain>.repository";
export async function doThing(ctx: AuthCtx, input: Input) {
  const user = requireUser(ctx);
  // 业务规则 + 事务 + 入队/埋点
  return repo.create(/* ... */);
}
```

```ts
// app/api/v1/<resource>/route.ts
import { handle, ok } from "@/server/lib/http";
import { getAuthCtx } from "@/server/lib/auth";
import * as svc from "@/server/modules/<domain>/<domain>.service";
export const POST = handle(async (req) => {
  const ctx = await getAuthCtx();
  const input = inputSchema.parse(await req.json());
  return ok(await svc.doThing(ctx, input));
});
```

## 6. 可观测性约定（埋点/日志）

- 日志：`lib/logger.ts`（pino），结构化、带 requestId；**禁 `console.log`**（global rule，hook 检测）。
- 埋点：`events.track(name, props, ctx)` 经 `after()` 异步，覆盖 PRD §9 事件（详见 10 §可观测性）。
- 错误：service 抛 `AppError`，route `handle()` 统一处理，详情只进服务端日志（04 §3）。
