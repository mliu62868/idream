# 01 · 系统架构

更新日期：2026-06-28

## 1. 架构风格：模块化单体 + Chat Service 独立边界

整个仓库是 npm workspaces monorepo（`packages/{main,chat,gen,admin,shared}`）。主站（`packages/main`）按业务域内聚、单部署。Chat 已**物理拆分**为独立服务（`packages/chat`），拥有自己的聊天域 Postgres schema/视图；主站不再写 chat 表、也不做 chat finalizer，只通过 BFF 代理（`server/bff/chat-proxy`）与 outbox 事件与之交互。

为什么：

- **KISS / YAGNI**：前端已是 Next 16，用同一个 App 提供 API 最省心；Vercel 原生支持。
- **Orthogonality**：主站 core domain 与 chat domain 通过只读 view 和 outbox 事件解耦，Chat 可独立扩展。
- **重活异步化**：聊天生成、图片/视频生成、审核、webhook 处理都走异步 job（见 06），所以同步 HTTP 路径很短，serverless 超时风险低，不需要长驻服务。

```
┌──────────────────────────────────────────────────────────────────┐
│              Monorepo（npm workspaces：packages/*）                  │
│  packages/main    主站 Next.js 16 App（单部署，本架构主体）          │
│  packages/chat    Chat Service（独立服务 + 独立 Postgres schema）    │
│  packages/gen     生成 worker（图/视频/语音 pipeline）              │
│  packages/admin   Admin 控制台（独立 Next App）                     │
│  packages/shared  跨包共享契约/类型（bff/chat/contracts/media…）    │
└──────────────────────────────────────────────────────────────────┘

packages/main 内部：
┌──────────────────────────────────────────────────────────────────┐
│  src/app/(public)/*       公开 SEO 页（SSR/预渲染，Cache Components）│
│  src/app/(app)/*          鉴权后产品页（dynamic）                    │
│  src/app/api/v1/[...resource]/route.ts                             │
│                           单一 catch-all → dispatchV1 按 resource 分发│
│  src/app/api/auth/[...all]/route.ts    better-auth handler         │
│  src/app/api/internal/worker/route.ts  内部 worker 端点（密钥保护）  │
│  proxy.ts                 轻量边缘检查（age gate cookie、安全 header）│
│         │                                                          │
│         ▼                                                          │
│  src/server/                  ← 后台核心（本架构主体）               │
│   ├─ modules/ourdream/service.ts  产品域 mega-module（dispatchV1）   │
│   ├─ modules/admin/               admin 域（service.ts + characters/）│
│   ├─ jobs/                    队列定义 + claim                       │
│   ├─ providers/               外部供应商抽象（AI/支付/存储/验证）     │
│   ├─ bff/                     chat-proxy（签名 + 反向代理到 Chat）    │
│   ├─ admin/                   权限 / dev-login                       │
│   └─ lib/                     横切（auth、db、errors、http、logger…） │
└──────────────────────────────────────────────────────────────────┘
        │ Prisma Client（单例）                  │ Provider SDK
        ▼                                        ▼
   PostgreSQL（Postgres-only，dev/prod 一致）   AI / PSP / Blob / Verify / Redis
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

严格单向依赖，**禁止反向**（lib/provider 不得 import 业务 service，service 不得 import route）：

```
catch-all route.ts ─▶ dispatchV1（service mega-module）─▶ Prisma Client ─▶ DB
                          │
                          └─▶ provider 抽象（AI/PSP/Blob/Verify）
                          └─▶ job queue（入队，不在请求内做重活）
                          └─▶ events（埋点，fire-and-forget）
                          └─▶ lib/auth（解析 session）、lib/http（envelope/error）
