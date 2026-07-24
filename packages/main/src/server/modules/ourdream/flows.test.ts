import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  api,
  completeQueuedCharacterPreview,
  createCharacter,
  createUser,
  expectError,
  expectOk,
  grantCoins,
  publishCharacterForPublicAudience,
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
  generationBootstrap?: boolean;
}) {
  await createCharacter({
    id: opts.id,
    creatorId: opts.creatorId,
    name: opts.name,
    age: opts.age ?? 24,
    visibility: "public",
    status: "approved",
    source: "official",
    gender: opts.gender ?? "female",
    chats: opts.chats ?? 0,
    likes: opts.likes ?? 0,
  });
  if (opts.createdAt) {
    await prisma.character.update({
      where: { id: opts.id },
      data: { createdAt: opts.createdAt },
    });
  }
  if (opts.generationBootstrap) {
    await prisma.characterVisualProfile.create({
      data: {
        id: `${opts.id}-bootstrap-visual-profile`,
        characterId: opts.id,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: `${opts.name}, adult woman`,
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        referenceAssetIds: [],
        adapterRefs: {},
        createdFrom: "generation_bootstrap:test",
      },
    });
  }
  await publishCharacterForPublicAudience({
    characterId: opts.id,
    ownerId: opts.creatorId,
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
    ).not.toContain("/generator/ai-roleplay-generator");
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
      body: {
        step: 3,
        appearance: { hair: "red" },
        advancedDetails: {
          description: "My private companion.",
          relationshipArchetype: "childhood friend",
          personality: "Bold, observant, and protective.",
          tone: "Direct, teasing, and emotionally attentive.",
          backstory: "You grew up on the same street and never lost touch.",
          exampleDialogue: [
            "I know that look. Tell me what you are avoiding.",
          ],
          firstMessage: "There you are. What took you so long?",
        },
      },
    });
    expectOk(patched);

    const preview = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(preview);
    // Preview is async now: enqueued queued, settled by the worker, polled via GET.
    expect(preview.data.previewJob.status).toBe("queued");
    await completeQueuedCharacterPreview({
      previewJobId: preview.data.previewJob.id as string,
      draftId,
      userId,
    });
    const previewState = await api("GET", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(previewState);
    expect(previewState.data.previewJob.status).toBe("completed");
    expect(previewState.data.asset).toBeTruthy();

    const selected = await api("POST", `character-drafts/${draftId}/preview-anchor`, {
      userId,
      ageGate: true,
      body: { previewJobId: previewState.data.previewJob.id },
    });
    expectOk(selected);

    const changedIdentity = await api("PATCH", `character-drafts/${draftId}`, {
      userId,
      ageGate: true,
      body: { appearance: { prompt: "silver hair with a new identity-defining face" } },
    });
    expectOk(changedIdentity);
    const staleIdentitySubmit = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: { age: 25, visibility: "public" },
    });
    expectError(staleIdentitySubmit, 400, "bad_request");

    const refreshedPreview = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(refreshedPreview);
    await completeQueuedCharacterPreview({
      previewJobId: refreshedPreview.data.previewJob.id as string,
      draftId,
      userId,
    });
    const refreshedPreviewState = await api("GET", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(refreshedPreviewState);
    const refreshedSelection = await api("POST", `character-drafts/${draftId}/preview-anchor`, {
      userId,
      ageGate: true,
      body: { previewJobId: refreshedPreviewState.data.previewJob.id },
    });
    expectOk(refreshedSelection);

    const submit = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: { age: 22, visibility: "private", description: "My private companion." },
    });
    expectOk(submit);
    expect(submit.data.character).toMatchObject({ status: "approved", visibility: "private" });
    const characterId = submit.data.character.id as string;
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({
      relationship: "childhood friend",
      advancedDetails: expect.objectContaining({
        personality: "Bold, observant, and protective.",
        tone: "Direct, teasing, and emotionally attentive.",
        backstory: "You grew up on the same street and never lost touch.",
        firstMessage: "There you are. What took you so long?",
      }),
      systemPrompt: expect.stringContaining(
        "Bold, observant, and protective.",
      ),
    });

    const library = await api("GET", "library/created", { userId, ageGate: true });
    expectOk(library);
    expect((library.data.items as Array<{ id: string }>).map((c) => c.id)).toContain(characterId);
  });

  it("requires an identity image and a complete chat persona before publishing", async () => {
    const userId = `${P}creator-public`;
    await createUser({ id: userId });
    const draftRes = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: { name: "ZZ Public" },
    });
    const draftId = draftRes.data.draft.id as string;
    const blockedSubmit = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: { age: 25, visibility: "public" },
    });
    expectError(blockedSubmit, 400, "bad_request");
    expect(blockedSubmit.error?.message).toBe(
      "Choose an identity image before publishing this character",
    );

    const preview = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(preview);
    await completeQueuedCharacterPreview({
      previewJobId: preview.data.previewJob.id as string,
      draftId,
      userId,
    });
    const previewState = await api("GET", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(previewState);
    const selected = await api("POST", `character-drafts/${draftId}/preview-anchor`, {
      userId,
      ageGate: true,
      body: { previewJobId: previewState.data.previewJob.id },
    });
    expectOk(selected);

    const incompletePersonaSubmit = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: { age: 25, visibility: "public" },
    });
    expectError(incompletePersonaSubmit, 400, "bad_request");
    expect(incompletePersonaSubmit.error?.message).toBe(
      "Complete the character persona before publishing",
    );
    expect(incompletePersonaSubmit.error?.details).toMatchObject({
      missingFields: [
        "description",
        "relationship",
        "personality",
        "tone",
        "backstory",
        "firstMessage",
        "exampleDialogue",
      ],
    });

    const completedPersona = await api("PATCH", `character-drafts/${draftId}`, {
      userId,
      ageGate: true,
      body: {
        advancedDetails: {
          description: "A sharp-witted investigative reporter who values honest answers.",
          relationshipArchetype: "trusted confidante",
          personality: "Curious, perceptive, and quietly protective.",
          tone: "Direct, warm, and lightly teasing.",
          backstory: "You met while chasing the same late-night story and stayed close.",
          firstMessage: "You are late. Tell me what happened.",
          exampleDialogue: ["Start with the detail everyone else missed."],
        },
      },
    });
    expectOk(completedPersona);

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
    await seedChar({
      id: charId,
      name: `${P} Gen Char`,
      creatorId: `${P}sys`,
      generationBootstrap: true,
    });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: charId, outputCount: 1 },
    });
    expectOk(gen, 202);
    expect(gen.data.job.status).toBe("queued");
    await runQueuedGenerationJobs(8, [
      "ai.image.generate",
      "app.ai.finalize",
    ]);

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
