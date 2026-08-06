import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { prisma } from "@/server/lib/db";
import {
  AGE_GATE_COOKIE_HEADER,
  api,
  createCharacter,
  createMedia,
  createUser,
  expectError,
  expectOk,
  grantCoins,
  publishCharacterForPublicAudience,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";
import { dispatchV1 } from "@/server/modules/ourdream/service";

// SPEC: endpoints from BackendFeatureSpec §5 that complete the surface —
// users/:id/follow (5.10), generation/presets/:id PATCH (5.5),
// age-verification/webhooks/:provider (5.1), community/collections (5.10).

const P = "zt-gap-";

function appSettingJsonInput(value: Prisma.JsonValue): Prisma.AppSettingCreateInput["value"] {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

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
    await createUser({ id: b, dataClass: "customer" });
    await createCharacter({
      id: `${P}follow-target-character`,
      creatorId: b,
      source: "official",
      visibility: "public",
      status: "approved",
    });
    await publishCharacterForPublicAudience({
      characterId: `${P}follow-target-character`,
      ownerId: b,
    });

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
      ageGate: true,
      body: { type: "background", label: "Beach" },
    });
    const presetId = created.data.preset.id as string;

    const edit = await api("PATCH", `generation/presets/${presetId}`, {
      userId: owner,
      ageGate: true,
      body: { label: "Sunset Beach", visibility: "public" },
    });
    expectOk(edit);
    expect(edit.data.preset).toMatchObject({ label: "Sunset Beach", visibility: "public" });

    const intrude = await api("PATCH", `generation/presets/${presetId}`, {
      userId: intruder,
      ageGate: true,
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
  it("keeps an explicitly focused public collection addressable beyond the recent page", async () => {
    const ownerId = `${P}coll-focus-owner`;
    const mediaId = `${P}coll-focus-media`;
    const focusedCollectionId = `${P}coll-focus-old`;
    const hiddenCollectionId = `${P}coll-focus-hidden`;
    const recentCollectionIds = Array.from(
      { length: 20 },
      (_, index) => `${P}coll-focus-recent-${index}`,
    );
    const collectionIds = [
      focusedCollectionId,
      hiddenCollectionId,
      ...recentCollectionIds,
    ];
    await createUser({ id: ownerId, dataClass: "customer" });
    await createMedia({
      id: mediaId,
      ownerId,
      visibility: "public_pack",
    });
    await prisma.mediaCollection.createMany({
      data: [
        {
          id: focusedCollectionId,
          ownerId,
          name: "Older focused collection",
          visibility: "public",
          createdAt: new Date("2020-01-01T00:00:00.000Z"),
        },
        {
          id: hiddenCollectionId,
          ownerId,
          name: "Hidden focused collection",
          visibility: "private",
          createdAt: new Date("2020-01-02T00:00:00.000Z"),
        },
        ...recentCollectionIds.map((id, index) => ({
          id,
          ownerId,
          name: `Recent collection ${index}`,
          visibility: "public",
          createdAt: new Date(Date.now() + index * 1_000),
        })),
      ],
    });
    await prisma.mediaCollectionItem.createMany({
      data: collectionIds.map((collectionId) => ({
        collectionId,
        mediaAssetId: mediaId,
      })),
    });

    try {
      const recent = await api("GET", "community/collections", { ageGate: true });
      expectOk(recent);
      expect(
        (recent.data.collections as Array<{ id: string }>).map((collection) => collection.id),
      ).not.toContain(focusedCollectionId);

      const focused = await api("GET", "community/collections", {
        ageGate: true,
        query: { collection: focusedCollectionId },
      });
      expectOk(focused);
      const focusedIds = (focused.data.collections as Array<{ id: string }>).map(
        (collection) => collection.id,
      );
      expect(focusedIds).toContain(focusedCollectionId);
      expect(new Set(focusedIds).size).toBe(focusedIds.length);

      const hidden = await api("GET", "community/collections", {
        ageGate: true,
        query: { collection: hiddenCollectionId },
      });
      expectOk(hidden);
      expect(
        (hidden.data.collections as Array<{ id: string }>).map((collection) => collection.id),
      ).not.toContain(hiddenCollectionId);
    } finally {
      await prisma.mediaCollection.deleteMany({
        where: { id: { in: collectionIds } },
      });
      await prisma.mediaAsset.deleteMany({ where: { id: mediaId } });
      await prisma.user.deleteMany({ where: { id: ownerId } });
    }
  });

  it("does not list an empty public collection", async () => {
    const owner = `${P}coll-owner`;
    await createUser({ id: owner, dataClass: "customer" });
    await prisma.mediaCollection.create({
      data: { id: `${P}coll-1`, ownerId: owner, name: "Faves", visibility: "public" },
    });

    const res = await api("GET", "community/collections", { ageGate: true });
    expectOk(res);
    const collection = (res.data.collections as Array<{
      id: string;
      itemCount: number;
      ownerName: string | null;
      previews: string[];
    }>).find((item) => item.id === `${P}coll-1`);
    expect(collection).toBeUndefined();
  });

  it("fails closed when any public collection item is not publicly readable", async () => {
    const owner = `${P}coll-filter-owner`;
    const collectionId = `${P}coll-filter`;
    const blockedIds = Array.from({ length: 4 }, (_, index) => `${P}coll-filter-blocked-${index}`);
    const validId = `${P}coll-filter-valid`;
    const validUrl = "/user-content/eligible-collection-preview.png";
    await createUser({ id: owner, dataClass: "customer" });
    for (const id of blockedIds) {
      await createMedia({
        id,
        ownerId: owner,
        visibility: "public_pack",
        safetyStatus: "blocked",
        url: `/user-content/${id}.png`,
      });
    }
    await createMedia({
      id: validId,
      ownerId: owner,
      visibility: "public_pack",
      safetyStatus: "passed",
      url: validUrl,
    });
    await prisma.mediaCollection.create({
      data: {
        id: collectionId,
        ownerId: owner,
        name: "Filtered public collection",
        visibility: "public",
        items: {
          create: [
            ...blockedIds.map((mediaAssetId, sortOrder) => ({
              mediaAssetId,
              sortOrder,
            })),
            { mediaAssetId: validId, sortOrder: 4 },
          ],
        },
      },
    });

    const response = await api("GET", "community/collections", { ageGate: true });
    expectOk(response);
    const collection = (response.data.collections as Array<{
      id: string;
      itemCount: number;
      previews: string[];
    }>).find((item) => item.id === collectionId);

    expect(collection).toBeUndefined();
  });

  it("lets owners publish generated media into community collections", async () => {
    const owner = `${P}coll-publisher`;
    const intruder = `${P}coll-intruder`;
    const mediaId = `${P}coll-media`;
    const otherMediaId = `${P}coll-other-media`;
    await createUser({ id: owner, dataClass: "customer" });
    await createUser({ id: intruder });
    await createMedia({ id: mediaId, ownerId: owner, visibility: "private" });
    await createMedia({ id: otherMediaId, ownerId: intruder, visibility: "private" });

    const created = await api("POST", "media/collections", {
      userId: owner,
      ageGate: true,
      body: {
        mediaAssetId: mediaId,
        name: "Launch Mood Board",
        visibility: "public",
      },
    });
    expectOk(created, 201);
    expect(created.data.collection).toMatchObject({
      name: "Launch Mood Board",
      visibility: "public",
      itemCount: 1,
    });

    const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    expect(media.visibility).toBe("public_pack");

    const ownCollections = await api("GET", "media/collections", {
      userId: owner,
      ageGate: true,
    });
    expectOk(ownCollections);
    expect(
      (ownCollections.data.collections as Array<{ name: string }>).some(
        (item) => item.name === "Launch Mood Board",
      ),
    ).toBe(true);

    const community = await api("GET", "community/collections", { ageGate: true });
    expectOk(community);
    const publicCollection = (community.data.collections as Array<{
      id: string;
      itemCount: number;
      name: string;
      previews: string[];
    }>).find((item) => item.id === created.data.collection.id);
    expect(publicCollection).toMatchObject({
      itemCount: 1,
      name: "Launch Mood Board",
    });
    expect(publicCollection?.previews.length).toBe(1);

    const blocked = await api("POST", `media/collections/${created.data.collection.id}/items`, {
      userId: owner,
      ageGate: true,
      body: { mediaAssetId: otherMediaId },
    });
    expectError(blocked, 404, "not_found");
  });

  it("keeps synthetic media private and outside public collection authority", async () => {
    const owner = `${P}synthetic-collection-owner`;
    const other = `${P}synthetic-collection-other`;
    const syntheticMediaId = `${P}synthetic-collection-media`;
    const realMediaId = `${P}synthetic-collection-real-media`;
    const syntheticStorageKey = `${P}synthetic-collection.webp`;
    const syntheticTarget = resolveLocalBlobPath(syntheticStorageKey);
    await mkdir(dirname(syntheticTarget), { recursive: true });
    await writeFile(syntheticTarget, Buffer.from("private synthetic preview"));
    await createUser({ id: owner, dataClass: "customer" });
    await createUser({ id: other, dataClass: "customer" });
    await prisma.mediaAsset.create({
      data: {
        id: syntheticMediaId,
        ownerId: owner,
        type: "image",
        url: `/user-content/${Buffer.from(syntheticMediaId, "utf8").toString("base64url")}/content.webp`,
        storageKey: syntheticStorageKey,
        contentType: "image/webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: { synthetic: true, source: "mock" },
      },
    });
    await createMedia({
      id: realMediaId,
      ownerId: owner,
      visibility: "private",
      safetyStatus: "passed",
    });

    const rejectedCreate = await api("POST", "media/collections", {
      userId: owner,
      ageGate: true,
      body: {
        mediaAssetId: syntheticMediaId,
        name: "Synthetic public board",
        visibility: "public",
      },
    });
    expectError(rejectedCreate, 400, "bad_request");

    const privateCollection = await api("POST", "media/collections", {
      userId: owner,
      ageGate: true,
      body: {
        mediaAssetId: syntheticMediaId,
        name: "Private synthetic audit board",
        visibility: "private",
      },
    });
    expectOk(privateCollection, 201);

    const rejectedPublish = await api(
      "PATCH",
      `media/collections/${privateCollection.data.collection.id}`,
      {
        userId: owner,
        ageGate: true,
        body: { visibility: "public" },
      },
    );
    expectError(rejectedPublish, 400, "bad_request");

    const publicCollection = await api("POST", "media/collections", {
      userId: owner,
      ageGate: true,
      body: {
        mediaAssetId: realMediaId,
        name: "Real public board",
        visibility: "public",
      },
    });
    expectOk(publicCollection, 201);
    const rejectedAdd = await api(
      "POST",
      `media/collections/${publicCollection.data.collection.id}/items`,
      {
        userId: owner,
        ageGate: true,
        body: { mediaAssetId: syntheticMediaId },
      },
    );
    expectError(rejectedAdd, 400, "bad_request");

    const rejectedVisibility = await api("POST", "media/bulk", {
      userId: owner,
      ageGate: true,
      body: {
        ids: [syntheticMediaId],
        action: "visibility",
        visibility: "public_pack",
      },
    });
    expectError(rejectedVisibility, 400, "bad_request");
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: syntheticMediaId } }),
    ).resolves.toMatchObject({ visibility: "private" });

    await prisma.mediaCollection.update({
      where: { id: privateCollection.data.collection.id as string },
      data: { visibility: "public" },
    });
    await prisma.mediaAsset.update({
      where: { id: syntheticMediaId },
      data: { visibility: "public_pack" },
    });
    const community = await api("GET", "community/collections", { ageGate: true });
    expectOk(community);
    expect(
      (community.data.collections as Array<{ id: string }>).map((item) => item.id),
    ).not.toContain(privateCollection.data.collection.id);

    const nonOwnerAuthority = await api("GET", "me", {
      userId: other,
      ageGate: true,
    });
    expectOk(nonOwnerAuthority);

    const ownerContent = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${syntheticMediaId}/content`, {
        headers: {
          cookie: AGE_GATE_COOKIE_HEADER,
          "x-idream-user-id": owner,
        },
      }),
      ["media", syntheticMediaId, "content"],
    );
    expect(ownerContent.status).toBe(200);
    expect(await ownerContent.text()).toBe("private synthetic preview");

    const nonOwnerContent = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${syntheticMediaId}/content`, {
        headers: {
          cookie: AGE_GATE_COOKIE_HEADER,
          "x-idream-user-id": other,
        },
      }),
      ["media", syntheticMediaId, "content"],
    );
    expect(nonOwnerContent.status).toBe(404);

    const anonymousAuthority = await api("POST", "age-gate/accept", {
      body: {
        sourcePath: "/community",
        policyVersion: "2026-06-13",
      },
    });
    expectOk(anonymousAuthority);

    const publicContent = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${syntheticMediaId}/content`, {
        headers: {
          cookie: AGE_GATE_COOKIE_HEADER,
          "x-idream-anonymous-id": anonymousAuthority.data.anonymousId as string,
        },
      }),
      ["media", syntheticMediaId, "content"],
    );
    expect(publicContent.status).toBe(401);
  });

  it("serves public collection preview media to age-gated anonymous visitors", async () => {
    const owner = `${P}public-preview-owner`;
    const publicMediaId = `${P}public-preview-media`;
    const privateMediaId = `${P}private-preview-media`;
    const storageKey = `${P}public-preview.webp`;
    const target = resolveLocalBlobPath(storageKey);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from("public preview"));
    await createUser({ id: owner });
    await prisma.mediaAsset.create({
      data: {
        id: publicMediaId,
        ownerId: owner,
        type: "image",
        url: `/user-content/${Buffer.from(publicMediaId, "utf8").toString("base64url")}/content.webp`,
        thumbnailUrl: null,
        storageKey,
        contentType: "image/webp",
        visibility: "public_pack",
        safetyStatus: "passed",
        prompt: "public collection preview",
        metadata: { providerKey: storageKey },
      },
    });
    await createMedia({ id: privateMediaId, ownerId: owner, visibility: "private" });

    const acceptance = await api("POST", "age-gate/accept", {
      body: {
        sourcePath: "/community",
        policyVersion: "2026-06-13",
      },
    });
    expectOk(acceptance);
    const anonymousId = acceptance.data.anonymousId as string;

    const publicResponse = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${publicMediaId}/content`, {
        headers: {
          cookie: AGE_GATE_COOKIE_HEADER,
          "x-idream-anonymous-id": anonymousId,
        },
      }),
      ["media", publicMediaId, "content"],
    );
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("content-type")).toBe("image/webp");
    expect(await publicResponse.text()).toBe("public preview");

    const privateResponse = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${privateMediaId}/content`, {
        headers: {
          cookie: AGE_GATE_COOKIE_HEADER,
          "x-idream-anonymous-id": anonymousId,
        },
      }),
      ["media", privateMediaId, "content"],
    );
    expect(privateResponse.status).toBe(401);
  });

  it("serves private production media to an authorized admin without consumer age-gate state", async () => {
    const adminId = `${P}media-admin`;
    const adminToken = `${P}media-admin-token`;
    const mediaId = `${P}admin-private-media`;
    const storageKey = `${P}admin-private.webp`;
    const target = resolveLocalBlobPath(storageKey);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from("admin private preview"));
    await createUser({ id: adminId, role: "admin" });
    await prisma.session.create({
      data: {
        userId: adminId,
        token: adminToken,
        expiresAt: new Date(Date.now() + 100_000),
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: adminId,
        type: "image",
        url: `/user-content/${Buffer.from(mediaId, "utf8").toString("base64url")}/content.webp`,
        storageKey,
        contentType: "image/webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: { providerKey: storageKey },
      },
    });

    const response = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${mediaId}/content`, {
        headers: { cookie: `idream_admin_session=${adminToken}` },
      }),
      ["media", mediaId, "content"],
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(await response.text()).toBe("admin private preview");
  });
});

