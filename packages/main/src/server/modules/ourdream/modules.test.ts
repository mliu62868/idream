import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAIN_TO_CHAT_EVENTS,
  METRIC_PRODUCT_EVENTS,
} from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import {
  hydratedImageReferenceInputs,
  imageReferenceInputsForGenerationJob,
} from "@/server/ai/reference-images";
import { dispatchV1 } from "@/server/modules/ourdream/service";
import { compileUserCharacterContent } from "@/server/modules/ourdream/character-soul";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  AGE_GATE_COOKIE_HEADER,
  api,
  createCharacter,
  createMedia,
  createRedeemCode,
  createUser,
  cookieHeader,
  dreamcoinBalance,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";
import { legacyRedeemCodeHash } from "@/server/lib/redeem-codes";
import { adminV2 } from "@/server/test/admin-v2-http";
import type { ApiResult } from "@/server/test/helpers";

// SPEC: Remaining API surface (BackendFeatureSpec §5.1/5.6/5.7/5.9/5.10) —
// age gate/verification, profile/preferences/language, redeem, referrals,
// account, library tabs, tags, likes/duplicate, presets, media bulk, feed,
// community, policies, analytics. Each endpoint gets happy-path + a key guard.

const P = "zt-mod-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;

async function seedCurrentPublicCharacterAuthority(input: {
  characterId: string;
  ownerId: string;
}) {
  const avatarAssetId = `${input.characterId}-public-avatar`;
  const projectId = `${input.characterId}-public-project`;
  const releaseId = `${input.characterId}-public-release`;
  const contentVersionId = `${releaseId}-content`;
  const snapshotHash = `${releaseId}-snapshot`;

  await prisma.$transaction(async (tx) => {
    const character = await tx.character.findUniqueOrThrow({
      where: { id: input.characterId },
      select: {
        creatorId: true,
        source: true,
        name: true,
        age: true,
        gender: true,
        relationship: true,
        description: true,
        style: true,
        appearance: true,
        advancedDetails: true,
      },
    });
    const generatedUserRelease = character.source === "user";
    if (generatedUserRelease && character.creatorId !== input.ownerId) {
      throw new Error("Generated public fixture must be owned by its user creator");
    }
    const releaseAssets = generatedUserRelease
      ? [
          { id: avatarAssetId, slotKey: "character_avatar" },
          { id: `${input.characterId}-public-hero`, slotKey: "character_hero" },
          { id: `${input.characterId}-public-chat`, slotKey: "character_chat" },
        ]
      : [{ id: avatarAssetId, slotKey: "character_avatar" }];
    await tx.mediaAsset.createMany({
      data: releaseAssets.map((asset) => ({
        id: asset.id,
        ownerId: input.ownerId,
        characterId: input.characterId,
        type: "image",
        url: `/user-content/${asset.id}/content.webp`,
        thumbnailUrl: `/user-content/${asset.id}/thumbnail.webp`,
        visibility: "public_pack",
        safetyStatus: "passed",
        metadata: {
          source: generatedUserRelease ? "generated_release_fixture" : "editorial_import",
          synthetic: false,
          platformAsset: { status: "approved" },
        },
      })),
    });
    const compiledContent = compileUserCharacterContent({
      name: character.name,
      age: character.age,
      gender: character.gender,
      relationship: character.relationship,
      description: character.description,
      style: character.style,
      appearance: character.appearance,
      advancedDetails: character.advancedDetails,
    });
    await tx.characterContentVersion.create({
      data: {
        id: contentVersionId,
        characterId: input.characterId,
        version: 1,
        contentHash: compiledContent.contentHash,
        personaSnapshot: toInputJson(compiledContent.personaSnapshot),
        openingSnapshot: toInputJson(compiledContent.openingSnapshot),
        appearanceSnapshot: toInputJson(compiledContent.appearanceSnapshot),
        sourceType: "test",
      },
    });
    await tx.character.update({
      where: { id: input.characterId },
      data: {
        imageAssetId: avatarAssetId,
        currentContentVersionId: contentVersionId,
      },
    });
    await tx.characterProject.create({
      data: {
        id: projectId,
        characterId: input.characterId,
        phase: "live_management",
        audience: {},
        successCriteria: [],
      },
    });
    await tx.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `${releaseId}-revision`,
        characterContentVersionId: contentVersionId,
        generationProvenance: generatedUserRelease
          ? {
              schemaVersion: "character-release-generation-provenance-v2",
              policyVersion: "character-release-policy-v2",
              requiredReleaseRoute: {
                routeFingerprint: `${releaseId}-route`,
                matrixKey: "modules-public-authority",
                generationProfileKey: "modules-public-profile",
                generationProfileVersion: 1,
                workflowKey: "modules-public-workflow",
                workflowVersion: 1,
              },
              placements: releaseAssets.map((asset) => ({
                slotKey: asset.slotKey,
                assetId: asset.id,
                provider: "pipeline",
              })),
            }
          : {
              schemaVersion: "character-release-editorial-import-v1",
              sourceAssetId: avatarAssetId,
            },
        releasePlacementManifest: generatedUserRelease
          ? {
              schemaVersion: 2,
              placements: releaseAssets.map((asset) => ({
                slotKey: asset.slotKey,
                assetId: asset.id,
                slotVersion: 1,
              })),
            }
          : {
              schemaVersion: 1,
              kind: "editorial_import",
              placements: [
                {
                  slotKey: "character_avatar",
                  assetId: avatarAssetId,
                  slotVersion: 1,
                },
              ],
            },
        snapshotHash,
        readiness: "ready",
        legacy: !generatedUserRelease,
        status: "published",
        publishedAt: new Date(),
      },
    });
    const validationRunId = generatedUserRelease
      ? `${releaseId}-validation`
      : null;
    if (validationRunId) {
      await tx.releaseValidationRun.create({
        data: {
          id: validationRunId,
          releaseId,
          snapshotHash,
          policyVersion: "character-release-policy-v2",
          result: "passed",
          finishedAt: new Date(),
        },
      });
    }
    await tx.publicCatalogQualification.create({
      data: {
        id: `${releaseId}-qualification`,
        releaseId,
        releaseSnapshotHash: snapshotHash,
        kind: generatedUserRelease ? "generated_release" : "editorial_import",
        validationRunId,
        evidence: generatedUserRelease
          ? {
              schemaVersion: "public-catalog-qualification-v1",
              policyVersion: "character-release-policy-v2",
              validationRunId,
            }
          : {
              schemaVersion: "public-catalog-qualification-v1",
              policyVersion: "public-catalog-editorial-import-v1",
              sourceAssetId: avatarAssetId,
            },
      },
    });
    await tx.characterServing.create({
      data: {
        id: `${releaseId}-serving`,
        characterId: input.characterId,
        currentReleaseId: releaseId,
        state: "live",
      },
    });
  });
}

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({
    id: SYS,
    email: `${SYS}@customer.invalid`,
    dataClass: "customer",
  });
  await createCharacter({
    id: CHAR,
    creatorId: SYS,
    visibility: "public",
    status: "approved",
    likes: 100_000,
    chats: 100_000,
  });
  await seedCurrentPublicCharacterAuthority({
    characterId: CHAR,
    ownerId: SYS,
  });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("age gate + age verification", () => {
  it("persists age-gate acceptance and sets cookies", async () => {
    const res = await api("POST", "age-gate/accept", {
      anonymousId: `${P}anon-1`,
      body: { sourcePath: "/", country: "US" },
    });
    expectOk(res);
    expect(res.data.accepted).toBe(true);
    expect(res.setCookies.join(";")).toContain("AdultContentAcceptedOD=true");

    const row = await prisma.ageGateAcceptance.findFirst({ where: { anonymousId: `${P}anon-1` } });
    expect(row).not.toBeNull();
  });

  it("reports verification status and starts a provider session", async () => {
    const userId = `${P}verify`;
    await createUser({ id: userId });

    const status = await api("GET", "age-verification/status", { userId });
    expectOk(status);
    expect(status.data.status).toBe("not_required");

    const session = await api("POST", "age-verification/sessions", { userId });
    expectOk(session);
    expect(session.data.verification).toBeTruthy();
  });
});

describe("profile, preferences, language", () => {
  it("returns in-memory preference defaults without creating a database row", async () => {
    const userId = `${P}profile-read-defaults`;
    await createUser({ id: userId });

    expect(await prisma.userPreferences.findUnique({ where: { userId } })).toBeNull();
    const preferences = await api("GET", "profile/preferences", { userId });
    expectOk(preferences);
    expect(preferences.data.preferences).toMatchObject({
      userId,
      locale: "en",
      mutedTags: [],
      safeModeFlags: {},
      notificationSettings: {},
      updatedAt: null,
    });
    expect(await prisma.userPreferences.findUnique({ where: { userId } })).toBeNull();
  });

  it("reads and updates profile + preferences + language", async () => {
    const userId = `${P}profile`;
    await createUser({ id: userId });

    const profile = await api("GET", "profile", { userId });
    expectOk(profile);
    expect(profile.data.balance).toBe(0);

    const updated = await api("PATCH", "profile", {
      userId,
      body: { displayName: "Renamed" },
    });
    expectOk(updated);
    expect(updated.data.user.displayName).toBe("Renamed");

    const prefs = await api("PATCH", "me/preferences", {
      userId,
      body: { locale: "fr", mutedTags: ["Teen", "slow burn"] },
    });
    expectOk(prefs);
    expect(prefs.data.preferences.locale).toBe("fr");
    expect(prefs.data.preferences.mutedTags).toEqual(["teen", "slow-burn"]);

    const lang = await api("PATCH", "profile/language", { userId, body: { locale: "de" } });
    expectOk(lang);
    expect(lang.data.preferences.locale).toBe("de");
  });
});

