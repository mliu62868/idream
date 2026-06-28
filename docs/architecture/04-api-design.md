# 04 · API 设计规范

更新日期：2026-06-28

完整 API 端点清单见 `BackendFeatureSpec.md §5`（auth/explore/creator/chat/generation/library/profile/billing/safety/feed）。本文件定义**所有端点共享的实现规范**：组织、响应、错误、校验、分页、鉴权、限流、幂等、流式。

## 1. 路由组织

主站**不是**每个资源一个 `route.ts`。`/api/v1/*` 由**单一 catch-all** 承接，再由 `dispatchV1` 按 `[resource, id, action, child]` 段在 `modules/ourdream/service.ts` 内部分发：

```
src/app/api/
  v1/[...resource]/route.ts   # 唯一 catch-all：GET/POST/PATCH/PUT/DELETE
                              # → dispatchV1(request, resource)
  auth/[...all]/route.ts      # 交给 better-auth handler
  internal/worker/route.ts    # Cron/after 触发，内部密钥保护
```

`dispatchV1` 内部按 resource 分发（节选，权威清单见 `dispatchV1Unsafe`）：

```
auth/{signup,login,logout}        me、me/preferences
age-gate/accept                   age-verification/{status,sessions,webhooks/:provider}
characters[/:id[/{like,report,duplicate}]]   tags、character-templates、search/suggest
character-drafts[/:id[/{preview,submit,tags}]]
chat/*、messages/*                → proxyChatRequest（反向代理到 Chat Service）
generation/{config,jobs[/:id/retry],voice,presets[/:id]}
media[/:id/{like,content,download}]、media/bulk
plans、billing/{checkout,portal,webhooks/:provider}、dreamcoins
library/:tab、profile[/{preferences,language}]
redeem-codes/redeem、referrals[/invite]、account/{sign-out-all,delete-request}
reports[/:id]、appeals、policies、users/:id/follow、events/track
feed/*、community/*、creators/:id
admin/*                           → dispatchAdmin（modules/admin）
```

约定：

- **版本前缀 `/api/v1`**：破坏性变更走 `/api/v2`，老版本保留过渡期。
- **REST 风格**：资源名复数；动作型子资源（`like`/`report`/`retry`/`regenerate`）用子路径 POST。
- **robots**：`/api`、`/chat/` 子路径、`/c/`、`/signup/1` 在 `robots.txt` disallow（沿用 spec）。鉴权产品页 SSR 但 `noindex`，不进 sitemap。
- catch-all `route.ts` 只做 HTTP 适配，逻辑在 `dispatchV1`/各 handler（见 01 §2）。`dispatchV1` 已统一 try/catch：`AppError`/`ZodError` → 结构化 envelope，其它 → 500（不泄堆栈）。

## 2. 统一响应 Envelope

实际实现（`packages/main/src/server/lib/http/index.ts`，代码为准）：

```ts
// packages/main/src/server/lib/http/index.ts
export function ok<T>(data: T, init?: ResponseInit) {
  return Response.json({ ok: true, data }, init);          // { ok: true, data }
}
export function empty(status = 204) {
  return new Response(null, { status });
}
export function fail(error: AppError) {                    // { ok: false, error }
  return Response.json(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.status < 500 ? error.details : undefined,  // 5xx 不外泄 details
      },
    },
    { status: error.status },
  );
}
```

- 成功统一 `{ ok: true, data }`，失败统一 `{ ok: false, error: { code, message, details? } }`（注意字段是 **`ok`** 不是 `success`）。
- 列表把 `{ items, nextCursor }` 放进 `data`（无独立 `meta` 层）；HTTP status 由错误 `code` 派生（见 §3），无需手传。
- 业务侧绝不抛裸 500：未捕获异常由统一 `handle()` 包装器转成失败 envelope（见 §3）。

## 3. 错误模型

统一错误类型 + 包装器，service 抛领域错误，`handle()` 转 HTTP。**`code` 是固定 8 值小写枚举，HTTP status 由 `code` 派生**（不再手传 status）：

```ts
// packages/main/src/server/lib/errors.ts
export type AppErrorCode =
  | "bad_request" | "unauthorized" | "forbidden" | "payment_required"
  | "not_found" | "conflict" | "rate_limited" | "internal";

const statusByCode: Record<AppErrorCode, number> = {
  bad_request: 400, unauthorized: 401, forbidden: 403, payment_required: 402,
  not_found: 404, conflict: 409, rate_limited: 429, internal: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;       // = statusByCode[code]
  readonly details?: unknown;
  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = statusByCode[code];
    this.details = details;
  }
}

export const Errors = {
  badRequest:      (m = "Bad request", d?: unknown) => new AppError("bad_request", m, d),
  unauthorized:    (m = "Unauthorized", d?: unknown) => new AppError("unauthorized", m, d),
  forbidden:       (m = "Forbidden", d?: unknown)    => new AppError("forbidden", m, d),
  paymentRequired: (m = "Payment required", d?: unknown) => new AppError("payment_required", m, d),
  notFound:        (m = "Not found", d?: unknown)    => new AppError("not_found", m, d),
  conflict:        (m = "Conflict", d?: unknown)     => new AppError("conflict", m, d),
  rateLimited:     (m = "Rate limited", d?: unknown) => new AppError("rate_limited", m, d),
  internal:        (m = "Internal error", d?: unknown) => new AppError("internal", m, d),
};
```

