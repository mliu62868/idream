import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  api,
  createUser,
  expectOk,
  grantCoins,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";

// SPEC (docs/architecture/11-testing.md §4 — core flows + state machines):
// - explore search / filter / sort / cursor pagination
// - chat: send → assistant persisted → history survives a refresh
// - create: draft → preview → submit → appears in My AI (library/created)
// - generation: queued → completed, media lands in the gallery
// - character lifecycle state transitions (private→approved, public→pending_review)

const P = "zt-flow-";
const TOKEN = "ZZQFLOW"; // unique, collision-free search token
const FOLLOW_TOKEN = "ZZQFOLLOW"; // unique, collision-free following sort token

async function seedChar(opts: {
  id: string;
  name: string;
  creatorId: string;
  chats?: number;
  likes?: number;
  createdAt?: Date;
  age?: number;
  gender?: string;
  tagSlug?: string;
}) {
  await prisma.character.create({
    data: {
      id: opts.id,
      creatorId: opts.creatorId,
      name: opts.name,
      age: opts.age ?? 24,
      description: "Flow fixture.",
      visibility: "public",
      status: "approved",
      gender: opts.gender ?? "female",
      appearance: {},
      advancedDetails: {},
      createdAt: opts.createdAt,
    },
  });
  await prisma.characterStats.create({
    data: {
      characterId: opts.id,
      chatsCount: opts.chats ?? 0,
      likesCount: opts.likes ?? 0,
    },
  });
  if (opts.tagSlug) {
    const tag = await prisma.tag.create({
      data: { id: `${P}tag-${opts.tagSlug}`, slug: opts.tagSlug, label: opts.tagSlug },
    });
    await prisma.characterTag.create({
      data: { characterId: opts.id, tagId: tag.id },
    });
  }
}

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: `${P}sys` });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("explore: search, filter, sort, pagination", () => {
  const sys = `${P}sys`;
  const followedCreator = `${P}followed-creator`;
  const otherCreator = `${P}other-creator`;
  const follower = `${P}follower`;

  beforeAll(async () => {
    await createUser({ id: followedCreator });
    await createUser({ id: otherCreator });
    await createUser({ id: follower });
    await seedChar({
      id: `${P}c-alpha`,
      name: `${TOKEN} Alpha`,
      creatorId: sys,
      chats: 300,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      age: 22,
      gender: "female",
      tagSlug: `${P}cosplay`,
    });
    await seedChar({
      id: `${P}c-beta`,
      name: `${TOKEN} Beta`,
      creatorId: sys,
      chats: 200,
      createdAt: new Date("2026-03-01T00:00:00Z"),
      age: 30,
      gender: "male",
    });
    await seedChar({
      id: `${P}c-gamma`,
      name: `${TOKEN} Gamma`,
      creatorId: sys,
      chats: 100,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      age: 38,
      gender: "female",
    });
    await seedChar({
      id: `${P}follow-old`,
      name: `${FOLLOW_TOKEN} Old`,
      creatorId: followedCreator,
      chats: 10,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      gender: "female",
    });
    await seedChar({
      id: `${P}follow-new`,
      name: `${FOLLOW_TOKEN} New`,
      creatorId: followedCreator,
      chats: 20,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      gender: "female",
    });
    await seedChar({
      id: `${P}follow-hidden`,
      name: `${FOLLOW_TOKEN} Hidden`,
      creatorId: otherCreator,
      chats: 999,
      createdAt: new Date("2026-07-01T00:00:00Z"),
      gender: "female",
    });
    await prisma.follow.create({
      data: { followerId: follower, followeeId: followedCreator },
    });
  });

  it("treats for-you as the default recommendation sort", async () => {
    const res = await api("GET", "characters", {
      ageGate: true,
      query: { q: TOKEN, sort: "for-you", limit: 28 },
    });
    expectOk(res);
    const ids = (res.data.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([`${P}c-alpha`, `${P}c-beta`, `${P}c-gamma`]);
  });

  it("searches by name and sorts by popularity (chats desc)", async () => {
    const res = await api("GET", "characters", {
      ageGate: true,
      query: { q: TOKEN, sort: "popular", limit: 28 },
    });
    expectOk(res);
    const ids = (res.data.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([`${P}c-alpha`, `${P}c-beta`, `${P}c-gamma`]);
  });

  it("sorts by newest (createdAt desc)", async () => {
    const res = await api("GET", "characters", {
      ageGate: true,
      query: { q: TOKEN, sort: "newest", limit: 28 },
    });
    const ids = (res.data.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([`${P}c-gamma`, `${P}c-beta`, `${P}c-alpha`]);
  });

  it("filters following mode to followed creators and sorts newest first", async () => {
    const res = await api("GET", "characters", {
      userId: follower,
      ageGate: true,
      query: { q: FOLLOW_TOKEN, sort: "following", limit: 28 },
    });
    expectOk(res);
    const ids = (res.data.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([`${P}follow-new`, `${P}follow-old`]);
  });

  it("returns an empty following mode for anonymous users", async () => {
    const res = await api("GET", "characters", {
      ageGate: true,
      query: { q: FOLLOW_TOKEN, sort: "following", limit: 28 },
    });
    expectOk(res);
    expect(res.data.items).toEqual([]);
    expect(res.data.nextCursor).toBeNull();
  });

  it("filters by gender", async () => {
    const res = await api("GET", "characters", {
      ageGate: true,
      query: { q: TOKEN, gender: "male" },
    });
    const ids = (res.data.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([`${P}c-beta`]);
  });

  it("filters by age range", async () => {
    const twenties = await api("GET", "characters", {
      ageGate: true,
      query: { q: TOKEN, age_min: "25", age_max: "34" },
    });
    expectOk(twenties);
    expect((twenties.data.items as Array<{ id: string }>).map((c) => c.id)).toEqual([
      `${P}c-beta`,
    ]);

    const mature = await api("GET", "characters", {
      ageGate: true,
      query: { q: TOKEN, age_min: "35" },
    });
    expectOk(mature);
    expect((mature.data.items as Array<{ id: string }>).map((c) => c.id)).toEqual([
      `${P}c-gamma`,
    ]);
  });

  it("treats any or unknown public filters as unfiltered", async () => {
    const res = await api("GET", "characters", {
      ageGate: true,
      query: { q: TOKEN, gender: "any", style: "any", sort: "popular" },
    });
    expectOk(res);
    const ids = (res.data.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([`${P}c-alpha`, `${P}c-beta`, `${P}c-gamma`]);

    const unknown = await api("GET", "characters", {
      ageGate: true,
      query: { q: TOKEN, gender: "robot", style: "claymation", sort: "popular" },
    });
    expectOk(unknown);
    expect((unknown.data.items as Array<{ id: string }>).map((c) => c.id)).toEqual(ids);
  });

  it("filters by tag slug", async () => {
    const res = await api("GET", "characters", {
      ageGate: true,
      query: { q: TOKEN, tags: `${P}cosplay` },
    });
    const ids = (res.data.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([`${P}c-alpha`]);
  });

  it("paginates with a cursor", async () => {
    const page1 = await api("GET", "characters", {
      ageGate: true,
      query: { q: TOKEN, sort: "popular", limit: 2 },
    });
    const ids1 = (page1.data.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids1).toEqual([`${P}c-alpha`, `${P}c-beta`]);
    expect(page1.data.nextCursor).not.toBeNull();

    const page2 = await api("GET", "characters", {
      ageGate: true,
      query: { q: TOKEN, sort: "popular", limit: 2, cursor: page1.data.nextCursor },
    });
    const ids2 = (page2.data.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids2).toEqual([`${P}c-gamma`]);
  });

  it("suggests characters and tags for a query", async () => {
    const res = await api("GET", "search/suggest", {
      ageGate: true,
      query: { q: `${TOKEN} Alpha` },
    });
    expectOk(res);
    expect((res.data.characters as Array<{ id: string }>).map((c) => c.id)).toContain(
      `${P}c-alpha`,
    );

    const tagRes = await api("GET", "search/suggest", {
      ageGate: true,
      query: { q: `${P}cosplay` },
    });
    expectOk(tagRes);
    expect((tagRes.data.tags as Array<{ slug: string }>).map((tag) => tag.slug)).toContain(
      `${P}cosplay`,
    );

    const guideRes = await api("GET", "search/suggest", {
      ageGate: true,
      query: { q: "character cards" },
    });
    expectOk(guideRes);
    expect((guideRes.data.routes as Array<{ href: string }>).map((route) => route.href)).toContain(
      "/guides/character-cards",
    );

    const generatorRes = await api("GET", "search/suggest", {
      ageGate: true,
      query: { q: "ai roleplay generator" },
    });
    expectOk(generatorRes);
    expect(
      (generatorRes.data.routes as Array<{ href: string }>).map((route) => route.href),
    ).toContain("/generator/ai-roleplay-generator");
  });
});

describe("create lifecycle: draft → preview → submit → My AI", () => {
  it("walks a draft through to an approved private character visible in library", async () => {
    const userId = `${P}creator`;
    await createUser({ id: userId });

    const draftRes = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: { gender: "female", style: "realistic", name: "ZZ Nova" },
    });
    expectOk(draftRes);
    const draftId = draftRes.data.draft.id as string;

    const patched = await api("PATCH", `character-drafts/${draftId}`, {
      userId,
      ageGate: true,
      body: { step: 3, appearance: { hair: "red" } },
    });
    expectOk(patched);

    const preview = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(preview);
    // Preview is async now: enqueued queued, settled by the worker, polled via GET.
    expect(preview.data.previewJob.status).toBe("queued");
    await runQueuedGenerationJobs(8);
    const previewState = await api("GET", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(previewState);
    expect(previewState.data.previewJob.status).toBe("completed");
    expect(previewState.data.asset).toBeTruthy();

    const submit = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: { age: 22, visibility: "private", description: "My private companion." },
    });
    expectOk(submit);
    expect(submit.data.character).toMatchObject({ status: "approved", visibility: "private" });
    const characterId = submit.data.character.id as string;

    const library = await api("GET", "library/created", { userId, ageGate: true });
    expectOk(library);
    expect((library.data.items as Array<{ id: string }>).map((c) => c.id)).toContain(characterId);
  });

  it("routes a public submission to pending_review", async () => {
    const userId = `${P}creator-public`;
    await createUser({ id: userId });
    const draftRes = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: { name: "ZZ Public" },
    });
    const draftId = draftRes.data.draft.id as string;
    const submit = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: { age: 25, visibility: "public" },
    });
    expectOk(submit);
    expect(submit.data.character.status).toBe("pending_review");
  });
});

describe("generation → media gallery", () => {
  it("completes an image job and the asset appears in the gallery", async () => {
    const userId = `${P}gen-user`;
    const charId = `${P}gen-char`;
    await createUser({ id: userId });
    await seedChar({ id: charId, name: `${P} Gen Char`, creatorId: `${P}sys` });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: charId, outputCount: 1 },
    });
    expectOk(gen, 202);
    expect(gen.data.job.status).toBe("queued");
    await runQueuedGenerationJobs(8);

    const poll = await api("GET", `generation/jobs/${gen.data.job.id}`, {
      userId,
      ageGate: true,
    });
    expectOk(poll);
    expect(poll.data.job.status).toBe("completed");
    const assetId = (poll.data.assets as Array<{ id: string }>)[0].id;

    const gallery = await api("GET", "media", {
      userId,
      ageGate: true,
      query: { type: "image" },
    });
    expectOk(gallery);
    expect((gallery.data.items as Array<{ id: string }>).map((m) => m.id)).toContain(assetId);

    const libraryMedia = await api("GET", "library/media", { userId, ageGate: true });
    expectOk(libraryMedia);
    expect((libraryMedia.data.items as Array<{ id: string }>).map((m) => m.id)).toContain(assetId);
  });
});
