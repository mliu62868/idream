import { afterAll, describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_COOKIE,
  SESSION_COOKIE,
  createSessionToken,
  getAuthCtx,
} from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { devAdminLogin, devAdminLogout, devLoginEnabled } from "./dev-login";

// SPEC: dev 后台快捷登录——内置账号校验 + 独立 admin cookie + 登录态优先级。
// INVARIANTS (vitest 下 APP_ENV=test，全局 setup 已 seed 内部角色用户):
//   - 正确账号 → idream_admin_session cookie，getAuthCtx 解析出对应内部角色
//   - 错误密码 → 401
//   - admin cookie 优先于普通 idream_session
//   - logout 清除 cookie 且删除 session 行

const issuedTokens: string[] = [];

function getSetCookie(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookieValue(setCookies: string[], name: string): string | undefined {
  for (const entry of setCookies) {
    const [pair] = entry.split(";");
    const [key, ...rest] = pair.split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function loginRequest(body: unknown) {
  return new Request("http://localhost:3001/api/admin-auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "vitest" },
    body: JSON.stringify(body),
  });
}

function ctxWithCookie(cookie: string) {
  return getAuthCtx(new Request("http://localhost/admin", { headers: { cookie } }));
}

afterAll(async () => {
  if (issuedTokens.length) {
    await prisma.session.deleteMany({ where: { token: { in: issuedTokens } } });
  }
  await prisma.$disconnect();
});

describe("dev admin login", () => {
  it("is enabled outside production", () => {
    expect(devLoginEnabled()).toBe(true);
  });

  it("issues an isolated admin session cookie that resolves the admin role", async () => {
    const response = await devAdminLogin(
      loginRequest({ username: "admin", password: "admin123" }),
    );
    expect(response.status).toBe(200);

    const token = cookieValue(getSetCookie(response), ADMIN_SESSION_COOKIE);
    expect(token).toBeTruthy();
    issuedTokens.push(token!);

    const ctx = await ctxWithCookie(`${ADMIN_SESSION_COOKIE}=${token}`);
    expect(ctx.userId).toBe("seed-admin-user");
    expect(ctx.role).toBe("admin");
  });

  it("maps the second built-in account to its internal role", async () => {
    const response = await devAdminLogin(
      loginRequest({ username: "support", password: "support123" }),
    );
    const token = cookieValue(getSetCookie(response), ADMIN_SESSION_COOKIE);
    issuedTokens.push(token!);

    const ctx = await ctxWithCookie(`${ADMIN_SESSION_COOKIE}=${token}`);
    expect(ctx.userId).toBe("seed-support-user");
    expect(ctx.role).toBe("support");
  });

  it("rejects a wrong password with 401", async () => {
    await expect(
      devAdminLogin(loginRequest({ username: "admin", password: "nope" })),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects an unknown account with 401", async () => {
    await expect(
      devAdminLogin(loginRequest({ username: "ghost", password: "whatever" })),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("prefers the admin session over a regular user session on the same host", async () => {
    const adminLogin = await devAdminLogin(
      loginRequest({ username: "admin", password: "admin123" }),
    );
    const adminToken = cookieValue(getSetCookie(adminLogin), ADMIN_SESSION_COOKIE)!;
    issuedTokens.push(adminToken);

    // 同时存在一个普通用户 session。
    const userToken = createSessionToken();
    issuedTokens.push(userToken);
    await prisma.session.create({
      data: {
        userId: "seed-dev-user",
        token: userToken,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const ctx = await ctxWithCookie(
      `${SESSION_COOKIE}=${userToken}; ${ADMIN_SESSION_COOKIE}=${adminToken}`,
    );
    expect(ctx.userId).toBe("seed-admin-user");
    expect(ctx.role).toBe("admin");
  });

  it("logout deletes the session row and clears the cookie", async () => {
    const login = await devAdminLogin(
      loginRequest({ username: "admin", password: "admin123" }),
    );
    const token = cookieValue(getSetCookie(login), ADMIN_SESSION_COOKIE)!;

    const logout = await devAdminLogout(
      new Request("http://localhost:3001/api/admin-auth/logout", {
        method: "POST",
        headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
      }),
    );
    const cleared = getSetCookie(logout).find((entry) =>
      entry.startsWith(`${ADMIN_SESSION_COOKIE}=`),
    );
    expect(cleared).toContain(`${ADMIN_SESSION_COOKIE}=;`);

    const remaining = await prisma.session.findUnique({ where: { token } });
    expect(remaining).toBeNull();
  });
});