```ts
// packages/main/src/server/lib/http/index.ts —— 包装每个 handler
export function handle<T>(handler: (req: Request) => Promise<T | Response> | T | Response) {
  return async (req: Request) => {
    try {
      const result = await handler(req);
      return result instanceof Response ? result : ok(result);
    } catch (error) {
      if (error instanceof AppError) return fail(error);
      if (error instanceof ZodError)
        return fail(new AppError("bad_request", "Validation failed", error.flatten()));
      logger.error({ error }, "Unhandled route error");   // 详情只进服务端日志
      return fail(new AppError("internal", "Internal error"));  // 不泄漏堆栈
    }
  };
}
```

**错误码表**（稳定契约，前端按 `code` 分支）：`bad_request` `unauthorized` `forbidden` `payment_required` `not_found` `conflict` `rate_limited` `internal`。

- 领域语义（dreamcoin 不足、需升级权益、年龄门槛、内容被审核拦截）统一收敛到这 8 个通用 `code`：扣费/权益类用 `payment_required`，年龄/权限类用 `forbidden`，被审核拦截用 `bad_request`，并把判别信息放进 `error.message` / `error.details`（如 `{ need, have, key, policy }`），前端按 `code` + `details` 分支。

## 4. 输入校验（Zod，系统边界强制）

Zod schema 内联在各 handler 旁定义（无独立 `*.schema.ts` 层），handler 在读 ctx 后、动业务前 `parse`：

```ts
// modules/ourdream/service.ts —— listCharacters handler 旁
export const listCharactersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  gender: z.enum(["female","male","trans"]).optional(),
  style: z.enum(["realistic","anime","hybrid","other"]).optional(),
  ageMin: z.coerce.number().int().min(18).optional(),     // 不变量：>=18
  ageMax: z.coerce.number().int().max(120).optional(),
  tags: z.array(z.string()).max(20).optional(),
  sort: z.enum(["for_you","popular","newest","following"]).default("popular"),
  period: z.enum(["day","week","month","all"]).default("month"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
});
```

- enum 取值的 **SSoT** 在 `src/server/lib/constants.ts`，Zod 与 schema 注释都引用它。
- 出参也用 Zod/类型做 DTO，**绝不直接把 Prisma model 整体返回**（防泄漏 `systemPrompt`、内部字段、他人隐私）。每模块提供 `toPublicDTO()` / `toOwnerDTO()`。
- env 也用 Zod 校验（见 10 §2）。

## 5. 分页（Cursor）

统一 **cursor 分页**（不用 offset，避免深翻页性能问题、对齐"无限加载"）：

- 请求：`?cursor=<opaque>&limit=24`。
- cursor = base64(`{createdAt,id}` 或排序键)；repository 用 `where: { OR: [...] }` + `take: limit+1` 判断 `nextCursor`。
- 响应：`meta.nextCursor`（无更多则 `null`）。
- 排序键随 `sort` 变化（popular → `stats.likesCount,id`；newest → `createdAt,id`）。游标必须包含排序键与 id 做 tiebreak，保证稳定。

```ts
// src/server/lib/pagination.ts
export const encodeCursor = (k: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(k)).toString("base64url");
export const decodeCursor = <T>(c?: string): T | null =>
  c ? JSON.parse(Buffer.from(c, "base64url").toString()) as T : null;
```

## 6. 鉴权与授权（AuthZ）

**两步：认证（你是谁）→ 授权（你能不能）**。认证在 service 入口统一取 context（不在 proxy，见 ADR-3/01 §5）：

```ts
// src/server/lib/auth/context.ts
export type AuthCtx = {
  user: { id: string; role: "user"|"moderator"|"admin"; status: string } | null;
  anonymousId: string;            // 始终有（proxy 维护 cookie）
  ageGateAccepted: boolean;
  ageVerification: "not_required"|"required"|"pending"|"verified"|"failed"|"expired";
};
export async function getAuthCtx(): Promise<AuthCtx> { /* 读 better-auth session + cookie + 查表 */ }
```

**授权助手**（service 内调用，集中表达 `BackendFeatureSpec §6 授权矩阵`）：

