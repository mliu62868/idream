import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { METRIC_PRODUCT_EVENTS } from "@idream/shared/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { projectCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/projector";
import { beginChatTurn, commitChatTerminal, createChatSession } from "@/server/modules/chat/turn-ledger";
import { api, createCharacter, createUser, expectOk, publishCharacterForPublicAudience } from "@/server/test/helpers";
import { FEATURED_SETTING_KEY } from "./featured-setting";

type ExposureContext = {
  contextToken: string;
  journeyId: string;
  placementId: string;
  impressionExposureId: string;
  detailExposureId: string;
};
type Card = { id: string; exposureContext?: ExposureContext | null };

const prefix = `zt-discovery-exposure-${randomUUID()}-`;
const viewerId = `${prefix}viewer`;
const creatorId = `${prefix}creator`;
const characterId = `${prefix}character`;
const featuredId = `${prefix}featured`;
const searchTerm = `exposurequery${randomUUID().replaceAll("-", "")}`;

function contextFor(cards: Card[], id: string) {
  const card = cards.find((item) => item.id === id);
  if (!card) throw new Error(`Expected ${id} in the discovery response`);
  if (!card.exposureContext) throw new Error(`Expected ${id} to carry an exposure context`);
  return card.exposureContext;
}

async function explore(query: Record<string, string> = {}, userId: string = viewerId) {
  const result = await api("GET", "characters", { userId, ageGate: true, query: { limit: "60", gender: "female", ...query } });
  expectOk(result);
  return result.data.items as Card[];
}

function exposureBody(
  context: ExposureContext,
  eventType: "eligible_impression" | "detail_view",
  visibleRatio = 0.75,
) {
  return {
    name: METRIC_PRODUCT_EVENTS.characterExposureRecorded,
    props: {
      contextToken: context.contextToken,
      characterId,
      eventType,
      exposureId: eventType === "eligible_impression" ? context.impressionExposureId : context.detailExposureId,
      journeyId: context.journeyId,
      parentExposureId: eventType === "eligible_impression" ? null : context.impressionExposureId,
      placementId: context.placementId,
      visibleDurationMs: eventType === "eligible_impression" ? 500 : 0,
      visibleRatio,
    },
  };
}

// APP_ENV is "test" here and the projector only admits production events, so
// the real persisted row is projected with its environment swapped in.
async function projectAsProduction(sourceEventId: string) {
  const event = await prisma.analyticsEvent.findUniqueOrThrow({
    where: { sourceService_sourceEventId: { sourceService: "main", sourceEventId } },
  });
  return projectCanonicalMetricEvent(prisma, {
    id: event.id,
    sourceService: event.sourceService,
    sourceEventId,
    name: event.name,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt ?? event.createdAt,
    ingestedAt: event.ingestedAt,
    environment: "production",
    dataClass: event.dataClass,
    trustClass: event.trustClass,
    actor: event.actor,
    context: event.context,
    props: event.props,
  } as Parameters<typeof projectCanonicalMetricEvent>[1]);
}

beforeAll(async () => {
  await createUser({ id: viewerId, dataClass: "customer" });
  await createUser({ id: creatorId, dataClass: "customer", displayName: "Exposure Creator" });
  const soul = compileCharacterSoul({
    name: "Nova",
    age: 31,
    gender: "female",
    characterPromise: "A ceramicist who works late.",
    detailsMarkdown: "Unhurried and specific.",
  });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  for (const [id, name] of [[characterId, searchTerm], [featuredId, "Featured fixture"]] as const) {
    await createCharacter({ id, creatorId, name, gender: "female" });
    const { releaseId } = await publishCharacterForPublicAudience({ characterId: id, ownerId: creatorId });
    // The editorial publish helper pins a content id but no row; exposure and
    // chat both resolve the real immutable content version.
    await prisma.characterContentVersion.create({
      data: {
        id: `${releaseId}-content`,
        characterId: id,
        version: 1,
        sourceType: "test",
        contentHash: `${releaseId}-content-hash`,
        personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)),
        openingSnapshot: { firstMessage: "Hello." },
        appearanceSnapshot: {},
      },
    });
  }
  await prisma.follow.create({ data: { followerId: viewerId, followeeId: creatorId } });
  await prisma.appSetting.upsert({
    where: { key: FEATURED_SETTING_KEY },
    create: { key: FEATURED_SETTING_KEY, value: { characterIds: [featuredId] } },
    update: { value: { characterIds: [featuredId] } },
  });
});

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: FEATURED_SETTING_KEY } });
  await prisma.character.updateMany({ where: { id: { startsWith: prefix } }, data: { visibility: "private", status: "archived" } });
  await prisma.user.updateMany({ where: { id: { in: [viewerId, creatorId] } }, data: { dataClass: "audit" } });
});

