import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { compileUserCharacterContent } from "@/server/modules/ourdream/character-soul";
import { toInputJson } from "../shared/prisma-json";
import { createCharacter, createMedia, createUser, purgeTestData } from "@/server/test/helpers";
import { listContentCharacters } from "../content/merchandising";
import { POST as preparePublication } from "@/app/api/v2/admin/characters/[id]/project/route";
import { GET as workspace } from "@/app/api/v2/admin/characters/[id]/route";
const P = "zt-pending-prep-";
const actorId = `${P}operator`;
beforeAll(async () => { await purgeTestData(P); await createUser({ id: actorId, role: "admin" }); });
afterAll(async () => { await purgeTestData(P); await prisma.$disconnect(); });
function request(characterId: string, submissionId: string, key: string = crypto.randomUUID()) {
  return new Request(`http://test.local/api/v2/admin/characters/${characterId}/project`, { method: "POST", headers: { "content-type": "application/json", "x-idream-user-id": actorId, "x-idream-role": "admin", "idempotency-key": key }, body: JSON.stringify({ submissionId, reason: "Prepare historical shared character", confirmation: `PREPARE PUBLICATION ${characterId}` }) });
}
async function prepare(characterId: string, submissionId: string, key?: string) {
  return preparePublication(request(characterId, submissionId, key), { params: Promise.resolve({ id: characterId }) });
}
async function seedSubmission(suffix: string, status = "pending", charStatus = "pending_review") {
  const submitterId = `${P}submitter-${suffix}`;
  const characterId = `${P}char-${suffix}`;
  await createUser({ id: submitterId });
  await createCharacter({
    id: characterId,
    creatorId: submitterId,
    name: `Pending ${suffix}`,
    visibility: "public",
    status: charStatus,
  });
  const submission = await prisma.characterSubmission.create({
    data: {
      id: `${P}sub-${suffix}`,
      characterId,
      submitterId,
      status,
    },
  });
  return { submission, characterId, submitterId };
}

async function seedPublishableSubmission(suffix: string) {
  const seeded = await seedSubmission(suffix);
  await prisma.user.update({
    where: { id: seeded.submitterId },
    data: { dataClass: "customer" },
  });
  await prisma.character.update({
    where: { id: seeded.characterId },
    data: { source: "user" },
  });
  const character = await prisma.character.findUniqueOrThrow({
    where: { id: seeded.characterId },
  });
  const imageAssetId = `${P}image-${suffix}`;
  await createMedia({
    id: imageAssetId,
    ownerId: seeded.submitterId,
    visibility: "private",
    safetyStatus: "passed",
  });
  await prisma.mediaAsset.update({
    where: { id: imageAssetId },
    data: { characterId: character.id },
  });
  const content = compileUserCharacterContent({
    name: character.name,
    age: character.age,
    gender: character.gender,
    description: character.description,
    style: character.style,
    appearance: character.appearance,
    advancedDetails: character.advancedDetails,
  });
  const contentVersionId = `${P}content-${suffix}`;
  await prisma.characterContentVersion.create({
    data: {
      id: contentVersionId,
      characterId: character.id,
      version: 1,
      contentHash: content.contentHash,
      personaSnapshot: toInputJson(content.personaSnapshot),
      openingSnapshot: toInputJson(content.openingSnapshot),
      appearanceSnapshot: toInputJson(content.appearanceSnapshot),
      sourceType: "user",
      sourceId: seeded.submission.id,
      createdById: seeded.submitterId,
    },
  });
  await prisma.character.update({
    where: { id: character.id },
    data: { imageAssetId, currentContentVersionId: contentVersionId },
  });
  return { ...seeded, imageAssetId, contentVersionId };
}

