// SPEC: dev-only 后台快捷登录——校验内置账号，签发独立的 admin session cookie。
// INTENT: 后台用与普通用户隔离的登录态(idream_admin_session)；仅本地开发，最简实现。
// INVARIANTS: APP_ENV=production 时快捷登录禁用；退出始终可用，并撤销后台实际使用的 session。
// EXAMPLE: POST /api/admin-auth/login {username:"admin",password:"admin123"} → 200 + Set-Cookie
import { z } from "zod";
import {
  ADMIN_SESSION_COOKIE,
  SESSION_COOKIE,
  adminSessionCookie,
  clearAdminSessionCookie,
  clearSessionCookie,
  createSessionToken,
  parseCookieHeader,
  type ActorRole,
} from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok, empty } from "@/server/lib/http";
import { DEV_ADMIN_ACCOUNTS } from "./dev-login-accounts";
import { effectivePermissions } from "./effective-permissions";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h，本地开发足够

const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});
const logoutSchema = z
  .object({
    includeUserSession: z.boolean().optional(),
  })
  .optional();

export function devLoginEnabled() {
  return env.APP_ENV !== "production";
}

export async function devAdminLogin(request: Request) {
  if (!devLoginEnabled()) throw Errors.forbidden("Dev admin login is disabled");

  const body = loginSchema.parse(await request.json());
  const account = DEV_ADMIN_ACCOUNTS.find((item) => item.username === body.username);
  if (!account || account.password !== body.password) {
    throw Errors.unauthorized("Invalid dev credentials");
  }

  const user = await prisma.user.findFirst({
    where: { id: account.userId, status: "active", deletedAt: null },
  });
  if (!user) {
    throw Errors.conflict(
      `Seed user "${account.userId}" missing — run \`npm run db:seed\` first`,
    );
  }

  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: {
      userId: user.id,
      token,
      expiresAt,
      userAgent: request.headers.get("user-agent"),
    },
  });

  const response = ok({ user: { id: user.id, role: user.role } });
  response.headers.append("set-cookie", adminSessionCookie(token, expiresAt));
  return response;
}

export async function adminLogout(request: Request) {
  const options = await readLogoutOptions(request);
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const adminToken = cookies.get(ADMIN_SESSION_COOKIE);
  const userToken = cookies.get(SESSION_COOKIE);
  const userSession = userToken
    ? await prisma.session.findUnique({ where: { token: userToken }, include: { user: true } })
    : null;
  const activeUserSession = userSession && userSession.expiresAt > new Date()
    && userSession.user.status === "active" && !userSession.user.deletedAt;
  const userSessionHasAdminAccess = activeUserSession
    && (await effectivePermissions(userSession.userId, userSession.user.role as ActorRole)).size > 0;
  // INTENT: 保留前台客户会话；撤销所有能回退授权后台的会话，避免退出后立即又以 staff 身份登录。
  const includeUserSession = options?.includeUserSession || userSessionHasAdminAccess;
  const tokens = [
    adminToken,
    includeUserSession ? userToken : null,
  ].filter((token): token is string => Boolean(token));
  if (tokens.length) await prisma.session.deleteMany({ where: { token: { in: tokens } } });

  const response = empty();
  response.headers.append("set-cookie", clearAdminSessionCookie());
  if (includeUserSession) {
    response.headers.append("set-cookie", clearSessionCookie());
  }
  return response;
}

async function readLogoutOptions(request: Request): Promise<z.infer<typeof logoutSchema>> {
  if (!request.headers.get("content-type")?.includes("application/json")) return undefined;
  const text = await request.text();
  if (!text.trim()) return undefined;
  return logoutSchema.parse(JSON.parse(text));
}