describe("redeem codes (reward exactly once)", () => {
  it("redeems a code once and rejects replay with 409", async () => {
    const userId = `${P}redeemer`;
    await createUser({ id: userId });
    await createRedeemCode(`${P}GIFT`, { dreamcoins: 300 });

    const first = await api("POST", "redeem-codes/redeem", {
      userId,
      body: { code: `${P}GIFT` },
    });
    expectOk(first);
    expect(first.data.dreamcoins).toBe(300);

    const me1 = await api("GET", "me", { userId });
    expect(me1.data.dreamcoins.balance).toBe(300);

    const replay = await api("POST", "redeem-codes/redeem", {
      userId,
      body: { code: `${P}GIFT` },
    });
    expectError(replay, 409, "conflict");

    const me2 = await api("GET", "me", { userId });
    expect(me2.data.dreamcoins.balance).toBe(300);
  });

  it("enforces a code-wide redemption limit across users", async () => {
    const firstUser = `${P}limited-1`;
    const secondUser = `${P}limited-2`;
    await createUser({ id: firstUser });
    await createUser({ id: secondUser });
    await createRedeemCode(`${P}LIMITED`, { dreamcoins: 25 }, { maxRedemptions: 1 });

    const first = await api("POST", "redeem-codes/redeem", {
      userId: firstUser,
      body: { code: `${P}LIMITED` },
    });
    expectOk(first);

    const second = await api("POST", "redeem-codes/redeem", {
      userId: secondUser,
      body: { code: `${P}LIMITED` },
    });
    expectError(second, 409, "conflict");
    expect(second.json.error.message).toBe("Code redemption limit reached");

    const redemptions = await prisma.redeemCodeRedemption.count({
      where: { redeemCode: { id: `${P}LIMITED` } },
    });
    expect(redemptions).toBe(1);
  });

  it("redeems legacy admin-hashed codes that were created before hash unification", async () => {
    const userId = `${P}legacy-redeemer`;
    const code = `${P}LEGACY`;
    await createUser({ id: userId });
    await prisma.redeemCode.create({
      data: {
        id: `${P}legacy-code`,
        codeHash: legacyRedeemCodeHash(code.toUpperCase()),
        reward: { dreamcoins: 40 },
        status: "active",
      },
    });

    const redeemed = await api("POST", "redeem-codes/redeem", {
      userId,
      body: { code: code.toLowerCase() },
    });
    expectOk(redeemed);
    expect(redeemed.data.dreamcoins).toBe(40);
  });

  it("rejects an unknown code with 404", async () => {
    const userId = `${P}redeemer-2`;
    await createUser({ id: userId });
    const res = await api("POST", "redeem-codes/redeem", {
      userId,
      body: { code: "NOPE-NOPE" },
    });
    expectError(res, 404, "not_found");
  });
});

describe("referrals + account", () => {
  it("returns a referral code and creates an invite", async () => {
    const userId = `${P}referrer`;
    await createUser({ id: userId });

    const list = await api("GET", "referrals", { userId });
    expectOk(list);
    expect(typeof list.data.code).toBe("string");

    const invite = await api("POST", "referrals/invite", { userId });
    expectOk(invite);
    expect(invite.data.shareUrl).toContain("ref=");
  });

  it("grants give/get dreamcoins when an invitee signs up with a ref code", async () => {
    const inviterId = `${P}ref-inviter`;
    await createUser({ id: inviterId });
    const invite = await api("POST", "referrals/invite", { userId: inviterId });
    expectOk(invite);
    const code = invite.data.referral.code as string;
    const inviterBefore = await dreamcoinBalance(inviterId);

    const firstSignup = await api("POST", "auth/signup", {
      ageGate: true,
      body: { email: `${P}invitee@example.com`, password: "password123", name: "Invitee", ref: code },
    });
    expectOk(firstSignup);
    const firstInviteeId = firstSignup.data.user.id as string;

    // Invitee: 250 signup bonus + 150 referral bonus.
    expect(await dreamcoinBalance(firstInviteeId)).toBe(400);

    const secondSignup = await api("POST", "auth/signup", {
      ageGate: true,
      body: {
        email: `${P}invitee2@example.com`,
        password: "password123",
        name: "Invitee 2",
        ref: code,
      },
    });
    expectOk(secondSignup);
    const secondInviteeId = secondSignup.data.user.id as string;
    expect(await dreamcoinBalance(secondInviteeId)).toBe(400);

    // Inviter: +150 give reward per invitee, granted exactly once for each.
    expect(await dreamcoinBalance(inviterId)).toBe(inviterBefore + 300);
    expect(
      await prisma.dreamcoinLedger.count({ where: { userId: inviterId, reason: "referral" } }),
    ).toBe(2);

    // Parent invite row remains reusable; conversions are one row per invitee.
    const parent = await prisma.referral.findFirst({ where: { code, inviteeId: null } });
    const conversions = await prisma.referral.findMany({
      where: { code, inviteeId: { not: null } },
      orderBy: { createdAt: "asc" },
    });
    expect(parent).not.toBeNull();
    expect(conversions.map((referral) => referral.inviteeId)).toEqual(
      expect.arrayContaining([firstInviteeId, secondInviteeId]),
    );
    expect(conversions.every((referral) => referral.rewardStatus === "granted")).toBe(true);
  });

  it("ignores an unknown ref code without blocking signup", async () => {
    const signup = await api("POST", "auth/signup", {
      ageGate: true,
      body: { email: `${P}noref@example.com`, password: "password123", name: "NoRef", ref: "DREAM-DOESNOTEXIST" },
    });
    expectOk(signup);
    // Only the base signup bonus — no referral grant from a bogus code.
    expect(await dreamcoinBalance(signup.data.user.id as string)).toBe(250);
  });

  it("signs out all sessions and processes a delete request", async () => {
    const userId = `${P}account`;
    await createUser({ id: userId });
    await prisma.session.create({
      data: { userId, token: `${P}tok-1`, expiresAt: new Date(Date.now() + 100000) },
    });

    const signOut = await api("POST", "account/sign-out-all", { userId });
    expectOk(signOut);
    expect(await prisma.session.count({ where: { userId } })).toBe(0);

    const del = await api("POST", "account/delete-request", { userId });
    expectOk(del);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user?.status).toBe("deleted");
  });

  it("delete request clears live sessions and blocks credential login", async () => {
    const email = `${P}account-delete-login@example.com`;
    const password = "password123";
    const signup = await api("POST", "auth/signup", {
      body: { email, password, name: "Delete Login" },
    });
    expectOk(signup);
    const userId = signup.data.user.id as string;
    await prisma.session.create({
      data: { userId, token: `${P}tok-delete-extra`, expiresAt: new Date(Date.now() + 100000) },
    });
    expect(await prisma.session.count({ where: { userId } })).toBe(2);

    const deleted = await api("POST", "account/delete-request", {
      cookie: cookieHeader(signup.setCookies),
    });
    expectOk(deleted);
    expect(deleted.setCookies.join(";")).toContain("idream_session=;");

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user?.status).toBe("deleted");
    expect(user?.deletedAt).toBeInstanceOf(Date);
    expect(await prisma.session.count({ where: { userId } })).toBe(0);

    const login = await api("POST", "auth/login", { body: { email, password } });
    expectError(login, 403, "forbidden");
    expect(login.error?.message).toBe("Account is not active");
  });

  it("commits account deletion and keeps its Chat erasure intent pending until graceEndsAt", async () => {
    const userId = `${P}account-delete-outbox`;
    const eventId = `user_deleted_${userId}`;
    await createUser({ id: userId });
    await prisma.session.create({
      data: {
        userId,
        token: `${P}tok-delete-outbox`,
        expiresAt: new Date(Date.now() + 100_000),
      },
    });
    const deleted = await api("POST", "account/delete-request", { userId });
    expectOk(deleted);
    expect(deleted.data).toMatchObject({
      requested: true,
      deletion: {
        status: "awaiting_chat",
        graceEndsAt: expect.any(String),
      },
    });

    await expect(prisma.user.findUniqueOrThrow({
      where: { id: userId },
    })).resolves.toMatchObject({
      status: "deleted",
      deletedAt: expect.any(Date),
    });
    await expect(prisma.session.count({ where: { userId } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    })).resolves.toMatchObject({
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      aggregateType: "user",
      aggregateId: userId,
      status: "pending",
      attempts: 0,
      nextRunAt: new Date(deleted.data.deletion.graceEndsAt as string),
      payload: expect.objectContaining({
        sourceService: "main",
        sourceEventId: eventId,
        eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
        schemaVersion: 2,
        payload: { userId },
      }),
    });
  });
});

describe("library tabs", () => {
  it("returns empty-state tabs and liked characters", async () => {
    const userId = `${P}lib`;
    await createUser({ id: userId });
    await api("POST", `characters/${CHAR}/like`, { userId, ageGate: true });
    await createMedia({ id: `${P}lib-media`, ownerId: userId, prompt: "library recent image" });

    const characters = await api("GET", "library/characters", { userId, ageGate: true });
    expectOk(characters);
    expect((characters.data.items as Array<{ id: string }>).map((c) => c.id)).toContain(CHAR);

    const groupChats = await api("GET", "library/group-chats", { userId, ageGate: true });
    expectOk(groupChats);
    expect(groupChats.data.items).toEqual([]);
    expect(groupChats.data.emptyCta).toBeNull();

    const packs = await api("GET", "library/packs", { userId, ageGate: true });
    expectOk(packs);
    expect(packs.data.items).toEqual([]);
    expect(packs.data.emptyCta).toBeNull();

    const recent = await api("GET", "library/recent", { userId, ageGate: true });
    expectOk(recent);
    const recentItems = recent.data.items as Array<{ id: string; type?: string }>;
    expect(recentItems.map((item) => item.id)).toContain(CHAR);
    expect(recentItems.map((item) => item.id)).toContain(`${P}lib-media`);
  });
});

