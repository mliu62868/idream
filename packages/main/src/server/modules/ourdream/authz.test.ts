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
  purgeTestData,
} from "@/server/test/helpers";

// SPEC (docs/architecture/11-testing.md §4 — authz/authorization):
// - unauthenticated access to user endpoints → 401
// - non-owner mutation of another user's resource → 403/404 (never succeeds)
// - non-admin access to admin endpoints → 403
// - Premium gate: no entitlement + custom prompt / video → 402
// - DTOs never leak systemPrompt or other private fields

const P = "zt-authz-";

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
    expect(me.data.user.email).toBe(`${P}alice@test.local`);
    expect(me.data.dreamcoins.balance).toBe(250);
    // userDTO must not leak any credential material.
    expect(me.data.user).not.toHaveProperty("password");
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
  it("requires Premium for custom prompts and Deluxe for video — 402", async () => {
    const userId = `${P}free-user`;
    const charId = `${P}gate-char`;
    await createUser({ id: userId });
    await createCharacter({ id: charId, creatorId: userId, visibility: "public", status: "approved" });
    await grantCoins(userId, 1000, "seed");

    const customPrompt = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: charId, prompt: "a custom scene", outputCount: 1 },
    });
    expectError(customPrompt, 402, "payment_required");

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
    expect(result.error?.details).toMatchObject({ cost: 5 });

    const entries = await prisma.dreamcoinLedger.count({ where: { userId } });
    expect(entries).toBe(0);
  });
});
