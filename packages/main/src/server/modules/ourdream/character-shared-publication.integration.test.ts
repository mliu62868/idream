import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
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
  it.each(["public", "unlisted"] as const)("routes %s Create through review and publication preparation", async (visibility) => {
    const result = await submit(visibility, visibility);
    expect(result.character).toMatchObject({ visibility, status: "pending_review" });
    expect(result.submission.status).toBe("pending");
    const replay = await api("POST", `character-drafts/${result.draftId}/submit`, {
      userId: result.userId, ageGate: true, body: { visibility },
    });
    expectOk(replay);
    expect(replay.data.character.id).toBe(result.characterId);
    expect(await prisma.characterSubmission.count({ where: { characterId: result.characterId } })).toBe(1);
    const pending = await api("GET", "library/created", { userId: result.userId, ageGate: true });
    expectOk(pending);
    expect(pending.data.items).toContainEqual(expect.objectContaining({
      id: result.characterId, publicationState: "pending_review",
    }));

    const moderatorId = `${prefix}moderator-${visibility}`;
    await createUser({ id: moderatorId, role: "moderator" });
    const queue = await adminV2("GET", "/api/v2/admin/content/review-queue", { userId: moderatorId, role: "moderator" });
    expectOk(queue);
    expect(queue.data.items).toContainEqual(expect.objectContaining({ submissionId: result.submission.id }));
    const reviewed = await adminV2("POST", `/api/v2/admin/content/review-queue/${result.submission.id}/decision`, {
      userId: moderatorId, role: "moderator",
      body: { decision: "approve", reason: "Prepare this shared Character", confirmation: result.submission.id },
    });
    expectOk(reviewed);
    expect(reviewed.data.publication).toMatchObject({
      state: "publication_prep", deepLink: `/admin/characters/${result.characterId}?tab=assets`,
    });
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

  it.each(["private", "public"] as const)("keeps the review queue authoritative when %s changes to unlisted", async (visibility) => {
    const result = await submit(`change-${visibility}`, visibility);
    const updated = await api("PATCH", `characters/${result.characterId}`, {
      userId: result.userId, ageGate: true, body: { visibility: "unlisted" },
    });
    expectOk(updated);
    expect(updated.data.character).toMatchObject({ visibility: "unlisted", status: "pending_review", publicationState: "pending_review" });
    const pending = await prisma.characterSubmission.findMany({ where: { characterId: result.characterId, status: "pending" } });
    expect(pending).toHaveLength(1);
    if (visibility === "public") expect(pending[0].id).toBe(result.submission.id);
  });
});
