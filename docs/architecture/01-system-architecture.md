# 01 · 系统架构

更新日期：2026-06-18

## 1. 架构风格：模块化单体 + Chat Service 独立边界

主站保持单仓、单部署、按业务模块（domain module）内聚分层。Chat 按独立服务边界设计：它拥有聊天域数据库能力，可以先在同仓/同库里落地，但热路径不再由主站写 chat 表或做 chat finalizer。

为什么：

- **KISS / YAGNI**：前端已是 Next 16，用同一个 App 提供 API 最省心；Vercel 原生支持。
- **Orthogonality**：主站 core domain 与 chat domain 通过只读 view 和 outbox 事件解耦，Chat 可独立扩展。
- **重活异步化**：聊天生成、图片/视频生成、审核、webhook 处理都走异步 job（见 06），所以同步 HTTP 路径很短，serverless 超时风险低，不需要长驻服务。

```
┌──────────────────────────────────────────────────────────────────┐
│                        Next.js 16 App (单部署)                      │
│                                                                    │
│  app/(public)/*          公开 SEO 页（SSR/预渲染，Cache Components） │
│  app/(app)/*             鉴权后产品页（dynamic）                     │
│  app/api/v1/*/route.ts   Route Handlers（产品 API）                 │
│  app/api/internal/*      内部 worker / cron 端点（共享密钥保护）      │
│  proxy.ts                轻量边缘检查（age gate cookie、安全 header） │
│         │                                                          │
│         ▼                                                          │
│  src/server/                  ← 后台核心（本架构主体）               │
│   ├─ modules/<domain>/        每个业务模块自洽（见 §3、09）          │
│   │    ├─ *.service.ts        业务逻辑 + 事务 + 鉴权断言             │
│   │    ├─ *.repository.ts     Prisma 数据访问（唯一碰 db 的层）      │
│   │    ├─ *.schema.ts         Zod 入参/出参契约                      │
│   │    └─ *.types.ts          模块内类型                            │
│   ├─ jobs/                    队列定义 + worker handler             │
│   ├─ providers/               外部供应商抽象（AI/支付/存储/验证）     │
│   ├─ lib/                     横切（auth、db、errors、ratelimit…）   │
│   └─ events/                  分析事件总线                          │
└──────────────────────────────────────────────────────────────────┘
        │ Prisma Client（单例）                  │ Provider SDK
        ▼                                        ▼
   PostgreSQL(prod) / SQLite(dev)         AI / PSP / Blob / Verify / Redis
```

Chat 目标拓扑：

```text
Main Site owns:
  identity, compliance, catalog/characters, creator, billing, generation, media, safety/admin, SEO

Chat Service owns:
  chat_sessions, messages, message_versions, chat_usage,
  companion_memories, relationship_states, chat stream, chat outbox

Chat Service reads only:
  core.chat_user_view
  core.chat_character_view
  billing.chat_entitlement_view
  compliance.chat_user_eligibility_view
```

## 2. 分层与依赖方向

严格单向依赖，**禁止反向**（repository 不得 import service，service 不得 import route）：

```
route handler ─▶ service ─▶ repository ─▶ Prisma Client ─▶ DB
     │              │            
     │              └─▶ provider 抽象（AI/PSP/Blob/Verify）
     │              └─▶ job queue（入队，不在请求内做重活）
     │              └─▶ event bus（埋点，fire-and-forget）
     └─▶ lib/auth（解析 session）、lib/ratelimit、lib/http（envelope/error）
```

