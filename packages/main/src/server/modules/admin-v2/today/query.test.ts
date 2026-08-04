import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayAllWorkQuerySchema, type TodayAllWorkQuery } from "@idream/shared/admin";
import { resolvePermissions } from "@/server/admin/permissions";
import { prisma } from "@/server/lib/db";
import { updateOperationalWorkPreference } from "./preferences";
import { claimTodayWorkItem } from "./claim";
import { buildTodayAllWork, buildTodayProjection, getTodayAllWork, getTodayProjection } from "./query";
import { adminCaseActiveKey } from "@/server/modules/admin-v2/cases/service";

/** `buildTodayAllWork` now takes the query the HTTP boundary already parsed, defaults included. */
function allWorkQuery(partial: Partial<TodayAllWorkQuery>): TodayAllWorkQuery {
  return todayAllWorkQuerySchema.parse(partial);
}

describe("Today authoritative projection", () => {
  const suffix = randomUUID();
  const actorId = `today-support-${suffix}`;
  const caseIds = Array.from({ length: 14 }, (_, index) => `today-case-${index}-${suffix}`);
  const incidentId = `today-incident-${suffix}`;
  const now = new Date("2026-07-11T12:00:00.000Z");

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@example.test`, role: "support", status: "active" },
    });
    await prisma.adminCase.createMany({
      data: [
        ...caseIds.slice(0, 12).map((id, index) => ({
          id,
          type: "support_request",
          targetType: "user",
          targetId: `customer-${index}`,
          caseKey: `support-${index}-${suffix}`,
          activeKey: adminCaseActiveKey(
            "support_request",
            "user",
            `customer-${index}`,
            `support-${index}-${suffix}`,
          ),
          status: "in_progress",
          priority: index === 0 ? "urgent" : "high",
          ownerId: actorId,
          slaDueAt: new Date("2026-07-11T18:00:00.000Z"),
          verificationState: "pending",
          createdAt: new Date("2026-07-10T12:00:00.000Z"),
          updatedAt: new Date("2026-07-11T11:00:00.000Z"),
        })),
        {
          id: caseIds[12],
          type: "support_request",
          targetType: "user",
          targetId: "unassigned-customer",
          caseKey: `unassigned-${suffix}`,
          activeKey: adminCaseActiveKey(
            "support_request",
            "user",
            "unassigned-customer",
            `unassigned-${suffix}`,
          ),
          status: "new",
          priority: "normal",
          ownerId: null,
          slaDueAt: new Date("2026-07-12T18:00:00.000Z"),
          verificationState: "pending",
          createdAt: new Date("2026-07-11T09:00:00.000Z"),
          updatedAt: new Date("2026-07-11T10:00:00.000Z"),
        },
        {
          id: caseIds[13],
          type: "support_request",
          targetType: "user",
          targetId: "resolved-customer",
          caseKey: `resolved-${suffix}`,
          status: "resolved",
          priority: "normal",
          ownerId: actorId,
          slaDueAt: new Date("2026-07-11T10:00:00.000Z"),
          resolution: { summary: "customer confirmed" },
          verificationState: "passed",
          createdAt: new Date("2026-07-10T09:00:00.000Z"),
          updatedAt: new Date("2026-07-11T11:30:00.000Z"),
        },
      ],
    });
    await prisma.opsIncident.create({
      data: {
        id: incidentId,
        signature: `support-linked-${suffix}`,
        signatureVersion: "v1",
        activeCorrelationKey: `today-correlation-${suffix}`,
        status: "mitigating",
        severity: "critical",
        ownerId: actorId,
        firstSeen: new Date("2026-07-11T08:00:00.000Z"),
        lastSeen: new Date("2026-07-11T11:30:00.000Z"),
        slaDueAt: new Date("2026-07-11T13:00:00.000Z"),
        impact: { affectedUsers: 4 },
        mitigation: { state: "active" },
        verificationState: "pending",
        createdAt: new Date("2026-07-11T08:00:00.000Z"),
        updatedAt: new Date("2026-07-11T11:30:00.000Z"),
      },
    });
    await prisma.operationalWorkPreference.createMany({
      data: [
        {
          actorId,
          sourceType: "admin_case",
          sourceId: caseIds[0],
          watching: true,
          pinned: true,
        },
        {
          actorId,
          sourceType: "admin_case",
          sourceId: caseIds[1],
          snoozedUntil: new Date("2026-07-12T12:00:00.000Z"),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.operationalWorkPreference.deleteMany({ where: { actorId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId, commandType: "today.work.claim" } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: caseIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: caseIds } } });
    await prisma.opsIncident.deleteMany({ where: { id: incidentId } });
    await prisma.adminCase.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("separates complete counts from the ten displayed rows and preserves domain truth", async () => {
    const sourceQueries: Array<{ sourceType: string; returnedRows: number; limit: number }> = [];
    const projection = await buildTodayProjection({
      actor: { id: actorId, role: "support" },
      permissions: resolvePermissions("support"),
      now,
      diagnostics: { onSourceQuery: (event) => sourceQueries.push(event) },
    });

    expect(projection.myShift.totalCount).toBe(12);
    expect(projection.myShift.items).toHaveLength(10);
    expect(projection.nextBestActions.totalCount).toBe(13);
    expect(projection.nextBestActions.items).toHaveLength(10);
    expect(projection.unassigned).toMatchObject({ totalCount: 1 });
    expect(projection.unassigned.items[0]).toMatchObject({
      sourceId: caseIds[12],
      ownerId: null,
      claim: { entityVersion: 1 },
    });
    expect(projection.watching).toMatchObject({ totalCount: 1 });
    expect(projection.recentlyResolved).toMatchObject({ totalCount: 1 });
    expect(projection.myShift.items[0]).toMatchObject({
      sourceType: "admin_case",
      sourceId: caseIds[0],
      ownerId: actorId,
      pinned: true,
      preferenceVersion: 1,
      environment: "test",
      dataClass: "customer",
    });
    expect(projection.myShift.items.some((item) => item.sourceId === caseIds[1])).toBe(false);
    expect(projection.watching.items[0]?.deepLink).toBe(`/admin/cases/${caseIds[0]}`);
    expect(sourceQueries.length).toBeGreaterThan(0);
    expect(sourceQueries.every((query) => query.returnedRows <= query.limit && query.limit === 10)).toBe(true);
    expect(sourceQueries.some((query) => query.sourceType === "admin_case" && query.returnedRows === 10)).toBe(true);
  });

  it("returns real empty queues when effective permissions expose no authoritative source", async () => {
    const projection = await buildTodayProjection({
      actor: { id: actorId, role: "analyst" },
      permissions: resolvePermissions("analyst"),
      now,
    });

    expect(projection.myShift).toEqual({ totalCount: 0, items: [] });
    expect(projection.nextBestActions).toEqual({ totalCount: 0, items: [] });
    expect(projection.watching).toEqual({ totalCount: 0, items: [] });
  });

  it("paginates the complete authoritative set with the same first-segment order as Summary", async () => {
    const sourceQueries: Array<{ returnedRows: number; limit: number }> = [];
    const authority = {
      actor: { id: actorId, role: "support" },
      permissions: resolvePermissions("support"),
      now,
    } as const;
    const summary = await buildTodayProjection(authority);
    const first = await buildTodayAllWork({ ...authority, query: allWorkQuery({ limit: 5 }), diagnostics: { onSourceQuery: (event) => sourceQueries.push(event) } });
    const second = await buildTodayAllWork({
      ...authority,
      query: allWorkQuery({ limit: 5, cursor: first.pageInfo.endCursor ?? undefined }),
    });
    const third = await buildTodayAllWork({
      ...authority,
      query: allWorkQuery({ limit: 5, cursor: second.pageInfo.endCursor ?? undefined }),
    });

    expect(first.items.map((item) => `${item.sourceType}:${item.sourceId}`)).toEqual(
      summary.nextBestActions.items.slice(0, 5).map((item) => `${item.sourceType}:${item.sourceId}`),
    );
    expect(first.totalCount).toBe(summary.nextBestActions.totalCount);
    expect(first.pageInfo).toMatchObject({ hasNextPage: true });
    expect(sourceQueries.every((event) => event.returnedRows <= 6 && event.limit === 6)).toBe(true);
    const pagedItems = [...first.items, ...second.items, ...third.items];
    expect(new Set(pagedItems.map((item) => `${item.sourceType}:${item.sourceId}`)).size).toBe(first.totalCount);
    expect(pagedItems).toHaveLength(first.totalCount);
    expect(third.pageInfo.hasNextPage).toBe(false);

    const filtered = await buildTodayAllWork({
      ...authority,
      query: allWorkQuery({ domain: "admin_case", severity: "high", owner: "mine", status: "in_progress", environment: "test" }),
    });
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.every((item) => item.sourceType === "admin_case" && item.severity === "high" && item.ownerId === actorId && item.sourceStatus === "in_progress" && item.environment === "test")).toBe(true);
    await expect(buildTodayAllWork({
      ...authority,
      query: allWorkQuery({ limit: 5, domain: "ops_incident", cursor: first.pageInfo.endCursor ?? undefined }),
    })).rejects.toThrow("cursor is invalid");
    const cursor = first.pageInfo.endCursor;
    if (!cursor) throw new Error("expected a signed Today cursor");
    const [payload, signature] = cursor.split(".");
    const decoded = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const forged = `${Buffer.from(JSON.stringify({ ...decoded, scanLimit: 1_000_000 })).toString("base64url")}.${signature}`;
    await expect(buildTodayAllWork({
      ...authority,
      query: allWorkQuery({ limit: 5, cursor: forged }),
    })).rejects.toThrow("cursor is invalid");
    await expect(buildTodayAllWork({
      ...authority,
      query: allWorkQuery({ limit: 5, cursor: `${payload}.${signature?.slice(0, -1)}x` }),
    })).rejects.toThrow("cursor is invalid");
  });

  it("authenticates before returning the Today read model", async () => {
    const response = await getTodayProjection(new Request("http://localhost/api/v2/admin/today"));
    expect(response.status).toBe(401);
  });

  it("authenticates before returning All Work", async () => {
    const response = await getTodayAllWork(new Request("http://localhost/api/v2/admin/today/all-work"));
    expect(response.status).toBe(401);
  });

  it("claims an unassigned source object through its authoritative domain transaction", async () => {
    const claimRequest = () => new Request("http://localhost/api/v2/admin/today/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actorId,
        "x-idream-role": "support",
        "idempotency-key": `today-claim-key-${suffix}`,
        "x-request-id": `today-claim-${suffix}`,
      },
      body: JSON.stringify({ sourceType: "admin_case", sourceId: caseIds[12], entityVersion: 1 }),
    });
    const response = await claimTodayWorkItem(claimRequest());

    expect(response).toMatchObject({
      sourceType: "admin_case",
      sourceId: caseIds[12],
      ownerId: actorId,
      entityVersion: 2,
    });
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseIds[12] } })).resolves.toMatchObject({
      ownerId: actorId,
      status: "triaged",
      version: 2,
    });
    await expect(prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "case.assigned", targetId: caseIds[12], requestId: `today-claim-${suffix}` },
    })).resolves.toBeDefined();
    await expect(prisma.mainOutboxEvent.findFirstOrThrow({
      where: { eventType: "admin.case.assigned.v2", aggregateId: caseIds[12] },
    })).resolves.toBeDefined();
    await expect(claimTodayWorkItem(claimRequest())).resolves.toEqual(response);
    await expect(prisma.adminAuditLog.count({
      where: { action: "case.assigned", targetId: caseIds[12], requestId: `today-claim-${suffix}` },
    })).resolves.toBe(1);
  });
});

describe("Today domain roots", () => {
  const suffix = randomUUID();
  const actorId = `today-root-admin-${suffix}`;
  const projectId = `today-project-${suffix}`;
  const releaseId = `today-release-${suffix}`;
  const servingId = `today-serving-${suffix}`;
  const creativeRunId = `today-creative-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" },
    });
    await prisma.character.create({ data: { id: `character-${suffix}`, name: "Today release character", age: 24, description: "Release monitor fixture", source: "official", appearance: {}, advancedDetails: {} } });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId: `character-${suffix}`,
        ownerId: null,
        phase: "qa",
        audience: {},
        successCriteria: [],
        activeKey: `today-project-active-${suffix}`,
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `revision-${suffix}`,
        characterContentVersionId: `content-version-${suffix}`,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `snapshot-${suffix}`,
        readiness: "blocked",
        status: "in_review",
      },
    });
    await prisma.characterServing.create({ data: { id: servingId, characterId: `character-${suffix}`, currentReleaseId: releaseId, state: "live" } });
    await prisma.contentProductionBatch.create({
      data: {
        id: creativeRunId,
        title: "Homepage visual",
        purpose: "homepage",
        presetIds: [],
        createdById: actorId,
        ownerId: null,
        dueAt: new Date("2026-07-11T18:00:00.000Z"),
        priority: "high",
        lifecycleState: "active",
        workflowStage: "review",
        verificationState: "failed",
      },
    });
    await prisma.operationalWorkPreference.createMany({
      data: [
        { actorId, sourceType: "character_release", sourceId: releaseId, watching: true, pinned: true },
        { actorId, sourceType: "creative_run", sourceId: creativeRunId, snoozedUntil: new Date("2026-07-12T00:00:00.000Z") },
      ],
    });
  });

  afterAll(async () => {
    await prisma.operationalWorkPreference.deleteMany({ where: { actorId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId, commandType: "today.work.claim" } });
    await prisma.releaseMonitor.deleteMany({ where: { releaseId: { in: [releaseId, `today-superseded-release-${suffix}`] } } });
    await prisma.characterServing.deleteMany({ where: { id: servingId } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [projectId, creativeRunId] } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId, targetId: { in: [projectId, creativeRunId] } } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: creativeRunId } });
    await prisma.characterRelease.deleteMany({ where: { projectId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: `character-${suffix}` } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("projects Character Release and Creative Run roots with watch, pin and snooze", async () => {
    const projection = await buildTodayProjection({
      actor: { id: actorId, role: "admin" },
      permissions: resolvePermissions("admin"),
      now: new Date("2026-07-11T12:00:00.000Z"),
      workMode: "character_producer",
    });

    expect(projection.nextBestActions.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "character_release",
        sourceId: releaseId,
        pinned: true,
        deepLink: `/admin/characters/character-${suffix}?tab=release&releaseId=${releaseId}`,
      }),
    ]));
    expect(projection.nextBestActions.items.some((item) => item.sourceId === creativeRunId)).toBe(false);
    expect(projection.watching.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "character_release",
        sourceId: releaseId,
        claim: { entityVersion: 1 },
      }),
    ]));
  });

  it("claims Character and Creative roots with CAS, Audit and Outbox", async () => {
    function request(sourceType: "character_release" | "creative_run", sourceId: string, requestId: string) {
      return new Request("http://localhost/api/v2/admin/today/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "idempotency-key": `today-claim:${sourceType}:${sourceId}`,
          "x-request-id": requestId,
        },
        body: JSON.stringify({ sourceType, sourceId, entityVersion: 1 }),
      });
    }

    await expect(claimTodayWorkItem(request("character_release", releaseId, `claim-character-${suffix}`))).resolves.toMatchObject({
      ownerId: actorId,
      entityVersion: 2,
    });
    await expect(claimTodayWorkItem(request("creative_run", creativeRunId, `claim-creative-${suffix}`))).resolves.toMatchObject({
      ownerId: actorId,
      entityVersion: 2,
    });
    await expect(prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } })).resolves.toMatchObject({ ownerId: actorId, version: 2 });
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: creativeRunId } })).resolves.toMatchObject({ ownerId: actorId, version: 2 });
    await expect(prisma.adminAuditLog.count({ where: { actorId, action: { in: ["character.project.claimed", "creative.run.claimed"] } } })).resolves.toBe(2);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: { in: [projectId, creativeRunId] } } })).resolves.toBe(2);
  });

  it("re-enters a published Release when monitor authority requires rollback review", async () => {
    const historicalReleaseId = `today-superseded-release-${suffix}`;
    await prisma.characterRelease.update({ where: { id: releaseId }, data: { status: "published", readiness: "ready" } });
    await prisma.characterRelease.create({ data: { id: historicalReleaseId, projectId, revisionId: `old-revision-${suffix}`, characterContentVersionId: `old-content-${suffix}`, generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: `old-snapshot-${suffix}`, readiness: "ready", status: "superseded" } });
    await prisma.releaseMonitor.create({
      data: {
        releaseId,
        window: "24h",
        status: "action_required",
        baseline: {},
        observed: {},
        verification: { recommendation: "rollback_review", operationalPassed: false },
      },
    });
    await prisma.releaseMonitor.create({ data: { releaseId: historicalReleaseId, window: "24h", status: "action_required", baseline: {}, observed: {}, verification: { recommendation: "rollback_review" } } });
    const projection = await buildTodayProjection({
      actor: { id: actorId, role: "admin" },
      permissions: resolvePermissions("admin"),
      now: new Date("2026-07-11T12:00:00.000Z"),
      workMode: "character_producer",
    });

    expect(projection.nextBestActions.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: releaseId, verificationState: "failed", recommendedAction: "Investigate monitor evidence and keep or rollback" }),
    ]));
    expect(projection.recentlyResolved.items.some((item) => item.sourceId === releaseId)).toBe(false);
    expect(projection.nextBestActions.items.some((item) => item.sourceId === historicalReleaseId)).toBe(false);
    await prisma.releaseMonitor.deleteMany({ where: { releaseId: historicalReleaseId } });
    await prisma.characterRelease.delete({ where: { id: historicalReleaseId } });
  });
});

