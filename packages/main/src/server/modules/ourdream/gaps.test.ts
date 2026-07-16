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
    await createUser({ id: b });

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
  it("lists public collections", async () => {
    const owner = `${P}coll-owner`;
    await createUser({ id: owner });
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
    expect(collection).toMatchObject({
      id: `${P}coll-1`,
      itemCount: 0,
      ownerName: "Test User",
      previews: [],
    });
  });

  it("lets owners publish generated media into community collections", async () => {
    const owner = `${P}coll-publisher`;
    const intruder = `${P}coll-intruder`;
    const mediaId = `${P}coll-media`;
    const otherMediaId = `${P}coll-other-media`;
    await createUser({ id: owner });
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

    const publicResponse = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${publicMediaId}/content`, {
        headers: { cookie: AGE_GATE_COOKIE_HEADER },
      }),
      ["media", publicMediaId, "content"],
    );
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("content-type")).toBe("image/webp");
    expect(await publicResponse.text()).toBe("public preview");

    const privateResponse = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${privateMediaId}/content`, {
        headers: { cookie: AGE_GATE_COOKIE_HEADER },
      }),
      ["media", privateMediaId, "content"],
    );
    expect(privateResponse.status).toBe(401);
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
    await createUser({ id: owner, displayName: "Feed Collection Creator" });
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
        previews: ["/images/ourdream/card-alexa-reeves.webp"],
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
      await createUser({ id: owner, displayName: "Feed Cursor Creator" });
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
        await createCharacter({
          id: `${P}feed-cursor-${index}`,
          creatorId: owner,
          name: `Feed Cursor ${index}`,
          visibility: "public",
          status: "approved",
          chats: 1_900_000_000 - index,
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
      ).toEqual([`${P}feed-cursor-3`, `${P}feed-cursor-4`]);
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

  it("spreads missing character images across stable fallback art", async () => {
    const owner = `${P}feed-fallback-owner`;
    await createUser({ id: owner, displayName: "Fallback Creator" });
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
    const fallbackImages = (
      feed.data.items as Array<{ type: string; character?: { id: string; image: string } }>
    )
      .filter((item) => item.type === "character" && item.character?.id.startsWith(`${P}feed-fallback-`))
      .map((item) => item.character?.image)
      .filter((image): image is string => Boolean(image));

    expect(fallbackImages.length).toBe(6);
    expect(new Set(fallbackImages).size).toBeGreaterThan(1);
    expect(fallbackImages.every((image) => image === "/images/ourdream/card-sarah-mercer.webp")).toBe(false);
  });

  it("focuses shared feed items and records generation provenance from remix", async () => {
    const owner = `${P}feed-owner`;
    const userId = `${P}feed-remixer`;
    const characterId = `${P}feed-char`;
    const itemId = `character:${characterId}`;
    await createUser({ id: owner, displayName: "Feed Creator" });
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await createCharacter({
      id: characterId,
      creatorId: owner,
      name: "Feed Remix Source",
      visibility: "public",
      status: "approved",
      chats: 999,
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

    const job = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": `${P}feed-remix-idem` },
      body: { mode: "image", characterId, outputCount: 1, remixFeedItemId: itemId },
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
    expect(remixedMedia?.provenance).toMatchObject({
      sourceType: "feed_remix",
      label: "Remixed from Feed",
      feedItemId: itemId,
      sourceCharacterId: characterId,
      sourceCharacterName: "Feed Remix Source",
      href: `/feed?item=${encodeURIComponent(itemId)}`,
    });
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
      visibility: "public",
      status: "approved",
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
