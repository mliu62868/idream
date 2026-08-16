import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { adminV2 as adminV2Api } from "@/server/test/admin-v2-http";
import {
  api,
  createCharacter,
  createUser,
  expectError,
  expectOk,
  publishCharacterForPublicAudience,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-featured-effective-";
const adminId = `${P}admin`;
const secondAdminId = `${P}admin-second`;
const customerId = `${P}customer`;
const characterIds = {
  paused: `${P}paused`,
  revoked: `${P}revoked`,
  privateAvatar: `${P}private-avatar`,
} as const;
const savedWhilePausedId = `${P}saved-while-paused`;
const missingCharacterId = `${P}missing`;

let previousFeatured: {
  value: Prisma.InputJsonValue;
  version: number;
  status: string;
} | null = null;
const releases = new Map<string, {
  assetId: string;
  releaseId: string;
}>();

beforeAll(async () => {
  await purgeTestData(P);
  const setting = await prisma.appSetting.findUnique({
    where: { key: "feed.featured" },
  });
  previousFeatured = setting
    ? {
        value: setting.value as Prisma.InputJsonValue,
        version: setting.version,
        status: setting.status,
      }
    : null;
  await createUser({
    id: adminId,
    role: "admin",
    dataClass: "internal",
  });
  await createUser({
    id: secondAdminId,
    role: "admin",
    dataClass: "internal",
  });
  await createUser({
    id: customerId,
    role: "user",
    dataClass: "customer",
  });
  for (const characterId of [
    ...Object.values(characterIds),
    savedWhilePausedId,
  ]) {
    await createCharacter({
      id: characterId,
      creatorId: adminId,
      source: "official",
      name: `Featured truth ${characterId}`,
      visibility: "public",
      status: "approved",
    });
    releases.set(
      characterId,
      await publishCharacterForPublicAudience({
        characterId,
        ownerId: adminId,
      }),
    );
  }
  await prisma.appSetting.upsert({
    where: { key: "feed.featured" },
    update: {
      value: { characterIds: Object.values(characterIds) },
    },
    create: {
      key: "feed.featured",
      value: { characterIds: Object.values(characterIds) },
    },
  });
});

afterAll(async () => {
  if (previousFeatured) {
    await prisma.appSetting.upsert({
      where: { key: "feed.featured" },
      update: previousFeatured,
      create: {
        key: "feed.featured",
        ...previousFeatured,
      },
    });
  } else {
    await prisma.appSetting.deleteMany({
      where: { key: "feed.featured" },
    });
  }
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("Featured configured and effective runtime truth", () => {
  it("matches the Feed before and after Serving, qualification, and avatar drift", async () => {
    const configuredIds = Object.values(characterIds);
    const baseline = await featured();
    expect(baseline.configuredCharacterIds).toEqual(configuredIds);
    expect(baseline.effectiveCharacterIds).toEqual(configuredIds);
    expect(
      baseline.items.map((item) => ({
        id: item.id,
        effective: item.effective,
        blockers: item.blockers,
      })),
    ).toEqual(
      configuredIds.map((id) => ({
        id,
        effective: true,
        blockers: [],
      })),
    );
    await expectFeedMembership(configuredIds, true);

    await prisma.characterServing.update({
      where: { characterId: characterIds.paused },
      data: { state: "paused" },
    });
    await prisma.publicCatalogQualification.update({
      where: {
        releaseId: requiredRelease(characterIds.revoked).releaseId,
      },
      data: { revokedAt: new Date() },
    });
    await prisma.mediaAsset.update({
      where: {
        id: requiredRelease(characterIds.privateAvatar).assetId,
      },
      data: { visibility: "private" },
    });

    const drifted = await featured();
    expect(drifted.configuredCharacterIds).toEqual(configuredIds);
    expect(drifted.characterIds).toEqual(configuredIds);
    expect(drifted.effectiveCharacterIds).toEqual([]);
    expect(blockerCodes(drifted, characterIds.paused)).toContain(
      "serving_not_live",
    );
    expect(blockerCodes(drifted, characterIds.revoked)).toContain(
      "qualification_revoked",
    );
    expect(blockerCodes(drifted, characterIds.privateAvatar)).toContain(
      "avatar_not_public",
    );
    await expectFeedMembership(configuredIds, false);
  });

  it("uses version zero for a missing setting and creates version one", async () => {
    await prisma.appSetting.deleteMany({
      where: { key: "feed.featured" },
    });
    const empty = await featured();
    expect(empty).toMatchObject({
      settingVersion: 0,
      configuredCharacterIds: [],
      effectiveCharacterIds: [],
      settingDiagnostics: [],
    });

    const missingVersion = await adminV2Api("PUT", "/api/v2/admin/content/featured", {
      userId: adminId,
      role: "admin",
      headers: {
        "idempotency-key": `${P}missing-version`,
      },
      body: {
        characterIds: [savedWhilePausedId],
        reason: "reject missing version authority",
        confirmation: savedWhilePausedId,
      },
    });
    expectError(missingVersion, 400, "bad_request");

    const response = await adminV2Api("PUT", "/api/v2/admin/content/featured", {
      userId: adminId,
      role: "admin",
      headers: {
        "idempotency-key": `${P}create-from-zero`,
      },
      body: {
        characterIds: [savedWhilePausedId],
        expectedVersion: 0,
        reason: "create canonical Featured authority",
        confirmation: savedWhilePausedId,
      },
    });
    expectOk(response);
    expect(response.data).toMatchObject({
      settingVersion: 1,
      configuredCharacterIds: [savedWhilePausedId],
      settingDiagnostics: [],
    });
  });

  it("persists a paused Character as configured and makes it effective automatically after resume", async () => {
    await prisma.characterServing.update({
      where: { characterId: savedWhilePausedId },
      data: { state: "paused" },
    });

    const submittedIds = [savedWhilePausedId, missingCharacterId];
    const beforeSave = await featured();
    const response = await adminV2Api("PUT", "/api/v2/admin/content/featured", {
      userId: adminId,
      role: "admin",
      headers: {
        "idempotency-key": `${P}save-paused`,
      },
      body: {
        characterIds: submittedIds,
        expectedVersion: beforeSave.settingVersion,
        reason: "preserve merchandising intent while Serving is paused",
        confirmation: submittedIds.join(","),
      },
    });
    expectOk(response);
    expect(response.data).toMatchObject({
      characterIds: [savedWhilePausedId],
      configuredCharacterIds: [savedWhilePausedId],
      effectiveCharacterIds: [],
      skipped: [missingCharacterId],
      invalid: [{
        id: missingCharacterId,
        reason: "character_not_found_or_not_configurable",
      }],
    });

    const setting = await prisma.appSetting.findUniqueOrThrow({
      where: { key: "feed.featured" },
    });
    expect(
      (setting.value as { characterIds?: string[] }).characterIds,
    ).toEqual([savedWhilePausedId]);

    const paused = await featured();
    expect(paused.configuredCharacterIds).toEqual([savedWhilePausedId]);
    expect(paused.effectiveCharacterIds).toEqual([]);
    expect(blockerCodes(paused, savedWhilePausedId)).toContain(
      "serving_not_live",
    );
    await expectFeedMembership([savedWhilePausedId], false);

    await prisma.characterServing.update({
      where: { characterId: savedWhilePausedId },
      data: { state: "live" },
    });

    const resumed = await featured();
    expect(resumed.configuredCharacterIds).toEqual([savedWhilePausedId]);
    expect(resumed.effectiveCharacterIds).toEqual([savedWhilePausedId]);
    expect(resumed.items).toEqual([
      expect.objectContaining({
        id: savedWhilePausedId,
        effective: true,
        blockers: [],
      }),
    ]);
    await expectFeedMembership([savedWhilePausedId], true);
  });

  it("allows exactly one of two operators to save the same setting version", async () => {
    const baselineVersion = 40;
    await prisma.appSetting.upsert({
      where: { key: "feed.featured" },
      update: {
        value: { characterIds: [] },
        version: baselineVersion,
      },
      create: {
        key: "feed.featured",
        value: { characterIds: [] },
        version: baselineVersion,
      },
    });

    const targets = [savedWhilePausedId, characterIds.paused] as const;
    const attempts = await Promise.all(
      targets.map((characterId, index) =>
        adminV2Api("PUT", "/api/v2/admin/content/featured", {
          userId: index === 0 ? adminId : secondAdminId,
          role: "admin",
          headers: {
            "idempotency-key": `${P}concurrent-${index}`,
          },
          body: {
            characterIds: [characterId],
            expectedVersion: baselineVersion,
            reason: `concurrent Featured operator ${index}`,
            confirmation: characterId,
          },
        }),
      ),
    );

    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([
      200,
      409,
    ]);
    const winner = attempts.find((attempt) => attempt.status === 200);
    const conflict = attempts.find((attempt) => attempt.status === 409);
    expect(winner?.data.settingVersion).toBe(baselineVersion + 1);
    expect(conflict?.error).toMatchObject({
      code: "conflict",
      details: {
        reason: "featured_setting_version_conflict",
        expectedVersion: baselineVersion,
        settingVersion: baselineVersion + 1,
        configuredCharacterIds: winner?.data.configuredCharacterIds,
      },
    });

    const stored = await prisma.appSetting.findUniqueOrThrow({
      where: { key: "feed.featured" },
    });
    expect(stored.version).toBe(baselineVersion + 1);
    expect(
      (stored.value as { characterIds?: string[] }).characterIds,
    ).toEqual(winner?.data.configuredCharacterIds);
    await expect(
      prisma.adminAuditLog.count({
        where: {
          action: "content.featured.write",
          reason: { startsWith: "concurrent Featured operator" },
        },
      }),
    ).resolves.toBe(1);
  });

  it("diagnoses and canonicalizes dirty history while Feed never repeats a card", async () => {
    const overflowIds = Array.from(
      { length: 24 },
      (_, index) => `${P}historical-${index}`,
    );
    await prisma.appSetting.update({
      where: { key: "feed.featured" },
      data: {
        version: 90,
        value: {
          characterIds: [
            ` ${savedWhilePausedId} `,
            savedWhilePausedId,
            42,
            "",
            ...overflowIds,
          ],
        },
      },
    });

    const authority = await featured();
    expect(authority.settingVersion).toBe(90);
    expect(authority.configuredCharacterIds).toHaveLength(24);
    expect(authority.configuredCharacterIds[0]).toBe(savedWhilePausedId);
    expect(authority.settingDiagnostics.map((item) => item.code)).toEqual([
      "character_id_duplicate",
      "character_id_not_string",
      "character_id_blank",
      "character_id_overflow",
    ]);

    const response = await api("GET", "feed", {
      userId: customerId,
      role: "user",
      ageGate: true,
      query: { limit: 60 },
    });
    expectOk(response);
    const savedItemId = `character:${savedWhilePausedId}`;
    expect(
      (response.data.items as Array<{ id: string }>)
        .filter((item) => item.id === savedItemId),
    ).toHaveLength(1);
  });
});

type FeaturedData = {
  characterIds: string[];
  configuredCharacterIds: string[];
  effectiveCharacterIds: string[];
  settingVersion: number;
  settingDiagnostics: Array<{
    code: string;
    message: string;
    index?: number;
    id?: string;
  }>;
  items: Array<{
    id: string;
    effective: boolean;
    blockers: Array<{
      code: string;
      message: string;
      repairDeepLink: string;
    }>;
  }>;
};

async function featured() {
  const response = await adminV2Api("GET", "/api/v2/admin/content/featured", {
    userId: adminId,
    role: "admin",
  });
  expectOk(response);
  return response.data as FeaturedData;
}

function requiredRelease(characterId: string) {
  const release = releases.get(characterId);
  if (!release) throw new Error(`Missing public release for ${characterId}`);
  return release;
}

function blockerCodes(data: FeaturedData, characterId: string) {
  const item = data.items.find((candidate) => candidate.id === characterId);
  if (!item) throw new Error(`Missing Featured item ${characterId}`);
  expect(item.effective).toBe(false);
  expect(item.blockers.every((blocker) => blocker.repairDeepLink.length > 0))
    .toBe(true);
  return item.blockers.map((blocker) => blocker.code);
}

async function expectFeedMembership(
  expectedCharacterIds: readonly string[],
  included: boolean,
) {
  const response = await api("GET", "feed", {
    userId: customerId,
    role: "user",
    ageGate: true,
    query: { limit: 60 },
  });
  expectOk(response);
  const itemIds = new Set(
    (response.data.items as Array<{ id: string }>).map((item) => item.id),
  );
  for (const characterId of expectedCharacterIds) {
    expect(itemIds.has(`character:${characterId}`)).toBe(included);
  }
}