describe("synthetic media identity authority", () => {
  async function assertSyntheticIdentityBoundaries(
    markerName: "boolean" | "malformed",
    syntheticMarker: true | "true",
  ) {
    const ownerId = `${P}synthetic-${markerName}-owner`;
    const mediaAssetId = `${P}synthetic-${markerName}-media`;
    const characterId = `${P}synthetic-${markerName}-character`;
    const draftId = `${P}synthetic-${markerName}-draft`;
    const previewJobId = `${P}synthetic-${markerName}-preview`;
    await createUser({ id: ownerId });
    await prisma.mediaAsset.create({
      data: {
        id: mediaAssetId,
        ownerId,
        type: "image",
        url: `/user-content/${mediaAssetId}/content.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: { synthetic: syntheticMarker, source: "mock" },
      },
    });
    await createCharacter({
      id: characterId,
      creatorId: ownerId,
      visibility: "private",
      status: "approved",
      imageAssetId: mediaAssetId,
    });

    const library = await api("GET", "media", {
      userId: ownerId,
      ageGate: true,
    });
    expectOk(library);
    expect(
      (library.data.items as Array<{ id: string; isSynthetic: boolean }>).find(
        (item) => item.id === mediaAssetId,
      ),
    ).toMatchObject({ isSynthetic: true });

    const identityUpdate = await api(
      "POST",
      `media/${mediaAssetId}/use-as-character-image`,
      {
        userId: ownerId,
        ageGate: true,
        body: { characterId },
      },
    );
    expectError(identityUpdate, 400, "bad_request");

    const characterPublish = await api("PATCH", `characters/${characterId}`, {
      userId: ownerId,
      ageGate: true,
      body: { visibility: "public" },
    });
    expectError(characterPublish, 400, "bad_request");
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ visibility: "private" });

    await prisma.characterDraft.create({
      data: {
        id: draftId,
        ownerId,
        gender: "female",
        style: "realistic",
        appearance: {},
        hair: {},
        body: {},
        name: "Synthetic Preview Guard",
        advancedDetails: {},
        tags: [],
      },
    });
    await prisma.characterPreviewJob.create({
      data: {
        id: previewJobId,
        draftId,
        status: "completed",
        provider: "mock",
        resultAssetId: mediaAssetId,
        completedAt: new Date(),
      },
    });

    const previewSelection = await api(
      "POST",
      `character-drafts/${draftId}/preview-anchor`,
      {
        userId: ownerId,
        ageGate: true,
        body: { previewJobId },
      },
    );
    expectError(previewSelection, 400, "bad_request");

    await prisma.characterDraft.update({
      where: { id: draftId },
      data: { previewJobId },
    });
    const draftSubmit = await api("POST", `character-drafts/${draftId}/submit`, {
      userId: ownerId,
      ageGate: true,
      body: {
        age: 25,
        description: "A completed adult character draft.",
        visibility: "private",
      },
    });
    expectError(draftSubmit, 400, "bad_request");
  }

  it.each([
    ["boolean", true],
    ["malformed", "true"],
  ] as const)(
    "fails closed for %s synthetic identity markers",
    assertSyntheticIdentityBoundaries,
  );
});

describe("feed share and remix provenance", () => {
  it("mixes public media collections into feed and focuses collection share links", async () => {
    const owner = `${P}feed-coll-owner`;
    const userId = `${P}feed-coll-user`;
    const collectionId = `${P}feed-coll`;
    const mediaId = `${P}feed-coll-media`;
    const itemId = `collection:${collectionId}`;
    await createUser({
      id: owner,
      displayName: "Feed Collection Creator",
      dataClass: "customer",
    });
    await createUser({ id: userId });
    await createMedia({
      id: mediaId,
      ownerId: owner,
      visibility: "public_pack",
      url: "/images/ourdream/card-alexa-reeves.webp",
    });
    await prisma.mediaCollection.create({
      data: {
        id: collectionId,
        ownerId: owner,
        name: "Feed Collection Board",
        visibility: "public",
        items: { create: { mediaAssetId: mediaId, sortOrder: 0 } },
      },
    });

    const feed = await api("GET", "feed", {
      userId,
      ageGate: true,
      query: { limit: 8 },
    });
    expectOk(feed);
    const collectionItem = (
      feed.data.items as Array<{
        id: string;
        type: string;
        collection?: { name: string; itemCount: number; previews: string[] };
      }>
    ).find((item) => item.id === itemId);
    expect(collectionItem).toMatchObject({
      id: itemId,
      type: "collection",
      collection: {
        name: "Feed Collection Board",
        itemCount: 1,
        previews: [
          `/user-content/${Buffer.from(mediaId, "utf8").toString("base64url")}/content.webp`,
        ],
      },
    });

    const share = await api("POST", `feed/items/${encodeURIComponent(itemId)}/share`, {
      userId,
      ageGate: true,
    });
    expectOk(share);
    expect(share.data.shareUrl).toBe(`/feed?item=${encodeURIComponent(itemId)}`);

    const focused = await api("GET", "feed", {
      userId,
      ageGate: true,
      query: { item: itemId, limit: 8 },
    });
    expectOk(focused);
    expect(focused.data.focusedItemId).toBe(itemId);
    expect(focused.data.items[0]).toMatchObject({
      id: itemId,
      type: "collection",
      collection: { name: "Feed Collection Board" },
    });

    const report = await api("POST", `feed/items/${encodeURIComponent(itemId)}/report`, {
      userId,
      ageGate: true,
      body: { category: "underage", description: "collection feed report" },
    });
    expectOk(report);
    expect(await prisma.contentReport.count({ where: { targetType: "feed_item", targetId: itemId } })).toBe(1);
    const hidden = await prisma.mediaCollection.findUniqueOrThrow({ where: { id: collectionId } });
    expect(hidden.visibility).toBe("private");
  });

  it("keeps feed pagination stable when collection cards occupy the first page", async () => {
    const owner = `${P}feed-cursor-owner`;
    const userId = `${P}feed-cursor-user`;
    const collectionId = `${P}feed-cursor-coll`;
    const mediaId = `${P}feed-cursor-media`;
    const previousFeatured = await prisma.appSetting.findUnique({ where: { key: "feed.featured" } });
    await prisma.appSetting.deleteMany({ where: { key: "feed.featured" } });
    try {
      await createUser({
        id: owner,
        displayName: "Feed Cursor Creator",
        dataClass: "customer",
      });
      await createUser({ id: userId });
      await createMedia({
        id: mediaId,
        ownerId: owner,
        visibility: "public_pack",
        url: "/images/ourdream/card-alexa-reeves.webp",
      });
      await prisma.mediaCollection.create({
        data: {
          id: collectionId,
          ownerId: owner,
          name: "Feed Cursor Board",
          visibility: "public",
          items: { create: { mediaAssetId: mediaId, sortOrder: 0 } },
        },
      });
      for (let index = 0; index < 5; index += 1) {
        const characterId = `${P}feed-cursor-${index}`;
        await createCharacter({
          id: characterId,
          creatorId: owner,
          name: `Feed Cursor ${index}`,
          source: "official",
          visibility: "public",
          status: "approved",
          chats: 1_900_000_000 - index,
        });
        await publishCharacterForPublicAudience({
          characterId,
          ownerId: owner,
        });
      }

      const first = await api("GET", "feed", {
        userId,
        ageGate: true,
        query: { limit: 4 },
      });
      expectOk(first);
      expect(
        (first.data.items as Array<{ type: string; character?: { id: string } }>)
          .filter((item) => item.type === "character")
          .map((item) => item.character?.id),
      ).toEqual([`${P}feed-cursor-0`, `${P}feed-cursor-1`, `${P}feed-cursor-2`]);
      expect((first.data.items as Array<{ id: string }>).map((item) => item.id)).toContain(
        `collection:${collectionId}`,
      );
      expect(first.data.nextCursor).toBeTruthy();

      const second = await api("GET", "feed", {
        userId,
        ageGate: true,
        query: { limit: 4, cursor: first.data.nextCursor },
      });
      expectOk(second);
      expect(
        (second.data.items as Array<{ type: string; character?: { id: string } }>)
          .filter((item) => item.type === "character")
          .map((item) => item.character?.id)
          .slice(0, 2),
      ).toEqual([`${P}feed-cursor-4`, `${P}feed-cursor-3`]);
    } finally {
      if (previousFeatured) {
        const value = appSettingJsonInput(previousFeatured.value);
        await prisma.appSetting.upsert({
          where: { key: "feed.featured" },
          update: {
            value,
            version: previousFeatured.version,
            status: previousFeatured.status,
          },
          create: {
            key: previousFeatured.key,
            value,
            version: previousFeatured.version,
            status: previousFeatured.status,
          },
        });
      }
    }
  });

  it("keeps focused feed pagination reachable when featured characters fill the first page", async () => {
    const owner = `${P}feed-featured-owner`;
    const userId = `${P}feed-featured-user`;
    const collectionIds = [
      `${P}feed-featured-coll-a`,
      `${P}feed-featured-coll-b`,
    ];
    const mediaId = `${P}feed-featured-media`;
    const previousFeatured = await prisma.appSetting.findUnique({
      where: { key: "feed.featured" },
    });
    const characterIds: string[] = [];
    await createUser({
      id: owner,
      displayName: "Feed Featured Creator",
      dataClass: "customer",
    });
    await createUser({ id: userId });
    await createMedia({
      id: mediaId,
      ownerId: owner,
      visibility: "public_pack",
      url: "/images/ourdream/card-alexa-reeves.webp",
    });
    for (const [index, collectionId] of collectionIds.entries()) {
      await prisma.mediaCollection.create({
        data: {
          id: collectionId,
          ownerId: owner,
          name: `Feed Featured Board ${index + 1}`,
          visibility: "public",
          items: { create: { mediaAssetId: mediaId, sortOrder: 0 } },
        },
      });
    }
    try {
      for (let index = 0; index < 12; index += 1) {
        const characterId = `${P}feed-featured-${index}`;
        characterIds.push(characterId);
        await createCharacter({
          id: characterId,
          creatorId: owner,
          name: `Feed Featured ${index}`,
          source: "official",
          visibility: "public",
          status: "approved",
          chats: 1_800_000_000 - index,
        });
        await publishCharacterForPublicAudience({
          characterId,
          ownerId: owner,
        });
      }
      await prisma.appSetting.upsert({
        where: { key: "feed.featured" },
        update: {
          value: {
            characterIds: [
              characterIds[0],
              characterIds[0],
              ...characterIds.slice(1, 8),
            ],
          },
          version: (previousFeatured?.version ?? 0) + 1,
          status: "active",
        },
        create: {
          key: "feed.featured",
          value: {
            characterIds: [
              characterIds[0],
              characterIds[0],
              ...characterIds.slice(1, 8),
            ],
          },
          version: 1,
          status: "active",
        },
      });

      const focusedItemId = `character:${characterIds[11]}`;
      const first = await api("GET", "feed", {
        userId,
        ageGate: true,
        query: { item: focusedItemId, limit: 8 },
      });
      expectOk(first);
      expect(first.data.focusedItemId).toBe(focusedItemId);
      expect(first.data.items[0]).toMatchObject({
        id: focusedItemId,
        type: "character",
      });
      expect(
        (first.data.items as Array<{ id: string }>).map((item) => item.id),
      ).toEqual(expect.arrayContaining(collectionIds.map((id) => `collection:${id}`)));
      expect(first.data.nextCursor).toBeTruthy();

      const observedIds: string[] = (
        first.data.items as Array<{
          type: string;
          character?: { id: string };
        }>
      )
        .flatMap((item) => item.character?.id ? [item.character.id] : [])
        .filter((id) => id.startsWith(`${P}feed-featured-`));
      // Real chat events can reorder the live popularity ranking between pages.
      // The continuation must remain a snapshot/keyset traversal, independent
      // of both that mutation and later page-size changes.
      await prisma.characterStats.update({
        where: { characterId: characterIds[10] },
        data: { chatsCount: 2_100_000_000 },
      });
      await prisma.characterStats.update({
        where: { characterId: characterIds[0] },
        data: { chatsCount: 0 },
      });
      let cursor = first.data.nextCursor as string | null;
      const continuationLimits = [3, 11, 2, 5, 13, 60];
      for (let page = 0; page < 20 && cursor; page += 1) {
        const next = await api("GET", "feed", {
          userId,
          ageGate: true,
          // The opaque cursor owns the focused scope. A client may safely omit
          // the original item query on subsequent pages.
          query: {
            cursor,
            limit: continuationLimits[page % continuationLimits.length],
          },
        });
        expectOk(next);
        observedIds.push(
          ...(next.data.items as Array<{
            type: string;
            character?: { id: string };
          }>)
            .flatMap((item) => item.character?.id ? [item.character.id] : [])
            .filter((id) => id.startsWith(`${P}feed-featured-`)),
        );
        cursor = next.data.nextCursor as string | null;
      }

      expect(new Set(observedIds).size).toBe(observedIds.length);
      expect([...new Set(observedIds)].sort()).toEqual([...characterIds].sort());

      const focusedSingleItem = await api("GET", "feed", {
        userId,
        ageGate: true,
        query: { item: focusedItemId, limit: 1 },
      });
      expectOk(focusedSingleItem);
      expect(focusedSingleItem.data.items).toEqual([
        expect.objectContaining({ id: focusedItemId, type: "character" }),
      ]);
      expect(focusedSingleItem.data.nextCursor).toBeTruthy();

      const afterFocusedSingleItem = await api("GET", "feed", {
        userId,
        ageGate: true,
        query: { cursor: focusedSingleItem.data.nextCursor, limit: 7 },
      });
      expectOk(afterFocusedSingleItem);
      expect(afterFocusedSingleItem.data.items.length).toBeGreaterThan(0);
      expect(
        (afterFocusedSingleItem.data.items as Array<{ id: string }>).map(
          (item) => item.id,
        ),
      ).not.toContain(focusedItemId);

      const mismatchedScope = await api("GET", "feed", {
        userId,
        ageGate: true,
        query: {
          cursor: focusedSingleItem.data.nextCursor,
          item: `character:${characterIds[0]}`,
          limit: 7,
        },
      });
      expectError(mismatchedScope, 400, "bad_request");

      const hiddenCharacterId = `${P}feed-featured-hidden`;
      await createCharacter({
        id: hiddenCharacterId,
        creatorId: owner,
        name: "Feed Hidden Deep Link",
        source: "user",
        visibility: "private",
        status: "approved",
        chats: 0,
      });
      const hiddenItemId = `character:${hiddenCharacterId}`;
      const staleLinkFirstPage = await api("GET", "feed", {
        userId,
        ageGate: true,
        query: { item: hiddenItemId, limit: 8 },
      });
      expectOk(staleLinkFirstPage);
      expect(staleLinkFirstPage.data.focusedItemId).toBeNull();
      expect(staleLinkFirstPage.data.nextCursor).toBeTruthy();

      const staleLinkContinuation = await api("GET", "feed", {
        userId,
        ageGate: true,
        query: {
          cursor: staleLinkFirstPage.data.nextCursor,
          item: hiddenItemId,
          limit: 8,
        },
      });
      expectOk(staleLinkContinuation);
      expect(staleLinkContinuation.data.items.length).toBeGreaterThan(0);

      const staleLinkMismatchedScope = await api("GET", "feed", {
        userId,
        ageGate: true,
        query: {
          cursor: staleLinkFirstPage.data.nextCursor,
          item: `character:${characterIds[0]}`,
          limit: 8,
        },
      });
      expectError(staleLinkMismatchedScope, 400, "bad_request");

      const duplicateExclusionCursor = Buffer.from(
        JSON.stringify({
          v: 2,
          scopeItemId: null,
          snapshotAt: new Date().toISOString(),
          excludedCharacterIds: [characterIds[0], characterIds[0]],
          lastCreatedAt: null,
          lastId: null,
        }),
        "utf8",
      ).toString("base64url");
      const duplicateExclusions = await api("GET", "feed", {
        userId,
        ageGate: true,
        query: { cursor: duplicateExclusionCursor, limit: 7 },
      });
      expectError(duplicateExclusions, 400, "bad_request");

      const legacyOffsetCursor = Buffer.from(
        JSON.stringify({
          v: 1,
          scopeItemId: null,
          offset: Number.MAX_SAFE_INTEGER,
          pinnedFeaturedIds: [characterIds[0]],
        }),
        "utf8",
      ).toString("base64url");
      const legacyOffset = await api("GET", "feed", {
        userId,
        ageGate: true,
        query: { cursor: legacyOffsetCursor, limit: 7 },
      });
      expectError(legacyOffset, 400, "bad_request");
    } finally {
      if (previousFeatured) {
        await prisma.appSetting.upsert({
          where: { key: "feed.featured" },
          update: {
            value: appSettingJsonInput(previousFeatured.value),
            version: previousFeatured.version,
            status: previousFeatured.status,
          },
          create: {
            key: previousFeatured.key,
            value: appSettingJsonInput(previousFeatured.value),
            version: previousFeatured.version,
            status: previousFeatured.status,
          },
        });
      } else {
        await prisma.appSetting.deleteMany({ where: { key: "feed.featured" } });
      }
    }
  });

  it("hides characters that lack an operational public image authority", async () => {
    const owner = `${P}feed-fallback-owner`;
    await createUser({
      id: owner,
      displayName: "Fallback Creator",
      dataClass: "customer",
    });
    for (let index = 0; index < 6; index += 1) {
      await createCharacter({
        id: `${P}feed-fallback-${index}`,
        creatorId: owner,
        name: `Fallback Character ${index}`,
        visibility: "public",
        status: "approved",
        chats: 2_000_000_000 - index,
      });
    }

    const feed = await api("GET", "feed", {
      ageGate: true,
      query: { limit: 8 },
    });
    expectOk(feed);
    const unqualifiedCharacters = (
      feed.data.items as Array<{
        type: string;
        character?: { id: string; image: string; hasImage: boolean };
      }>
    )
      .filter((item) => item.type === "character" && item.character?.id.startsWith(`${P}feed-fallback-`))
      .map((item) => item.character)
      .filter((character): character is NonNullable<typeof character> => Boolean(character));

    expect(unqualifiedCharacters).toEqual([]);
  });

  it("focuses shared feed items and records generation provenance from remix", async () => {
    const owner = `${P}feed-owner`;
    const userId = `${P}feed-remixer`;
    const characterId = `${P}feed-char`;
    const itemId = `character:${characterId}`;
    await createUser({
      id: owner,
      displayName: "Feed Creator",
      dataClass: "customer",
    });
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await createCharacter({
      id: characterId,
      creatorId: owner,
      name: "Feed Remix Source",
      source: "official",
      visibility: "public",
      status: "approved",
      chats: 999,
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${characterId}-bootstrap-visual-profile`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Feed Remix Source, adult woman",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        adapterRefs: {},
        createdFrom: "generation_bootstrap:test",
      },
    });
    await publishCharacterForPublicAudience({
      characterId,
      ownerId: owner,
    });

    const shared = await api("POST", `feed/items/${encodeURIComponent(itemId)}/share`, {
      userId,
      ageGate: true,
    });
    expectOk(shared);
    expect(shared.data.shareUrl).toBe(`/feed?item=${encodeURIComponent(itemId)}`);

    const feed = await api("GET", "feed", {
      userId,
      ageGate: true,
      query: { item: itemId, limit: 6 },
    });
    expectOk(feed);
    expect(feed.data.focusedItemId).toBe(itemId);
    expect(feed.data.items[0]).toMatchObject({
      id: itemId,
      character: { id: characterId, title: "Feed Remix Source" },
    });

    const remix = await api("POST", `feed/items/${encodeURIComponent(itemId)}/remix`, {
      userId,
      ageGate: true,
    });
    expectOk(remix);
    expect(remix.data).toMatchObject({
      characterId,
      remixFeedItemId: itemId,
      remixUrl: `/generate?characterId=${characterId}&remixFeedItemId=character%3A${characterId}`,
    });

    const generationInput = {
      mode: "image" as const,
      characterId,
      outputCount: 1,
      remixFeedItemId: itemId,
    };
    const quote = await api("POST", "generation/quote", {
      userId,
      ageGate: true,
      body: generationInput,
    });
    expectOk(quote);
    const quotedCost = (
      quote.data.quote.costs as Array<{
        outputCount: number;
        costDreamcoins: number;
      }>
    ).find((cost) => cost.outputCount === 1);
    expect(quotedCost).toBeTruthy();
    const generationBody = {
      ...generationInput,
      quoteAuthority: {
        profileId: quote.data.quote.profileId as string,
        profileVersion: quote.data.quote.profileVersion as number,
        routeFingerprint: quote.data.quote.routeFingerprint as string,
        pricingFingerprint: quote.data.quote.pricing.fingerprint as string,
        outputCount: 1,
        costDreamcoins: quotedCost?.costDreamcoins as number,
      },
    };
    const remixIdempotencyKey = `${P}feed-remix-idem`;
    const job = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": remixIdempotencyKey },
      body: generationBody,
    });
    expectOk(job, 202);
    const stored = await prisma.generationJob.findUniqueOrThrow({
      where: { id: job.data.job.id as string },
    });
    expect(stored.sourceType).toBe("feed_remix");
    expect(stored.sourceId).toContain(itemId);
    expect(stored.sourceMeta).toMatchObject({
      feedItemId: itemId,
      sourceCharacterId: characterId,
      sourceCreatorId: owner,
      sourceCharacterName: "Feed Remix Source",
    });
    // The full integration suite shares one deterministic test queue across
    // files. Drain enough work to guarantee this remix reaches its terminal
    // finalize step even when earlier tests left completed queue records.
    await runQueuedGenerationJobs(32);

    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { sourceJobId: job.data.job.id as string },
    });
    const expectedProvenance = {
      sourceType: "feed_remix",
      label: "Remixed from Feed",
      feedItemId: itemId,
      sourceCharacterId: characterId,
      sourceCharacterName: "Feed Remix Source",
      href: `/feed?item=${encodeURIComponent(itemId)}`,
    };
    const completedJob = await api(
      "GET",
      `generation/jobs/${job.data.job.id as string}`,
      {
        userId,
        ageGate: true,
      },
    );
    expectOk(completedJob);
    const completedAsset = (
      completedJob.data.assets as Array<{
        id: string;
        provenance?: Record<string, unknown> | null;
      }>
    ).find((item) => item.id === asset.id);
    expect(completedAsset?.provenance).toMatchObject(expectedProvenance);

    const media = await api("GET", "media", {
      userId,
      ageGate: true,
      query: { type: "image", limit: 10 },
    });
    expectOk(media);
    const remixedMedia = (
      media.data.items as Array<{
        id: string;
        provenance?: Record<string, unknown> | null;
      }>
    ).find((item) => item.id === asset.id);
    expect(remixedMedia?.provenance).toMatchObject(expectedProvenance);
    expect(completedAsset?.provenance).toEqual(remixedMedia?.provenance);

    const balanceAfterCreate = await prisma.dreamcoinLedger.findFirstOrThrow({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { balanceAfter: true },
    });
    const serving = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
      select: { currentReleaseId: true },
    });
    expect(serving.currentReleaseId).toBeTruthy();
    await prisma.$transaction(async (tx) => {
      await tx.characterServing.update({
        where: { characterId },
        data: { state: "paused" },
      });
      await tx.publicCatalogQualification.update({
        where: { releaseId: serving.currentReleaseId as string },
        data: { revokedAt: new Date() },
      });
    });
    const replayAfterFeedWithdrawal = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      autoGenerationQuote: false,
      headers: { "Idempotency-Key": remixIdempotencyKey },
      body: generationBody,
    });
    expectOk(replayAfterFeedWithdrawal, 202);
    expect(replayAfterFeedWithdrawal.data.job.id).toBe(job.data.job.id);
    await expect(
      prisma.generationJob.count({
        where: { userId, idempotencyKey: remixIdempotencyKey },
      }),
    ).resolves.toBe(1);
    const balanceAfterReplay = await prisma.dreamcoinLedger.findFirstOrThrow({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { balanceAfter: true },
    });
    expect(balanceAfterReplay.balanceAfter).toBe(
      balanceAfterCreate.balanceAfter,
    );
  });

  it("rejects feed remix provenance for private or mismatched items", async () => {
    const owner = `${P}feed-owner-private`;
    const userId = `${P}feed-remixer-private`;
    const publicCharacterId = `${P}feed-public`;
    const privateCharacterId = `${P}feed-private`;
    await createUser({ id: owner });
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await createCharacter({
      id: publicCharacterId,
      creatorId: owner,
      source: "official",
      visibility: "public",
      status: "approved",
    });
    await publishCharacterForPublicAudience({
      characterId: publicCharacterId,
      ownerId: owner,
    });
    await createCharacter({
      id: privateCharacterId,
      creatorId: owner,
      visibility: "private",
      status: "approved",
    });

    const privateRemix = await api("POST", `feed/items/character%3A${privateCharacterId}/remix`, {
      userId,
      ageGate: true,
    });
    expectError(privateRemix, 404, "not_found");

    const mismatch = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId: publicCharacterId,
        outputCount: 1,
        remixFeedItemId: `character:${privateCharacterId}`,
      },
    });
    expectError(mismatch, 404, "not_found");
  });
});
