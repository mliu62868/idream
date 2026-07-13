import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as publishReferenceSet } from "@/app/api/v2/admin/characters/[id]/reference-sets/route";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";

describe("Character Reference Set publication", () => {
  const prefix = `zt-reference-set-${randomUUID()}-`;
  const actorId = `${prefix}admin`;
  const characterId = `${prefix}character`;
  const profileId = `${prefix}profile`;
  const assetIds = [`${prefix}anchor`, `${prefix}reference`, `${prefix}deleted-reference`];

  beforeAll(async () => {
    await purgeTestData(prefix);
    await createUser({ id: actorId, role: "admin" });
    await createCharacter({ id: characterId, creatorId: actorId, status: "draft", visibility: "private" });
    await prisma.mediaAsset.createMany({ data: assetIds.map((id) => ({
      id,
      ownerId: actorId,
      type: "image",
      url: `/user-content/${id}/content.webp`,
      visibility: "private",
      safetyStatus: "passed",
      metadata: {},
    })) });
    await prisma.characterVisualProfile.create({ data: {
      id: profileId,
      characterId,
      version: 1,
      status: "active",
      style: "realistic",
      identityPrompt: "Immutable identity fixture",
      faceTraits: { shape: "oval" },
      hairTraits: {},
      bodyTraits: {},
      signatureTraits: {},
      styleTraits: {},
      anchorAssetIds: [assetIds[0]],
      referenceAssetIds: [assetIds[1], assetIds[2]],
      adapterRefs: {},
      createdFrom: "test",
    } });
  });

  afterAll(async () => {
    await purgeTestData(prefix);
  });

  it("publishes one immutable revision and replays the same idempotent command", async () => {
    const body = {
      visualProfileId: profileId,
      selectorVersion: "admin-visual-workbench-v1",
      references: [
        { mediaAssetId: assetIds[0], role: "identity_anchor", weight: 1 },
        { mediaAssetId: assetIds[1], role: "identity_reference", weight: 1 },
      ],
      reason: { code: "reference_snapshot_publish", summary: "Seal the reviewed identity references" },
      confirmation: `PUBLISH REFERENCES ${characterId}`,
    };
    const request = () => new Request(`http://localhost/api/v2/admin/characters/${characterId}/reference-sets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "idempotency-key": `${prefix}publish-key`,
      },
      body: JSON.stringify(body),
    });

    const first = await publishReferenceSet(request(), { params: Promise.resolve({ id: characterId }) });
    const second = await publishReferenceSet(request(), { params: Promise.resolve({ id: characterId }) });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json() as { data: { id: string; snapshotHash: string; references: unknown[] } };
    const secondBody = await second.json() as { data: { id: string } };
    expect(secondBody.data.id).toBe(firstBody.data.id);
    expect(firstBody.data.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(firstBody.data.references).toHaveLength(2);
    expect(await prisma.referenceSetRevision.count({ where: { visualProfileId: profileId } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { action: "character.reference_set.published", targetId: firstBody.data.id } })).toBe(1);
  });

  it("fails closed instead of sealing a soft-deleted reference", async () => {
    await prisma.mediaAsset.update({ where: { id: assetIds[2] }, data: { deletedAt: new Date() } });
    const response = await publishReferenceSet(new Request(`http://localhost/api/v2/admin/characters/${characterId}/reference-sets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "idempotency-key": `${prefix}deleted-key`,
      },
      body: JSON.stringify({
        visualProfileId: profileId,
        selectorVersion: "admin-visual-workbench-v1",
        references: [{ mediaAssetId: assetIds[2], role: "identity_reference", weight: 1 }],
        reason: { code: "reference_snapshot_publish", summary: "Attempt to seal deleted evidence" },
        confirmation: `PUBLISH REFERENCES ${characterId}`,
      }),
    }), { params: Promise.resolve({ id: characterId }) });

    expect(response.status).toBe(409);
    expect(await prisma.referenceSetRevision.count({ where: { visualProfileId: profileId } })).toBe(1);
  });
});
