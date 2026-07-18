import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { getAuthCtx } from "./index";

const userId = "zt-auth-boundary-user";

describe("request authentication trust boundary", () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
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
});