| 层 | 唯一职责 | 不允许 |
| --- | --- | --- |
| **Route Handler** (`app/api/.../route.ts`) | HTTP 适配：解析请求、Zod 校验、调 service、用统一 envelope 返回；鉴权/限流装饰 | 写业务逻辑、直接用 Prisma |
| **Service** (`*.service.ts`) | 业务规则、跨表事务、权限断言、入队 job、发埋点；可组合其它 service | 碰 `Request`/`Response`、写 SQL |
| **Repository** (`*.repository.ts`) | 用 Prisma 读写单一聚合；查询构造、分页 | 业务规则、调用其它模块 |
| **Provider** (`providers/*`) | 把外部供应商封装成稳定接口；处理 SDK、重试、签名 | 业务规则 |
| **lib/** | 横切能力（auth、db 单例、错误、限流、日志、ID、加密、env） | 业务规则 |

> 这套分层同时满足全局规则里的 Repository Pattern 与 SSoT：业务逻辑在 service 单点、数据访问在 repository 单点。

## 3. 模块清单与依赖

模块边界对齐 `BackendFeatureSpec.md §2`。下表是技术归属（每个模块 = `src/server/modules/<name>/`）：

| 模块 | 目录 | 依赖 | P0 |
| --- | --- | --- | --- |
| identity | `modules/identity` | lib/auth | ✅ |
| compliance（age gate + age verification） | `modules/compliance` | identity, providers/verify | ✅ |
| catalog（角色目录/搜索/筛选/标签/统计） | `modules/catalog` | — | ✅ |
| chat | `modules/chat` or Chat Service | read-only core/billing/compliance views, safety policy, providers/chat | ✅ |
| creator（草稿/预览/提交/审核态） | `modules/creator` | catalog, safety, jobs, providers/image | ✅ |
| generation（图/视频任务、presets） | `modules/generation` | catalog, billing(dreamcoin), safety, jobs, providers/image,video | ✅(先图) |
| media（图库 like/manage/download） | `modules/media` | providers/blob | ✅(基础) |
| billing（计划/订阅/权益/dreamcoin） | `modules/billing` | identity, providers/payment, jobs | ✅ |
| safety（审核/举报/申诉/政策） | `modules/safety` | jobs, providers/moderation | ✅ |
| library（My AI 各 tab 聚合） | `modules/library` | catalog, chat, media, generation | ✅(基础) |
| profile（资料/偏好/语言/兑换码/推荐/账号） | `modules/profile` | identity, billing | P0/P1 |
| feed（推荐流 + 互动） | `modules/feed` | catalog, media, safety | P1 |
| community（榜单/创作者/collections） | `modules/community` | catalog, profile | P1 |
| seo（路由内容/文章/比较页 metadata） | `modules/seo` | — | P1 |
| support（helpdesk 映射） | `modules/support` | — | P1 |
| analytics（产品事件/漏斗） | `src/server/events` | — | P0 轻量 |
| admin（审核后台/用户内容任务管理） | `modules/admin` | safety, catalog, billing, identity | P0 内部 |

**依赖治理规则**：

- 跨模块只能 `import` 对方的 `*.service.ts`（公开 API），禁止跨模块 import 对方 repository。
- 出现双向依赖时，下沉公共概念到 `lib/` 或用 **事件/job** 解耦（如 billing 完成 → 发事件 → library 刷新）。
- 共享读模型（如"角色卡 DTO"）放对应模块的 `*.types.ts` 并导出。
- Chat 是特殊边界：主站可以调用/代理 Chat API，也可以消费 Chat outbox；主站不直接写 Chat Service 权威表。Chat 可以只读主站 User/Character/Entitlement/Eligibility view，但不能写主站权威表。

## 4. 请求生命周期

### 4.1 典型读请求（Explore 列表 `GET /api/v1/characters`）

```
Client
  │  fetch（带 session cookie / age gate cookie）
  ▼
proxy.ts          安全 header；可选 age-gate 乐观检查（不做最终鉴权）
  ▼
route.ts GET      ratelimit(ip) → parse query(Zod) → 调 catalog.service.listPublic()
  ▼
catalog.service   断言 age gate 已接受（从 lib/auth 读 ctx）→ catalog.repository.search()
  ▼
catalog.repo      Prisma 查询（cursor 分页、tag 过滤、可见性=public+approved）
  ▼
route.ts          ok(envelope, { items, nextCursor })  +  after(()=>events.track('explore_...'))
```

### 4.2 典型写请求（发消息 `POST /api/v1/chat/sessions/:id/messages`）

Chat 写请求进入 Chat Service。主站可以作为 BFF 验证 session cookie 并代理请求，但不写 `chat_sessions/messages/memories/relationships`，也不做 chat finalizer。

```
Browser ─▶ Main BFF/API Gateway ─▶ Chat Service
                                ├─ verify signed user context
                                ├─ read core.chat_user_view
                                ├─ read compliance.chat_user_eligibility_view
                                ├─ read billing.chat_entitlement_view
                                ├─ read core.chat_character_view
                                ├─ moderation.input(content)
                                ├─ transaction:
                                │    insert user message
                                │    insert assistant placeholder
                                │    update session.lastMessageAt
                                ├─ enqueue internal chat.generate
                                └─ return {assistantMessageId, streamUrl}

Chat worker:
  recent messages + memory + relationship + character persona
  → ChatModel.stream
  → Redis Stream / SSE
  → moderation.output
  → transaction:
       update assistant message + version
       increment chat_usage
       apply memory / relationship
       insert chat outbox events
```

### 4.3 webhook（支付/验证 provider）

`POST /api/v1/billing/webhooks/:provider` → **先验签** → 落 `provider_events`（按 event id 去重，幂等）→ 入队 `billing.webhook` → 立即 200。worker 再更新订阅/权益/ledger（见 08）。

## 5. Next.js 16 落地要点（破坏性变更）

> AGENTS.md 警告：这不是你熟悉的 Next.js。以下基于本地 `node_modules/next/dist/docs/` 16.2 文档。

| 能力 | Next 16 现状 | 我们的用法 |
| --- | --- | --- |
| **Proxy**（原 middleware） | `proxy.ts` 根/`src` 一个文件；官方明确**不要**用于"完整会话管理或鉴权" | 只做：安全 header、age-gate cookie 的**乐观**重定向、维护匿名 `anonymous_id`。真正鉴权在 service 层。 |
| **Route Handlers** | `app/api/.../route.ts`，Web `Request/Response`；非 GET 默认不缓存 | 全部产品 API；统一 envelope；`export const dynamic` 控制缓存 |
| **`after()`** (`next/server`) | 响应后执行副作用，受路由 `maxDuration` 约束 | 埋点、轻量日志、**触发**（非执行）job；**不**放长任务 |
| **`connection()`** | 替代 `unstable_noStore`，强制运行时渲染 | 动态产品页/handler 里需要时调用 |
| **Cache Components** | `use cache` + `cacheLife` + `cacheTag`，GET handler 也走同模型 | 公开 SEO 页、角色目录读模型缓存；角色更新 `revalidateTag('character:'+id)` |
| `maxDuration` | route segment config | 给 worker/流式 handler 配置更长超时（见 06/10） |

关键纪律：

- **鉴权绝不放 proxy**。proxy 里 `fetch` 的 cache 选项无效、且不适合慢数据。
- worker/cron 端点放 `app/api/internal/*`，用 `CRON_SECRET` / `INTERNAL_TOKEN` 头校验，`proxy.ts` 的 matcher 排除它们。
- SSE 流式聊天用 Route Handler 返回 `ReadableStream`（`text/event-stream`），见 04 §8。

## 6. 数据流与一致性

- **强一致**（同库事务）：下单扣 dreamcoin（reserve）、创建角色、改可见性等用 `prisma.$transaction`。
- **最终一致**（跨副作用）：生成结果落库 → 发事件 → 刷新 library 读模型 / 失效缓存；webhook → 权益同步。
- **dreamcoin / 订阅**：**append-only ledger 派生余额**，绝不直接覆盖余额字段（见 08 §4）。
- **审计**：审核决定、申诉、ledger、provider 事件均不可变（insert-only），保留 policy_code 与时间。

## 7. 部署拓扑

```
                 ┌─────────── Vercel Project ───────────┐
   用户 ──HTTPS──▶│ Edge/Proxy → Functions(Fluid Compute) │
                 │   - 公开页(预渲染/ISR)                  │
                 │   - 产品 API (Node runtime)            │
                 │   - /api/internal/worker (Cron 触发)   │
                 └───────┬───────────────┬───────────────┘
                         │               │
              Prisma(pooled URL)   Provider SDK（HTTPS）
                         │               │
        ┌────────────────▼───┐   ┌───────▼──────────────────────────┐
        │ PostgreSQL (Neon)   │   │ AI 模型托管 / PSP / Blob(R2) /     │
        │  - pooled (app)     │   │ 年龄验证 / Upstash Redis(限流)     │
        │  - direct (migrate) │   └──────────────────────────────────┘
        └─────────────────────┘

                 ┌──────────── Chat Service ────────────┐
                 │ Chat API / SSE / chat workers         │
                 │ read-only core views + write chat.*   │
                 └───────────────────────────────────────┘

   dev：本地 `next dev` + SQLite 文件 + provider 的 mock/sandbox 实现
```

- **主部署 Vercel**：Fluid Compute（Node.js，非 edge-only），默认函数超时已放宽（见知识更新）；Cron 触发 worker。
- **备选 Docker**：`next.config.ts` 已 `output: "standalone"`，配 `docker-compose.yml` 可自托管（见 10）。
- **数据库**：prod 用 Neon/Supabase（Vercel Marketplace，**Vercel Postgres 已下线**）；app 走 pooled 连接，migrate 走 direct 连接。
- 详细环境矩阵、env 变量、连接池与迁移 runbook 见 [10-operations.md](./10-operations.md)。

## 8. 架构不变量（Invariants，写代码时反复自检）

1. 只有 repository 碰 Prisma；其它层碰 db 即违规。
2. 同步 HTTP 路径不调用 AI / 不做重 IO；重活入队。
3. 余额/额度类数值由 ledger/usage 表派生，不可就地覆盖。
4. 一切用户可见内容（角色、媒体、消息、feed）可被举报且能进审核队列。
5. 成人内容前必过 age gate；受限司法辖区必过身份验证。
6. 客户端传来的 plan / 权益一律不可信，服务端按 entitlements 判定。
7. provider 回调先验签、再幂等落库、最后入队处理。
8. schema 只用 SQLite + Postgres 双方都支持的特性子集（见 03 §2）。
9. Chat Service 只读主站 User/Character/Entitlement/Eligibility view，只写 chat domain 表。
