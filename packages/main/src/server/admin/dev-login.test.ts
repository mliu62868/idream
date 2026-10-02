import { afterAll, describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_COOKIE,
  SESSION_COOKIE,
  createSessionToken,
  getAuthCtx,
} from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { devAdminLogin, adminLogout, devLoginEnabled } from "./dev-login";

// SPEC: dev 后台快捷登录——内置账号校验 + 独立 admin cookie + 登录态优先级。
// INVARIANTS (vitest 下 APP_ENV=test，全局 setup 已 seed 内部角色用户):
//   - 正确账号 → idream_admin_session cookie，getAuthCtx 解析出对应内部角色
//   - 错误密码 → 401
//   - admin cookie 仅在 Admin 请求中优先于普通 idream_session
//   - logout 清除 cookie 且删除 session 行
//   - dev 切换账号时可显式同时清除普通用户 session

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

  it("keeps Main customer identity when the same browser is also signed into Admin", async () => {
    const response = await devAdminLogin(loginRequest({ username: "admin", password: "admin123" }));
    const adminToken = cookieValue(getSetCookie(response), ADMIN_SESSION_COOKIE)!;
    const userToken = createSessionToken();
    issuedTokens.push(adminToken, userToken);
    await prisma.session.create({ data: { userId: "seed-dev-user", token: userToken, expiresAt: new Date(Date.now() + 60_000) } });
    const cookie = `${SESSION_COOKIE}=${userToken}; ${ADMIN_SESSION_COOKIE}=${adminToken}`;
    const customer = await getAuthCtx(new Request("http://localhost:3000/api/v1/me", { headers: { cookie } }));
    expect(customer.userId).toBe("seed-dev-user");
    expect(customer.role).toBe("user");
    const operator = await getAuthCtx(new Request("http://localhost:3000/api/v2/admin/bootstrap", { headers: { cookie } }));
    expect(operator.userId).toBe("seed-admin-user");
    expect(operator.role).toBe("admin");
    const anonymous = await getAuthCtx(new Request("http://localhost:3000/api/v1/me", { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${adminToken}` } }));
    expect(anonymous.userId).toBeUndefined();
  });

  it("allows production staff to revoke the regular session used by Admin while dev login stays closed", async () => {
    const token = createSessionToken();
    issuedTokens.push(token);
    await prisma.session.create({ data: { userId: "seed-admin-user", token, expiresAt: new Date(Date.now() + 60_000) } });
    const previous = env.APP_ENV;
    env.APP_ENV = "production";
    try {
      await expect(devAdminLogin(loginRequest({ username: "admin", password: "admin123" }))).rejects.toMatchObject({ code: "forbidden" });
      const response = await adminLogout(new Request("http://localhost/api/admin-auth/logout", {
        method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }));
      expect(response.status).toBe(204);
      expect(getSetCookie(response).join(";")).toContain(`${SESSION_COOKIE}=;`);
      expect(await prisma.session.findUnique({ where: { token } })).toBeNull();
    } finally { env.APP_ENV = previous; }
  });

  it("logout deletes the session row and clears the cookie", async () => {
    const login = await devAdminLogin(
      loginRequest({ username: "admin", password: "admin123" }),
    );
    const token = cookieValue(getSetCookie(login), ADMIN_SESSION_COOKIE)!;

    const logout = await adminLogout(
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

  it("revokes the fallback user session when the isolated admin session has expired", async () => {
    const adminToken = createSessionToken();
    const userToken = createSessionToken();
    issuedTokens.push(adminToken, userToken);
    await prisma.session.createMany({ data: [
      { userId: "seed-admin-user", token: adminToken, expiresAt: new Date(Date.now() - 60_000) },
      { userId: "seed-admin-user", token: userToken, expiresAt: new Date(Date.now() + 60_000) },
    ] });
    const response = await adminLogout(new Request("http://localhost/api/admin-auth/logout", {
      method: "POST", headers: { cookie: `${ADMIN_SESSION_COOKIE}=${adminToken}; ${SESSION_COOKIE}=${userToken}` },
    }));
    expect(response.status).toBe(204);
    expect(getSetCookie(response).join(";")).toContain(`${SESSION_COOKIE}=;`);
    expect(await prisma.session.count({ where: { token: { in: [adminToken, userToken] } } })).toBe(0);
  });

  it("logout keeps the regular user session unless explicitly asked to clear it", async () => {
    const adminLogin = await devAdminLogin(
      loginRequest({ username: "admin", password: "admin123" }),
    );
    const adminToken = cookieValue(getSetCookie(adminLogin), ADMIN_SESSION_COOKIE)!;

    const userToken = createSessionToken();
    issuedTokens.push(userToken);
    await prisma.session.create({
      data: {
        userId: "seed-dev-user",
        token: userToken,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const logout = await adminLogout(
      new Request("http://localhost:3001/api/admin-auth/logout", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${userToken}; ${ADMIN_SESSION_COOKIE}=${adminToken}`,
        },
      }),
    );

    expect(getSetCookie(logout).join(";")).toContain(`${ADMIN_SESSION_COOKIE}=;`);
    expect(getSetCookie(logout).join(";")).not.toContain(`${SESSION_COOKIE}=;`);
    expect(await prisma.session.findUnique({ where: { token: adminToken } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { token: userToken } })).not.toBeNull();
  });

  it("revokes a second staff session so Admin cannot silently sign back in after logout", async () => {
    const adminToken = createSessionToken();
    const userToken = createSessionToken();
    issuedTokens.push(adminToken, userToken);
    await prisma.session.createMany({ data: [adminToken, userToken].map(token => ({
      userId: "seed-admin-user", token, expiresAt: new Date(Date.now() + 60_000),
    })) });
    const cookie = `${ADMIN_SESSION_COOKIE}=${adminToken}; ${SESSION_COOKIE}=${userToken}`;
    const response = await adminLogout(new Request("http://localhost/api/admin-auth/logout", { method: "POST", headers: { cookie } }));
    expect(response.status).toBe(204);
    expect(getSetCookie(response).join(";")).toContain(`${SESSION_COOKIE}=;`);
    expect((await ctxWithCookie(cookie)).userId).toBeUndefined();
    expect(await prisma.session.count({ where: { token: { in: [adminToken, userToken] } } })).toBe(0);
  });

  it.each([false, true])("preserves Main customer sign-in when the Admin cookie is missing or expired (expired=%s)", async expired => {
    const userToken = createSessionToken();
    const adminToken = expired ? createSessionToken() : undefined;
    issuedTokens.push(userToken);
    await prisma.session.create({ data: { userId: "seed-dev-user", token: userToken, expiresAt: new Date(Date.now() + 60_000) } });
    if (adminToken) {
      issuedTokens.push(adminToken);
      await prisma.session.create({ data: { userId: "seed-admin-user", token: adminToken, expiresAt: new Date(Date.now() - 60_000) } });
    }
    const cookie = `${SESSION_COOKIE}=${userToken}${adminToken ? `; ${ADMIN_SESSION_COOKIE}=${adminToken}` : ""}`;
    const response = await adminLogout(new Request("http://localhost/api/admin-auth/logout", { method: "POST", headers: { cookie } }));
    expect(response.status).toBe(204);
    expect(getSetCookie(response).join(";")).not.toContain(`${SESSION_COOKIE}=;`);
    expect(await prisma.session.findUnique({ where: { token: userToken } })).not.toBeNull();
    if (adminToken) expect(await prisma.session.findUnique({ where: { token: adminToken } })).toBeNull();
  });

  it("logout can clear both admin and foreground user sessions for dev account switching", async () => {
    const adminLogin = await devAdminLogin(
      loginRequest({ username: "admin", password: "admin123" }),
    );
    const adminToken = cookieValue(getSetCookie(adminLogin), ADMIN_SESSION_COOKIE)!;

    const userToken = createSessionToken();
    issuedTokens.push(userToken);
    await prisma.session.create({
      data: {
        userId: "seed-dev-user",
        token: userToken,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const logout = await adminLogout(
      new Request("http://localhost:3001/api/admin-auth/logout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${userToken}; ${ADMIN_SESSION_COOKIE}=${adminToken}`,
        },
        body: JSON.stringify({ includeUserSession: true }),
      }),
    );

    const cleared = getSetCookie(logout).join(";");
    expect(cleared).toContain(`${ADMIN_SESSION_COOKIE}=;`);
    expect(cleared).toContain(`${SESSION_COOKIE}=;`);
    expect(await prisma.session.findUnique({ where: { token: adminToken } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { token: userToken } })).toBeNull();
  });
});
