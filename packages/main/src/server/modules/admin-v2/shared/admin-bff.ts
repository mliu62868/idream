import {
  BFF_HEADER,
  BFF_USER_HEADER,
  verifyBffContext,
  type BffContext,
} from "@idream/shared/bff";

const ADMIN_BFF_SERVICE_ID = "admin-bff";
const ADMIN_BFF_TTL_MS = 30_000;

export type AdminBffVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export async function verifyAdminBffRequest(
  request: Request,
  options: {
    readonly secret?: string;
    readonly appEnv?: string;
    readonly now?: number;
    readonly ttlMs?: number;
  } = {},
): Promise<AdminBffVerification> {
  const secret = options.secret ?? process.env.ADMIN_BFF_SIGNING_SECRET;
  const appEnv = options.appEnv ?? process.env.APP_ENV ?? "development";
  if (!secret) {
    return appEnv === "production"
      ? { ok: false, reason: "missing_secret" }
      : { ok: true };
  }

  const signature = request.headers.get(BFF_HEADER);
  const contextHeader = request.headers.get(BFF_USER_HEADER);
  if (!signature || !contextHeader) return { ok: false, reason: "missing_bff" };

  let context: BffContext;
  try {
    context = JSON.parse(contextHeader) as BffContext;
  } catch {
    return { ok: false, reason: "bad_context" };
  }
  if (context.userId !== ADMIN_BFF_SERVICE_ID) {
    return { ok: false, reason: "wrong_service" };
  }

  const url = new URL(request.url);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? ""
      : Buffer.from(await request.clone().arrayBuffer()).toString("base64");
  return verifyBffContext({
    secret,
    signature,
    context,
    method: request.method,
    path: `${url.pathname}${url.search}`,
    body,
    now: options.now ?? Date.now(),
    ttlMs: options.ttlMs ?? ADMIN_BFF_TTL_MS,
  });
}
