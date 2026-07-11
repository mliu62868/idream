import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";

describe("immutable admin evidence database guards", () => {
  const suffix = crypto.randomUUID();

  beforeAll(async () => {
    const sql = await readFile(path.resolve(process.cwd(), "prisma/migrations/20260711120000_immutable_admin_evidence/migration.sql"), "utf8");
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await prisma.analyticsEvent.deleteMany({ where: { sourceEventId: { startsWith: suffix } } });
    await prisma.metricDefinitionSnapshot.deleteMany({ where: { key: { startsWith: suffix } } });
    await prisma.caseEvidence.deleteMany({ where: { sourceId: { startsWith: suffix } } });
    await prisma.adminCase.deleteMany({ where: { caseKey: { startsWith: suffix } } });
    await prisma.creativeReviewDecision.deleteMany({ where: { runItemId: { startsWith: suffix } } });
    await prisma.characterRelease.deleteMany({ where: { projectId: { startsWith: suffix } } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId: { startsWith: suffix } } });
    await prisma.generationTransportExecution.deleteMany({ where: { attemptId: { startsWith: suffix } } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: { startsWith: suffix } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { startsWith: suffix } } });
    await prisma.$disconnect();
  });

  it("rejects rewrites of canonical product, metric, case, and review facts", async () => {
    const event = await prisma.analyticsEvent.create({ data: { name: "immutable.test", props: {}, sourceService: "test", sourceEventId: `${suffix}:event` } });
    await expect(prisma.analyticsEvent.update({ where: { id: event.id }, data: { props: { rewritten: true } } })).rejects.toThrow(/immutable/);

    const metric = await prisma.metricDefinitionSnapshot.create({ data: { key: `${suffix}:metric`, version: 1, definition: {}, queryHash: "a".repeat(64), qualityState: "certified", effectiveAt: new Date() } });
    await expect(prisma.metricDefinitionSnapshot.update({ where: { id: metric.id }, data: { qualityState: "invalid" } })).rejects.toThrow(/immutable/);

    const adminCase = await prisma.adminCase.create({ data: { type: "test", targetType: "test", targetId: suffix, caseKey: `${suffix}:case` } });
    const evidence = await prisma.caseEvidence.create({ data: { caseId: adminCase.id, sourceType: "test", sourceId: `${suffix}:evidence`, snapshot: { original: true }, occurredAt: new Date() } });
    await expect(prisma.caseEvidence.update({ where: { id: evidence.id }, data: { snapshot: { rewritten: true } } })).rejects.toThrow(/immutable/);

    const decision = await prisma.creativeReviewDecision.create({ data: { runItemId: `${suffix}:item`, artifactId: `${suffix}:artifact`, decision: "approved", identityConsistency: "passed", reason: "Original review", reviewerId: `${suffix}:reviewer` } });
    await expect(prisma.creativeReviewDecision.update({ where: { id: decision.id }, data: { decision: "rejected" } })).rejects.toThrow(/immutable/);
  });

  it("allows Release lifecycle progress but rejects pinned snapshot mutation", async () => {
    const content = await prisma.characterContentVersion.create({ data: { characterId: `${suffix}:character`, version: 1, contentHash: `${suffix}:hash`, personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "test" } });
    await expect(prisma.characterContentVersion.update({ where: { id: content.id }, data: { personaSnapshot: { rewritten: true } } })).rejects.toThrow(/immutable/);
    const release = await prisma.characterRelease.create({ data: { projectId: `${suffix}:project`, revisionId: `${suffix}:revision`, characterContentVersionId: content.id, generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: `${suffix}:snapshot`, status: "approved" } });
    await expect(prisma.characterRelease.update({ where: { id: release.id }, data: { status: "published", version: { increment: 1 } } })).resolves.toMatchObject({ status: "published", version: 2 });
    await expect(prisma.characterRelease.update({ where: { id: release.id }, data: { snapshotHash: `${suffix}:rewritten` } })).rejects.toThrow(/snapshot is immutable/);
  });

  it("allows one TransportExecution terminal transition and rejects history rewrites", async () => {
    const attemptId = `${suffix}:attempt`;
    await prisma.generationAttempt.create({ data: { id: attemptId, requestId: `${suffix}:request`, attemptNo: 1 } });
    await prisma.generationTransportExecution.create({ data: { attemptId, transportAttemptNo: 1, idempotencyKey: `${suffix}:key`, status: "running" } });
    await expect(prisma.generationTransportExecution.update({ where: { attemptId_transportAttemptNo: { attemptId, transportAttemptNo: 1 } }, data: { status: "failed", finishedAt: new Date() } })).resolves.toMatchObject({ status: "failed" });
    await expect(prisma.generationTransportExecution.update({ where: { attemptId_transportAttemptNo: { attemptId, transportAttemptNo: 1 } }, data: { status: "unknown" } })).rejects.toThrow(/append-only/);
  });
});
