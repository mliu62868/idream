import { randomUUID } from "node:crypto";
import { characterPortfolioQuerySchema, type CharacterPortfolioQuery, type TodayAllWorkResponse } from "@idream/shared/admin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as allWorkRoute } from "@/app/api/v2/admin/today/all-work/route";
import { prisma } from "@/server/lib/db";
import { characterOperationsSummary } from "./operations-summary";
import { listCharacterPortfolioData } from "./portfolio";

const asOf = new Date("2026-08-20T12:00:00.000Z");
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe("Character portfolio work queues and performance loop", () => {
  const suffix = randomUUID();
  const adminId = `queue-admin-${suffix}`;
  const roles = ["healthy", "chat-only", "silent", "paused", "archived", "failed", "pending", "stale", "candidate", "user"] as const;
  const id = (role: string) => `queue-${role}-${suffix}`;
  const ids = roles.map(id);
  const scope = { asOf, authorizedCharacterIds: ids, authorizedDraftAssetCharacterIds: null };
  const list = (query: Partial<Record<keyof CharacterPortfolioQuery, unknown>> = {}) =>
    listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({ limit: 50, ...query }), scope);
  const names = async (query: Partial<Record<keyof CharacterPortfolioQuery, unknown>>) =>
    (await list(query)).items.map((item) => item.characterId).sort();

  async function createRole(role: string, overrides: {
    state?: string;
    published?: Date | null;
    readiness?: string;
    source?: string;
  } = {}) {
    const characterId = id(role);
    await prisma.character.create({ data: {
      id: characterId, name: `Queue ${role}`, age: 25, description: "queue fixture", visibility: "public", status: "approved",
      source: overrides.source ?? "official", creatorId: overrides.source === "user" ? adminId : undefined,
      style: "realistic", gender: "female", appearance: {}, advancedDetails: {},
    } });
    await prisma.characterProject.create({ data: { id: `${characterId}-project`, characterId, activeKey: `${characterId}-project` } });
    await prisma.characterContentVersion.create({ data: {
      id: `${characterId}-content`, characterId, version: 1, contentHash: characterId,
      personaSnapshot: { name: `Queue ${role}` }, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "queue_test",
    } });
    await prisma.characterRevision.create({ data: { id: `${characterId}-rev-1`, projectId: `${characterId}-project`, revision: 1, characterContentVersionId: `${characterId}-content`, projectSnapshot: {} } });
    const published = overrides.published === undefined ? day("2026-06-01") : overrides.published;
    if (published) {
      await prisma.characterRelease.create({ data: {
        id: `${characterId}-release`, projectId: `${characterId}-project`, revisionId: `${characterId}-rev-1`,
        characterContentVersionId: `${characterId}-content`, generationProvenance: {}, releasePlacementManifest: {},
        snapshotHash: characterId, readiness: overrides.readiness ?? "ready", legacy: true, status: "published", publishedAt: published,
      } });
    }
    if (overrides.state !== null) {
      await prisma.characterServing.create({ data: {
        characterId, state: overrides.state ?? "live", currentReleaseId: published ? `${characterId}-release` : null,
      } });
    }
  }

  // 每天一行：曝光链与聊天都齐，付费归因不可用，所以最多 directional。
  async function trafficFor(characterId: string, releaseId: string, from: Date, days: number, rates: { qce: number; d7: number }) {
    const contentId = `${characterId}-content`;
    const impressions = Array.from({ length: 150 }, (_, index) => ({
      exposureId: `${releaseId}-imp-${index}`, sourceService: "queue_test", sourceEventId: `${releaseId}-imp-${index}`,
      journeyId: `${releaseId}-journey`, characterId, characterContentVersionId: contentId, characterReleaseId: releaseId,
      placementId: "feed.hero", eventType: "eligible_impression", visibleRatio: 1, visibleDurationMs: 1_000,
      environment: "production", dataClass: "customer", trustClass: "canonical", eligible: true,
      occurredAt: from, validFrom: from, coverageState: "exact",
    }));
    const details = Array.from({ length: 100 }, (_, index) => ({
      ...impressions[index], exposureId: `${releaseId}-det-${index}`, sourceEventId: `${releaseId}-det-${index}`,
      eventType: "detail_view", parentExposureId: impressions[index].exposureId,
    }));
    await prisma.characterExposureFact.createMany({ data: [...impressions, ...details] });
    await prisma.characterFunnelDaily.create({ data: {
      characterId, characterContentVersionId: contentId, characterReleaseId: releaseId, placementId: null, productDay: from,
      metricVersion: 1, eligibleImpressions: 150, detailViews: 100, firstSuccessfulExchanges: 50,
      qceCount: Math.round(50 * rates.qce), sameCharacterD7EligiblePairs: 20, sameCharacterD7Returns: Math.round(20 * rates.d7),
      coverageState: "exact_through_same_character_d7_paid_attribution_unavailable", projectionVersion: 2,
      latestDataAt: from, sourceEvidence: [],
    } });
    void days;
  }

  beforeAll(async () => {
    await prisma.user.create({ data: { id: adminId, email: `${adminId}@example.test`, role: "admin", dataClass: "customer" } });
    await createRole("healthy");
    await createRole("chat-only");
    await createRole("silent");
    await createRole("paused", { state: "paused" });
    await createRole("archived", { state: "retired", published: null });
    await createRole("failed", { state: "inactive", published: null });
    await createRole("pending");
    await createRole("stale", { readiness: "stale" });
    await createRole("candidate");
    await createRole("user", { source: "user", state: "inactive", published: null });

    await prisma.characterRevision.create({ data: { id: `${id("pending")}-rev-2`, projectId: `${id("pending")}-project`, revision: 2, characterContentVersionId: `${id("pending")}-content`, projectSnapshot: {} } });
    await prisma.characterRelease.create({ data: {
      id: `${id("candidate")}-next`, projectId: `${id("candidate")}-project`, revisionId: `${id("candidate")}-rev-1`,
      characterContentVersionId: `${id("candidate")}-content`, generationProvenance: {}, releasePlacementManifest: {},
      snapshotHash: `${id("candidate")}-next`, readiness: "ready", legacy: true, status: "approved",
    } });

    // 有人聊，但聊天没带曝光入口，所以没有曝光和漏斗行。
    await prisma.chatExchangeFact.create({ data: {
      exchangeId: `${id("chat-only")}-x`, sourceService: "queue_test", sourceEventId: `${id("chat-only")}-x`, userMessageId: "u", assistantMessageId: "a",
      selectedAssistantMessageId: "a", assistantAttemptNo: 1, sessionId: "s", engagementSessionId: "e", userId: adminId,
      characterId: id("chat-only"), characterContentVersionId: `${id("chat-only")}-content`, characterReleaseId: `${id("chat-only")}-release`,
      environment: "production", dataClass: "customer", trustClass: "canonical", eligible: true,
      occurredAt: day("2026-06-10"), productDay: day("2026-06-10"), sourceUpdatedAt: day("2026-06-10"), validFrom: day("2026-06-10"),
    } });
    // 不合格的聊天不算流量。
    await prisma.chatExchangeFact.create({ data: {
      exchangeId: `${id("silent")}-x`, sourceService: "queue_test", sourceEventId: `${id("silent")}-x`, userMessageId: "u", assistantMessageId: "a",
      selectedAssistantMessageId: "a", assistantAttemptNo: 1, sessionId: "s", engagementSessionId: "e", userId: adminId,
      characterId: id("silent"), characterContentVersionId: `${id("silent")}-content`, characterReleaseId: `${id("silent")}-release`,
      environment: "production", dataClass: "customer", trustClass: "canonical", actorIsInternal: true, eligible: false,
      occurredAt: day("2026-06-10"), productDay: day("2026-06-10"), sourceUpdatedAt: day("2026-06-10"), validFrom: day("2026-06-10"),
    } });

    await trafficFor(id("healthy"), `${id("healthy")}-release`, day("2026-08-10"), 1, { qce: 0.6, d7: 0.5 });
    await trafficFor(id("pending"), `${id("pending")}-release`, day("2026-08-11"), 1, { qce: 0.2, d7: 0.1 });

    await prisma.contentProductionBatch.create({ data: {
      id: `${id("failed")}-run`, title: "failed run", purpose: "character_hero", targetType: "character", targetId: id("failed"),
      presetIds: [], createdById: adminId, totalItems: 1, failedItems: 1, status: "failed", lifecycleState: "closed",
      items: { create: { status: "failed", tags: [] } },
    } });
  });

  afterAll(async () => {
    await prisma.chatExchangeFact.deleteMany({ where: { characterId: { in: ids } } });
    await prisma.characterFunnelDaily.deleteMany({ where: { characterId: { in: ids } } });
    await prisma.characterExposureFact.deleteMany({ where: { characterId: { in: ids } } });
    await prisma.contentProductionBatch.deleteMany({ where: { targetId: { in: ids } } });
    await prisma.characterServing.deleteMany({ where: { characterId: { in: ids } } });
    await prisma.characterRelease.deleteMany({ where: { projectId: { in: ids.map((value) => `${value}-project`) } } });
    await prisma.characterRevision.deleteMany({ where: { projectId: { in: ids.map((value) => `${value}-project`) } } });
    await prisma.characterProject.deleteMany({ where: { characterId: { in: ids } } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId: { in: ids } } });
    await prisma.character.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.delete({ where: { id: adminId } });
  });

  // SPEC: 曾只看曝光和漏斗，有人聊也报「7 天无观测」，运营被派去查没坏的投放链路。
  it("does not flag a live Character people are chatting with", async () => {
    const flagged = await list({ attention: true });
    const flaggedIds = flagged.items.map((item) => item.characterId);
    expect(flaggedIds).not.toContain(id("chat-only"));
    expect(flaggedIds).toContain(id("silent"));
    expect(flaggedIds).not.toContain(id("healthy"));
    expect(flagged.items.find((item) => item.characterId === id("silent"))).toMatchObject({
      needsAttention: true,
      attentionReason: "no_traffic_after_window",
    });
  });

  // SPEC: Today 与列表读同一份事实和原因。Today 的时钟是真实 now，asOf 只影响列表，这里两边都是早已满 7 天。
  it("surfaces the same zero-traffic Character in Today with the same reason", async () => {
    const response = await allWorkRoute(new Request(
      "http://localhost/api/v2/admin/today/all-work?domain=character_release&severity=medium&limit=50",
      { headers: { "x-idream-user-id": adminId, "x-idream-role": "admin" } },
    ));
    expect(response.status, await response.clone().text()).toBe(200);
    const items = ((await response.json()).data as TodayAllWorkResponse).items;
    const silent = items.find((item) => item.sourceId === `${id("silent")}-release`);
    expect(silent).toMatchObject({
      severity: "medium",
      recommendedAction: "Check placement targeting and event delivery",
    });
    expect(silent?.summary).toContain("no exposure, funnel, or chat traffic");
    expect(silent?.deepLink).toContain("tab=monitor");
    expect(items.some((item) => item.sourceId === `${id("chat-only")}-release`)).toBe(false);
  });

  it("carries source, visibility and updatedAt, and filters official and user Characters", async () => {
    const all = await list();
    expect(all.items.find((item) => item.characterId === id("user"))).toMatchObject({ source: "user", visibility: "public", updatedAt: expect.any(String) });
    expect(await names({ source: "user" })).toEqual([id("user")]);
    expect(await names({ source: "official" })).not.toContain(id("user"));
  });

  // SPEC: 归档草稿 updatedAt 新，曾排在「全部」最前面。
  it("keeps archived Characters out of the All view and in their own view", async () => {
    expect(await names({ excludeArchived: true })).not.toContain(id("archived"));
    expect(await names({ servingState: "retired" })).toEqual([id("archived")]);
    expect(await names({ servingState: "paused" })).toEqual([id("paused")]);
    // 角色详情等默认调用方仍读得到。
    expect(await names({})).toContain(id("archived"));
  });

  it("filters each work queue before paginating and counts every view exactly", async () => {
    expect(await names({ workQueue: "pending_changes" })).toEqual([id("pending")]);
    expect(await names({ workQueue: "candidate_unpublished" })).toEqual([id("candidate")]);
    expect(await names({ workQueue: "publish_blocked" })).toEqual([id("stale")]);
    // 没有视觉身份的角色下一步是建身份，失败 Run 不抢这一步；有身份的情形见 portfolio.integration。
    expect(await names({ workQueue: "recent_generation_failed" })).toEqual([]);
    const { facets } = await list({ includeFacets: true, servingState: "paused" });
    expect(facets?.viewCounts).toMatchObject({
      all: 9,
      draft: 2,
      live: 6,
      paused: 1,
      archived: 1,
      pending_changes: 1,
      candidate_unpublished: 1,
      publish_blocked: 1,
    });
    // 零流量且 live 的只有 silent、stale、candidate；healthy/pending 有曝光，chat-only 有聊天。
    expect(facets?.viewCounts.attention).toBe(3);
    // 不要的调用方不付这个代价。
    expect((await list()).facets).toBeUndefined();
  });

  it("stops at the first page of a queue and keeps the keyset consistent", async () => {
    const first = await list({ excludeArchived: true, limit: 4, sort: "project_id_asc" });
    expect(first.pageInfo.totalCount).toBe(9);
    const second = await list({ excludeArchived: true, limit: 4, sort: "project_id_asc", cursor: first.pageInfo.endCursor });
    const seen = [...first.items, ...second.items].map((item) => item.characterId);
    expect(new Set(seen).size).toBe(8);
  });

  // SPEC: 表现排序在 funnel 窗口聚合上，率缺分母永远排在后面，不当成 0%。
  it("sorts by funnel aggregates across pages with missing rates last in both directions", async () => {
    const query = { operating: true, performanceWindow: "28d", aggregateOnly: true };
    const desc = await list({ ...query, sort: "qce_rate_desc", limit: 1 });
    expect(desc.items[0].characterId).toBe(id("healthy"));
    const next = await list({ ...query, sort: "qce_rate_desc", limit: 1, cursor: desc.pageInfo.endCursor });
    expect(next.items[0].characterId).toBe(id("pending"));
    const asc = await list({ ...query, sort: "qce_rate_asc", limit: 2 });
    expect(asc.items.map((item) => item.characterId)).toEqual([id("pending"), id("healthy")]);
    const impressions = await list({ ...query, sort: "impressions_desc", limit: 2 });
    expect(impressions.items.map((item) => item.characterId).sort()).toEqual([id("healthy"), id("pending")].sort());
    expect(desc.items[0].performance.every((row) => row.placementId === null)).toBe(true);
    expect(await names({ operating: true })).not.toContain(id("failed"));
  });

  // SPEC: 两个写入方都写不出 exact，要求 certified 时新旧对比永远算不出来。
  it("compares two Releases on directional evidence, labels it, and keeps margin certified-only", async () => {
    const characterId = id("healthy");
    const previousId = `${characterId}-previous`;
    await prisma.characterRelease.create({ data: {
      id: previousId, projectId: `${characterId}-project`, revisionId: `${characterId}-rev-1`,
      characterContentVersionId: `${characterId}-content`, generationProvenance: {}, releasePlacementManifest: {},
      snapshotHash: previousId, readiness: "ready", legacy: true, status: "superseded", publishedAt: day("2026-05-01"),
    } });
    await trafficFor(characterId, previousId, day("2026-05-05"), 1, { qce: 0.4, d7: 0.5 });
    try {
      const item = (await list({ includePerformance: true, aggregateOnly: true, search: characterId })).items[0];
      expect(item.changeMarkers.find((marker) => marker.window === "28d")).toMatchObject({ comparable: false });
      await prisma.characterRelease.update({ where: { id: `${characterId}-release` }, data: { publishedAt: day("2026-07-20") } });
      const compared = (await list({ includePerformance: true, aggregateOnly: true, search: characterId })).items[0];
      const marker = compared.changeMarkers.find((row) => row.window === "28d");
      expect(marker).toMatchObject({
        previousReleaseId: previousId,
        comparable: true,
        comparisonQuality: "directional",
        contributionMarginDeltaMicros: null,
      });
      expect(marker?.qceRateDelta).toBeCloseTo(0.2);
      expect(marker?.sameCharacterD7Delta).toBeCloseTo(0);
    } finally {
      await prisma.characterRelease.update({ where: { id: `${characterId}-release` }, data: { publishedAt: day("2026-06-01") } });
      await prisma.characterFunnelDaily.deleteMany({ where: { characterReleaseId: previousId } });
      await prisma.characterExposureFact.deleteMany({ where: { characterReleaseId: previousId } });
      await prisma.characterRelease.delete({ where: { id: previousId } });
    }
  });

  it("attaches a recommendation that says insufficient data without peers, never a verdict", async () => {
    const item = (await list({ includePerformance: true, aggregateOnly: true, search: id("healthy") })).items[0];
    expect(item.recommendation).toMatchObject({ window: "28d", recommendation: "insufficient_data" });
    expect((await list({ search: id("healthy") })).items[0].recommendation).toBeNull();
  });

  it("summarizes operating efficiency from committed facts and says nothing without evidence", async () => {
    const empty = await characterOperationsSummary(prisma, { window: "7d", asOf, authorizedCharacterIds: [] });
    expect(empty).toMatchObject({
      firstUsableImage: { medianHours: null, sampleSize: 0 },
      createToFirstPublish: { medianHours: null, sampleSize: 0 },
      imageAdoption: { rate: null },
      adoptedImageCost: { microsPerAdoptedImage: null, coverage: "none" },
      publishFailures: { count: 0, coverage: "committed_commands_only" },
      operationCount: 0,
    });
    const characterId = id("failed");
    const asset = `${characterId}-asset`;
    const job = `${characterId}-job`;
    const start = new Date("2026-08-18T00:00:00.000Z");
    await prisma.mediaAsset.create({ data: { id: asset, ownerId: adminId, characterId, type: "image", url: `/media/${asset}`, safetyStatus: "passed", metadata: {}, createdAt: start } });
    await prisma.generationJob.create({ data: { id: job, userId: adminId, characterId, mode: "image", controls: {}, presetIds: [], status: "completed" } });
    await prisma.contentProductionBatch.create({ data: {
      id: `${characterId}-ok`, title: "ok", purpose: "character_cover", targetType: "character", targetId: characterId,
      presetIds: [], createdById: adminId, totalItems: 1, status: "completed",
      items: { create: { status: "generated", tags: [], mediaAssetId: asset, jobId: job, createdAt: start } },
    } });
    await prisma.generationAttempt.create({ data: {
      id: `${characterId}-attempt`, requestId: job, attemptNo: 1, status: "succeeded",
    } });
    await prisma.generationTransportExecution.create({ data: { attemptId: `${characterId}-attempt`, transportAttemptNo: 1, status: "succeeded", costMicros: BigInt(40_000), pricingVersion: "v1" } });
    await prisma.adminAuditLog.create({ data: {
      actorId: adminId, actorRole: "admin", action: "character.project.image_placement_selected", targetType: "character_project",
      targetId: `${characterId}-project`, after: { assetId: asset }, createdAt: start,
    } });
    await prisma.controlPlaneCommand.create({ data: {
      scope: `${characterId}-scope`, idempotencyKey: characterId, coordinationKey: `character:${characterId}`, commandType: "character.release.publish",
      targetType: "character_release", targetId: characterId, actorId: adminId, requestId: characterId, requestHash: characterId, status: "failed", createdAt: start,
    } });
    try {
      const summary = await characterOperationsSummary(prisma, { window: "7d", asOf, authorizedCharacterIds: [characterId] });
      expect(summary.imageAdoption).toEqual({ adopted: 1, generated: 1, rate: 1 });
      expect(summary.adoptedImageCost).toEqual({ microsPerAdoptedImage: 40_000, currency: "USD", coverage: "complete" });
      expect(summary.publishFailures.count).toBe(1);
      expect(summary.operationCount).toBe(1);
      expect(summary.firstUsableImage.sampleSize).toBe(1);
      // 有一次调用没有真实成本就不给单价，不用部分成本冒充。
      await prisma.generationTransportExecution.create({ data: { attemptId: `${characterId}-attempt`, transportAttemptNo: 2, status: "succeeded" } });
      const partial = await characterOperationsSummary(prisma, { window: "7d", asOf, authorizedCharacterIds: [characterId] });
      expect(partial.adoptedImageCost).toEqual({ microsPerAdoptedImage: null, currency: "USD", coverage: "partial" });
    } finally {
      await prisma.generationTransportExecution.deleteMany({ where: { attemptId: `${characterId}-attempt` } });
      await prisma.generationAttempt.delete({ where: { id: `${characterId}-attempt` } });
      await prisma.controlPlaneCommand.deleteMany({ where: { targetId: characterId } });
      await prisma.adminAuditLog.deleteMany({ where: { targetId: `${characterId}-project` } });
      await prisma.contentProductionBatch.delete({ where: { id: `${characterId}-ok` } });
      await prisma.generationJob.delete({ where: { id: job } });
      await prisma.mediaAsset.delete({ where: { id: asset } });
    }
  });
});