```ts
// src/server/lib/auth/guards.ts
export const requireUser   = (c: AuthCtx) => c.user ?? raise(Errors.unauthorized());
export const requireAdmin  = (c: AuthCtx) => (c.user?.role === "admin" ? c.user : raise(Errors.forbidden()));
export const requireAgeGate= (c: AuthCtx) => c.ageGateAccepted || raise(Errors.ageGate());
export const requireAgeVerified = (c: AuthCtx) =>
  c.ageVerification === "verified" || c.ageVerification === "not_required" || raise(Errors.ageVerify());
export const requireOwner  = (c: AuthCtx, ownerId: string) =>
  (c.user?.id === ownerId || c.user?.role === "admin") || raise(Errors.forbidden());
export const requireEntitlement = async (c: AuthCtx, key: string) =>
  (await entitlements.has(c.user!.id, key)) || raise(Errors.entitlement(key));
```

矩阵落地原则：

- **Public after age gate**（explore/detail/feed 读）：`requireAgeGate`，无需登录。
- **User**：`requireUser`（+ 视情况 `requireAgeVerified`）。
- **Owner**：`requireOwner(ctx, resource.ownerId)`，资源载入后判定。
- **Admin/Moderator**：`requireAdmin` / role 检查。
- **Premium 门**：服务端 `requireEntitlement`（如 `custom_prompt`/`video_gen`），**绝不信客户端 plan**（01 §8 不变量 6）。

## 7. 限流

- 装饰器 `withRateLimit(key, limit)` 包在 route 外层；超限抛 `Errors.rateLimited(retrySeconds)` → `429 + Retry-After`。
- 维度 key：登录/注册按 `ip`；产品操作按 `user.id`；匿名读按 `anonymousId`。
- 预算（建议初值，可调）：

| 端点类 | 维度 | 限额 |
| --- | --- | --- |
| auth login/signup | ip | 10 / 10min |
| search/suggest | anon/user | 60 / min |
| chat send | user | 30 / min（+ 额度/entitlement 另算） |
| generation create | user | 10 / min（+ dreamcoin 另算） |
| report/appeal | user/ip | 20 / day |
| webhook | provider | 宽松，但验签 + 幂等兜底 |

实现见 ADR-9（dev DB 令牌桶 / prod Upstash）。

## 8. 流式（SSE）聊天

Chat SSE 由 Chat Service 提供；主站可以作为同源 BFF 代理，但不直接写 chat 表、不拼 prompt、不做 chat finalizer。

标准两步：

```text
POST /api/v1/chat/sessions/:id/messages
GET  /api/v1/chat/streams/:assistantMessageId
```

`POST` 返回 `assistantMessageId` 和 `streamUrl`；`GET` 返回 `text/event-stream`：

```ts
// 简化骨架
export const POST = handle(async (req, { params }) => {
  const ctx = await getAuthCtx();
  const user = requireUser(ctx);
  const { content } = sendMessageBody.parse(await req.json());
  const result = await chatClient.sendMessage({
    signedUserContext: signInternalUserContext(user),
    sessionId: params.id,
    content,
  });
  return accepted(result);
});

export const GET = handle(async (req, { params }) => {
  const ctx = await getAuthCtx();
  const user = requireUser(ctx);
  const upstream = await chatClient.openStream({
    signedUserContext: signInternalUserContext(user),
    assistantMessageId: params.assistantMessageId,
    lastEventId: req.headers.get("last-event-id"),
  });
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for await (const event of upstream) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
});
```

- 输出审核在 Chat Service 内对完整文本复核（见 06 §7）；流式期间命中高危可提前中断并发送安全错误事件。
- 设置较长 `maxDuration`（route segment config）适配流式；超时由前端可重连/轮询兜底。
- 备选非流式：返回 `202 {assistantMessageId}`，前端轮询 `GET /api/v1/chat/sessions/:id` 直到 `sent`。

## 9. 幂等

- **webhook**：`provider_events(provider, providerEventId)` 唯一约束去重（08 §3）。
- **生成创建**：可选 `Idempotency-Key` 头 → `jobs.dedupeKey`，重复提交返回同一 job。
- **聊天发消息**：由 Chat Service 按 `assistantMessageId` / request id 幂等，重复提交返回同一 stream/message。
- **like/follow**：用复合主键的 upsert/delete，天然幂等。
- **redeem**：`redeem_code_redemptions(redeemCodeId,userId)` 唯一，重复兑换 `409`。

## 10. 约定汇总（清单）

- [ ] route 只做适配，逻辑在 service。
- [ ] 所有入参过 Zod；出参走 DTO，不裸返 Prisma model。
- [ ] 统一 envelope + `handle()` 包装；错误码稳定。
- [ ] 列表一律 cursor 分页。
- [ ] 鉴权在 service；proxy 只做乐观检查。
- [ ] 敏感/写操作限流。
- [ ] 重活入队，不在请求内调 AI。
- [ ] Premium 门 / age / owner 服务端判定。
- [ ] 埋点用 `after()`，不阻塞响应。
