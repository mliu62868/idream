import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { getAuthCtx } from "./index";

const userId = "zt-auth-boundary-user";
const adminId = "zt-auth-boundary-admin";

describe("request authentication trust boundary", () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, adminId] } } });
  });

  it.each(["development", "preview", "production"] as const)(
    "ignores plaintext identity headers in %s",
    async (appEnv) => {
      const previousAppEnv = env.APP_ENV;
      env.APP_ENV = appEnv;
      try {
        const ctx = await getAuthCtx(new Request("http://localhost/api/v1/me", {
          headers: {
            "x-idream-anonymous-id": "forged-anonymous-id",
            "x-idream-role": "admin",
            "x-idream-user-id": userId,
          },
        }));

        expect(ctx.userId).toBeUndefined();
        expect(ctx.role).toBeUndefined();
        expect(ctx.anonymousId).toBeUndefined();
      } finally {
        env.APP_ENV = previousAppEnv;
      }
    },
  );

  it("uses the database role even when a test request forges admin", async () => {
    await prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        email: `${userId}@test.local`,
        emailVerified: true,
        displayName: "Auth Boundary User",
        role: "user",
        status: "active",
        dataClass: "fixture",
      },
      update: {
        deletedAt: null,
        role: "user",
        status: "active",
      },
    });

    const ctx = await getAuthCtx(new Request("http://localhost/api/v1/me", {
      headers: {
        "x-idream-role": "admin",
        "x-idream-user-id": userId,
      },
    }));

    expect(ctx.userId).toBe(userId);
    expect(ctx.role).toBe("user");
  });

  it("scopes shared media previews to the operator while preserving Main customer identity", async () => {
    for (const [id, role] of [[userId, "user"], [adminId, "admin"]]) {
      await prisma.user.upsert({
        where: { id },
        create: { id, email: `${id}@test.local`, displayName: id, role, status: "active", dataClass: "fixture" },
        update: { role, status: "active", deletedAt: null },
      });
      await prisma.session.upsert({
        where: { token: `${id}-token` },
        create: { token: `${id}-token`, userId: id, expiresAt: new Date(Date.now() + 100_000) },
        update: { expiresAt: new Date(Date.now() + 100_000) },
      });
    }
    const headers = { cookie: `idream_session=${userId}-token; idream_admin_session=${adminId}-token` };
    for (const pathname of ["/api/v1/me", "/api/v1/generation/jobs", "/api/v1/media/private/content/other"]) {
      expect((await getAuthCtx(new Request(`http://localhost${pathname}`, { headers }))).userId).toBe(userId);
    }
    for (const pathname of ["/user-content/private/content.png", "/api/v1/media/private/content"]) {
      expect((await getAuthCtx(new Request(`http://localhost${pathname}`, { headers }))).userId).toBe(userId);
      expect((await getAuthCtx(new Request(`http://localhost${pathname}`, { headers: { ...headers, "x-idream-admin-read-authority": "not_applicable" } }))).userId).toBe(adminId);
      expect((await getAuthCtx(new Request(`http://localhost${pathname}`, { headers: { cookie: `idream_admin_session=${adminId}-token` } }))).userId).toBe(adminId);
      expect((await getAuthCtx(new Request(`http://localhost${pathname}`, { method: "POST", headers }))).userId).toBe(userId);
    }
  });
});
