import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as publishReferenceSet } from "@/app/api/v2/admin/characters/[id]/reference-sets/route";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { createCharacterVisualProfile } from "@/server/modules/admin/characters/visual-profiles";
import { patchContentAsset } from "@/server/modules/admin/content/assets";

describe("Character Reference Set publication", () => {
  const prefix = `zt-reference-set-${randomUUID()}-`;
  const actorId = `${prefix}admin`;
  const characterId = `${prefix}character`;
  const foreignCharacterId = `${prefix}foreign-character`;
  const profileId = `${prefix}profile`;
  const assetIds = [
    `${prefix}anchor`,
    `${prefix}reference`,
    `${prefix}deleted-reference`,
    `${prefix}foreign-reference`,
    `${prefix}blocked-reference`,
  ];

  beforeAll(async () => {
    await purgeTestData(prefix);
    await createUser({ id: actorId, role: "admin", dataClass: "internal" });
    await createCharacter({ id: characterId, creatorId: actorId, status: "draft", visibility: "private" });
    await createCharacter({ id: foreignCharacterId, creatorId: actorId, status: "draft", visibility: "private" });
    await prisma.mediaAsset.createMany({ data: assetIds.map((id, index) => ({
      id,
      ownerId: actorId,
      characterId: index === 3 ? foreignCharacterId : characterId,
      type: "image",
      url: `/user-content/${id}/content.webp`,
      storageKey: `test-fixtures/${id}.webp`,
      visibility: "private",
      safetyStatus: index === 4 ? "blocked" : "passed",
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
      anchorAssetIds: assetIds,
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
      expectedActiveReferenceSetRevisionId: null,
      expectedActiveReferenceSetRevision: 0,
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

  it("allows only one publication from the same active revision and preserves the winner replay", async () => {
    const concurrentCharacterId = `${prefix}concurrent-character`;
    const concurrentProfileId = `${prefix}concurrent-profile`;
    const concurrentAssetIds = [
      `${prefix}concurrent-anchor-a`,
      `${prefix}concurrent-anchor-b`,
    ];
    await createCharacter({
      id: concurrentCharacterId,
      creatorId: actorId,
      status: "draft",
      visibility: "private",
    });
    await prisma.mediaAsset.createMany({
      data: concurrentAssetIds.map((id) => ({
        id,
        ownerId: actorId,
        characterId: concurrentCharacterId,
        type: "image",
        url: `/user-content/${id}/content.webp`,
        storageKey: `test-fixtures/${id}.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      })),
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: concurrentProfileId,
        characterId: concurrentCharacterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Concurrent reference publication fixture",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: concurrentAssetIds,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    const bodies = concurrentAssetIds.map((mediaAssetId) => ({
      visualProfileId: concurrentProfileId,
      expectedActiveReferenceSetRevisionId: null,
      expectedActiveReferenceSetRevision: 0,
      selectorVersion: "admin-visual-workbench-concurrency-v1",
      references: [{
        mediaAssetId,
        role: "identity_anchor",
        weight: 1,
      }],
      reason: {
        code: "reference_snapshot_publish",
        summary: `Seal ${mediaAssetId} from the same loaded revision`,
      },
      confirmation: `PUBLISH REFERENCES ${concurrentCharacterId}`,
    }));
    const requestFor = (index: number, key: string, body = bodies[index]) =>
      new Request(
        `http://localhost/api/v2/admin/characters/${concurrentCharacterId}/reference-sets`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
            "idempotency-key": key,
          },
          body: JSON.stringify(body),
        },
      );
    const keys = [
      `${prefix}concurrent-publish-a`,
      `${prefix}concurrent-publish-b`,
    ];
    const responses = await Promise.all([
      publishReferenceSet(requestFor(0, keys[0]), {
        params: Promise.resolve({ id: concurrentCharacterId }),
      }),
      publishReferenceSet(requestFor(1, keys[1]), {
        params: Promise.resolve({ id: concurrentCharacterId }),
      }),
    ]);
    expect(responses.map((response) => response.status).sort())
      .toEqual([201, 409]);
    expect(await prisma.referenceSetRevision.count({
      where: { visualProfileId: concurrentProfileId },
    })).toBe(1);

    const winnerIndex = responses.findIndex(
      (response) => response.status === 201,
    );
    const firstWinner = await responses[winnerIndex].json() as {
      data: { id: string; replayed: boolean };
    };
    expect(firstWinner.data.replayed).toBe(false);
    const replay = await publishReferenceSet(
      requestFor(winnerIndex, keys[winnerIndex]),
      { params: Promise.resolve({ id: concurrentCharacterId }) },
    );
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toMatchObject({
      data: { id: firstWinner.data.id, replayed: true },
    });

    const changedBody = {
      ...bodies[winnerIndex],
      reason: {
        ...bodies[winnerIndex].reason,
        summary: "A changed payload must not reuse the winner key",
      },
    };
    const conflict = await publishReferenceSet(
      requestFor(winnerIndex, keys[winnerIndex], changedBody),
      { params: Promise.resolve({ id: concurrentCharacterId }) },
    );
    expect(conflict.status).toBe(409);
  });

  it("fails closed instead of sealing a soft-deleted reference", async () => {
    await prisma.mediaAsset.update({ where: { id: assetIds[2] }, data: { deletedAt: new Date() } });
    const current = await prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: profileId, status: "active" },
    });
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
        expectedActiveReferenceSetRevisionId: current.id,
        expectedActiveReferenceSetRevision: current.revision,
        selectorVersion: "admin-visual-workbench-v1",
        references: [{ mediaAssetId: assetIds[2], role: "identity_reference", weight: 1 }],
        reason: { code: "reference_snapshot_publish", summary: "Attempt to seal deleted evidence" },
        confirmation: `PUBLISH REFERENCES ${characterId}`,
      }),
    }), { params: Promise.resolve({ id: characterId }) });

    expect(response.status).toBe(409);
    expect(await prisma.referenceSetRevision.count({ where: { visualProfileId: profileId } })).toBe(1);
  });

  it.each([
    [assetIds[3], "foreign-owner"],
    [assetIds[4], "blocked-safety"],
  ])("fails closed instead of sealing %s", async (assetId, key) => {
    const current = await prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: profileId, status: "active" },
    });
    const response = await publishReferenceSet(new Request(`http://localhost/api/v2/admin/characters/${characterId}/reference-sets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "idempotency-key": `${prefix}${key}`,
      },
      body: JSON.stringify({
        visualProfileId: profileId,
        expectedActiveReferenceSetRevisionId: current.id,
        expectedActiveReferenceSetRevision: current.revision,
        selectorVersion: "admin-visual-workbench-v1",
        references: [{ mediaAssetId: assetId, role: "identity_reference", weight: 1 }],
        reason: { code: "reference_snapshot_publish", summary: "Attempt to seal invalid evidence" },
        confirmation: `PUBLISH REFERENCES ${characterId}`,
      }),
    }), { params: Promise.resolve({ id: characterId }) });

    expect(response.status).toBe(409);
    expect(await prisma.referenceSetRevision.count({ where: { visualProfileId: profileId } })).toBe(1);
  });

  it("removes a deselected reference from runtime authority and the next identity version", async () => {
    const current = await prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: profileId, status: "active" },
    });
    const pruneRequest = new Request(
      `http://localhost/api/v2/admin/characters/${characterId}/reference-sets`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "idempotency-key": `${prefix}prune-reference`,
        },
        body: JSON.stringify({
          visualProfileId: profileId,
          expectedActiveReferenceSetRevisionId: current.id,
          expectedActiveReferenceSetRevision: current.revision,
          selectorVersion: "admin-visual-workbench-v2",
          references: [
            { mediaAssetId: assetIds[0], role: "identity_anchor", weight: 1 },
          ],
          reason: {
            code: "reference_pruned",
            summary: "Remove the weak secondary reference from active generation",
          },
          confirmation: `PUBLISH REFERENCES ${characterId}`,
        }),
      },
    );
    const pruned = await publishReferenceSet(pruneRequest, {
      params: Promise.resolve({ id: characterId }),
    });
    expect(pruned.status).toBe(201);
    const activeReferenceSet = await prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: profileId, status: "active" },
      include: { references: { orderBy: { position: "asc" } } },
    });
    expect(activeReferenceSet.revision).toBe(2);
    expect(activeReferenceSet.references.map((reference) => reference.mediaAssetId))
      .toEqual([assetIds[0]]);

    const identityResponse = await createCharacterVisualProfile(
      new Request(
        `http://localhost/api/v1/admin/content/characters/${characterId}/visual-profiles`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
            "x-request-id": `${prefix}next-identity-request`,
            "idempotency-key": `${prefix}next-identity`,
          },
          body: JSON.stringify({
            identityPrompt: "Immutable identity fixture after reference pruning",
            reason: "Carry only the current Reference Set into the next identity version",
            confirmation: `${characterId}:visual-profile`,
          }),
        },
      ),
      characterId,
    );
    expect(identityResponse.status).toBe(200);
    const activeProfile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
      orderBy: { version: "desc" },
    });
    expect(activeProfile.version).toBe(2);
    // 参考集只在 ReferenceSetRevision 上：新身份版本继承的是被裁剪后的当前参考集。
    const inheritedReferenceSet = await prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: activeProfile.id, status: "active" },
      include: { references: { orderBy: { position: "asc" } } },
    });
    expect(inheritedReferenceSet.references.map((reference) => reference.mediaAssetId))
      .toEqual([assetIds[0]]);

    const archived = await patchContentAsset(
      new Request(
        `http://localhost/api/v1/admin/content/assets/${assetIds[1]}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
          },
          body: JSON.stringify({
            status: "archived",
            reason: "Archive the reference after it left active authority",
            confirmation: assetIds[1],
          }),
        },
      ),
      assetIds[1],
    );
    expect(archived.status).toBe(200);
  });

  it("never seals an archived current image or inherited anchor into a Visual Profile", async () => {
    const fallbackCharacterId = `${prefix}archived-fallback-character`;
    const fallbackAssetId = `${prefix}archived-fallback-asset`;
    await createCharacter({
      id: fallbackCharacterId,
      creatorId: actorId,
      status: "draft",
      visibility: "private",
    });
    await prisma.mediaAsset.create({
      data: {
        id: fallbackAssetId,
        ownerId: actorId,
        characterId: fallbackCharacterId,
        type: "image",
        url: `/user-content/${fallbackAssetId}/content.webp`,
        storageKey: `test-fixtures/${fallbackAssetId}.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.character.update({
      where: { id: fallbackCharacterId },
      data: { imageAssetId: fallbackAssetId },
    });
    await expect(patchContentAsset(
      new Request(
        `http://localhost/api/v1/admin/content/assets/${fallbackAssetId}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
          },
          body: JSON.stringify({
            status: "archived",
            reason: "Archive the legacy current image before it becomes identity authority",
            confirmation: fallbackAssetId,
          }),
        },
      ),
      fallbackAssetId,
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "asset_authority_dependency_active",
        assetId: fallbackAssetId,
      },
    });
    // Simulate a legacy/corrupted row that predates the primary-image
    // dependency guard. Visual Profile creation must still fail closed rather
    // than sealing this archived pointer into identity authority.
    await prisma.mediaAsset.update({
      where: { id: fallbackAssetId },
      data: {
        metadata: {
          platformAsset: {
            status: "archived",
          },
        },
      },
    });
    await expect(
      createCharacterVisualProfile(
        new Request(
          `http://localhost/api/v1/admin/content/characters/${fallbackCharacterId}/visual-profiles`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-idream-user-id": actorId,
              "x-idream-role": "admin",
              "x-request-id": `${prefix}archived-fallback-request`,
              "idempotency-key": `${prefix}archived-fallback-command`,
            },
            body: JSON.stringify({
              identityPrompt: "This archived image must not define identity",
              reason: "Prove the current image fallback is revalidated after its media lock",
              confirmation: `${fallbackCharacterId}:visual-profile`,
            }),
          },
        ),
        fallbackCharacterId,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(prisma.characterVisualProfile.count({
      where: { characterId: fallbackCharacterId },
    })).resolves.toBe(0);

    const inheritedCharacterId = `${prefix}archived-anchor-character`;
    const inheritedAssetId = `${prefix}archived-anchor-asset`;
    await createCharacter({
      id: inheritedCharacterId,
      creatorId: actorId,
      status: "draft",
      visibility: "private",
    });
    await prisma.mediaAsset.create({
      data: {
        id: inheritedAssetId,
        ownerId: actorId,
        characterId: inheritedCharacterId,
        type: "image",
        url: `/user-content/${inheritedAssetId}/content.webp`,
        storageKey: `test-fixtures/${inheritedAssetId}.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: { platformAsset: { status: "archived" } },
      },
    });
    const inheritedProfileId = `${prefix}archived-anchor-profile`;
    await prisma.characterVisualProfile.create({
      data: {
        id: inheritedProfileId,
        characterId: inheritedCharacterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Legacy identity with an archived anchor",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [inheritedAssetId],
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await expect(
      createCharacterVisualProfile(
        new Request(
          `http://localhost/api/v1/admin/content/characters/${inheritedCharacterId}/visual-profiles`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-idream-user-id": actorId,
              "x-idream-role": "admin",
              "x-request-id": `${prefix}archived-anchor-request`,
              "idempotency-key": `${prefix}archived-anchor-command`,
            },
            body: JSON.stringify({
              identityPrompt: "The archived anchor must not carry into V2",
              reason: "Prove inherited anchors are revalidated after their media locks",
              confirmation: `${inheritedCharacterId}:visual-profile`,
            }),
          },
        ),
        inheritedCharacterId,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(prisma.characterVisualProfile.findMany({
      where: { characterId: inheritedCharacterId },
      select: { id: true, version: true, status: true },
    })).resolves.toEqual([
      {
        id: inheritedProfileId,
        version: 1,
        status: "active",
      },
    ]);
  });
});
