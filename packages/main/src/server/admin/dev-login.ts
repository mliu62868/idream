// SPEC: dev-only 后台快捷登录——校验内置账号，签发独立的 admin session cookie。
// INTENT: 后台用与普通用户隔离的登录态(idream_admin_session)；仅本地开发，最简实现。
// INVARIANTS: APP_ENV=production 时整体禁用；账号必须已 seed 进 DB 才能签发(Session FK)。
// EXAMPLE: POST /api/admin-auth/login {username:"admin",password:"admin123"} → 200 + Set-Cookie
import { z } from "zod";
import {
  ADMIN_SESSION_COOKIE,
  adminSessionCookie,
  clearAdminSessionCookie,
  createSessionToken,
  parseCookieHeader,
} from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok, empty } from "@/server/lib/http";
import { DEV_ADMIN_ACCOUNTS } from "./dev-login-accounts";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h，本地开发足够

const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

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

export async function devAdminLogout(request: Request) {
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const token = cookies.get(ADMIN_SESSION_COOKIE);
  if (token) await prisma.session.deleteMany({ where: { token } });

  const response = empty();
  response.headers.append("set-cookie", clearAdminSessionCookie());
  return response;
}