describe("Today complete-set ranking and collaboration bridge", () => {
  const suffix = randomUUID();
  const actorId = `today-ranking-${suffix}`;
  const caseIds = Array.from({ length: 12 }, (_, index) => `today-ranking-case-${index}-${suffix}`);

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@example.test`, role: "support", status: "active" },
    });
    await prisma.adminCase.createMany({
      data: caseIds.map((id, index) => ({
        id,
        type: "support_request",
        targetType: "user",
        targetId: `ranking-customer-${index}-${suffix}`,
        caseKey: `ranking-${index}-${suffix}`,
        activeKey: adminCaseActiveKey(
          "support_request",
          "user",
          `ranking-customer-${index}-${suffix}`,
          `ranking-${index}-${suffix}`,
        ),
        status: "in_progress",
        priority: index === 0 ? "urgent" : "low",
        ownerId: actorId,
        slaDueAt: index === 0
          ? new Date("2026-07-10T08:00:00.000Z")
          : new Date("2026-07-11T18:00:00.000Z"),
        verificationState: "pending",
        createdAt: index === 0
          ? new Date("2026-06-01T00:00:00.000Z")
          : new Date(`2026-07-11T${String(index).padStart(2, "0")}:00:00.000Z`),
        updatedAt: index === 0
          ? new Date("2026-06-01T00:00:00.000Z")
          : new Date(`2026-07-11T${String(index).padStart(2, "0")}:00:00.000Z`),
      })),
    });
  });

  afterAll(async () => {
    await prisma.adminCase.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("ranks an old critical overdue row above newer low-priority rows from the complete eligible set", async () => {
    const projection = await buildTodayProjection({
      actor: { id: actorId, role: "support" },
      permissions: resolvePermissions("support"),
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(projection.myShift.totalCount).toBe(12);
    expect(projection.myShift.items).toHaveLength(10);
    expect(projection.myShift.items[0]).toMatchObject({
      sourceType: "admin_case",
      sourceId: caseIds[0],
      severity: "critical",
    });
  });
});

describe("Today mentions and collaboration watch aliases", () => {
  const suffix = randomUUID();
  const actorId = `today-collab-${suffix}`;
  const visibleCaseId = `today-visible-case-${suffix}`;
  const hiddenCaseId = `today-hidden-case-${suffix}`;
  const incidentId = `today-watched-incident-${suffix}`;
  const projectId = `today-watched-project-${suffix}`;
  const characterId = `today-watched-character-${suffix}`;
  const currentReleaseId = `today-watched-current-${suffix}`;
  const candidateReleaseId = `today-watched-candidate-${suffix}`;
  const creativeRunId = `today-watched-creative-${suffix}`;
  const commandId = `today-command-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@example.test`, role: "support", status: "active" },
    });
    await prisma.adminCase.createMany({ data: [
      {
        id: visibleCaseId,
        type: "support_request",
        targetType: "user",
        targetId: `visible-customer-${suffix}`,
        caseKey: `visible-${suffix}`,
        activeKey: adminCaseActiveKey(
          "support_request",
          "user",
          `visible-customer-${suffix}`,
          `visible-${suffix}`,
        ),
        status: "new",
        priority: "normal",
        slaDueAt: new Date("2026-07-15T00:00:00.000Z"),
      },
      {
        id: hiddenCaseId,
        type: "content_report",
        targetType: "character",
        targetId: `hidden-character-${suffix}`,
        caseKey: `hidden-${suffix}`,
        activeKey: adminCaseActiveKey(
          "content_report",
          "character",
          `hidden-character-${suffix}`,
          `hidden-${suffix}`,
        ),
        status: "new",
        priority: "high",
        slaDueAt: new Date("2026-07-12T00:00:00.000Z"),
      },
    ] });
    await prisma.adminCollaborationActivity.createMany({ data: [
      {
        id: `today-visible-mention-${suffix}`,
        targetType: "case",
        targetId: visibleCaseId,
        kind: "comment",
        actorId,
        body: "Please verify the customer outcome",
        mentionedIds: [actorId],
        metadata: {},
        idempotencyKey: `visible-mention-${suffix}`,
      },
      {
        id: `today-hidden-mention-${suffix}`,
        targetType: "case",
        targetId: hiddenCaseId,
        kind: "comment",
        actorId,
        body: "Out-of-scope moderation mention",
        mentionedIds: [actorId],
        metadata: {},
        idempotencyKey: `hidden-mention-${suffix}`,
      },
    ] });
    await prisma.opsIncident.create({ data: {
      id: incidentId,
      signature: `today-watch-${suffix}`,
      signatureVersion: "v1",
      status: "monitoring",
      severity: "high",
      ownerId: actorId,
      firstSeen: new Date("2026-07-11T08:00:00.000Z"),
      lastSeen: new Date("2026-07-11T09:00:00.000Z"),
      impact: {},
      mitigation: {},
    } });
    await prisma.character.create({ data: {
      id: characterId,
      name: "Watched Character",
      age: 24,
      description: "Today collaboration fixture.",
      source: "official",
      appearance: {},
      advancedDetails: {},
    } });
    await prisma.characterProject.create({ data: {
      id: projectId,
      characterId,
      ownerId: actorId,
      phase: "qa",
      audience: {},
      successCriteria: [],
      activeKey: `today-watch-project-${suffix}`,
    } });
    await prisma.characterRelease.createMany({ data: [
      {
        id: currentReleaseId,
        projectId,
        revisionId: `current-revision-${suffix}`,
        characterContentVersionId: `current-content-${suffix}`,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `current-snapshot-${suffix}`,
        readiness: "ready",
        status: "published",
      },
      {
        id: candidateReleaseId,
        projectId,
        revisionId: `candidate-revision-${suffix}`,
        characterContentVersionId: `candidate-content-${suffix}`,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `candidate-snapshot-${suffix}`,
        readiness: "blocked",
        status: "approved",
      },
    ] });
    await prisma.characterServing.create({ data: {
      id: `today-watch-serving-${suffix}`,
      characterId,
      currentReleaseId,
      state: "live",
    } });
    await prisma.contentProductionBatch.create({ data: {
      id: creativeRunId,
      title: "Watched Creative Run",
      purpose: "campaign",
      presetIds: [],
      createdById: actorId,
      lifecycleState: "active",
      workflowStage: "review",
    } });
    await prisma.controlPlaneCommand.create({ data: {
      id: commandId,
      scope: `today-command-${suffix}`,
      idempotencyKey: `today-command-${suffix}`,
      commandType: "case.verify",
      targetType: "admin_case",
      targetId: visibleCaseId,
      actorId,
      requestId: `today-request-${suffix}`,
      requestHash: `today-hash-${suffix}`,
      requestPayload: {},
      status: "verifying",
    } });
    await prisma.operationalWorkPreference.createMany({ data: [
      { actorId, sourceType: "case", sourceId: visibleCaseId, watching: true },
      { actorId, sourceType: "incident", sourceId: incidentId, watching: true },
      { actorId, sourceType: "character_project", sourceId: projectId, watching: true },
      { actorId, sourceType: "creative_run", sourceId: creativeRunId, watching: true },
    ] });
  });

  afterAll(async () => {
    await prisma.operationalWorkPreference.deleteMany({ where: { actorId } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { actorId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: commandId } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: creativeRunId } });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.characterRelease.deleteMany({ where: { projectId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.opsIncident.deleteMany({ where: { id: incidentId } });
    await prisma.adminCase.deleteMany({ where: { id: { in: [visibleCaseId, hiddenCaseId] } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("projects only read-scoped mentions into My shift", async () => {
    const projection = await buildTodayProjection({
      actor: { id: actorId, role: "support" },
      permissions: resolvePermissions("support"),
      now: new Date("2026-07-11T12:00:00.000Z"),
    });
    const mentions = projection.myShift.items.filter((item) => item.sourceType === "collaboration_mention");
    expect(mentions).toEqual([
      expect.objectContaining({
        sourceId: `today-visible-mention-${suffix}`,
        ownerId: actorId,
        deepLink: `/admin/cases/${visibleCaseId}`,
      }),
    ]);
  });

  it("links commands to readable command context in the audit workspace", async () => {
    const projection = await buildTodayProjection({
      actor: { id: actorId, role: "support" },
      permissions: resolvePermissions("support"),
      now: new Date("2026-07-11T12:00:00.000Z"),
    });
    expect(projection.myShift.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "control_plane_command",
        sourceId: commandId,
        deepLink: `/admin/system/audit?commandId=${commandId}`,
      }),
    ]));
  });

  it("applies pin and snooze preferences to an authorized mention", async () => {
    const mentionId = `today-visible-mention-${suffix}`;
    const requestIds = [`pin-mention-${suffix}`, `snooze-mention-${suffix}`];
    try {
      await updateOperationalWorkPreference({
        actor: { id: actorId, role: "support" },
        permissions: resolvePermissions("support"),
        sourceType: "collaboration_mention",
        sourceId: mentionId,
        watching: false,
        pinned: true,
        snoozedUntil: null,
        requestId: requestIds[0],
        expectedVersion: 0,
      });
      const pinned = await buildTodayProjection({
        actor: { id: actorId, role: "support" },
        permissions: resolvePermissions("support"),
        now: new Date("2026-07-11T12:00:00.000Z"),
      });
      expect(pinned.myShift.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceType: "collaboration_mention", sourceId: mentionId, pinned: true }),
      ]));

      await updateOperationalWorkPreference({
        actor: { id: actorId, role: "support" },
        permissions: resolvePermissions("support"),
        sourceType: "collaboration_mention",
        sourceId: mentionId,
        watching: false,
        pinned: false,
        snoozedUntil: new Date("2026-07-12T12:00:00.000Z"),
        requestId: requestIds[1],
        expectedVersion: 1,
      });
      const snoozed = await buildTodayProjection({
        actor: { id: actorId, role: "support" },
        permissions: resolvePermissions("support"),
        now: new Date("2026-07-11T12:00:00.000Z"),
      });
      expect(snoozed.myShift.items.some((item) => item.sourceId === mentionId)).toBe(false);
      expect(snoozed.nextBestActions.items.some((item) => item.sourceId === mentionId)).toBe(false);
    } finally {
      await prisma.operationalWorkPreference.deleteMany({
        where: { actorId, sourceType: "collaboration_mention", sourceId: mentionId },
      });
      await prisma.adminAuditLog.deleteMany({ where: { requestId: { in: requestIds } } });
    }
  });

  it("bridges collaboration target aliases and maps a watched Character Project to current and candidate Releases", async () => {
    const projection = await buildTodayProjection({
      actor: { id: actorId, role: "admin" },
      permissions: resolvePermissions("admin"),
      now: new Date("2026-07-11T12:00:00.000Z"),
    });
    expect(new Set(projection.watching.items.map((item) => item.sourceId))).toEqual(new Set([
      visibleCaseId,
      incidentId,
      currentReleaseId,
      candidateReleaseId,
      creativeRunId,
    ]));
  });
});

/**
 * SPEC: 按紧急度筛 All Work 时，SQL 选行与 TS 投影必须给出同一个答案。
 * INTENT: totalCount 来自各来源的 SQL count，items 来自 projectRow 之后的 TS 过滤。
 * 两侧对同一条规则各写一份时，页面会同时显示「共 N 条」和一页也翻不出来的空列表 ——
 * 而且每个来源的规则此前写了三遍（SQL rank、选行谓词、TS 三段式），谁也不对账。
 * 这里对每个紧急度断言「宣称的条数 == 真能翻出来的条数」，并断言四档之和等于不筛时的总数
 * （即这四档在选行侧确实互斥且穷尽）。
 */
describe("Today All Work severity selection matches projection", () => {
  const suffix = randomUUID();
  const actorId = `today-severity-${suffix}`;
  const characterId = `today-severity-character-${suffix}`;
  const projectId = `today-severity-project-${suffix}`;
  const creativeRunIds = [`today-severity-creative-high-${suffix}`, `today-severity-creative-medium-${suffix}`];
  const caseIds = ["urgent", "high", "normal", "low"].map((priority) => `today-severity-case-${priority}-${suffix}`);
  const incidentIds = ["critical", "high", "moderate", "low"].map((severity) => `today-severity-incident-${severity}-${suffix}`);
  const releaseIds = ["blocked", "stale", "ready"].map((readiness) => `today-severity-release-${readiness}-${suffix}`);
  const commandIds = ["failed", "running"].map((status) => `today-severity-command-${status}-${suffix}`);
  const now = new Date("2026-07-11T12:00:00.000Z");

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" },
    });
    await prisma.adminCase.createMany({
      data: ["urgent", "high", "normal", "low"].map((priority, index) => ({
        id: caseIds[index],
        type: "support_request",
        targetType: "user",
        targetId: `severity-customer-${index}-${suffix}`,
        caseKey: `severity-${index}-${suffix}`,
        activeKey: adminCaseActiveKey(
          "support_request",
          "user",
          `severity-customer-${index}-${suffix}`,
          `severity-${index}-${suffix}`,
        ),
        status: "in_progress",
        priority,
        ownerId: actorId,
        verificationState: "pending",
      })),
    });
    // "moderate" 不在 severity 词表里：老的选行谓词写的是 `severity = 'medium'`，
    // 投影却把未知值归一成 medium —— 这一行专门钉住那个洞。
    await prisma.opsIncident.createMany({
      data: ["critical", "high", "moderate", "low"].map((severity, index) => ({
        id: incidentIds[index],
        signature: `severity-${severity}-${suffix}`,
        signatureVersion: "v1",
        activeCorrelationKey: `severity-correlation-${index}-${suffix}`,
        status: "mitigating",
        severity,
        ownerId: actorId,
        firstSeen: now,
        lastSeen: now,
        impact: {},
        mitigation: {},
        verificationState: "pending",
      })),
    });
    await prisma.character.create({
      data: { id: characterId, name: "Severity fixture", age: 24, description: "Severity fixture", source: "official", appearance: {}, advancedDetails: {} },
    });
    await prisma.characterProject.create({
      data: { id: projectId, characterId, ownerId: actorId, phase: "qa", audience: {}, successCriteria: [], activeKey: `severity-project-active-${suffix}` },
    });
    await prisma.characterRelease.createMany({
      data: ["blocked", "stale", "ready"].map((readiness, index) => ({
        id: releaseIds[index],
        projectId,
        revisionId: `severity-revision-${index}-${suffix}`,
        characterContentVersionId: `severity-content-${index}-${suffix}`,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `severity-snapshot-${index}-${suffix}`,
        readiness,
        status: "in_review",
      })),
    });
    await prisma.contentProductionBatch.createMany({
      data: ["failed", "pending"].map((verificationState, index) => ({
        id: creativeRunIds[index],
        title: `Severity creative ${verificationState}`,
        purpose: "homepage",
        presetIds: [],
        createdById: actorId,
        ownerId: actorId,
        priority: "normal",
        lifecycleState: "active",
        workflowStage: "review",
        verificationState,
      })),
    });
    await prisma.controlPlaneCommand.createMany({
      data: ["failed", "running"].map((status, index) => ({
        id: commandIds[index],
        scope: `severity-${index}-${suffix}`,
        idempotencyKey: `severity-key-${index}-${suffix}`,
        commandType: "creative.run.retry",
        targetType: "creative_run",
        targetId: creativeRunIds[0],
        actorId,
        requestId: `severity-request-${index}-${suffix}`,
        requestHash: `severity-hash-${index}-${suffix}`,
        status,
      })),
    });
  });

  afterAll(async () => {
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: commandIds } } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: { in: creativeRunIds } } });
    await prisma.characterRelease.deleteMany({ where: { projectId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.opsIncident.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  async function allWork(severity?: "critical" | "high" | "medium" | "low") {
    return buildTodayAllWork({
      actor: { id: actorId, role: "admin" },
      permissions: resolvePermissions("admin"),
      query: allWorkQuery({ owner: "mine", ownerId: actorId, ...(severity ? { severity } : {}) }),
      now,
    });
  }

  it("returns exactly as many rows as it claims for every severity", async () => {
    const severities = ["critical", "high", "medium", "low"] as const;
    const pages = await Promise.all(severities.map((severity) => allWork(severity)));
    const counted: Record<string, number> = {};
    for (const [index, page] of pages.entries()) {
      const severity = severities[index];
      expect(page.items.map((item) => item.severity), severity).toEqual(page.items.map(() => severity));
      expect(page.totalCount, severity).toBe(page.items.length);
      expect(page.pageInfo.hasNextPage, severity).toBe(false);
      counted[severity] = page.totalCount;
    }
    expect(counted).toEqual({ critical: 2, high: 5, medium: 5, low: 3 });
  });

  it("partitions the unfiltered set across the four severities without loss or overlap", async () => {
    const unfiltered = await allWork();
    const perSeverity = await Promise.all((["critical", "high", "medium", "low"] as const).map(allWork));
    expect(perSeverity.reduce((sum, page) => sum + page.totalCount, 0)).toBe(unfiltered.totalCount);
    expect(new Set(perSeverity.flatMap((page) => page.items.map((item) => item.sourceId))))
      .toEqual(new Set(unfiltered.items.map((item) => item.sourceId)));
  });
});
