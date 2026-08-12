import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  api,
  cookieHeader,
  createCharacter,
  createMedia,
  createUser,
  expectError,
  expectOk,
  grantCoins,
  publishCharacterForPublicAudience,
  purgeTestData,
} from "@/server/test/helpers";

// SPEC (docs/architecture/11-testing.md §4 — authz/authorization):
// - unauthenticated access to user endpoints → 401
// - non-owner mutation of another user's resource → 403/404 (never succeeds)
// - non-admin access to admin endpoints → 403
// - Premium gate: no entitlement + custom prompt / video → 402
// - DTOs never leak systemPrompt or other private fields

const P = "zt-authz-";

async function withRejectedAnalytics(
  names: readonly string[],
  run: () => Promise<void>,
) {
  const rejectedNames = names
    .map((name) => `'${name.replaceAll("'", "''")}'`)
    .join(", ");
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_reject_selected_analytics()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.name IN (${rejectedNames}) THEN
        RAISE EXCEPTION 'injected analytics failure for %', NEW.name;
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER test_reject_selected_analytics
    BEFORE INSERT ON analytics_events
    FOR EACH ROW EXECUTE FUNCTION test_reject_selected_analytics()
  `);
  try {
    await run();
  } finally {
    await prisma.$executeRawUnsafe(
      "DROP TRIGGER IF EXISTS test_reject_selected_analytics ON analytics_events",
    );
    await prisma.$executeRawUnsafe(
      "DROP FUNCTION IF EXISTS test_reject_selected_analytics()",
    );
  }
}

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("auth lifecycle (cookie session)", () => {
  it("signs up, sets a session cookie, grants the signup bonus, and reflects /me", async () => {
    const signup = await api("POST", "auth/signup", {
      ageGate: true,
      body: { email: `${P}alice@test.local`, password: "password123", name: "Alice" },
    });
    expectOk(signup);
    expect(signup.setCookies.join(";")).toContain("idream_session=");

    const cookie = cookieHeader(signup.setCookies);
    const me = await api("GET", "me", { cookie });
    expectOk(me);
    expect(me.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(me.headers.get("pragma")).toBe("no-cache");
    expect(me.headers.get("vary")).toContain("Cookie");
    expect(me.headers.get("vary")).toContain("Authorization");
    expect(me.data.user.email).toBe(`${P}alice@test.local`);
    expect(me.data.dreamcoins.balance).toBe(250);
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { email: `${P}alice@test.local` },
        select: { emailVerified: true },
      }),
    ).toEqual({ emailVerified: false });
    // userDTO must not leak any credential material.
    expect(me.data.user).not.toHaveProperty("password");
  });

  it("atomically links anonymous age authority without rewriting immutable analytics history", async () => {
    const anonymousId = `${P}immutable-anon`;
    const email = `${P}immutable-signup@test.local`;
    const acceptance = await prisma.ageGateAcceptance.create({
      data: {
        anonymousId,
        policyVersion: "2026-06-13",
        sourcePath: "/explore",
      },
    });
    const anonymousEvent = await prisma.analyticsEvent.create({
      data: {
        anonymousId,
        name: "character_viewed",
        props: { source: "explore" },
        sourceService: "web",
      },
    });

    const signup = await api("POST", "auth/signup", {
      ageGate: true,
      anonymousId,
      body: { email, password: "password123", name: "Immutable Signup" },
    });
    expectOk(signup);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await expect(prisma.ageGateAcceptance.findUniqueOrThrow({
      where: { id: acceptance.id },
      select: { userId: true, anonymousId: true },
    })).resolves.toEqual({ userId: user.id, anonymousId });
    await expect(prisma.analyticsEvent.findUniqueOrThrow({
      where: { id: anonymousEvent.id },
      select: { userId: true, anonymousId: true, props: true },
    })).resolves.toEqual({
      userId: null,
      anonymousId,
      props: { source: "explore" },
    });
  });

  it("does not let optional signup telemetry flip a committed account to 500", async () => {
    const email = `${P}atomic-failure@test.local`;
    await withRejectedAnalytics(["signup"], async () => {
      const signup = await api("POST", "auth/signup", {
        ageGate: true,
        anonymousId: `${P}atomic-failure-anon`,
        body: { email, password: "password123", name: "Atomic Failure" },
      });
      expectOk(signup);
      expect(signup.setCookies.join(";")).toContain("idream_session=");
      await expect(prisma.user.count({ where: { email } })).resolves.toBe(1);
      await expect(prisma.account.count({ where: { accountId: email } })).resolves.toBe(1);
    });
  });

  it("rolls back the account when required canonical signup evidence fails", async () => {
    const email = `${P}canonical-failure@test.local`;
    await withRejectedAnalytics(
      ["customer.signup.completed.v2"],
      async () => {
        const signup = await api("POST", "auth/signup", {
          ageGate: true,
          anonymousId: `${P}canonical-failure-anon`,
          body: { email, password: "password123", name: "Canonical Failure" },
        });
        expectError(signup, 500, "internal");
        await expect(prisma.user.count({ where: { email } })).resolves.toBe(0);
        await expect(prisma.account.count({ where: { accountId: email } })).resolves.toBe(0);
      },
    );
  });

  it("normalizes concurrent duplicate signup races to one success and deterministic conflicts", async () => {
    const email = `${P}concurrent@test.local`;
    const anonymousId = `${P}concurrent-anon`;
    await prisma.ageGateAcceptance.create({
      data: {
        anonymousId,
        policyVersion: "2026-06-13",
        sourcePath: "/signup",
      },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => api("POST", "auth/signup", {
        ageGate: true,
        anonymousId,
        body: { email, password: "password123", name: "Concurrent" },
      })),
    );

    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status === 409)).toHaveLength(7);
    expect(results.every((result) => [200, 409].includes(result.status))).toBe(true);
    await expect(prisma.user.count({ where: { email } })).resolves.toBe(1);
    await expect(prisma.account.count({ where: { accountId: email } })).resolves.toBe(1);
  });

  it("rejects duplicate email with 409 and bad credentials with 401", async () => {
    const email = `${P}bob@test.local`;
    await api("POST", "auth/signup", {
      ageGate: true,
      body: { email, password: "password123", name: "Bob" },
    });
    const dup = await api("POST", "auth/signup", {
      ageGate: true,
      body: { email, password: "password123", name: "Bob2" },
    });
    expectError(dup, 409, "conflict");

    const badLogin = await api("POST", "auth/login", {
      body: { email, password: "wrong-password" },
    });
    expectError(badLogin, 401, "unauthorized");

    const goodLogin = await api("POST", "auth/login", {
      body: { email, password: "password123" },
    });
    expectOk(goodLogin);
    expect(goodLogin.setCookies.join(";")).toContain("idream_session=");
  });

  it("keeps login and the fresh age gate usable when legacy telemetry fails", async () => {
    const email = `${P}telemetry-failure@test.local`;
    const signup = await api("POST", "auth/signup", {
      ageGate: true,
      body: { email, password: "password123", name: "Telemetry Failure" },
    });
    expectOk(signup);
    const userId = signup.data.user.id as string;
    const sessionsBefore = await prisma.session.count({ where: { userId } });

    await withRejectedAnalytics(
      ["login", "age_gate_accepted"],
      async () => {
        const login = await api("POST", "auth/login", {
          body: { email, password: "password123" },
        });
        expectOk(login);
        expect(login.setCookies.join(";")).toContain("idream_session=");
        await expect(prisma.session.count({ where: { userId } })).resolves.toBe(
          sessionsBefore + 1,
        );

        const accepted = await api("POST", "age-gate/accept", {
          body: { sourcePath: "/explore", policyVersion: "2026-06-13" },
        });
        expectOk(accepted);
        const acceptedCookies = accepted.setCookies.join(";");
        expect(acceptedCookies).toContain("AdultContentAcceptedOD=true");
        expect(acceptedCookies).toContain("idream_anonymous_id=");
        const anonymousId = accepted.data.anonymousId as string;
        await expect(prisma.ageGateAcceptance.count({
          where: { anonymousId, policyVersion: "2026-06-13" },
        })).resolves.toBe(1);

        const replay = await api("POST", "age-gate/accept", {
          anonymousId,
          cookie: cookieHeader(accepted.setCookies),
          body: { sourcePath: "/explore", policyVersion: "2026-06-13" },
        });
        expectOk(replay);
        await expect(prisma.ageGateAcceptance.count({
          where: { anonymousId, policyVersion: "2026-06-13" },
        })).resolves.toBe(1);
      },
    );

    const trackedAnonymousId = `${P}tracked-age-anon`;
    const tracked = await api("POST", "age-gate/accept", {
      anonymousId: trackedAnonymousId,
      body: { sourcePath: "/community", policyVersion: "2026-06-13" },
    });
    expectOk(tracked);
    await expect(prisma.analyticsEvent.findFirstOrThrow({
      where: { name: "age_gate_accepted", anonymousId: trackedAnonymousId },
      orderBy: { createdAt: "desc" },
      select: { userId: true, anonymousId: true, dataClass: true, actor: true },
    })).resolves.toEqual({
      userId: null,
      anonymousId: trackedAnonymousId,
      dataClass: "customer",
      actor: {
        type: "anonymous",
        anonymousId: trackedAnonymousId,
        isInternal: false,
      },
    });
  });

  it("rejects public signup on reserved internal email domains", async () => {
    const signup = await api("POST", "auth/signup", {
      ageGate: true,
      body: {
        email: `${P}operator@admin.idream.internal`,
        password: "password123",
        name: "Reserved Operator",
      },
    });
    expectError(signup, 400, "bad_request");
    expect(await prisma.user.count({
      where: { email: `${P}operator@admin.idream.internal` },
    })).toBe(0);
  });

  it("allows signup when a reused anonymous id already belongs to another account", async () => {
    const anonymousId = `${P}shared-anon`;
    const firstEmail = `${P}anon-owner@test.local`;
    const secondEmail = `${P}anon-new@test.local`;

    const first = await api("POST", "auth/signup", {
      ageGate: true,
      anonymousId,
      body: { email: firstEmail, password: "password123", name: "Anon Owner" },
    });
    expectOk(first);

    const second = await api("POST", "auth/signup", {
      ageGate: true,
      anonymousId,
      body: { email: secondEmail, password: "password123", name: "Anon New" },
    });
    expectOk(second);

    const users = await prisma.user.findMany({
      where: { email: { in: [firstEmail, secondEmail] } },
      select: { email: true, anonymousId: true },
    });
    const anonymousByEmail = new Map(users.map((user) => [user.email, user.anonymousId]));
    expect(anonymousByEmail.get(firstEmail)).toBe(anonymousId);
    expect(anonymousByEmail.get(secondEmail)).toBeNull();
  });

  it("logout clears public and admin sessions from the main app", async () => {
    const adminId = `${P}admin-cookie`;
    const adminToken = `${P}admin-token`;
    await createUser({ id: adminId, role: "admin", displayName: "Admin Cookie" });
    await prisma.session.create({
      data: { userId: adminId, token: adminToken, expiresAt: new Date(Date.now() + 100000) },
    });

    const cookie = `idream_admin_session=${adminToken}`;
    const before = await api("GET", "me", { cookie });
    expectOk(before);
    expect(before.data.user.id).toBe(adminId);

    const logout = await api("POST", "auth/logout", { cookie });
    expect(logout.status).toBe(204);
    expect(logout.setCookies.join(";")).toContain("idream_session=;");
    expect(logout.setCookies.join(";")).toContain("idream_admin_session=;");
    expect(await prisma.session.count({ where: { token: adminToken } })).toBe(0);

    const after = await api("GET", "me", { cookie });
    expectOk(after);
    expect(after.data.user).toBeNull();
  });

  it("returns a null user for anonymous /me", async () => {
    const me = await api("GET", "me");
    expectOk(me);
    expect(me.data.user).toBeNull();
  });
});

describe("authentication required", () => {
  it("rejects unauthenticated access to a user-only endpoint with 401", async () => {
    const result = await api("GET", "media");
    expectError(result, 401, "unauthorized");
    expect(result.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(result.headers.get("vary")).toContain("Cookie");
    expect(result.headers.get("vary")).toContain("Authorization");
  });

  it("rejects unauthenticated dreamcoins access with 401", async () => {
    const result = await api("GET", "dreamcoins");
    expectError(result, 401, "unauthorized");
  });
});

describe("ownership scoping", () => {
  it("prevents a non-owner from editing another user's character", async () => {
    const owner = `${P}owner-1`;
    const intruder = `${P}intruder-1`;
    const charId = `${P}char-1`;
    await createUser({ id: owner });
    await createUser({ id: intruder });
    await createCharacter({ id: charId, creatorId: owner, visibility: "public", status: "approved" });

    const result = await api("PATCH", `characters/${charId}`, {
      userId: intruder,
      ageGate: true,
      body: { name: "Hijacked" },
    });
    expectError(result, 404, "not_found");

    const unchanged = await prisma.character.findUnique({ where: { id: charId } });
    expect(unchanged?.name).not.toBe("Hijacked");
  });

  it("prevents a non-owner from downloading or deleting another user's media", async () => {
    const owner = `${P}owner-2`;
    const intruder = `${P}intruder-2`;
    const mediaId = `${P}media-2`;
    await createUser({ id: owner });
    await createUser({ id: intruder });
    await createMedia({ id: mediaId, ownerId: owner });

    const download = await api("GET", `media/${mediaId}/download`, {
      userId: intruder,
      ageGate: true,
    });
    expectError(download, 404, "not_found");

    // Soft-delete is scoped to the owner; the intruder's call must not delete it.
    await api("DELETE", `media/${mediaId}`, { userId: intruder, ageGate: true });
    const stillThere = await prisma.mediaAsset.findFirst({
      where: { id: mediaId, deletedAt: null },
    });
    expect(stillThere).not.toBeNull();
  });
});

describe("admin authorization", () => {
  it("rejects non-admin access to the moderation queue with 403", async () => {
    const userId = `${P}plain-user`;
    await createUser({ id: userId });
    const result = await api("GET", "admin/moderation/queue", { userId });
    expectError(result, 403, "forbidden");
  });
});

describe("DTO privacy", () => {
  it("never exposes systemPrompt on the character detail or list DTO", async () => {
    const owner = `${P}sys-owner`;
    const charId = `${P}secret-char`;
    await createUser({ id: owner });
    await createCharacter({
      id: charId,
      creatorId: owner,
      visibility: "public",
      status: "approved",
      systemPrompt: "TOP SECRET persona instructions",
    });
    await publishCharacterForPublicAudience({
      characterId: charId,
      ownerId: owner,
    });

    const detail = await api("GET", `characters/${charId}`, { ageGate: true });
    expectOk(detail);
    expect(detail.data.character).not.toHaveProperty("systemPrompt");
    expect(JSON.stringify(detail.json)).not.toContain("TOP SECRET");

    const list = await api("GET", "characters", { ageGate: true, query: { q: "Test Character" } });
    expectOk(list);
    for (const item of list.data.items as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty("systemPrompt");
    }
  });
});

describe("premium entitlement gates (402)", () => {
  it("keeps character Moments free while requiring Premium for freeplay prompts and Deluxe for video", async () => {
    const userId = `${P}free-user`;
    const charId = `${P}gate-char`;
    await createUser({ id: userId });
    await createCharacter({ id: charId, creatorId: userId, visibility: "public", status: "approved" });
    await grantCoins(userId, 1000, "seed");

    const characterMoment = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: charId, prompt: "a custom scene", outputCount: 1 },
    });
    expectOk(characterMoment, 202);

    const freeplayPrompt = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", freeplay: true, prompt: "a custom scene", outputCount: 1 },
    });
    expectError(freeplayPrompt, 402, "payment_required");

    const video = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "video", characterId: charId, outputCount: 1 },
    });
    expectError(video, 402, "payment_required");
  });

  it("returns 402 when dreamcoin balance is insufficient and does not deduct", async () => {
    const userId = `${P}broke-user`;
    const charId = `${P}broke-char`;
    await createUser({ id: userId });
    await createCharacter({ id: charId, creatorId: userId, visibility: "public", status: "approved" });
    // No coins granted — balance 0, image costs 5.

    const result = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: charId, outputCount: 1 },
    });
    expectError(result, 402, "payment_required");
    expect(result.error?.details).toMatchObject({
      required: 5,
      available: 0,
    });

    const entries = await prisma.dreamcoinLedger.count({ where: { userId } });
    expect(entries).toBe(0);
  });
});
