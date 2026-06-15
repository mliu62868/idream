# 04 · API 设计规范

更新日期：2026-06-13

完整 API 端点清单见 `BackendFeatureSpec.md §5`（auth/explore/creator/chat/generation/library/profile/billing/safety/feed）。本文件定义**所有端点共享的实现规范**：组织、响应、错误、校验、分页、鉴权、限流、幂等、流式。

## 1. 路由组织

```
app/
  api/
    v1/
      auth/[...all]/route.ts        # 交给 better-auth handler
      me/route.ts
      age-gate/accept/route.ts
      age-verification/...
      characters/route.ts           # GET 列表
      characters/[id]/route.ts      # GET 详情 / PATCH / DELETE
      characters/[id]/like/route.ts # POST / DELETE
      characters/[id]/report/route.ts
      tags/route.ts
      search/suggest/route.ts
      character-drafts/...
      chat/sessions/...
      generation/jobs/...
      generation/presets/...
      media/...
      library/...
      profile/...
      plans/route.ts
      billing/checkout/route.ts
      billing/webhooks/[provider]/route.ts
      reports/route.ts
      appeals/route.ts
      policies/route.ts
      feed/...                       # P1
      community/...                  # P1
      admin/moderation/...           # admin-only
    internal/
      worker/route.ts                # Cron/after 触发，INTERNAL_TOKEN 保护
      cron/[task]/route.ts           # 定时任务
```

约定：

- **版本前缀 `/api/v1`**：破坏性变更走 `/api/v2`，老版本保留过渡期。
- **REST 风格**：资源名复数；动作型子资源（`like`/`report`/`retry`/`regenerate`）用子路径 POST。
- **robots**：`/api`、`/chat/` 子路径、`/c/`、`/signup/1` 在 `robots.txt` disallow（沿用 spec）。鉴权产品页 SSR 但 `noindex`，不进 sitemap。
- 每个 `route.ts` 只做 HTTP 适配，逻辑在对应 `modules/<domain>/*.service.ts`（见 01 §2）。

## 2. 统一响应 Envelope

对齐全局规则 `patterns.md` 的 `ApiResponse<T>`：

```ts
// src/server/lib/http/envelope.ts
export type ApiOk<T>  = { success: true;  data: T;  meta?: Meta };
export type ApiErr    = { success: false; error: ApiError };
export type ApiError  = { code: string; message: string; details?: unknown };
export type Meta      = { nextCursor?: string | null; total?: number; limit?: number };

export const ok  = <T>(data: T, meta?: Meta, init?: ResponseInit) =>
  Response.json({ success: true, data, ...(meta && { meta }) } satisfies ApiOk<T>,
    { status: 200, ...init });

export const created = <T>(data: T) => ok(data, undefined, { status: 201 });
export const accepted = <T>(data: T) => ok(data, undefined, { status: 202 });

export const fail = (status: number, code: string, message: string, details?: unknown) =>
  Response.json({ success: false, error: { code, message, details } } satisfies ApiErr,
    { status });
```

- 列表统一返回 `{ items, nextCursor }` 在 `data`，或把 `nextCursor` 放 `meta`（二选一，团队定一种，本规范用 `meta.nextCursor`）。
- 业务侧绝不抛裸 500：未捕获异常由统一 `handle()` 包装器转成 `ApiErr`（见 §3）。

## 3. 错误模型

统一错误类型 + 包装器，service 抛领域错误，route 转 HTTP：

