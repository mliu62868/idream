/* eslint-disable @typescript-eslint/no-explicit-any */
import { GET as approvalsGet, POST as approvalsPost } from "@/app/api/v2/admin/approvals/route";
import { POST as approvalApprove } from "@/app/api/v2/admin/approvals/[id]/approve/route";
import { POST as approvalReject } from "@/app/api/v2/admin/approvals/[id]/reject/route";
import { GET as ageVerificationsGet } from "@/app/api/v2/admin/compliance/age-verifications/route";
import { POST as ageVerificationOverride } from "@/app/api/v2/admin/compliance/age-verifications/[id]/override/route";
import { POST as complianceErase } from "@/app/api/v2/admin/compliance/users/[id]/erase/route";
import { GET as complianceExport } from "@/app/api/v2/admin/compliance/users/[id]/export/route";
import { POST as appealDecisionRoute } from "@/app/api/v2/admin/moderation/appeals/[id]/decision/route";
import { POST as mediaDecisionRoute } from "@/app/api/v2/admin/moderation/media/[id]/decision/route";
import { GET as moderationQueueRoute } from "@/app/api/v2/admin/moderation/queue/route";
import { POST as reportDecisionRoute } from "@/app/api/v2/admin/moderation/reports/[id]/decision/route";
import { GET as riskAbuseRoute } from "@/app/api/v2/admin/risk/abuse/route";

// SPEC: 在集成测试里按「method + v2 路径」调 Trust & Safety 的 Route Handler，
//       返回和 `helpers.ts` 的 `api()` 同一个 ApiResult 形状。
// INTENT: v2 没有中央 dispatcher，每个端点都是自己的 route 文件。测试要么在每个用例里
//         手写 `new Request(...)` + 手动取 params，要么在这里集中一次。集中一次，
//         调用点才只差一个函数名。
// INVARIANT: 这里只登记本域（moderation / compliance / risk / approvals）的端点，
//            登记一个不存在的路径必须立刻抛，而不是静默 404。

type RouteHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response> | Response;

type RouteEntry = {
  readonly method: string;
  readonly pattern: RegExp;
  readonly params: readonly string[];
  readonly handler: RouteHandler;
};

const routes: readonly RouteEntry[] = [
  { method: "GET", pattern: /^moderation\/queue$/, params: [], handler: moderationQueueRoute as RouteHandler },
  { method: "POST", pattern: /^moderation\/media\/([^/]+)\/decision$/, params: ["id"], handler: mediaDecisionRoute as RouteHandler },
  { method: "POST", pattern: /^moderation\/reports\/([^/]+)\/decision$/, params: ["id"], handler: reportDecisionRoute as RouteHandler },
  { method: "POST", pattern: /^moderation\/appeals\/([^/]+)\/decision$/, params: ["id"], handler: appealDecisionRoute as RouteHandler },
  { method: "GET", pattern: /^compliance\/users\/([^/]+)\/export$/, params: ["id"], handler: complianceExport as RouteHandler },
  { method: "POST", pattern: /^compliance\/users\/([^/]+)\/erase$/, params: ["id"], handler: complianceErase as RouteHandler },
  { method: "GET", pattern: /^compliance\/age-verifications$/, params: [], handler: ageVerificationsGet as RouteHandler },
  { method: "POST", pattern: /^compliance\/age-verifications\/([^/]+)\/override$/, params: ["id"], handler: ageVerificationOverride as RouteHandler },
  { method: "GET", pattern: /^risk\/abuse$/, params: [], handler: riskAbuseRoute as RouteHandler },
  { method: "GET", pattern: /^approvals$/, params: [], handler: approvalsGet as RouteHandler },
  { method: "POST", pattern: /^approvals$/, params: [], handler: approvalsPost as RouteHandler },
  { method: "POST", pattern: /^approvals\/([^/]+)\/approve$/, params: ["id"], handler: approvalApprove as RouteHandler },
  { method: "POST", pattern: /^approvals\/([^/]+)\/reject$/, params: ["id"], handler: approvalReject as RouteHandler },
];

export interface TrustAdminV2Options {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  userId?: string;
  role?: string;
  cookie?: string;
}

export interface TrustAdminV2Result {
  status: number;
  ok: boolean;
  data: any;
  error: { code?: string; message?: string; details?: any } | undefined;
  json: any;
  headers: Headers;
  setCookies: string[];
}

/** Drive an Admin v2 Trust & Safety endpoint exactly as the Next Route Handler does. */
export async function adminV2(
  method: string,
  path: string,
  options: TrustAdminV2Options = {},
): Promise<TrustAdminV2Result> {
  const route = routes.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path),
  );
  if (!route) throw new Error(`No Admin v2 Trust & Safety route for ${method} /${path}`);
  const matched = route.pattern.exec(path)!;
  const params = Object.fromEntries(
    route.params.map((name, index) => [name, decodeURIComponent(matched[index + 1]!)]),
  );

  const url = new URL(`http://localhost/api/v2/admin/${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.userId) headers["x-idream-user-id"] = options.userId;
  if (options.role) headers["x-idream-role"] = options.role;
  if (options.cookie) headers["cookie"] = options.cookie;
  const hasIdempotencyKey = Object.keys(headers).some(
    (name) => name.toLowerCase() === "idempotency-key",
  );
  if (method !== "GET" && !hasIdempotencyKey) {
    headers["idempotency-key"] = crypto.randomUUID();
  }

  const request = new Request(url, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const response = await route.handler(request, { params: Promise.resolve(params) });
  const text = await response.text();
  const json = text ? (JSON.parse(text) as any) : null;
  return {
    status: response.status,
    ok: Boolean(json?.ok),
    data: json?.data,
    error: json?.error,
    json,
    headers: response.headers,
    setCookies: response.headers.getSetCookie(),
  };
}