describe("feed actions", () => {
  it("likes, shares, remixes, and reports a feed item", async () => {
    const userId = `${P}feed-user`;
    await createUser({ id: userId });
    const itemId = `character:${CHAR}`;

    const like = await api("POST", `feed/items/${encodeURIComponent(itemId)}/like`, {
      userId,
      ageGate: true,
    });
    expectOk(like);
    expect(like.data.liked).toBe(true);
    expect(await prisma.characterLike.count({ where: { userId, characterId: CHAR } })).toBe(1);

    const feedAfterLike = await api("GET", "feed", { userId, ageGate: true });
    expectOk(feedAfterLike);
    const likedFeedItem = (feedAfterLike.data.items as Array<{
      id: string;
      character?: { liked?: boolean };
    }>).find((item) => item.id === itemId);
    expect(likedFeedItem?.character?.liked).toBe(true);

    const share = await api("POST", `feed/items/${encodeURIComponent(itemId)}/share`, {
      userId,
      ageGate: true,
    });
    expectOk(share);
    expect(share.data.shareUrl).toContain("character%3A");

    const remix = await api("POST", `feed/items/${encodeURIComponent(itemId)}/remix`, {
      userId,
      ageGate: true,
    });
    expectOk(remix);
    expect(remix.data.remixUrl).toContain("/generate");

    const report = await api("POST", `feed/items/${encodeURIComponent(itemId)}/report`, {
      userId,
      ageGate: true,
      body: { category: "other_prohibited_content" },
    });
    expectOk(report);
    expect(report.data.report.targetType).toBe("feed_item");
  });

  it("keeps duplicate feed likes idempotent under concurrent clicks", async () => {
    const userId = `${P}feed-race-user`;
    const characterId = `${P}feed-race-char`;
    await createUser({ id: userId, dataClass: "customer" });
    await createCharacter({
      id: characterId,
      creatorId: SYS,
      visibility: "public",
      status: "approved",
    });
    await seedCurrentPublicCharacterAuthority({
      characterId,
      ownerId: SYS,
    });
    const itemId = `character:${characterId}`;

    const results = await Promise.all([
      api("POST", `feed/items/${encodeURIComponent(itemId)}/like`, { userId, ageGate: true }),
      api("POST", `feed/items/${encodeURIComponent(itemId)}/like`, { userId, ageGate: true }),
    ]);

    for (const result of results) expectOk(result);
    expect(await prisma.characterLike.count({ where: { userId, characterId } })).toBe(1);
    const stats = await prisma.characterStats.findUniqueOrThrow({ where: { characterId } });
    expect(stats.likesCount).toBe(1);
  });
});