```ts
// src/server/lib/errors.ts
export class AppError extends Error {
  constructor(
    public code: string,        // 机器可读，稳定
    public httpStatus: number,
    message: string,            // 面向用户、可安全展示（不泄敏感信息）
    public details?: unknown,
  ) { super(message); }
}
export const Errors = {
  unauthorized:  (m = "请先登录") => new AppError("UNAUTHORIZED", 401, m),
  forbidden:     (m = "无权限")   => new AppError("FORBIDDEN", 403, m),
  notFound:      (m = "不存在")   => new AppError("NOT_FOUND", 404, m),
  validation:    (d: unknown)     => new AppError("VALIDATION", 422, "参数校验失败", d),
  rateLimited:   (retry: number)  => new AppError("RATE_LIMITED", 429, "请求过于频繁", { retry }),
  ageGate:       ()               => new AppError("AGE_GATE_REQUIRED", 403, "需要确认年满 18 岁"),
  ageVerify:     ()               => new AppError("AGE_VERIFICATION_REQUIRED", 403, "该地区需身份年龄验证"),
  insufficientCoins: (need: number, have: number) =>
                  new AppError("INSUFFICIENT_DREAMCOINS", 402, "dreamcoin 不足", { need, have }),
  entitlement:   (key: string)    => new AppError("ENTITLEMENT_REQUIRED", 402, "该功能需升级", { key }),
  blockedByModeration: (policy: string) =>
                  new AppError("CONTENT_BLOCKED", 422, "内容不符合安全规则", { policy }),
  conflict:      (m = "状态冲突")  => new AppError("CONFLICT", 409, m),
};
```

```ts
// src/server/lib/http/handle.ts —— 包装每个 route handler
export function handle(fn: (req: NextRequest, ctx: RouteCtx) => Promise<Response>) {
  return async (req: NextRequest, ctx: RouteCtx) => {
    try { return await fn(req, ctx); }
    catch (e) {
      if (e instanceof AppError) {
        const init = e.code === "RATE_LIMITED"
          ? { headers: { "Retry-After": String((e.details as any)?.retry ?? 60) } } : undefined;
        return fail(e.httpStatus, e.code, e.message, e.details, init);
      }
      if (e instanceof ZodError) return fail(422, "VALIDATION", "参数校验失败", e.flatten());
      logger.error({ err: e, path: req.nextUrl.pathname }, "unhandled");  // 详情只进服务端日志
      return fail(500, "INTERNAL", "服务器开小差了");                       // 不泄漏堆栈
    }
  };
}
```

**错误码表**（稳定契约，前端按 `code` 分支）：`UNAUTHORIZED` `FORBIDDEN` `NOT_FOUND` `VALIDATION` `CONFLICT` `RATE_LIMITED` `AGE_GATE_REQUIRED` `AGE_VERIFICATION_REQUIRED` `INSUFFICIENT_DREAMCOINS` `ENTITLEMENT_REQUIRED` `CONTENT_BLOCKED` `INTERNAL`。

## 4. 输入校验（Zod，系统边界强制）

每模块 `*.schema.ts` 定义入参/出参，route 在调 service 前 `parse`：

```ts
// modules/catalog/catalog.schema.ts
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

`POST /api/v1/chat/sessions/:id/messages?stream=1` 返回 `text/event-stream`：

```ts
// 简化骨架
export const POST = handle(async (req, { params }) => {
  const ctx = await getAuthCtx(); requireUser(ctx); requireAgeVerified(ctx);
  const { content } = sendMessageBody.parse(await req.json());
  const { messageId, stream } = await chat.service.sendMessage(ctx, params.id, content);
  if (!new URL(req.url).searchParams.has("stream")) return accepted({ messageId });

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for await (const delta of stream) {                 // service 内对接 ChatModel 流
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta)}\n\n`));
      }
      controller.enqueue(encoder.encode(`event: done\ndata: {"messageId":"${messageId}"}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
});
```

- 输出审核在流结束后对完整文本复核（见 06 §4）；流式期间命中高危可提前中断并发送安全错误事件。
- 设置较长 `maxDuration`（route segment config）适配流式；超时由前端可重连/轮询兜底。
- 备选非流式：返回 `202 {messageId}`，前端轮询 `GET messages` 直到 `sent`。

## 9. 幂等

- **webhook**：`provider_events(provider, providerEventId)` 唯一约束去重（08 §3）。
- **生成/聊天创建**：可选 `Idempotency-Key` 头 → `jobs.dedupeKey`，重复提交返回同一 job。
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
