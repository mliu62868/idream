import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  api,
  createUser,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";

// SPEC: endpoints from BackendFeatureSpec §5 that complete the surface —
// users/:id/follow (5.10), generation/presets/:id PATCH (5.5),
// age-verification/webhooks/:provider (5.1), community/collections (5.10).

const P = "zt-gap-";

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("follow / unfollow creators", () => {
  it("follows and unfollows another user", async () => {
    const a = `${P}a`;
    const b = `${P}b`;
    await createUser({ id: a });
    await createUser({ id: b });

    const follow = await api("POST", `users/${b}/follow`, { userId: a });
    expectOk(follow);
    expect(follow.data.following).toBe(true);
    expect(await prisma.follow.count({ where: { followerId: a, followeeId: b } })).toBe(1);

    // Idempotent re-follow.
    await api("POST", `users/${b}/follow`, { userId: a });
    expect(await prisma.follow.count({ where: { followerId: a, followeeId: b } })).toBe(1);

    const unfollow = await api("DELETE", `users/${b}/follow`, { userId: a });
    expectOk(unfollow);
    expect(await prisma.follow.count({ where: { followerId: a, followeeId: b } })).toBe(0);
  });

  it("rejects following yourself (400) and unknown users (404)", async () => {
    const a = `${P}self`;
    await createUser({ id: a });

    const self = await api("POST", `users/${a}/follow`, { userId: a });
    expectError(self, 400, "bad_request");

    const ghost = await api("POST", `users/${P}ghost/follow`, { userId: a });
    expectError(ghost, 404, "not_found");
  });

  it("requires authentication", async () => {
    const res = await api("POST", `users/${P}x/follow`);
    expectError(res, 401, "unauthorized");
  });
});

describe("preset editing (PATCH)", () => {
  it("lets the owner edit and blocks non-owners", async () => {
    const owner = `${P}preset-owner`;
    const intruder = `${P}preset-intruder`;
    await createUser({ id: owner });
    await createUser({ id: intruder });

    const created = await api("POST", "generation/presets", {
      userId: owner,
      body: { type: "background", label: "Beach" },
    });
    const presetId = created.data.preset.id as string;

    const edit = await api("PATCH", `generation/presets/${presetId}`, {
      userId: owner,
      body: { label: "Sunset Beach", visibility: "public" },
    });
    expectOk(edit);
    expect(edit.data.preset).toMatchObject({ label: "Sunset Beach", visibility: "public" });

    const intrude = await api("PATCH", `generation/presets/${presetId}`, {
      userId: intruder,
      body: { label: "Hijacked" },
    });
    expectError(intrude, 404, "not_found");
  });
});

describe("age verification webhook", () => {
  it("applies the reported status and is idempotent", async () => {
    const userId = `${P}verify-hook`;
    await createUser({ id: userId });
    await prisma.ageVerification.create({
      data: { userId, provider: "mock", status: "pending", metadata: {} },
    });

    const webhook = await api("POST", "age-verification/webhooks/mock", {
      headers: { "x-provider-event-id": `${P}age-evt-1` },
      body: { userId, status: "verified", providerEventId: `${P}age-evt-1` },
    });
    expectOk(webhook);
    expect(webhook.data.processed).toBe(true);

    const status = await api("GET", "age-verification/status", { userId });
    expect(status.data.status).toBe("verified");

    const replay = await api("POST", "age-verification/webhooks/mock", {
      headers: { "x-provider-event-id": `${P}age-evt-1` },
      body: { userId, status: "failed", providerEventId: `${P}age-evt-1` },
    });
    expectOk(replay);
    expect(replay.data).toMatchObject({ idempotent: true, processed: false });

    // Replay must not overwrite the already-applied status.
    const after = await api("GET", "age-verification/status", { userId });
    expect(after.data.status).toBe("verified");
  });
});

describe("community collections", () => {
  it("lists public collections", async () => {
    const owner = `${P}coll-owner`;
    await createUser({ id: owner });
    await prisma.mediaCollection.create({
      data: { id: `${P}coll-1`, ownerId: owner, name: "Faves", visibility: "public" },
    });

    const res = await api("GET", "community/collections", { ageGate: true });
    expectOk(res);
    expect((res.data.collections as Array<{ id: string }>).map((c) => c.id)).toContain(`${P}coll-1`);
  });
});