describe("tags, likes, duplicate", () => {
  it("lists tags with public character counts and user mute state", async () => {
    const userId = `${P}tag-user`;
    await createUser({ id: userId });
    const tag = await prisma.tag.create({
      data: { id: `${P}tag-counted`, slug: `${P}counted`, label: "Counted" },
    });
    await createCharacter({ id: `${P}tag-public`, creatorId: SYS, visibility: "public", status: "approved" });
    await createCharacter({ id: `${P}tag-private`, creatorId: SYS, visibility: "private", status: "approved" });
    await createCharacter({ id: `${P}tag-removed`, creatorId: SYS, visibility: "public", status: "removed" });
    await seedCurrentPublicCharacterAuthority({
      characterId: `${P}tag-public`,
      ownerId: SYS,
    });
    await prisma.characterTag.createMany({
      data: [
        { characterId: `${P}tag-public`, tagId: tag.id },
        { characterId: `${P}tag-private`, tagId: tag.id },
        { characterId: `${P}tag-removed`, tagId: tag.id },
      ],
    });

    const res = await api("GET", "tags");
    expectOk(res);
    expect(Array.isArray(res.data.items)).toBe(true);
    expect(
      (res.data.items as Array<{ publicCharacterCount?: number; slug: string }>).find(
        (item) => item.slug === `${P}counted`,
      ),
    ).toMatchObject({ publicCharacterCount: 1 });

    await api("PATCH", "profile/preferences", { userId, body: { mutedTags: [tag.slug] } });
    const personalized = await api("GET", "tags", { userId });
    expectOk(personalized);
    expect(
      (
        personalized.data.items as Array<{
          isMutedByUser?: boolean;
          publicCharacterCount?: number;
          slug: string;
        }>
      ).find((item) => item.slug === `${P}counted`),
    ).toMatchObject({ isMutedByUser: true, publicCharacterCount: 1 });
  });

  it("excludes user-muted tags from character exploration", async () => {
    const userId = `${P}muted-explore-user`;
    const characterId = `${P}muted-explore-char`;
    const tag = await prisma.tag.create({
      data: { id: `${P}muted-explore-tag`, slug: `${P}muted-explore`, label: "Muted Explore" },
    });
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: SYS, visibility: "public", status: "approved" });
    await seedCurrentPublicCharacterAuthority({
      characterId,
      ownerId: SYS,
    });
    await prisma.characterTag.create({ data: { characterId, tagId: tag.id } });

    const anonymous = await api("GET", "characters", {
      ageGate: true,
      query: { tags: tag.slug, gender: "female" },
    });
    expectOk(anonymous);
    expect((anonymous.data.items as Array<{ id: string }>).map((item) => item.id)).toContain(
      characterId,
    );

    await api("PATCH", "profile/preferences", { userId, body: { mutedTags: [tag.slug] } });
    const personalized = await api("GET", "characters", {
      ageGate: true,
      query: { tags: tag.slug, gender: "female" },
      userId,
    });
    expectOk(personalized);
    expect((personalized.data.items as Array<{ id: string }>).map((item) => item.id)).not.toContain(
      characterId,
    );
  });

  it("excludes user-muted tags from search suggestions", async () => {
    const userId = `${P}muted-suggest-user`;
    const characterId = `${P}muted-suggest-char`;
    const tag = await prisma.tag.create({
      data: {
        id: `${P}muted-suggest-tag`,
        slug: `${P}muted-suggest`,
        label: "Muted Suggest",
      },
    });
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: SYS,
      name: "Muted Suggest Character",
      visibility: "public",
      status: "approved",
    });
    await seedCurrentPublicCharacterAuthority({
      characterId,
      ownerId: SYS,
    });
    await prisma.characterTag.create({ data: { characterId, tagId: tag.id } });

    const anonymous = await api("GET", "search/suggest", {
      ageGate: true,
      query: { q: "Muted Suggest" },
    });
    expectOk(anonymous);
    expect((anonymous.data.characters as Array<{ id: string }>).map((item) => item.id)).toContain(
      characterId,
    );
    expect((anonymous.data.tags as Array<{ slug: string }>).map((item) => item.slug)).toContain(
      tag.slug,
    );

    await api("PATCH", "profile/preferences", { userId, body: { mutedTags: [tag.slug] } });
    const personalized = await api("GET", "search/suggest", {
      ageGate: true,
      query: { q: "Muted Suggest" },
      userId,
    });
    expectOk(personalized);
    expect(
      (personalized.data.characters as Array<{ id: string }>).map((item) => item.id),
    ).not.toContain(characterId);
    expect(
      (personalized.data.tags as Array<{ slug: string }>).map((item) => item.slug),
    ).not.toContain(tag.slug);
  });

  it("likes then unlikes a character and adjusts stats", async () => {
    const userId = `${P}liker`;
    await createUser({ id: userId, dataClass: "customer" });
    const before = await prisma.characterStats.findUniqueOrThrow({
      where: { characterId: CHAR },
    });

    const like = await api("POST", `characters/${CHAR}/like`, { userId, ageGate: true });
    expectOk(like);
    const duplicate = await api("POST", `characters/${CHAR}/like`, { userId, ageGate: true });
    expectOk(duplicate);
    const liked = await prisma.characterLike.findFirst({ where: { userId, characterId: CHAR } });
    expect(liked).not.toBeNull();
    expect(
      (await prisma.characterStats.findUniqueOrThrow({ where: { characterId: CHAR } }))
        .likesCount,
    ).toBe(before.likesCount + 1);

    const unlike = await api("DELETE", `characters/${CHAR}/like`, { userId, ageGate: true });
    expectOk(unlike);
    const stillLiked = await prisma.characterLike.findFirst({ where: { userId, characterId: CHAR } });
    expect(stillLiked).toBeNull();
    expect(
      (await prisma.characterStats.findUniqueOrThrow({ where: { characterId: CHAR } }))
        .likesCount,
    ).toBe(before.likesCount);
  });

  it("keeps fixture likes out of public engagement totals", async () => {
    const userId = `${P}fixture-liker`;
    const characterId = `${P}fixture-like-target`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: SYS,
      visibility: "public",
      status: "approved",
    });
    await seedCurrentPublicCharacterAuthority({
      characterId,
      ownerId: SYS,
    });

    const like = await api("POST", `characters/${characterId}/like`, {
      userId,
      ageGate: true,
    });
    expectOk(like);
    expect(
      await prisma.characterLike.count({ where: { userId, characterId } }),
    ).toBe(1);
    expect(
      (await prisma.characterStats.findUniqueOrThrow({ where: { characterId } }))
        .likesCount,
    ).toBe(0);
  });

  it("omits a cross-owner primary image whose bytes have no serviceable locator", async () => {
    const userId = `${P}dup`;
    await createUser({ id: userId });
    const sourceImageAssetId = `${CHAR}-public-avatar`;
    await prisma.mediaAsset.update({
      where: { id: sourceImageAssetId },
      data: {
        metadata: {
          source: "editorial_import",
          synthetic: false,
          providerKey: `${P}provider-key-without-owned-storage`,
          platformAsset: { status: "approved" },
        },
      },
    });
    const res = await api("POST", `characters/${CHAR}/duplicate`, { userId, ageGate: true });
    expectOk(res);
    expect(res.data.character).toMatchObject({
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    expect(res.data.character.name).toContain("Copy");
    expect(res.data.character.imageAssetId).toBeNull();

    const duplicate = await prisma.character.findUniqueOrThrow({
      where: { id: res.data.character.id as string },
      include: { imageAsset: true, stats: true },
    });
    expect(duplicate.imageAsset).toBeNull();
    expect(duplicate.stats).toMatchObject({
      likesCount: 0,
      chatsCount: 0,
      viewsCount: 0,
    });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: CHAR } }),
    ).resolves.toMatchObject({ imageAssetId: sourceImageAssetId });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: sourceImageAssetId } }),
    ).resolves.toMatchObject({
      id: sourceImageAssetId,
      ownerId: SYS,
      characterId: CHAR,
      deletedAt: null,
      metadata: {
        providerKey: `${P}provider-key-without-owned-storage`,
        platformAsset: { status: "approved" },
      },
    });

    const detail = await api("GET", `characters/${duplicate.id}`, {
      userId,
      ageGate: true,
    });
    expectOk(detail);
    expect(detail.data.character).toMatchObject({
      id: duplicate.id,
      imageAssetId: null,
      hasImage: false,
    });
    await expect(prisma.mediaAsset.count({
      where: {
        ownerId: userId,
        metadata: {
          path: ["duplicateLineage", "sourceAssetId"],
          equals: sourceImageAssetId,
        },
      },
    })).resolves.toBe(0);
  });

  it("keeps the duplicate private image serviceable after the source Character and asset are archived", async () => {
    const userId = `${P}dup-blob-user`;
    const reviewerId = `${P}dup-blob-reviewer`;
    const sourceCharacterId = `${P}dup-blob-character`;
    const sourceMediaId = `${P}dup-blob-media`;
    const storageKey = `${P}dup-blob/source.webp`;
    const bytes = Buffer.from("independent duplicate image bytes");
    await createUser({ id: userId, dataClass: "customer" });
    await createUser({
      id: reviewerId,
      role: "moderator",
      dataClass: "internal",
    });
    await createCharacter({
      id: sourceCharacterId,
      creatorId: userId,
      source: "user",
      visibility: "private",
    });
    const stored = await providers.blob.putPrivate({
      key: storageKey,
      body: bytes,
      contentType: "image/webp",
    });
    expect(stored.ok).toBe(true);
    await prisma.mediaAsset.create({
      data: {
        id: sourceMediaId,
        ownerId: userId,
        characterId: sourceCharacterId,
        type: "image",
        url: `/user-content/${sourceMediaId}/content.webp`,
        thumbnailUrl: `/user-content/${sourceMediaId}/thumbnail.webp`,
        storageKey,
        contentType: "image/webp",
        width: 512,
        height: 512,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {
          provider: "pipeline",
          providerKey: storageKey,
          platformAsset: { status: "approved" },
          synthetic: false,
        },
      },
    });
    await prisma.character.update({
      where: { id: sourceCharacterId },
      data: { imageAssetId: sourceMediaId },
    });

    const duplicateResponse = await api(
      "POST",
      `characters/${sourceCharacterId}/duplicate`,
      { userId, ageGate: true },
    );
    expectOk(duplicateResponse);
    const duplicateCharacterId = duplicateResponse.data.character.id as string;
    const duplicateMediaId = duplicateResponse.data.character.imageAssetId as string;
    const duplicateMedia = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: duplicateMediaId },
    });
    expect(duplicateMedia).toMatchObject({
      ownerId: userId,
      characterId: duplicateCharacterId,
      storageKey: null,
      contentType: "image/webp",
      width: 512,
      height: 512,
      safetyStatus: "unknown",
    });
    expect(duplicateMedia.url).not.toBe(`/user-content/${sourceMediaId}/content.webp`);
    expect(duplicateMedia.thumbnailUrl).toBe(duplicateMedia.url);
    expect(duplicateMedia.metadata).toMatchObject({
      blobLocator: {
        schemaVersion: "media-asset-blob-locator-v1",
        kind: "shared_immutable",
        key: storageKey,
        sourceAssetId: sourceMediaId,
      },
      provider: "pipeline",
      providerKey: storageKey,
      source: "character_duplicate",
      synthetic: false,
    });
    expect(duplicateMedia.metadata).not.toHaveProperty("platformAsset");
    const generationReferenceInput = {
      userId,
      characterId: duplicateCharacterId,
      controls: { sourceImageAssetId: duplicateMediaId },
      maxReferences: 1,
    };
    await expect(
      imageReferenceInputsForGenerationJob(generationReferenceInput),
    ).resolves.toEqual([]);

    const mediaQueue = await adminV2("GET", "moderation/queue", {
      userId: reviewerId,
      role: "moderator",
      query: {
        scope: "media",
        search: duplicateMediaId,
      },
    });
    expectOk(mediaQueue);
    expect(mediaQueue.data.mediaReview).toEqual([
      expect.objectContaining({
        id: duplicateMediaId,
        characterId: duplicateCharacterId,
        safetyStatus: "unknown",
        reviewKind: "independent_duplicate",
        sourceAssetId: sourceMediaId,
      }),
    ]);

    const mediaDecision = await adminV2(
      "POST",
      `moderation/media/${duplicateMediaId}/decision`,
      {
        userId: reviewerId,
        role: "moderator",
        body: {
          decision: "passed",
          reason: "Independent duplicate image review passed",
          confirmation: duplicateMediaId,
        },
      },
    );
    expectOk(mediaDecision);
    expect(mediaDecision.data.asset).toMatchObject({
      id: duplicateMediaId,
      safetyStatus: "passed",
    });
    await expect(
      prisma.adminAuditLog.findFirst({
        where: {
          action: "safety.media.review",
          targetId: duplicateMediaId,
        },
      }),
    ).resolves.not.toBeNull();

    const publish = await api("PATCH", `characters/${duplicateCharacterId}`, {
      userId,
      ageGate: true,
      body: { visibility: "public" },
    });
    expectOk(publish);
    const submission = await prisma.characterSubmission.findFirstOrThrow({
      where: {
        characterId: duplicateCharacterId,
        status: "pending",
      },
      orderBy: { submittedAt: "desc" },
    });
    const characterQueue = await api("GET", "admin/content/review-queue", {
      userId: reviewerId,
      role: "moderator",
      query: { search: duplicateCharacterId },
    });
    expectOk(characterQueue);
    expect(characterQueue.data.items).toEqual([
      expect.objectContaining({
        submissionId: submission.id,
        character: expect.objectContaining({
          id: duplicateCharacterId,
          status: "pending_review",
          imageAssetId: duplicateMediaId,
        }),
      }),
    ]);
    const characterDecision = await api(
      "POST",
      `admin/content/review-queue/${submission.id}/decision`,
      {
        userId: reviewerId,
        role: "moderator",
        body: {
          decision: "approve",
          reviewReason: "Character and independent identity image approved",
          reason: "Public Character review passed",
          confirmation: submission.id,
        },
      },
    );
    expectOk(characterDecision);
    await expect(
      prisma.character.findUniqueOrThrow({
        where: { id: duplicateCharacterId },
      }),
    ).resolves.toMatchObject({
      visibility: "public",
      status: "approved",
      imageAssetId: duplicateMediaId,
    });

    expectOk(await api("DELETE", `characters/${sourceCharacterId}`, {
      userId,
      ageGate: true,
    }));
    expectOk(await api("DELETE", `media/${sourceMediaId}`, {
      userId,
      ageGate: true,
    }));
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: sourceMediaId } }),
    ).resolves.toMatchObject({ deletedAt: expect.any(Date) });

    const references = await imageReferenceInputsForGenerationJob(
      generationReferenceInput,
    );
    expect(references).toEqual([
      expect.objectContaining({
        assetId: duplicateMediaId,
        role: "source_image",
        storageKey,
      }),
    ]);
    const hydratedReferences = await hydratedImageReferenceInputs(
      references,
      providers.blob,
    );
    expect(hydratedReferences).toEqual([
      expect.objectContaining({
        assetId: duplicateMediaId,
        role: "source_image",
        storageKey,
        b64Json: bytes.toString("base64"),
      }),
    ]);

    const content = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${duplicateMediaId}/content`, {
        headers: {
          "x-idream-user-id": userId,
          cookie: AGE_GATE_COOKIE_HEADER,
        },
      }),
      ["media", duplicateMediaId, "content"],
    );
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("image/webp");
    expect(Buffer.from(await content.arrayBuffer())).toEqual(bytes);
  });

  it("preserves the no-image duplicate flow without inventing media authority", async () => {
    const userId = `${P}dup-no-image-user`;
    const sourceCharacterId = `${P}dup-no-image-source`;
    await createUser({ id: userId });
    await createCharacter({
      id: sourceCharacterId,
      creatorId: userId,
      source: "user",
      visibility: "private",
      imageAssetId: undefined,
    });

    const response = await api("POST", `characters/${sourceCharacterId}/duplicate`, {
      userId,
      ageGate: true,
    });
    expectOk(response);
    expect(response.data.character).toMatchObject({
      creatorId: userId,
      visibility: "private",
      imageAssetId: null,
    });
    await expect(
      prisma.mediaAsset.count({
        where: {
          ownerId: userId,
          metadata: {
            path: ["duplicateLineage", "sourceCharacterId"],
            equals: sourceCharacterId,
          },
        },
      }),
    ).resolves.toBe(0);
  });

  it.each([
    { authorityChange: "archive", update: { metadata: { platformAsset: { status: "archived" } } } },
    { authorityChange: "delete", update: { deletedAt: new Date() } },
  ])(
    "waits for the canonical media lock and refuses a source image that wins the $authorityChange race",
    async ({ authorityChange, update }) => {
      const userId = `${P}dup-race-${authorityChange}-user`;
      const sourceCharacterId = `${P}dup-race-${authorityChange}-character`;
      const sourceMediaId = `${P}dup-race-${authorityChange}-media`;
      await createUser({ id: userId });
      await createMedia({ id: sourceMediaId, ownerId: userId });
      await createCharacter({
        id: sourceCharacterId,
        creatorId: userId,
        source: "user",
        visibility: "private",
        imageAssetId: sourceMediaId,
      });
      await prisma.mediaAsset.update({
        where: { id: sourceMediaId },
        data: { characterId: sourceCharacterId },
      });

      let duplicateRequest: ReturnType<typeof adminV2> | undefined;
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${sourceMediaId}`}))`;
        duplicateRequest = api("POST", `characters/${sourceCharacterId}/duplicate`, {
          userId,
          ageGate: true,
        });
        const state = await Promise.race([
          duplicateRequest.then(() => "settled" as const),
          new Promise<"waiting">((resolve) => {
            setTimeout(() => resolve("waiting"), 75);
          }),
        ]);
        expect(state).toBe("waiting");
        await tx.mediaAsset.update({
          where: { id: sourceMediaId },
          data: update,
        });
      });

      expect(duplicateRequest).toBeDefined();
      const response = await duplicateRequest!;
      expectError(response, 409, "conflict");
      expect(response.error?.message).toContain("source Character image");
      await expect(
        prisma.character.count({
          where: {
            creatorId: userId,
            name: "Test Character Copy",
          },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.mediaAsset.count({
          where: {
            ownerId: userId,
            metadata: {
              path: ["duplicateLineage", "sourceAssetId"],
              equals: sourceMediaId,
            },
          },
        }),
      ).resolves.toBe(0);
    },
  );

  it("serializes Character soft-delete, clears its image, and atomically retires its active Project", async () => {
    const userId = `${P}character-delete-user`;
    const characterId = `${P}character-delete-character`;
    const mediaId = `${P}character-delete-media`;
    const projectId = `${P}character-delete-project`;
    await createUser({ id: userId });
    await createMedia({ id: mediaId, ownerId: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      source: "user",
      visibility: "private",
      imageAssetId: mediaId,
    });
    await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: { characterId },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "producing",
        activeKey: `${characterId}:active`,
        version: 3,
        audience: {},
        successCriteria: [],
        draftImageAssetId: mediaId,
      },
    });
    const prematureMediaDelete = await api("DELETE", `media/${mediaId}`, {
      userId,
      ageGate: true,
    });
    expectError(prematureMediaDelete, 409, "conflict");
    expect(prematureMediaDelete.error?.details).toMatchObject({
      dependencies: expect.arrayContaining([
        expect.objectContaining({
          kind: "character_project_draft",
          characterId,
          projectId,
        }),
      ]),
    });

    let archiveRequest: ReturnType<typeof adminV2> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${mediaId}`}))`;
      archiveRequest = api("DELETE", `characters/${characterId}`, {
        userId,
        ageGate: true,
      });
      const state = await Promise.race([
        archiveRequest.then(() => "settled" as const),
        new Promise<"waiting">((resolve) => {
          setTimeout(() => resolve("waiting"), 75);
        }),
      ]);
      expect(state).toBe("waiting");
    });

    expect(archiveRequest).toBeDefined();
    expectOk(await archiveRequest!);
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({
      status: "archived",
      deletedAt: expect.any(Date),
      imageAssetId: null,
    });
    await expect(
      prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } }),
    ).resolves.toMatchObject({
      phase: "retired",
      activeKey: null,
      version: 4,
    });

    const deleteMediaResponse = await api("DELETE", `media/${mediaId}`, {
      userId,
      ageGate: true,
    });
    expectOk(deleteMediaResponse);
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } }),
    ).resolves.toMatchObject({ deletedAt: expect.any(Date) });
  });
});

describe("generation presets", () => {
  it("creates, lists, and archives a user preset", async () => {
    const userId = `${P}preset-user`;
    await createUser({ id: userId });

    const created = await api("POST", "generation/presets", {
      userId,
      ageGate: true,
      body: { type: "pose", label: "My Pose", controls: { angle: "side" } },
    });
    expectOk(created);
    const presetId = created.data.preset.id as string;

    const list = await api("GET", "generation/presets", {
      userId,
      ageGate: true,
      query: { type: "pose" },
    });
    expectOk(list);
    expect((list.data.items as Array<{ id: string }>).map((p) => p.id)).toContain(presetId);

    const archived = await api("DELETE", `generation/presets/${presetId}`, {
      userId,
      ageGate: true,
    });
    expectOk(archived);
    const after = await prisma.generationPreset.findUnique({ where: { id: presetId } });
    expect(after?.status).toBe("archived");
  });
});

describe("media bulk operations", () => {
  it("protects a Character primary image even without Project, Profile, or Release authority", async () => {
    const userId = `${P}primary-image-user`;
    const mediaId = `${P}primary-image-media`;
    const characterId = `${P}primary-image-character`;
    await createUser({ id: userId });
    await createMedia({
      id: mediaId,
      ownerId: userId,
      visibility: "public_pack",
    });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      source: "user",
      visibility: "private",
      imageAssetId: mediaId,
    });

    const madePrivate = await api("POST", "media/bulk", {
      userId,
      ageGate: true,
      body: {
        ids: [mediaId],
        action: "visibility",
        visibility: "private",
      },
    });
    expectError(madePrivate, 409, "conflict");
    expect(madePrivate.error?.details).toMatchObject({
      code: "media_asset_authority_dependency_active",
      mediaAssetId: mediaId,
      dependencies: expect.arrayContaining([
        expect.objectContaining({
          kind: "character_primary_image",
          characterId,
          repairPath: `/admin/characters/${characterId}?tab=assets`,
        }),
      ]),
    });

    const deleted = await api("DELETE", `media/${mediaId}`, {
      userId,
      ageGate: true,
    });
    expectError(deleted, 409, "conflict");
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } }),
    ).resolves.toMatchObject({
      visibility: "public_pack",
      deletedAt: null,
    });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ imageAssetId: mediaId });
  });

  it("rejects make-private and delete while an image is owned by the live Character Release", async () => {
    const liveAvatarId = `${CHAR}-public-avatar`;

    const madePrivate = await api("POST", "media/bulk", {
      userId: SYS,
      ageGate: true,
      body: {
        ids: [liveAvatarId],
        action: "visibility",
        visibility: "private",
      },
    });
    expectError(madePrivate, 409, "conflict");
    expect(madePrivate.error?.details).toMatchObject({
      code: "media_asset_authority_dependency_active",
      mediaAssetId: liveAvatarId,
      dependencies: expect.arrayContaining([
        expect.objectContaining({
          kind: "character_release",
          characterId: CHAR,
          releaseState: "current",
        }),
      ]),
      repairPath: `/admin/characters/${CHAR}?tab=release`,
    });

    const deleted = await api("DELETE", `media/${liveAvatarId}`, {
      userId: SYS,
      ageGate: true,
    });
    expectError(deleted, 409, "conflict");
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: liveAvatarId } }),
    ).resolves.toMatchObject({
      visibility: "public_pack",
      deletedAt: null,
    });
    await expect(
      prisma.characterServing.findUniqueOrThrow({
        where: { characterId: CHAR },
      }),
    ).resolves.toMatchObject({ state: "live" });
  });

  it("serializes a single owner delete behind the shared media authority barrier", async () => {
    const userId = `${P}single-delete-barrier-user`;
    const mediaId = `${P}single-delete-barrier-media`;
    await createUser({ id: userId });
    await createMedia({ id: mediaId, ownerId: userId });

    let deleteRequest: Promise<ApiResult> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${mediaId}`}))`;
      deleteRequest = api("DELETE", `media/${mediaId}`, {
        userId,
        ageGate: true,
      });
      const state = await Promise.race([
        deleteRequest.then(() => "settled" as const),
        new Promise<"waiting">((resolve) => {
          setTimeout(() => resolve("waiting"), 75);
        }),
      ]);
      expect(state).toBe("waiting");
      await tx.mediaAsset.update({
        where: { id: mediaId },
        data: { metadata: { authorityConsumer: "committed-before-delete" } },
      });
    });

    expect(deleteRequest).toBeDefined();
    expectOk(await deleteRequest!);
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: mediaId },
    })).resolves.toMatchObject({
      deletedAt: expect.any(Date),
      metadata: { authorityConsumer: "committed-before-delete" },
    });
  });

  it("locks the complete owned bulk-delete set in shared sorted authority order", async () => {
    const userId = `${P}bulk-delete-barrier-user`;
    const firstId = `${P}bulk-delete-barrier-a`;
    const secondId = `${P}bulk-delete-barrier-b`;
    await createUser({ id: userId });
    await createMedia({ id: firstId, ownerId: userId });
    await createMedia({ id: secondId, ownerId: userId });

    let deleteRequest: Promise<ApiResult> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${secondId}`}))`;
      deleteRequest = api("POST", "media/bulk", {
        userId,
        ageGate: true,
        body: {
          ids: [secondId, firstId],
          action: "delete",
        },
      });
      const state = await Promise.race([
        deleteRequest.then(() => "settled" as const),
        new Promise<"waiting">((resolve) => {
          setTimeout(() => resolve("waiting"), 75);
        }),
      ]);
      expect(state).toBe("waiting");
    });

    expect(deleteRequest).toBeDefined();
    const response = await deleteRequest!;
    expectOk(response);
    expect(response.data.deleted).toBe(2);
    await expect(prisma.mediaAsset.count({
      where: {
        id: { in: [firstId, secondId] },
        deletedAt: null,
      },
    })).resolves.toBe(0);
  });

  it("bulk-deletes and bulk-updates visibility for owned media", async () => {
    const userId = `${P}bulk`;
    await createUser({ id: userId });
    const a = `${P}m-a`;
    const b = `${P}m-b`;
    await createMedia({ id: a, ownerId: userId });
    await createMedia({ id: b, ownerId: userId });

    const visibility = await api("POST", "media/bulk", {
      userId,
      ageGate: true,
      body: { ids: [a, b], action: "visibility", visibility: "unlisted" },
    });
    expectOk(visibility);
    expect(visibility.data.updated).toBe(2);

    const del = await api("POST", "media/bulk", {
      userId,
      ageGate: true,
      body: { ids: [a], action: "delete" },
    });
    expectOk(del);
    const remaining = await prisma.mediaAsset.findFirst({ where: { id: a, deletedAt: null } });
    expect(remaining).toBeNull();
  });
});

describe("feed, community, policies, analytics", () => {
  it("returns a feed, restarts it, shares and reports items", async () => {
    const userId = `${P}feed`;
    await createUser({ id: userId });

    const feed = await api("GET", "feed", { userId, ageGate: true });
    expectOk(feed);
    expect(Array.isArray(feed.data.items)).toBe(true);

    const restart = await api("POST", "feed/restart", { userId, ageGate: true });
    expectOk(restart);

    const itemId = `character:${CHAR}`;
    expectError(
      await api("POST", "feed/not-a-real-action", {
        userId,
        ageGate: true,
      }),
      404,
      "not_found",
    );
    expectError(
      await api("PATCH", `feed/items/${encodeURIComponent(itemId)}/like`, {
        userId,
        ageGate: true,
      }),
      404,
      "not_found",
    );

    const share = await api("POST", `feed/items/${encodeURIComponent(itemId)}/share`, {
      userId,
      ageGate: true,
    });
    expectOk(share);
    expect(share.data.shareUrl).toContain(CHAR);

    const report = await api("POST", `feed/items/${encodeURIComponent(itemId)}/report`, {
      userId,
      ageGate: true,
      body: { category: "spam" },
    });
    expectOk(report);
    const row = await prisma.contentReport.findFirst({
      where: { targetType: "feed_item", targetId: itemId },
    });
    expect(row).not.toBeNull();
  });

  it("returns community leaderboards", async () => {
    const res = await api("GET", "community/leaderboards", { ageGate: true });
    expectOk(res);
    expect(res.data.leaderboards).toHaveProperty("characters");
    const characters = res.data.leaderboards.characters as Array<{
      id: string;
      creatorId: string | null;
      isFollowing: boolean;
    }>;
    expect(characters.find((character) => character.id === CHAR)).toMatchObject({
      creatorId: null,
      isFollowing: false,
    });
    const dreamers = res.data.leaderboards.dreamers as Array<{
      id: string;
      displayName: string;
      characters: number;
      isSelf: boolean;
    }>;
    expect(dreamers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: SYS,
          displayName: "Test User",
        }),
      ]),
    );
    const sysDreamer = dreamers.find((dreamer) => dreamer.id === SYS);
    expect(sysDreamer?.characters).toBeGreaterThanOrEqual(1);
    expect(sysDreamer?.isSelf).toBe(false);
    expect(JSON.stringify(dreamers)).not.toContain("@test.local");

    const signedIn = await api("GET", "community/leaderboards", {
      userId: SYS,
      ageGate: true,
    });
    expectOk(signedIn);
    expect(
      (signedIn.data.leaderboards.dreamers as Array<{
        id: string;
        isSelf: boolean;
      }>).find((dreamer) => dreamer.id === SYS),
    ).toMatchObject({ isSelf: true });
  });

  it("returns published community campaign banners", async () => {
    const mediaId = `${P}campaign-media`;
    const placementId = `${P}campaign-placement`;
    await createMedia({
      id: mediaId,
      ownerId: SYS,
      safetyStatus: "passed",
      visibility: "unlisted",
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: placementId,
        mediaAssetId: mediaId,
        slot: "campaign",
        targetType: "campaign",
        targetId: `${P}campaign`,
        status: "published",
        verificationState: "passed",
        publishedAt: new Date(),
        createdById: SYS,
        metadata: {
          ctaLabel: "Open collection",
          eyebrow: "Featured",
          href: "/community?collection=seed-collection-fantasy-escapes",
          title: "Community campaign",
        },
      },
    });

    const res = await api("GET", "community/campaigns", { ageGate: true });
    expectOk(res);
    expect(
      (res.data.campaigns as Array<{
        ctaLabel?: string;
        eyebrow: string;
        href?: string;
        id: string;
        image: string;
        title: string;
      }>).find((item) => item.id === placementId),
    ).toMatchObject({
      ctaLabel: "Open collection",
      eyebrow: "Featured",
      href: "/community?collection=seed-collection-fantasy-escapes",
      image:
        `/user-content/${Buffer.from(mediaId, "utf8").toString("base64url")}/content.webp`,
      title: "Community campaign",
    });
  });

  it("returns a public creator profile with their characters and follow state", async () => {
    const ownerId = `${P}creator-owner`;
    const characterId = `${P}creator-character`;
    const viewer = `${P}creator-viewer`;
    await createUser({
      id: ownerId,
      dataClass: "customer",
      displayName: "Profile Creator",
    });
    await createCharacter({
      id: characterId,
      creatorId: ownerId,
      source: "user",
      visibility: "public",
      status: "approved",
      style: `${P}creator-follow-style`,
    });
    await seedCurrentPublicCharacterAuthority({
      characterId,
      ownerId,
    });
    await createUser({ id: viewer });

    const profile = await api("GET", `creators/${ownerId}`, { userId: viewer, ageGate: true });
    expectOk(profile);
    expect(profile.data.creator).toMatchObject({
      id: ownerId,
      displayName: "Profile Creator",
      isFollowing: false,
      isSelf: false,
    });
    expect(profile.data.creator.stats.characters).toBe(1);
    expect(Array.isArray(profile.data.characters)).toBe(true);
    expect(profile.data.characters).toEqual([
      expect.objectContaining({
        id: characterId,
        source: "user",
        creatorType: "user",
        creatorId: ownerId,
        creatorName: "Profile Creator",
        isFollowing: false,
      }),
    ]);

    const follow = await api("POST", `users/${ownerId}/follow`, { userId: viewer, ageGate: true });
    expectOk(follow);
    const after = await api("GET", `creators/${ownerId}`, { userId: viewer, ageGate: true });
    expectOk(after);
    expect(after.data.creator.isFollowing).toBe(true);
    expect(
      (after.data.characters as Array<{
        id: string;
        isFollowing: boolean;
      }>).find((character) => character.id === characterId),
    ).toMatchObject({ isFollowing: true });

    const communityAfterFollow = await api("GET", "community/leaderboards", {
      userId: viewer,
      ageGate: true,
      query: { style: `${P}creator-follow-style` },
    });
    expectOk(communityAfterFollow);
    expect(
      (communityAfterFollow.data.leaderboards.characters as Array<{
        id: string;
        isFollowing: boolean;
      }>).find((character) => character.id === characterId),
    ).toMatchObject({ isFollowing: true });
  });

  it("reports all-character creator totals while limiting the returned card page", async () => {
    const ownerId = `${P}creator-aggregate-owner`;
    const characterIds = Array.from(
      { length: 25 },
      (_, index) => `${P}creator-aggregate-${index + 1}`,
    );
    await createUser({ id: ownerId, dataClass: "customer" });
    await prisma.character.createMany({
      data: characterIds.map((id, index) => ({
        id,
        creatorId: ownerId,
        name: `Aggregate Character ${index + 1}`,
        age: 24,
        description: "Public aggregate test character.",
        visibility: "public",
        status: "approved",
        source: "user",
        style: "realistic",
        gender: "female",
        relationship: "trusted companion",
        appearance: {},
        advancedDetails: {
          personality: "Observant, emotionally specific, and consistent.",
          tone: "Natural, direct, and concise.",
          backstory: "A stable aggregate fixture with explicit persona context.",
          firstMessage: "I'm here. What should we talk about?",
          exampleDialogue: ["Tell me the part that matters most."],
        },
      })),
    });
    await prisma.characterStats.createMany({
      data: characterIds.map((characterId, index) => ({
        characterId,
        likesCount: index + 1,
        chatsCount: (index + 1) * 2,
      })),
    });
    for (const characterId of characterIds) {
      await seedCurrentPublicCharacterAuthority({
        characterId,
        ownerId,
      });
    }

    const profile = await api("GET", `creators/${ownerId}`, { ageGate: true });
    expectOk(profile);
    expect(profile.data.characters).toHaveLength(24);
    expect(profile.data.creator.stats).toMatchObject({
      characters: 25,
      likesCount: 325,
      chatsCount: 650,
    });
  });

  it("reflects follow state in community dreamers and 404s unknown creators", async () => {
    const viewer = `${P}community-follower`;
    await createUser({ id: viewer });
    await api("POST", `users/${SYS}/follow`, { userId: viewer, ageGate: true });

    const res = await api("GET", "community/leaderboards", { userId: viewer, ageGate: true });
    expectOk(res);
    const dreamer = (res.data.leaderboards.dreamers as Array<{ id: string; isFollowing: boolean }>).find(
      (d) => d.id === SYS,
    );
    expect(dreamer?.isFollowing).toBe(true);

    const missing = await api("GET", `creators/${P}does-not-exist`, { userId: viewer, ageGate: true });
    expectError(missing, 404);
  });

  it("returns published policies", async () => {
    const res = await api("GET", "policies");
    expectOk(res);
    expect((res.data.items as unknown[]).length).toBeGreaterThan(0);
  });

  it("tracks an analytics event", async () => {
    const userId = `${P}analytics`;
    await createUser({ id: userId });
    const res = await api("POST", "events/track", {
      userId,
      body: { name: "custom_event", props: { foo: "bar" } },
    });
    expectOk(res);
    const row = await prisma.analyticsEvent.findFirst({
      where: { userId, name: "custom_event" },
    });
    expect(row).not.toBeNull();
  });

  it("records Character exposure with server-resolved live Release attribution", async () => {
    const userId = `${P}exposure-user`;
    const characterId = `${P}exposure-character`;
    const contentVersionId = `${P}exposure-content-v1`;
    const projectId = `${P}exposure-project`;
    const releaseId = `${P}exposure-release-v1`;
    await createUser({
      id: userId,
      email: `${userId}@customer.invalid`,
      dataClass: "customer",
    });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      source: "user",
      likes: 9_999_999,
    });
    const releaseAssetIds = {
      avatar: `${P}exposure-avatar`,
      hero: `${P}exposure-hero`,
      chat: `${P}exposure-chat`,
    };
    await prisma.mediaAsset.createMany({
      data: Object.entries(releaseAssetIds).map(([slot, id]) => ({
        id,
        ownerId: userId,
        characterId,
        type: "image",
        url: `/user-content/${id}/content.webp`,
        thumbnailUrl: `/user-content/${id}/thumbnail.webp`,
        visibility: "public_pack",
        safetyStatus: "passed",
        metadata: {
          slot,
          provider: "pipeline",
          synthetic: false,
          platformAsset: { status: "approved" },
        },
      })),
    });
    await prisma.character.update({
      where: { id: characterId },
      data: { imageAssetId: releaseAssetIds.avatar },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentVersionId,
        characterId,
        version: 1,
        contentHash: `${P}exposure-content-hash`,
        personaSnapshot: {},
        openingSnapshot: {},
        appearanceSnapshot: {},
        sourceType: "test",
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        ownerId: userId,
        phase: "live_management",
        audience: {},
        successCriteria: [],
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `${P}exposure-revision-v1`,
        characterContentVersionId: contentVersionId,
        generationProvenance: {
          schemaVersion: "character-release-generation-provenance-v2",
          policyVersion: "character-release-policy-v2",
          requiredReleaseRoute: {
            routeFingerprint: `${releaseId}-route`,
            matrixKey: "exposure-authority",
            generationProfileKey: "exposure-profile",
            generationProfileVersion: 1,
            workflowKey: "exposure-workflow",
            workflowVersion: 1,
          },
          placements: [
            {
              slotKey: "character_avatar",
              assetId: releaseAssetIds.avatar,
              provider: "pipeline",
            },
            {
              slotKey: "character_hero",
              assetId: releaseAssetIds.hero,
              provider: "pipeline",
            },
            {
              slotKey: "character_chat",
              assetId: releaseAssetIds.chat,
              provider: "pipeline",
            },
          ],
        },
        releasePlacementManifest: {
          schemaVersion: 2,
          placements: [
            {
              slotKey: "character_avatar",
              assetId: releaseAssetIds.avatar,
              slotVersion: 1,
            },
            {
              slotKey: "character_hero",
              assetId: releaseAssetIds.hero,
              slotVersion: 1,
            },
            {
              slotKey: "character_chat",
              assetId: releaseAssetIds.chat,
              slotVersion: 1,
            },
          ],
        },
        snapshotHash: `${P}exposure-release-hash`,
        readiness: "ready",
        status: "published",
        publishedAt: new Date(),
      },
    });
    const validationRunId = `${P}exposure-validation-v1`;
    await prisma.releaseValidationRun.create({
      data: {
        id: validationRunId,
        releaseId,
        snapshotHash: `${P}exposure-release-hash`,
        policyVersion: "character-release-policy-v2",
        result: "passed",
        finishedAt: new Date(),
      },
    });
    await prisma.publicCatalogQualification.create({
      data: {
        id: `${P}exposure-qualification-v1`,
        releaseId,
        releaseSnapshotHash: `${P}exposure-release-hash`,
        kind: "generated_release",
        validationRunId,
        evidence: {
          schemaVersion: "public-catalog-qualification-v1",
          policyVersion: "character-release-policy-v2",
          validationRunId,
        },
      },
    });
    await prisma.characterServing.create({
      data: {
        id: `${P}exposure-serving`,
        characterId,
        currentReleaseId: releaseId,
        state: "live",
      },
    });

    const leaderboard = await api("GET", "community/leaderboards", {
      userId,
      ageGate: true,
    });
    expectOk(leaderboard);
    const character = (leaderboard.data.leaderboards.characters as Array<{
      id: string;
      exposureContext: {
        contextToken: string;
        journeyId: string;
        placementId: string;
        impressionExposureId: string;
        detailExposureId: string;
      } | null;
    }>).find((item) => item.id === characterId);
    expect(character).toBeDefined();
    expect(character?.exposureContext).not.toBeNull();
    const exposureContext = character?.exposureContext;
    if (!exposureContext) throw new Error("Expected a server-signed exposure context");

    const forged = await api("POST", "events/track", {
      userId,
      ageGate: true,
      body: {
        name: METRIC_PRODUCT_EVENTS.characterExposureRecorded,
        props: {
          contextToken: `${exposureContext.contextToken}tampered`,
          exposureId: exposureContext.impressionExposureId,
          eventType: "eligible_impression",
          parentExposureId: null,
          journeyId: exposureContext.journeyId,
          characterId,
          placementId: exposureContext.placementId,
          visibleRatio: 0.75,
          visibleDurationMs: 500,
        },
      },
    });
    expectError(forged, 400, "bad_request");

    const body = {
      name: METRIC_PRODUCT_EVENTS.characterExposureRecorded,
      props: {
        contextToken: exposureContext.contextToken,
        exposureId: exposureContext.impressionExposureId,
        eventType: "eligible_impression",
        parentExposureId: null,
        journeyId: exposureContext.journeyId,
        characterId,
        placementId: exposureContext.placementId,
        visibleRatio: 0.75,
        visibleDurationMs: 500,
      },
    };
    const recorded = await api("POST", "events/track", { userId, ageGate: true, body });
    expectOk(recorded);
    const replayed = await api("POST", "events/track", { userId, ageGate: true, body });
    expectOk(replayed);
    expect(replayed.data.event.id).toBe(recorded.data.event.id);

    const event = await prisma.analyticsEvent.findUniqueOrThrow({
      where: {
        sourceService_sourceEventId: {
          sourceService: "main",
          sourceEventId: `character_exposure:${exposureContext.impressionExposureId}`,
        },
      },
    });
    expect(event).toMatchObject({
      userId,
      anonymousId: null,
      name: METRIC_PRODUCT_EVENTS.characterExposureRecorded,
      schemaVersion: 2,
      dataClass: "customer",
      trustClass: "typed_client",
      props: expect.objectContaining({
        characterId,
        characterContentVersionId: contentVersionId,
        characterReleaseId: releaseId,
      }),
    });
    expect(event.props).not.toHaveProperty("contextToken");
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: event.id } })).resolves.toBe(1);

    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: event.id } });
    await prisma.analyticsEvent.delete({ where: { id: event.id } });
    await prisma.characterServing.delete({ where: { characterId } });
    await prisma.publicCatalogQualification.deleteMany({
      where: { releaseId },
    });
    await prisma.releaseValidationRun.delete({ where: { id: validationRunId } });
    await prisma.characterRelease.delete({ where: { id: releaseId } });
    await prisma.characterProject.delete({ where: { id: projectId } });
    await prisma.characterContentVersion.delete({ where: { id: contentVersionId } });
  });

  it("applies a stable Community ranking assignment and records only a subject-bound real exposure", async () => {
    const userId = `${P}community-experiment-user`;
    const intruderId = `${P}community-experiment-intruder`;
    const experimentId = `${P}community-ranking-experiment`;
    await createUser({ id: userId });
    await createUser({ id: intruderId });
    await prisma.experimentDefinition.create({ data: {
      id: experimentId,
      key: "community.character-ranking.v1",
      version: 1,
      hypothesis: "Relationship-first ranking increases qualified conversations",
      eligibility: { surface: "community.leaderboard" },
      variants: [{ key: "control", allocationBps: 5_000 }, { key: "relationship_first", allocationBps: 5_000 }],
      salt: `${P}community-ranking-salt`,
      metrics: {
        primary: "relationship.qce_activation.v1",
        controlVariant: "control",
        minimumMaturePerArm: 20,
        guardrails: [{ metricKey: "guardrail.support_contact_rate.v1", maxAbsoluteRegression: 0.02 }],
      },
      status: "running",
    } });
    try {
      const collections = await api("GET", "community/collections", {
        userId,
        ageGate: true,
      });
      expectOk(collections);
      const campaigns = await api("GET", "community/campaigns", {
        userId,
        ageGate: true,
      });
      expectOk(campaigns);
      await expect(
        prisma.experimentAssignment.count({ where: { experimentId } }),
      ).resolves.toBe(0);

      const community = await api("GET", "community/leaderboards", { userId, ageGate: true });
      expectOk(community);
      const assignment = community.data.experimentAssignment as {
        assignmentId: string;
        exposureId: string;
        surface: "community.leaderboard";
        variant: string;
      };
      expect(assignment).toMatchObject({
        assignmentId: expect.any(String),
        exposureId: expect.any(String),
        surface: "community.leaderboard",
      });
      expect(["control", "relationship_first"]).toContain(assignment.variant);

      const body = { name: METRIC_PRODUCT_EVENTS.experimentExposed, props: {
        exposureId: assignment.exposureId,
        assignmentId: assignment.assignmentId,
        surface: assignment.surface,
      } };
      const stolen = await api("POST", "events/track", { userId: intruderId, ageGate: true, body });
      expectError(stolen, 400, "bad_request");
      const recorded = await api("POST", "events/track", { userId, ageGate: true, body });
      expectOk(recorded);
      const replay = await api("POST", "events/track", { userId, ageGate: true, body });
      expectOk(replay);
      expect(replay.data.exposure.status).toBe("duplicate");
      await expect(prisma.analyticsEvent.findUnique({
        where: { sourceService_sourceEventId: { sourceService: "main-experiment-runtime", sourceEventId: assignment.exposureId } },
      })).resolves.toMatchObject({
        name: METRIC_PRODUCT_EVENTS.experimentExposed,
        trustClass: "typed_client",
        props: expect.objectContaining({ assignmentId: assignment.assignmentId, subjectId: userId, variant: assignment.variant }),
      });
    } finally {
      const assignments = await prisma.experimentAssignment.findMany({ where: { experimentId }, select: { id: true } });
      await prisma.metricProjectionReceipt.deleteMany({ where: { sourceEventId: { startsWith: "experiment-exposure-" } } });
      const events = await prisma.analyticsEvent.findMany({ where: { sourceService: "main-experiment-runtime", actor: { path: ["userId"], equals: userId } }, select: { id: true } });
      await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: events.map((event) => event.id) } } });
      await prisma.analyticsEvent.deleteMany({ where: { id: { in: events.map((event) => event.id) } } });
      await prisma.experimentExposureFact.deleteMany({ where: { experimentId } });
      await prisma.experimentAssignment.deleteMany({ where: { id: { in: assignments.map((assignment) => assignment.id) } } });
      await prisma.experimentDefinition.deleteMany({ where: { id: experimentId } });
    }
  });

  it("creates a tracked support request for a signed-in adult user", async () => {
    const userId = `${P}support-requester`;
    await createUser({ id: userId, dataClass: "customer" });

    const res = await api("POST", "support/requests", {
      userId,
      ageGate: true,
      body: {
        category: "generation",
        subject: "Image job stuck",
        description: "The latest image generation job stayed queued for several minutes.",
        diagnosticConsent: true,
        sourcePath: "/helpdesk",
      },
    });

    expectOk(res, 201);
    expect(res.data.request.ticketId).toMatch(/^SUP-/);
    const request = await prisma.supportRequest.findUnique({
      where: { ticketId: res.data.request.ticketId },
    });
    expect(request).toMatchObject({
      id: res.data.request.id,
      userId,
      category: "generation",
      subject: "Image job stuck",
      status: "received",
      diagnosticConsent: true,
      sourcePath: "/helpdesk",
    });
    const row = await prisma.analyticsEvent.findFirst({
      where: { userId, name: "support_request_submitted" },
    });
    expect(row).not.toBeNull();
    expect(row?.dataClass).toBe("customer");
    expect(row?.props).toMatchObject({
      ticketId: res.data.request.ticketId,
      category: "generation",
      subject: "Image job stuck",
      diagnosticConsent: true,
      sourcePath: "/helpdesk",
    });
    const canonical = await prisma.analyticsEvent.findUnique({
      where: { sourceService_sourceEventId: {
        sourceService: "main",
        sourceEventId: `support_request:${res.data.request.id}`,
      } },
    });
    expect(canonical).toMatchObject({
      name: METRIC_PRODUCT_EVENTS.supportRequestSubmitted,
      schemaVersion: 2,
      trustClass: "canonical",
      props: expect.objectContaining({ supportRequestId: res.data.request.id, userId, category: "generation" }),
    });
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: canonical?.id } })).resolves.toBe(1);
  });

  it("requires age gate before creating a support request", async () => {
    const userId = `${P}support-no-age`;
    await createUser({ id: userId });

    const res = await api("POST", "support/requests", {
      userId,
      body: {
        category: "bug",
        subject: "Broken button",
        description: "Clicking the button does not show any response.",
      },
    });

    expectError(res, 403, "forbidden");
  });

  it("lists roadmap feedback and lets signed-in adults submit and vote", async () => {
    const userId = `${P}feedback-voter`;
    await createUser({ id: userId, dataClass: "customer" });

    const list = await api("GET", "feedback/items");
    expectOk(list);
    expect(list.data.items.length).toBeGreaterThanOrEqual(3);
    const defaultItem = list.data.items.find(
      (item: { title: string }) => item.title === "Saved generator recipes",
    );
    expect(defaultItem).toBeTruthy();

    const created = await api("POST", "feedback/items", {
      userId,
      ageGate: true,
      body: {
        category: "feature",
        title: `${P}Feature voting in Help Desk`,
        description: "Let beta users submit a feature idea and vote on roadmap priorities.",
      },
    });
    expectOk(created, 201);
    expect(created.data.item).toMatchObject({
      title: `${P}Feature voting in Help Desk`,
      voteCount: 1,
      userVoted: true,
    });

    const vote = await api("POST", `feedback/items/${defaultItem.id}/vote`, {
      userId,
      ageGate: true,
    });
    expectOk(vote);
    expect(vote.data.item.userVoted).toBe(true);
    expect(vote.data.item.voteCount).toBe(defaultItem.voteCount + 1);

    const unvote = await api("DELETE", `feedback/items/${defaultItem.id}/vote`, {
      userId,
      ageGate: true,
    });
    expectOk(unvote);
    expect(unvote.data.item.userVoted).toBe(false);
    expect(unvote.data.item.voteCount).toBe(defaultItem.voteCount);

    const fixtureId = `${P}feedback-fixture-voter`;
    await createUser({ id: fixtureId });
    const fixtureVote = await api("POST", `feedback/items/${defaultItem.id}/vote`, {
      userId: fixtureId,
      ageGate: true,
    });
    expectOk(fixtureVote);
    expect(fixtureVote.data.item.userVoted).toBe(true);
    expect(fixtureVote.data.item.voteCount).toBe(defaultItem.voteCount);
  });

  it("does not write defaults on read and excludes non-customer user feedback", async () => {
    const customerId = `${P}feedback-customer`;
    const fixtureId = `${P}feedback-fixture`;
    await createUser({ id: customerId, dataClass: "customer" });
    await createUser({ id: fixtureId });
    await prisma.productFeedbackItem.createMany({
      data: [
        {
          id: `${P}feedback-customer-item`,
          createdById: customerId,
          title: `${P}Customer feedback`,
          description: "A real customer-created roadmap suggestion.",
        },
        {
          id: `${P}feedback-fixture-item`,
          createdById: fixtureId,
          title: `${P}Fixture feedback`,
          description: "An automated suggestion that must stay hidden.",
        },
      ],
    });
    const removedOfficial = await prisma.productFeedbackItem.delete({
      where: { sourceKey: "chat-memory-review" },
    });

    try {
      const list = await api("GET", "feedback/items");
      expectOk(list);
      expect(
        list.data.items.some(
          (item: { title: string }) => item.title === `${P}Customer feedback`,
        ),
      ).toBe(true);
      expect(
        list.data.items.some(
          (item: { title: string }) => item.title === `${P}Fixture feedback`,
        ),
      ).toBe(false);
      expect(
        list.data.items.some(
          (item: { sourceKey: string | null }) => item.sourceKey === "chat-memory-review",
        ),
      ).toBe(false);
    } finally {
      await prisma.productFeedbackItem.create({ data: removedOfficial });
    }
  });

  it("requires age gate before creating roadmap feedback", async () => {
    const userId = `${P}feedback-no-age`;
    await createUser({ id: userId });

    const res = await api("POST", "feedback/items", {
      userId,
      body: {
        category: "feature",
        title: `${P}No age feedback`,
        description: "This request is missing the accepted age gate cookie.",
      },
    });

    expectError(res, 403, "forbidden");
  });
});

describe("appeals", () => {
  it("creates a moderation appeal", async () => {
    const userId = `${P}appealer`;
    await createUser({ id: userId });
    const targetId = `${P}appealer-character`;
    await createCharacter({ id: targetId, creatorId: userId, status: "removed" });
    const report = await prisma.contentReport.create({
      data: {
        id: `${P}appealer-report`,
        targetType: "character",
        targetId,
        category: "other_prohibited_content",
        status: "closed",
      },
    });
    const decision = await prisma.moderationReview.create({
      data: {
        id: `${P}appealer-decision`,
        reportId: report.id,
        reviewerId: SYS,
        decision: "actioned",
      },
    });
    const res = await api("POST", "appeals", {
      userId,
      ageGate: true,
      body: { targetType: "character", targetId, appealText: "please review again" },
    });
    expectOk(res);
    expect(res.data.appeal).toMatchObject({
      targetId,
      originalDecisionId: decision.id,
    });
    const evidence = await prisma.caseEvidence.findFirstOrThrow({
      where: { sourceType: "appeal", sourceId: res.data.appeal.id as string },
    });
    expect(await prisma.adminCase.findUniqueOrThrow({ where: { id: evidence.caseId } })).toMatchObject({
      type: "appeal",
      status: "new",
      priority: "high",
    });
  });

  it("rejects unsupported appeal target types", async () => {
    const userId = `${P}appealer-bad-target`;
    await createUser({ id: userId });
    const res = await api("POST", "appeals", {
      userId,
      ageGate: true,
      body: {
        targetType: "random_surface",
        targetId: CHAR,
        appealText: "please review this unsupported target type",
      },
    });
    expectError(res, 400);
  });
});