```

> 现状已**没有**独立的 repository 层：数据访问直接由 service handler 用 Prisma 完成（见 §3、05）。下表是各角色的职责约束。

| 层 | 唯一职责 | 不允许 |
| --- | --- | --- |
| **Route Handler** (`app/api/v1/[...resource]/route.ts`) | HTTP 适配：单一 catch-all 把 method+segments 交给 `dispatchV1` | 写业务逻辑、直接用 Prisma |
| **Service** (`modules/ourdream/service.ts`、`modules/admin/`) | 业务规则、跨表事务、权限断言、**直接用 Prisma 读写**、入队 job、发埋点 | 碰 `Request` 之外的 HTTP 细节、绕过 provider 直连外部 SDK |
| **Provider** (`providers/*`) | 把外部供应商封装成稳定接口；处理 SDK、重试、签名 | 业务规则 |
| **lib/** | 横切能力（auth、db 单例、http、错误、日志、env、constants） | 业务规则、import 业务模块 |

> Prisma 访问集中在 service 层（`modules/ourdream` + `modules/admin`），不在 route/provider/lib 里散落，满足 SSoT。

## 3. 模块清单与依赖

下表是**逻辑业务域**划分（对齐 `BackendFeatureSpec.md §2` 与 `dispatchV1` 的 resource 分发）。与早期设计不同，主站后台**不再**按域拆成十几个 `modules/<name>/` 目录：除 admin 外，所有产品域都内聚在单一 mega-module `src/server/modules/ourdream/service.ts`，由 `dispatchV1(request, segments)` 按 `resource` 段分发到对应 handler。chat 已拆成独立服务（`packages/chat`）。

| 逻辑域 | 实现位置 | 依赖 | P0 |
| --- | --- | --- | --- |
| identity | `ourdream/service.ts`（auth/me/account handler） | lib/auth | ✅ |
| compliance（age gate + age verification） | `ourdream/service.ts` | providers/verify | ✅ |
| catalog（角色目录/搜索/筛选/标签/统计） | `ourdream/service.ts` | — | ✅ |
| chat | **独立服务 `packages/chat`**；主站经 `server/bff/chat-proxy` 代理 | read-only core/billing/compliance views, providers/chat | ✅ |
| creator（草稿/预览/提交/审核态） | `ourdream/service.ts` | safety, jobs, providers/image | ✅ |
| generation（图/视频/语音任务、presets） | `ourdream/service.ts`；worker pipeline 在 `packages/gen` | billing(dreamcoin), safety, jobs, providers/image,video,voice | ✅(先图) |
| media（图库 like/manage/download） | `ourdream/service.ts` | providers/blob | ✅(基础) |
| billing（计划/订阅/权益/dreamcoin） | `ourdream/service.ts` | providers/payment, jobs | ✅ |
| safety（审核/举报/申诉/政策） | `ourdream/service.ts` | jobs, providers/moderation | ✅ |
| library（My AI 各 tab 聚合） | `ourdream/service.ts` | catalog, media, generation | ✅(基础) |
| profile（资料/偏好/语言/兑换码/推荐/账号） | `ourdream/service.ts` | identity, billing | P0/P1 |
| feed（推荐流 + 互动） | `ourdream/service.ts` | catalog, media, safety | P1 |
| community（榜单/创作者/collections） | `ourdream/service.ts` | catalog, profile | P1 |
| seo（路由内容/文章/比较页 metadata） | `ourdream/service.ts` + `src/app` 路由 | — | P1 |
| analytics（产品事件/漏斗） | `ourdream/service.ts`（events/track）+ `processes/event-consumer` | — | P0 轻量 |
| admin（审核后台/角色 CMS/用户内容任务管理） | **`modules/admin/`**（service.ts + characters/）+ `server/admin`（权限） | safety, catalog, billing, identity | P0 内部 |

**依赖治理规则**：

- 主站产品域目前共处一个 mega-module；硬服务边界只剩两处：**chat（独立服务 `packages/chat`）** 与 **admin 模块（`modules/admin/`）**。
- 出现双向依赖时，下沉公共概念到 `lib/` 或用 **事件/job** 解耦（如 billing 完成 → 发事件 → library 刷新）。
- 跨包共享读模型/契约放 `packages/shared`（`bff/chat/contracts/media…`）。
- Chat 是特殊边界：主站经 BFF 代理/消费 Chat outbox；主站不直接写 Chat Service 权威表。Chat 只读主站 User/Character/Entitlement/Eligibility view，但不能写主站权威表。

## 4. 请求生命周期

### 4.1 典型读请求（Explore 列表 `GET /api/v1/characters`）

```
Client
  │  fetch（带 session cookie / age gate cookie）
  ▼
proxy.ts          安全 header；可选 age-gate 乐观检查（不做最终鉴权）
  ▼
[...resource]/route.ts   → dispatchV1(request, ["characters"])
  ▼
dispatchV1        匹配 resource=characters & GET → 调 listCharacters handler
  ▼
listCharacters    断言 age gate（从 ctx）→ 直接 Prisma 查询
                  （cursor 分页、tag 过滤、可见性=public+approved）
  ▼
handler           ok({ items, nextCursor })  +  after(()=>events.track('explore_...'))
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
| **Route Handlers** | Web `Request/Response`；非 GET 默认不缓存 | 单一 catch-all `app/api/v1/[...resource]/route.ts` → `dispatchV1`；统一 envelope；`export const dynamic="force-dynamic"` |
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

   dev：本地 `next dev` + 本地 Postgres（Postgres-only）+ provider 的 mock/sandbox 实现
```

- **主部署 Vercel**：Fluid Compute（Node.js，非 edge-only），默认函数超时已放宽（见知识更新）；Cron 触发 worker。
- **备选 Docker**：`next.config.ts` 已 `output: "standalone"`，配 `docker-compose.yml` 可自托管（见 10）。
- **数据库**：prod 用 Neon/Supabase（Vercel Marketplace，**Vercel Postgres 已下线**）；app 走 pooled 连接，migrate 走 direct 连接。
- 详细环境矩阵、env 变量、连接池与迁移 runbook 见 [10-operations.md](./10-operations.md)。

## 8. 架构不变量（Invariants，写代码时反复自检）

1. Prisma 访问集中在 service 层（`modules/ourdream` + `modules/admin`）；route/provider/lib 碰 db 即违规。
2. 同步 HTTP 路径不调用 AI / 不做重 IO；重活入队。
3. 余额/额度类数值由 ledger/usage 表派生，不可就地覆盖。
4. 一切用户可见内容（角色、媒体、消息、feed）可被举报且能进审核队列。
5. 成人内容前必过 age gate；受限司法辖区必过身份验证。
6. 客户端传来的 plan / 权益一律不可信，服务端按 entitlements 判定。
7. provider 回调先验签、再幂等落库、最后入队处理。
8. 数据库为 Postgres-only（`DB_PROVIDER="postgresql" as const`），dev/prod 一致；Chat Service 用独立 Postgres schema/视图（见 03）。
9. Chat Service 只读主站 User/Character/Entitlement/Eligibility view，只写 chat domain 表。
