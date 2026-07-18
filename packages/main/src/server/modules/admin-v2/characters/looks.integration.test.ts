import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATCH as archiveLookRoute } from "@/app/api/v2/admin/characters/[id]/looks/[lookId]/route";
import { prisma } from "@/server/lib/db";
import { mediaAssetAuthorityDependencies } from "@/server/modules/admin-v2/shared/media-asset-authority-dependencies";
import {
  createCharacter,
  createUser,
  purgeTestData,
} from "@/server/test/helpers";

const prefix = "character-look-admin-";
const adminId = `${prefix}admin`;
const ownerId = `${prefix}owner`;
const characterId = `${prefix}character`;
const profileId = `${prefix}profile`;
const assetId = `${prefix}asset`;

function request(
  lookId: string,
  body: Record<string, unknown>,
  idempotencyKey = `${prefix}key-${lookId}`,
) {
  return new Request(
    `http://localhost/api/v2/admin/characters/${characterId}/looks/${lookId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-idream-user-id": adminId,
        "x-idream-role": "admin",
      },
      body: JSON.stringify(body),
    },
  );
}

async function createLook(id: string) {
  return prisma.characterLook.create({
    data: {
      id,
      characterId,
      visualProfileId: profileId,
      ownerId,
      label: `Look ${id}`,
      appearanceDelta: { outfit: "black dress" },
      referenceAssetId: assetId,
      status: "active",
      activeKey: `${ownerId}:${characterId}:${id}`,
    },
  });
}

beforeAll(async () => {
  await purgeTestData(prefix);
  await createUser({ id: adminId, role: "admin", dataClass: "internal" });
  await createUser({ id: ownerId, dataClass: "customer" });
  await createCharacter({
    id: characterId,
    creatorId: ownerId,
    source: "user",
    visibility: "private",
    status: "approved",
  });
  await prisma.mediaAsset.create({
    data: {
      id: assetId,
      ownerId,
      characterId,
      type: "image",
      url: `/user-content/${assetId}/content.webp`,
      visibility: "private",
      safetyStatus: "passed",
      metadata: {},
    },
  });
  await prisma.characterVisualProfile.create({
    data: {
      id: profileId,
      characterId,
      version: 1,
      status: "active",
      style: "realistic",
      identityPrompt: "same adult character",
      faceTraits: {},
      hairTraits: {},
      bodyTraits: {},
      signatureTraits: {},
      styleTraits: {},
      anchorAssetIds: [assetId],
      referenceAssetIds: [assetId],
      adapterRefs: {},
      createdFrom: "test",
    },
  });
});

afterAll(async () => {
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

describe("Admin Character Look archive authority", () => {
  it("archives once and replays the same result for the same idempotency key", async () => {
    const look = await createLook(`${prefix}replay-look`);
    await expect(
      mediaAssetAuthorityDependencies(prisma, assetId),
    ).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "character_look",
        lookId: look.id,
        repairPath: `/admin/characters/${characterId}?tab=visual#character-looks`,
      }),
    ]));
    const body = {
      operation: "archive",
      expectedUpdatedAt: look.updatedAt.toISOString(),
      reason: {
        code: "look_retired",
        summary: "Retire an unused operator Look before archiving its image",
      },
      confirmation: `ARCHIVE LOOK ${look.id}`,
    };

    const first = await archiveLookRoute(request(look.id, body), {
      params: Promise.resolve({ id: characterId, lookId: look.id }),
    });
    expect(first.status).toBe(200);
    const replay = await archiveLookRoute(request(look.id, body), {
      params: Promise.resolve({ id: characterId, lookId: look.id }),
    });
    expect(replay.status).toBe(200);
    await expect(
      prisma.characterLook.findUniqueOrThrow({ where: { id: look.id } }),
    ).resolves.toMatchObject({ status: "archived", activeKey: null });
    await expect(
      prisma.adminAuditLog.count({
        where: {
          action: "character.look.archived",
          targetId: look.id,
        },
      }),
    ).resolves.toBe(1);
    expect(
      (await mediaAssetAuthorityDependencies(prisma, assetId))
        .filter((dependency) => dependency.kind === "character_look"),
    ).toEqual([]);
  });

  it("rejects a stale expectedUpdatedAt without archiving the Look", async () => {
    const look = await createLook(`${prefix}stale-look`);
    const response = await archiveLookRoute(
      request(
        look.id,
        {
          operation: "archive",
          expectedUpdatedAt: new Date(
            look.updatedAt.getTime() - 1_000,
          ).toISOString(),
          reason: {
            code: "look_retired",
            summary: "Attempt a stale Look archive",
          },
          confirmation: `ARCHIVE LOOK ${look.id}`,
        },
        `${prefix}stale-key`,
      ),
      {
        params: Promise.resolve({ id: characterId, lookId: look.id }),
      },
    );
    expect(response.status).toBe(409);
    await expect(
      prisma.characterLook.findUniqueOrThrow({ where: { id: look.id } }),
    ).resolves.toMatchObject({ status: "active" });
  });
});
