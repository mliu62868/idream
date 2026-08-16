import { z } from "zod";
import {
  adminIsoDateTimeSchema,
  adminPageInfoSchema,
  chatOpsModerationEventSchema,
  chatOpsOverviewSchema,
  chatOpsProviderHealthItemSchema,
  chatOpsSessionSchema,
  chatOpsUsageSchema,
  type ChatOpsProxyDiagnostics,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { AppError, Errors } from "@/server/lib/errors";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";

/**
 * SPEC: Chat 服务只读运营视图在 Main 侧的权威。Main 只做鉴权 + 转发 + 契约收口；
 *   数据权威始终在 `packages/chat/src/admin.ts`（DB 边界：Main 不直连 chat 库）。
 * INTENT: v1 把上游响应体整个 spread 进信封，Main 对里面有什么零声明。这里改成先按
 *   manifest 声明的 DTO 收一遍：过不了就降级成 `configured:false` +
 *   `contract_mismatch`，而不是让 `adminV2Route` 抛 500 —— Chat 出问题时运营台仍要
 *   能打开，并看见「为什么是空的」。
 * INVARIANT: 上游 400 是运营输入错（游标失效之类），照原样冒泡成 badRequest；
 *   其余不可达/未配置一律降级，不是错误。
 */

type ChatProxyOutcome<T> = {
  readonly configured: boolean;
  readonly data: T | null;
  readonly diagnostics: ChatOpsProxyDiagnostics;
};

async function proxyChatAdmin<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<ChatProxyOutcome<T>> {
  if (!env.CHAT_SERVICE_URL) {
    return {
      configured: false,
      data: null,
      diagnostics: { reason: "missing_url", serviceUrlConfigured: false },
    };
  }
  let payload: unknown;
  try {
    const response = await fetch(`${env.CHAT_SERVICE_URL}${path}`, {
      headers: { "x-internal-token": env.INTERNAL_TOKEN },
    });
    if (!response.ok) {
      if (response.status === 400) {
        throw Errors.badRequest(
          "Chat admin query was rejected by the authority service",
          { upstreamStatus: response.status },
        );
      }
      return {
        configured: false,
        data: null,
        diagnostics: {
          reason: response.status === 401 ? "unauthorized" : "upstream_error",
          status: response.status,
          serviceUrlConfigured: true,
        },
      };
    }
    payload = (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return {
      configured: false,
      data: null,
      diagnostics: {
        reason: error instanceof SyntaxError ? "bad_json" : "unreachable",
        serviceUrlConfigured: true,
      },
    };
  }
  const narrowed = schema.safeParse(payload);
  if (!narrowed.success) {
    return {
      configured: false,
      data: null,
      diagnostics: { reason: "contract_mismatch", serviceUrlConfigured: true },
    };
  }
  return {
    configured: true,
    data: narrowed.data,
    diagnostics: { serviceUrlConfigured: true },
  };
}

function upstreamQuery(query: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

/**
 * SPEC: Chat `/internal/admin/*` 每条路径的响应体形状 —— Main 对上游的期待。
 * INTENT: 与对外 DTO 分开写，因为信封（configured/diagnostics）是 Main 加的，上游没有。
 *   item 层复用同一批 DTO，所以「上游给的」和「Main 发的」不可能长歪成两个形状。
 */
const providerHealthPayload = z
  .object({
    checkedAt: adminIsoDateTimeSchema,
    items: z.array(chatOpsProviderHealthItemSchema),
  })
  .strict();
const sessionPayload = z
  .object({ items: z.array(chatOpsSessionSchema), pageInfo: adminPageInfoSchema })
  .strict();
const usagePayload = z
  .object({
    items: z.array(chatOpsUsageSchema),
    freeDailyLimit: z.number().int().nonnegative(),
    pageInfo: adminPageInfoSchema,
  })
  .strict();
const moderationEventPayload = z
  .object({
    items: z.array(chatOpsModerationEventSchema),
    pageInfo: adminPageInfoSchema,
  })
  .strict();

export async function chatOpsOverview(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const result = await proxyChatAdmin("/internal/admin/overview", chatOpsOverviewSchema);
  return {
    configured: result.configured,
    diagnostics: result.diagnostics,
    overview: result.data,
  };
}

export async function chatOpsProviderHealth(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const result = await proxyChatAdmin(
    "/internal/admin/provider-health",
    providerHealthPayload,
  );
  return {
    configured: result.configured,
    diagnostics: result.diagnostics,
    checkedAt: result.data?.checkedAt ?? null,
    items: result.data?.items ?? [],
  };
}

export async function chatOpsSessions(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const query = queryParams(request, "GET /api/v2/admin/chat/sessions");
  const result = await proxyChatAdmin(
    `/internal/admin/sessions?${upstreamQuery(query)}`,
    sessionPayload,
  );
  return {
    configured: result.configured,
    diagnostics: result.diagnostics,
    items: result.data?.items ?? [],
    pageInfo: result.data?.pageInfo ?? null,
  };
}

export async function chatOpsUsage(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const query = queryParams(request, "GET /api/v2/admin/chat/usage");
  const result = await proxyChatAdmin(
    `/internal/admin/usage?${upstreamQuery(query)}`,
    usagePayload,
  );
  return {
    configured: result.configured,
    diagnostics: result.diagnostics,
    freeDailyLimit: result.data?.freeDailyLimit ?? null,
    items: result.data?.items ?? [],
    pageInfo: result.data?.pageInfo ?? null,
  };
}

export async function chatOpsModerationEvents(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const query = queryParams(request, "GET /api/v2/admin/chat/moderation-events");
  const result = await proxyChatAdmin(
    `/internal/admin/moderation-events?${upstreamQuery(query)}`,
    moderationEventPayload,
  );
  return {
    configured: result.configured,
    diagnostics: result.diagnostics,
    items: result.data?.items ?? [],
    pageInfo: result.data?.pageInfo ?? null,
  };
}