describe("historical pending Character automatic publication preparation", () => {
  it("provides recovery and passes automatic checks without fabricating a reviewer or publishing", async () => {
    const fixture = await seedPublishableSubmission("valid");
    const discoverable = await listContentCharacters({ status: "pending_review", search: "Pending valid", sort: "recent", limit: 25 });
    expect(discoverable.items.map((item) => item.id)).toContain(fixture.characterId);
    const missing = await workspace(new Request(`http://test.local/api/v2/admin/characters/${fixture.characterId}`, { headers: { "x-idream-user-id": actorId, "x-idream-role": "admin" } }), { params: Promise.resolve({ id: fixture.characterId }) });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { details: { reason: "customer_publication_prep_missing", submissionId: fixture.submission.id } } });
    const first = await prepare(fixture.characterId, fixture.submission.id, `${P}valid`);
    expect(first.status).toBe(200);
    const payload = await first.json();
    expect(payload).toMatchObject({ data: { state: "publication_prep", servingState: "inactive", replayed: false } });
    expect(await prisma.characterSubmission.findUnique({ where: { id: fixture.submission.id } })).toMatchObject({ status: "approved", reviewerId: null, reviewedAt: null });
    expect(await prisma.character.findUnique({ where: { id: fixture.characterId } })).toMatchObject({ status: "approved" });
    expect(await prisma.characterServing.findUnique({ where: { characterId: fixture.characterId } })).toMatchObject({ state: "inactive", currentReleaseId: null });
    expect(await prisma.characterRelease.count({ where: { projectId: payload.data.projectId } })).toBe(0);
    expect(await prisma.moderationEvent.findFirst({ where: { targetId: fixture.characterId, layer: "publication_preparation" } })).toMatchObject({ status: "passed" });
    const remaining = await listContentCharacters({ status: "pending_review", search: "Pending valid", sort: "recent", limit: 25 });
    expect(remaining.items.map((item) => item.id)).not.toContain(fixture.characterId);
    const replay = await prepare(fixture.characterId, fixture.submission.id, `${P}valid`);
    expect(await replay.json()).toMatchObject({ data: { projectId: payload.data.projectId, replayed: true } });
    expect(await prisma.characterProject.count({ where: { characterId: fixture.characterId } })).toBe(1);
  });

  it.each(["blocked_text", "underage", "wrong_owner", "wrong_character", "archived_image", "synthetic_image", "missing_blob", "wrong_submission"])("keeps the pending state and creates no publication when %s fails", async (failure) => {
    const fixture = await seedPublishableSubmission(failure);
    if (failure === "blocked_text") await prisma.character.update({ where: { id: fixture.characterId }, data: { description: "underage character" } });
    if (failure === "underage") await prisma.character.update({ where: { id: fixture.characterId }, data: { age: 17 } });
    if (failure === "wrong_owner") await prisma.mediaAsset.update({ where: { id: fixture.imageAssetId }, data: { ownerId: actorId } });
    if (failure === "wrong_character") await prisma.mediaAsset.update({ where: { id: fixture.imageAssetId }, data: { characterId: null } });
    if (failure === "archived_image") await prisma.mediaAsset.update({ where: { id: fixture.imageAssetId }, data: { metadata: { platformAsset: { status: "archived" } } } });
    if (failure === "synthetic_image") await prisma.mediaAsset.update({ where: { id: fixture.imageAssetId }, data: { metadata: { synthetic: true } } });
    if (failure === "missing_blob") await prisma.mediaAsset.update({ where: { id: fixture.imageAssetId }, data: { storageKey: null, url: "/missing.png" } });
    const response = await prepare(fixture.characterId, failure === "wrong_submission" ? "unrelated-submission" : fixture.submission.id);
    expect(response.status).toBeGreaterThanOrEqual(400); expect(response.status).toBeLessThan(500);
    expect(await prisma.character.findUnique({ where: { id: fixture.characterId } })).toMatchObject({ status: "pending_review" });
    expect(await prisma.characterSubmission.findUnique({ where: { id: fixture.submission.id } })).toMatchObject({ status: "pending", reviewerId: null });
    expect(await prisma.characterProject.count({ where: { characterId: fixture.characterId } })).toBe(0);
    expect(await prisma.characterServing.count({ where: { characterId: fixture.characterId } })).toBe(0);
  });
});
