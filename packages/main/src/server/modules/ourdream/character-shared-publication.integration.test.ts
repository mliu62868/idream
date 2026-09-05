import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createUser, expectOk, purgeTestData } from "@/server/test/helpers";
import { getCharacterWorkspace } from "../admin-v2/characters/workspace";
import { prepareApprovedCustomerCharacterPublication } from "../admin-v2/characters/publication-prep";

const prefix = `zt-shared-create-${randomUUID()}-`;
afterAll(async () => {
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

async function submit(suffix: string, visibility: "public" | "unlisted" | "private") {
  const userId = `${prefix}${suffix}`;
  await createUser({ id: userId, dataClass: "customer" });
  const created = await api("POST", "character-drafts", {
    userId, ageGate: true, body: { name: `Avery ${suffix}`, age: 25, gender: "female", style: "realistic" },
  });
  expectOk(created);
  const draftId = created.data.draft.id as string;
  expectOk(await api("PATCH", `character-drafts/${draftId}`, {
    userId, ageGate: true,
    body: { age: 25, advancedDetails: { description: "A warm radio host", firstMessage: "Welcome back." } },
  }));
  const draft = await prisma.characterDraft.findUniqueOrThrow({ where: { id: draftId } });
  const asset = await prisma.mediaAsset.create({ data: {
    ownerId: userId, type: "image", url: `/user-content/${userId}.png`, storageKey: `${userId}.png`,
    visibility: "private", safetyStatus: "passed", metadata: { synthetic: false },
  } });
  const preview = await prisma.characterPreviewJob.create({ data: {
    draftId, status: "completed", resultAssetId: asset.id, completedAt: new Date(),
  } });
  const recipe = await prisma.generationRecipe.create({ data: {
    id: `${userId}-recipe`, recipeKey: `${userId}-recipe`, label: "Identity", body: "Identity portrait",
    presetOrder: [], safetyHints: {}, sampleMatrix: [],
  } });
  await prisma.generationJob.create({ data: {
    userId, mode: "image", controls: {}, presetIds: [], sourceType: "character_preview", sourceId: preview.id,
    recipeId: recipe.recipeKey, recipeVersion: recipe.version,
    prompt: [recipe.body, "realistic portrait of an adult female character", `Character name: ${draft.name}`,
      `Appearance: ${JSON.stringify(draft.appearance ?? {})}`, `Hair: ${JSON.stringify(draft.hair ?? {})}`,
      `Body: ${JSON.stringify(draft.body ?? {})}`, `Details: ${JSON.stringify(draft.advancedDetails ?? {})}`,
      "single subject, clear face, identity reference portrait"].join(". "),
  } });
  expectOk(await api("POST", `character-drafts/${draftId}/preview-anchor`, {
    userId, ageGate: true, body: { previewJobId: preview.id },
  }));
  const result = await api("POST", `character-drafts/${draftId}/submit`, {
    userId, ageGate: true, body: { visibility },
  });
  expectOk(result);
  const characterId = result.data.character.id as string;
  const submission = await prisma.characterSubmission.findFirstOrThrow({ where: { characterId } });
  return { userId, draftId, characterId, submission, character: result.data.character };
}

describe("customer shared Character publication", () => {
  it.each(["public", "unlisted"] as const)("routes %s Create directly to publication preparation after automatic checks", async (visibility) => {
    const result = await submit(visibility, visibility);
    expect(result.character).toMatchObject({ visibility, status: "approved" });
    expect(result.submission.status).toBe("approved");
    const replay = await api("POST", `character-drafts/${result.draftId}/submit`, {
      userId: result.userId, ageGate: true, body: { visibility },
    });
    expectOk(replay);
    expect(replay.data.character.id).toBe(result.characterId);
    expect(await prisma.characterSubmission.count({ where: { characterId: result.characterId } })).toBe(1);
    const pending = await api("GET", "library/created", { userId: result.userId, ageGate: true });
    expectOk(pending);
    expect(pending.data.items).toContainEqual(expect.objectContaining({
      id: result.characterId, publicationState: "awaiting_publication",
    }));

    expect(await prisma.characterSubmission.count({ where: { characterId: result.characterId, status: "pending" } })).toBe(0);
    expect(result.submission.reviewerId).toBeNull();
    expect(await getCharacterWorkspace(result.characterId)).toMatchObject({
      project: { characterId: result.characterId }, serving: { state: "inactive" }, releases: [],
    });
    const approved = await api("GET", "library/created", { userId: result.userId, ageGate: true });
    expectOk(approved);
    expect(approved.data.items).toContainEqual(expect.objectContaining({
      id: result.characterId, visibility, status: "approved", publicationState: "awaiting_publication",
    }));
    // Approval must not expose an unqualified Character to a visitor or the directory.
    expect((await api("GET", `characters/${result.characterId}`, { ageGate: true })).status).toBe(404);
    const explore = await api("GET", "characters", { ageGate: true, query: { q: `Avery ${visibility}` } });
    expectOk(explore);
    expect(explore.data.items).toEqual([]);
  });

  it("keeps private Create owner-only and rejects publication preparation", async () => {
    const result = await submit("private", "private");
    expect(result.character).toMatchObject({ visibility: "private", status: "approved" });
    expect(result.submission.status).toBe("approved");
    expect(await prisma.characterProject.count({ where: { characterId: result.characterId } })).toBe(0);
    await expect(prisma.$transaction(tx => prepareApprovedCustomerCharacterPublication(tx, {
      characterId: result.characterId, submissionId: result.submission.id,
      actor: { id: result.userId, role: "admin" }, requestId: randomUUID(), reason: "Private must stay private",
    }))).rejects.toMatchObject({ status: 409 });
  });

  it("offers the existing preparation recovery for an approved unlisted Character", async () => {
    const result = await submit("legacy-unlisted", "private");
    await prisma.character.update({ where: { id: result.characterId }, data: { visibility: "unlisted" } });
    await expect(getCharacterWorkspace(result.characterId)).rejects.toMatchObject({ details: {
      reason: "customer_publication_prep_missing", submissionId: result.submission.id,
    } });
    const moderatorId = `${prefix}recovery-admin`;
    await createUser({ id: moderatorId, role: "admin" });
    const prepared = await prisma.$transaction(tx => prepareApprovedCustomerCharacterPublication(tx, {
      characterId: result.characterId, submissionId: result.submission.id,
      actor: { id: moderatorId, role: "admin" }, requestId: randomUUID(), reason: "Recover publication preparation",
    }));
    expect(prepared).toMatchObject({ state: "publication_prep", servingState: "inactive" });
    expect(await prisma.character.findUniqueOrThrow({ where: { id: result.characterId } }))
      .toMatchObject({ visibility: "unlisted", status: "approved" });
  });

  it.each(["private", "public"] as const)("prepares publication without manual review when %s changes to unlisted", async (visibility) => {
    const result = await submit(`change-${visibility}`, visibility);
    const updated = await api("PATCH", `characters/${result.characterId}`, {
      userId: result.userId, ageGate: true, body: { visibility: "unlisted" },
    });
    expectOk(updated);
    expect(updated.data.character).toMatchObject({ visibility: "unlisted", status: "approved", publicationState: "awaiting_publication" });
    const pending = await prisma.characterSubmission.findMany({ where: { characterId: result.characterId, status: "pending" } });
    expect(pending).toHaveLength(0);
    expect(await prisma.characterServing.findUnique({ where: { characterId: result.characterId } })).toMatchObject({ state: "inactive", currentReleaseId: null });
  });
  it("keeps automatic text checks and report removals effective without manual review", async () => {
    const result = await submit("automatic-boundaries", "private");
    expect((await api("PATCH", `characters/${result.characterId}`, {
      userId: result.userId, ageGate: true, body: { description: "underage minor" },
    })).status).toBe(403);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: result.characterId } }))
      .toMatchObject({ description: "A warm radio host", status: "approved" });
    await prisma.character.update({ where: { id: result.characterId }, data: { status: "removed" } });
    expect((await api("PATCH", `characters/${result.characterId}`, {
      userId: result.userId, ageGate: true, body: { visibility: "public" },
    })).status).toBe(403);
    expect(await prisma.characterProject.count({ where: { characterId: result.characterId } })).toBe(0);
  });

  it("does not create duplicate submissions when sharing preferences are replayed", async () => {
    const result = await submit("sharing-replay", "public");
    for (let i = 0; i < 2; i++) expectOk(await api("PATCH", `characters/${result.characterId}`, {
      userId: result.userId, ageGate: true, body: { visibility: "unlisted" },
    }));
    expect(await prisma.characterSubmission.count({ where: { characterId: result.characterId } })).toBe(1);
    expect(await prisma.characterProject.count({ where: { characterId: result.characterId } })).toBe(1);
  });

});
