import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  api,
  createCharacter,
  createMedia,
  createRedeemCode,
  createUser,
  dreamcoinBalance,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";

// SPEC: Remaining API surface (BackendFeatureSpec §5.1/5.6/5.7/5.9/5.10) —
// age gate/verification, profile/preferences/language, redeem, referrals,
// account, library tabs, tags, likes/duplicate, presets, media bulk, feed,
// community, policies, analytics. Each endpoint gets happy-path + a key guard.

const P = "zt-mod-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: SYS });
  await createCharacter({ id: CHAR, creatorId: SYS, visibility: "public", status: "approved" });
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
      body: { locale: "fr", mutedTags: ["teen"] },
    });
    expectOk(prefs);
    expect(prefs.data.preferences.locale).toBe("fr");

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

    const signup = await api("POST", "auth/signup", {
      ageGate: true,
      body: { email: `${P}invitee@example.com`, password: "password123", name: "Invitee", ref: code },
    });
    expectOk(signup);
    const inviteeId = signup.data.user.id as string;

    // Invitee: 250 signup bonus + 150 referral bonus.
    expect(await dreamcoinBalance(inviteeId)).toBe(400);
    // Inviter: +150 give reward, granted exactly once for this invitee.
    expect(await dreamcoinBalance(inviterId)).toBe(inviterBefore + 150);
    expect(
      await prisma.dreamcoinLedger.count({ where: { userId: inviterId, reason: "referral_reward" } }),
    ).toBe(1);

    // Referral row attributed + marked granted.
    const referral = await prisma.referral.findUnique({ where: { code } });
    expect(referral?.inviteeId).toBe(inviteeId);
    expect(referral?.rewardStatus).toBe("granted");
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
    expect(groupChats.data.emptyCta).toBe("/create");

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
    await createUser({ id: userId });
    await createCharacter({ id: characterId, visibility: "public", status: "approved" });
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
  it("lists tags", async () => {
    const res = await api("GET", "tags");
    expectOk(res);
    expect(Array.isArray(res.data.items)).toBe(true);
  });

  it("likes then unlikes a character and adjusts stats", async () => {
    const userId = `${P}liker`;
    await createUser({ id: userId });

    const like = await api("POST", `characters/${CHAR}/like`, { userId, ageGate: true });
    expectOk(like);
    const liked = await prisma.characterLike.findFirst({ where: { userId, characterId: CHAR } });
    expect(liked).not.toBeNull();

    const unlike = await api("DELETE", `characters/${CHAR}/like`, { userId, ageGate: true });
    expectOk(unlike);
    const stillLiked = await prisma.characterLike.findFirst({ where: { userId, characterId: CHAR } });
    expect(stillLiked).toBeNull();
  });

  it("duplicates a readable character into a private copy", async () => {
    const userId = `${P}dup`;
    await createUser({ id: userId });
    const res = await api("POST", `characters/${CHAR}/duplicate`, { userId, ageGate: true });
    expectOk(res);
    expect(res.data.character).toMatchObject({ visibility: "private" });
    expect(res.data.character.name).toContain("Copy");
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

    const share = await api("POST", `feed/items/${CHAR}/share`, { userId, ageGate: true });
    expectOk(share);
    expect(share.data.shareUrl).toContain(CHAR);

    const report = await api("POST", `feed/items/${CHAR}/report`, {
      userId,
      ageGate: true,
      body: { category: "spam" },
    });
    expectOk(report);
    const row = await prisma.contentReport.findFirst({
      where: { targetType: "feed_item", targetId: CHAR },
    });
    expect(row).not.toBeNull();
  });

  it("returns community leaderboards", async () => {
    const res = await api("GET", "community/leaderboards", { ageGate: true });
    expectOk(res);
    expect(res.data.leaderboards).toHaveProperty("characters");
    expect(res.data.leaderboards.dreamers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: SYS,
          displayName: "Test User",
          characters: 1,
        }),
      ]),
    );
    expect(JSON.stringify(res.data.leaderboards.dreamers)).not.toContain("@test.local");
  });

  it("returns a public creator profile with their characters and follow state", async () => {
    const viewer = `${P}creator-viewer`;
    await createUser({ id: viewer });

    const profile = await api("GET", `creators/${SYS}`, { userId: viewer, ageGate: true });
    expectOk(profile);
    expect(profile.data.creator).toMatchObject({ id: SYS, isFollowing: false, isSelf: false });
    expect(profile.data.creator.stats.characters).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(profile.data.characters)).toBe(true);
    expect((profile.data.characters as Array<{ creatorId: string }>).every((c) => c.creatorId === SYS)).toBe(true);

    const follow = await api("POST", `users/${SYS}/follow`, { userId: viewer, ageGate: true });
    expectOk(follow);
    const after = await api("GET", `creators/${SYS}`, { userId: viewer, ageGate: true });
    expectOk(after);
    expect(after.data.creator.isFollowing).toBe(true);
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
});

describe("appeals", () => {
  it("creates a moderation appeal", async () => {
    const userId = `${P}appealer`;
    await createUser({ id: userId });
    const res = await api("POST", "appeals", {
      userId,
      body: { targetType: "character", targetId: CHAR, appealText: "please review again" },
    });
    expectOk(res);
    expect(res.data.appeal).toMatchObject({ targetId: CHAR });
  });
});