describe("discovery surfaces issue exposure contexts", () => {
  it("names the placement of every Explore list by what the viewer is looking at", async () => {
    expect(contextFor(await explore(), characterId).placementId).toBe("explore.feed");
    expect(contextFor(await explore({ sort: "newest" }), characterId).placementId).toBe("explore.feed");
    expect(contextFor(await explore({ sort: "popular", period: "all" }), characterId).placementId).toBe("explore.feed");
    expect(contextFor(await explore({ q: searchTerm }), characterId).placementId).toBe("explore.search");
    expect(contextFor(await explore({ sort: "following" }), characterId).placementId).toBe("explore.following");
  });

  it("names embedded character shelves that reuse the Explore list", async () => {
    expect(contextFor(await explore({ surface: "chat-hub" }), characterId).placementId).toBe("chat.hub");
    expect(contextFor(await explore({ surface: "guide-strip" }), characterId).placementId).toBe("guide.strip");
    expect(contextFor(await explore({ surface: "similar" }), characterId).placementId).toBe("character.similar");
    // A client cannot mint an arbitrary placement through the signed context.
    expect(contextFor(await explore({ surface: "made-up" }), characterId).placementId).toBe("explore.feed");
  });

  it("covers search suggestions, the creator profile and the Community leaderboard", async () => {
    const suggest = await api("GET", "search/suggest", { userId: viewerId, ageGate: true, query: { q: searchTerm } });
    expectOk(suggest);
    expect(contextFor(suggest.data.characters, characterId).placementId).toBe("search.suggest");

    const creator = await api("GET", `creators/${creatorId}`, { userId: viewerId, ageGate: true });
    expectOk(creator);
    expect(contextFor(creator.data.characters, characterId).placementId).toBe("creator.profile");

    const community = await api("GET", "community/leaderboards", { userId: viewerId, ageGate: true });
    expectOk(community);
    expect(contextFor(community.data.leaderboards.characters, characterId).placementId).toBe("community.leaderboard");
  });

  it("separates curated, ranked and deep-linked cards on the Feed, including later pages", async () => {
    const first = await api("GET", "feed", { userId: viewerId, ageGate: true, query: { limit: "2" } });
    expectOk(first);
    const firstCards = (first.data.items as Array<{ type: string; character?: Card }>)
      .flatMap((item) => item.type === "character" && item.character ? [item.character] : []);
    expect(contextFor(firstCards, featuredId).placementId).toBe("feed.featured");
    expect(firstCards.filter((card) => card.id !== featuredId).every(
      (card) => card.exposureContext?.placementId === "feed.recommended",
    )).toBe(true);

    expect(first.data.nextCursor).toEqual(expect.any(String));
    const next = await api("GET", "feed", { userId: viewerId, ageGate: true, query: { limit: "60", cursor: first.data.nextCursor } });
    expectOk(next);
    const nextCards = (next.data.items as Array<{ character: Card }>).map((item) => item.character);
    expect(nextCards.length).toBeGreaterThan(0);
    expect(nextCards.every((card) => card.exposureContext?.placementId === "feed.recommended")).toBe(true);

    const shared = await api("GET", "feed", { userId: viewerId, ageGate: true, query: { limit: "2", item: `character:${characterId}` } });
    expectOk(shared);
    const focused = (shared.data.items as Array<{ id: string; character?: Card }>)
      .find((item) => item.id === shared.data.focusedItemId);
    expect(focused?.character?.exposureContext?.placementId).toBe("feed.shared");
  });

  it("gives anonymous viewers a context bound to their anonymous subject", async () => {
    const anonymous = await api("GET", "characters", { ageGate: true, query: { limit: "60", gender: "female" } });
    expectOk(anonymous);
    expect(contextFor(anonymous.data.items, characterId).placementId).toBe("explore.feed");
  });
});

