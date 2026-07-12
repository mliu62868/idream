import { env } from "@/server/lib/env";
import { AppError, Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  clampInt,
} from "@/server/modules/admin/shared/legacy-primitives";

type ChatAdminProxyResult = {
  configured: boolean;
  data: unknown | null;
  diagnostics: {
    reason?:
      | "missing_url"
      | "unreachable"
      | "unauthorized"
      | "upstream_error"
      | "bad_json";
    status?: number;
    serviceUrlConfigured: boolean;
  };
};

async function proxyChatAdmin(path: string): Promise<ChatAdminProxyResult> {
  if (!env.CHAT_SERVICE_URL) {
    return {
      configured: false,
      data: null,
      diagnostics: { reason: "missing_url", serviceUrlConfigured: false },
    };
  }
  try {
    const response = await fetch(`${env.CHAT_SERVICE_URL}${path}`, {
      headers: { "x-internal-token": env.INTERNAL_TOKEN },
    });
    if (!response.ok) {
      if (response.status === 400) {
        throw Errors.badRequest(
          "Chat admin query was rejected by the authority service",
          {
            upstreamStatus: response.status,
          },
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
    try {
      return {
        configured: true,
        data: (await response.json()) as unknown,
        diagnostics: { serviceUrlConfigured: true },
      };
    } catch {
      return {
        configured: false,
        data: null,
        diagnostics: { reason: "bad_json", serviceUrlConfigured: true },
      };
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    return {
      configured: false,
      data: null,
      diagnostics: { reason: "unreachable", serviceUrlConfigured: true },
    };
  }
}

export async function chatOpsOverview(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const result = await proxyChatAdmin("/internal/admin/overview");
  return ok({
    configured: result.configured,
    diagnostics: result.diagnostics,
    overview: isRecord(result.data) ? result.data : null,
  });
}

export async function chatOpsProviderHealth(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const result = await proxyChatAdmin("/internal/admin/provider-health");
  return ok({
    configured: result.configured,
    diagnostics: result.diagnostics,
    ...(isRecord(result.data) ? result.data : { items: [] }),
  });
}

export async function chatOpsSessions(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const url = new URL(request.url);
  const params = new URLSearchParams();
  copy(url, params, ["userId", "characterId", "status", "cursor"]);
  params.set(
    "limit",
    String(clampInt(url.searchParams.get("limit"), 1, 100, 50)),
  );
  const result = await proxyChatAdmin(
    `/internal/admin/sessions?${params.toString()}`,
  );
  return ok({
    configured: result.configured,
    diagnostics: result.diagnostics,
    ...(isRecord(result.data) ? result.data : { items: [] }),
  });
}

export async function chatOpsUsage(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const url = new URL(request.url);
  const params = new URLSearchParams();
  copy(url, params, ["userId", "cursor"]);
  params.set(
    "limit",
    String(clampInt(url.searchParams.get("limit"), 1, 100, 50)),
  );
  const result = await proxyChatAdmin(
    `/internal/admin/usage?${params.toString()}`,
  );
  return ok({
    configured: result.configured,
    diagnostics: result.diagnostics,
    ...(isRecord(result.data) ? result.data : { items: [] }),
  });
}

export async function chatOpsModerationEvents(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const url = new URL(request.url);
  const params = new URLSearchParams();
  copy(url, params, [
    "status",
    "layer",
    "policyCode",
    "targetType",
    "targetId",
    "cursor",
  ]);
  params.set(
    "limit",
    String(clampInt(url.searchParams.get("limit"), 1, 100, 50)),
  );
  const result = await proxyChatAdmin(
    `/internal/admin/moderation-events?${params.toString()}`,
  );
  return ok({
    configured: result.configured,
    diagnostics: result.diagnostics,
    ...(isRecord(result.data) ? result.data : { items: [] }),
  });
}

function copy(source: URL, target: URLSearchParams, keys: string[]) {
  for (const key of keys) {
    const value = source.searchParams.get(key);
    if (value) target.set(key, value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