describe("discovery exposure attribution chain", () => {
  it("deduplicates one journey + Character + placement across refetches", async () => {
    const first = contextFor(await explore(), characterId);
    const second = contextFor(await explore(), characterId);
    // A focus refetch or Back navigation must not mint a second impression.
    expect(second.journeyId).toBe(first.journeyId);
    expect(second.impressionExposureId).toBe(first.impressionExposureId);
    expect(second.detailExposureId).toBe(first.detailExposureId);
    const search = contextFor(await explore({ q: searchTerm }), characterId);
    expect(search.journeyId).toBe(first.journeyId);
    expect(search.impressionExposureId).not.toBe(first.impressionExposureId);

    const recorded = await api("POST", "events/track", {
      userId: viewerId, ageGate: true, body: exposureBody(first, "eligible_impression", 0.6),
    });
    expectOk(recorded);
    // A reloaded page measures a different ratio for the same exposure; the
    // first measurement stands and the replay is not a conflict.
    const replayed = await api("POST", "events/track", {
      userId: viewerId, ageGate: true, body: exposureBody(second, "eligible_impression", 1),
    });
    expectOk(replayed);
    expect(replayed.data.event.id).toBe(recorded.data.event.id);
  });

  it("carries an Explore entry through chat into CharacterFunnelDaily", async () => {
    const release = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: `${characterId}-public-release` },
      select: { id: true },
    });

    const entryViewerId = `${prefix}entry-viewer`;
    await createUser({ id: entryViewerId, dataClass: "customer" });
    const context = contextFor(await explore({}, entryViewerId), characterId);
    expect(context.placementId).toBe("explore.feed");

    for (const eventType of ["eligible_impression", "detail_view"] as const) {
      expectOk(await api("POST", "events/track", {
        userId: entryViewerId, ageGate: true, body: exposureBody(context, eventType),
      }));
      const exposureId = eventType === "eligible_impression" ? context.impressionExposureId : context.detailExposureId;
      await expect(projectAsProduction(`character_exposure:${exposureId}`))
        .resolves.toMatchObject({ status: "applied", factType: "character_exposure" });
    }

    const session = await createChatSession(entryViewerId, {
      characterId,
      entryExposureId: context.detailExposureId,
      entryJourneyId: context.journeyId,
      entryPlacementId: context.placementId,
    });
    const turn = await beginChatTurn({
      userId: entryViewerId, sessionId: session.id, content: "Hello from Explore.", idempotencyKey: randomUUID(),
    });
    const snapshot = turn.snapshot;
    if (!snapshot) throw new Error("Expected an admitted chat turn");
    await commitChatTerminal({
      version: 1,
      turnId: snapshot.turnId,
      sessionId: snapshot.sessionId,
      assistantMessageId: snapshot.assistantMessageId,
      attempt: snapshot.attempt,
      status: "sent",
      content: "Hello back.",
      model: "fixture",
      promptTokens: 2,
      completionTokens: 2,
      sceneVersion: snapshot.sceneVersion + 1,
      scene: {
        schemaVersion: 1,
        version: snapshot.sceneVersion + 1,
        location: null,
        time: null,
        participants: [],
        emotionalBeat: null,
        unresolvedThreads: [],
      },
      terminalEvidence: {
        authority: "test",
        prompt: {
          productPromptVersion: "companion-product-1",
          preparedTurnVersion: 4,
          systemPromptDigest: "a".repeat(64),
          soulFingerprint: "b".repeat(64),
        },
      },
    });

    await expect(projectAsProduction(`chat_exchange:${snapshot.turnId}:${snapshot.attempt}`))
      .resolves.toMatchObject({ status: "applied", factType: "chat_exchange" });
    await expect(prisma.chatExchangeFact.findUniqueOrThrow({ where: { exchangeId: snapshot.turnId } }))
      .resolves.toMatchObject({
        coverageState: "exact",
        entryExposureId: context.detailExposureId,
        journeyId: context.journeyId,
        placementId: "explore.feed",
      });
    const funnel = await prisma.characterFunnelDaily.findFirstOrThrow({
      where: { characterId, characterReleaseId: release.id, placementId: "explore.feed" },
      orderBy: { productDay: "desc" },
    });
    expect(funnel).toMatchObject({ eligibleImpressions: 1, detailViews: 1, firstSuccessfulExchanges: 1 });
  });
});
