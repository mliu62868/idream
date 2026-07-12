import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { runProductionBackfillCli } from "@/processes/admin-production-backfill";
import { runProductionBackfillBatch } from "./production-runner";

describe("production Incident and Case backfill runner", () => {
  const suffix = randomUUID();
  const userId = `backfill-customer-${suffix}`;
  const operatorId = `backfill-operator-${suffix}`;
  const supportIds = [0, 1, 2].map((index) => `backfill-support-${index}-${suffix}`);
  const attemptIds = {
    stable: `zz-backfill-attempt-1-stable-${suffix}`,
    crash: `zz-backfill-attempt-2-crash-${suffix}`,
    incomplete: `zz-backfill-attempt-3-incomplete-${suffix}`,
  };
  const reportIds = {
    active: `zz-backfill-report-1-active-${suffix}`,
    terminal: `zz-backfill-report-2-terminal-${suffix}`,
  };
  const appealId = `zz-backfill-appeal-1-terminal-${suffix}`;

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: userId, email: `${userId}@example.test`, role: "user", status: "active" },
        { id: operatorId, email: `${operatorId}@example.test`, role: "admin", status: "active" },
      ],
    });
    await prisma.supportRequest.createMany({
      data: supportIds.map((id, index) => ({
        id,
        ticketId: `ticket-${id}`,
        userId,
        category: index === 1 ? "billing_dispute" : "technical",
        subject: `Backfill request ${index}`,
        description: "Historical request",
        status: "open",
      })),
    });
    await prisma.generationAttempt.createMany({
      data: [
        {
          id: attemptIds.stable,
          requestId: `request-${attemptIds.stable}`,
          attemptNo: 1,
          provider: "test-provider",
          profileKey: "test-profile",
          workflowKey: "test-workflow",
          status: "failed",
          errorClass: "provider_error",
          errorSignature: "stable-error",
          retryability: "operator_retry",
          finishedAt: new Date("2026-07-10T00:00:00.000Z"),
        },
        {
          id: attemptIds.crash,
          requestId: `request-${attemptIds.crash}`,
          attemptNo: 1,
          provider: "test-provider",
          profileKey: "test-profile",
          workflowKey: "test-workflow",
          status: "failed",
          errorClass: "provider_error",
          errorSignature: "crash-error",
          retryability: "operator_retry",
          finishedAt: new Date("2026-07-10T01:00:00.000Z"),
        },
        {
          id: attemptIds.incomplete,
          requestId: `request-${attemptIds.incomplete}`,
          attemptNo: 1,
          status: "failed",
          errorClass: "provider_error",
          errorSignature: "missing-route-authority",
          finishedAt: new Date("2026-07-10T02:00:00.000Z"),
        },
      ],
    });
    await prisma.contentReport.createMany({
      data: [
        {
          id: reportIds.active,
          reporterId: userId,
          targetType: "character",
          targetId: `review-active-${suffix}`,
          category: "quality",
          status: "open",
          priority: 2,
        },
        {
          id: reportIds.terminal,
          reporterId: userId,
          targetType: "character",
          targetId: `review-terminal-${suffix}`,
          category: "quality",
          status: "resolved",
          priority: 3,
        },
      ],
    });
    await prisma.appeal.create({
      data: {
        id: appealId,
        userId,
        targetType: "character",
        targetId: `appeal-terminal-${suffix}`,
        status: "resolved",
        appealText: "Historical appeal",
        resolvedAt: new Date("2026-07-10T03:00:00.000Z"),
      },
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "backfill_item_crash" ON "admin_backfill_items"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "inject_backfill_item_crash"()`);
    const reviewEvidence = await prisma.caseEvidence.findMany({
      where: { OR: [
        { sourceType: "content_report", sourceId: { in: Object.values(reportIds) } },
        { sourceType: "appeal", sourceId: appealId },
      ] },
      select: { caseId: true },
    });
    const cases = await prisma.adminCase.findMany({ where: { targetId: userId }, select: { id: true } });
    const caseIds = [...new Set([...cases.map((row) => row.id), ...reviewEvidence.map((row) => row.caseId)])];
    const occurrences = await prisma.opsIncidentOccurrence.findMany({
      where: { attemptId: { in: Object.values(attemptIds) } },
      select: { incidentId: true },
    });
    const incidentIds = [...new Set(occurrences.map((row) => row.incidentId))];
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: [...caseIds, ...incidentIds] } } });
    await prisma.caseEvidence.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.opsIncidentOccurrence.deleteMany({ where: { attemptId: { in: Object.values(attemptIds) } } });
    await prisma.opsIncident.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.adminBackfillItem.deleteMany({ where: { entityId: { in: [...supportIds, ...Object.values(attemptIds), ...Object.values(reportIds), appealId] } } });
    await prisma.adminBackfillRun.deleteMany({ where: { domain: { in: ["customer_case_v1", "generation_incident_v1", "review_case_v1"] } } });
    await prisma.appeal.delete({ where: { id: appealId } });
    await prisma.contentReport.deleteMany({ where: { id: { in: Object.values(reportIds) } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { in: Object.values(attemptIds) } } });
    await prisma.supportRequest.deleteMany({ where: { id: { in: supportIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, operatorId] } } });
    await prisma.$disconnect();
  });

  it("persists a side-effect-free dry-run batch and pauses at its keyset cursor", async () => {
    const result = await runProductionBackfillBatch(prisma, {
      domain: "customer_case_v1",
      mode: "dry_run",
      batchSize: 1,
      actor: { id: operatorId, role: "admin" },
    });

    expect(result).toMatchObject({ status: "paused", summary: { scanned: 1, eligible: 1, applied: 0 } });
    expect(result.nextCursor).toEqual(expect.any(String));
    await expect(prisma.adminCase.count({ where: { targetId: userId } })).resolves.toBe(0);
    await expect(prisma.adminBackfillRun.findUniqueOrThrow({ where: { id: result.runId } })).resolves.toMatchObject({
      domain: "customer_case_v1",
      mode: "dry_run",
      status: "paused",
      cursor: result.nextCursor,
      batchSize: 1,
    });
    await expect(prisma.adminBackfillItem.findMany({ where: { runId: result.runId } })).resolves.toEqual([
      expect.objectContaining({
        entityType: "support_request",
        entityId: supportIds[0],
        classification: "eligible",
        applied: false,
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it("resumes persisted apply options and reruns without duplicating Case authority", async () => {
    const first = await runProductionBackfillBatch(prisma, {
      domain: "customer_case_v1",
      mode: "apply",
      batchSize: 1,
      actor: { id: operatorId, role: "admin" },
    });
    expect(first).toMatchObject({ status: "paused", summary: { scanned: 1, applied: 1 } });

    const second = await runProductionBackfillBatch(prisma, { runId: first.runId });
    expect(second).toMatchObject({ status: "paused", summary: { scanned: 2, applied: 2 } });
    const completed = await runProductionBackfillBatch(prisma, { runId: first.runId });
    expect(completed).toMatchObject({
      status: "completed",
      nextCursor: null,
      summary: { scanned: 3, eligible: 3, applied: 3, mismatch: 0 },
      reportHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(prisma.adminBackfillRun.findUniqueOrThrow({ where: { id: first.runId } })).resolves.toMatchObject({
      status: "completed",
      before: { sourceCount: 3, targetCount: 0 },
      after: { sourceCount: 3, targetCount: 3 },
      reportHash: completed.reportHash,
      finishedAt: expect.any(Date),
    });
    await expect(prisma.adminCase.count({ where: { targetId: userId } })).resolves.toBe(3);
    await expect(prisma.caseEvidence.count({ where: { sourceType: "support_request", sourceId: { in: supportIds } } })).resolves.toBe(3);

    const replay = await runProductionBackfillBatch(prisma, {
      domain: "customer_case_v1",
      mode: "apply",
      batchSize: 100,
      actor: { id: operatorId, role: "admin" },
    });
    expect(replay).toMatchObject({ status: "completed", summary: { scanned: 3, mismatch: 0 } });
    await expect(prisma.adminCase.count({ where: { targetId: userId } })).resolves.toBe(3);
    await expect(prisma.caseEvidence.count({ where: { sourceType: "support_request", sourceId: { in: supportIds } } })).resolves.toBe(3);
  });

  it("reports unavailable Incident evidence and makes the CLI exit non-zero", async () => {
    const initialCursor = `zz-backfill-attempt-0-${suffix}`;
    const result = await runProductionBackfillBatch(prisma, {
      domain: "generation_incident_v1",
      mode: "dry_run",
      batchSize: 10,
      initialCursor,
      stopAtId: attemptIds.incomplete,
      actor: { id: operatorId, role: "admin" },
    });
    expect(result).toMatchObject({
      status: "completed",
      summary: { scanned: 3, eligible: 2, applied: 0, unavailable: 1, mismatch: 1 },
      report: { coverage: { sourceCount: 3, scanned: 3, ratio: 1 } },
      reportHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.report).toMatchObject({ mismatches: [
      expect.objectContaining({ entityId: attemptIds.incomplete, code: "insufficient_stable_signature" }),
    ] });
    await expect(prisma.opsIncidentOccurrence.count({ where: { attemptId: { in: Object.values(attemptIds) } } })).resolves.toBe(0);

    let output = "";
    const cli = await runProductionBackfillCli(
      ["--run-id", result.runId],
      { db: prisma, write: (text) => { output += text; } },
    );
    expect(cli.exitCode).toBe(2);
    expect(output).toContain('"exitCode": 2');
  });

  it("continues after a crash between Incident apply and Item receipt without duplicate effects", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "inject_backfill_item_crash"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityId" = '${attemptIds.crash}' THEN
          RAISE EXCEPTION 'injected backfill item crash';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "backfill_item_crash"
      BEFORE INSERT ON "admin_backfill_items"
      FOR EACH ROW EXECUTE FUNCTION "inject_backfill_item_crash"()
    `);

    await expect(runProductionBackfillBatch(prisma, {
      domain: "generation_incident_v1",
      mode: "apply",
      batchSize: 1,
      initialCursor: attemptIds.stable,
      stopAtId: attemptIds.crash,
      actor: { id: operatorId, role: "admin" },
    })).rejects.toThrow("injected backfill item crash");
    const run = await prisma.adminBackfillRun.findFirstOrThrow({
      where: { domain: "generation_incident_v1", mode: "apply", stopAtId: attemptIds.crash },
      orderBy: { startedAt: "desc" },
    });
    await expect(prisma.opsIncidentOccurrence.count({ where: { attemptId: attemptIds.crash } })).resolves.toBe(1);
    await expect(prisma.adminBackfillItem.count({ where: { runId: run.id } })).resolves.toBe(0);
    expect(run).toMatchObject({ status: "running", cursor: attemptIds.stable });

    await prisma.$executeRawUnsafe(`DROP TRIGGER "backfill_item_crash" ON "admin_backfill_items"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION "inject_backfill_item_crash"()`);
    const resumed = await runProductionBackfillBatch(prisma, { runId: run.id });
    expect(resumed).toMatchObject({ status: "completed", summary: { scanned: 1, applied: 1, mismatch: 0 } });
    await expect(prisma.opsIncidentOccurrence.count({ where: { attemptId: attemptIds.crash } })).resolves.toBe(1);
    const occurrence = await prisma.opsIncidentOccurrence.findUniqueOrThrow({
      where: { occurrenceKey: `generation-attempt:${attemptIds.crash}` },
    });
    await expect(prisma.adminAuditLog.count({
      where: { targetId: occurrence.incidentId, action: "incident.occurrence.correlated" },
    })).resolves.toBe(1);
    await expect(prisma.adminBackfillItem.count({ where: { runId: run.id, applied: true } })).resolves.toBe(1);
  });

  it("continuously resumes the two-source Review Case cursor and reruns idempotently", async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const args = [
      "--domain", "review_case_v1",
      "--apply",
      "--continuous",
      "--batch-size", "1",
      "--cursor", encode({ contentReportId: `zz-backfill-report-0-${suffix}`, appealId: `zz-backfill-appeal-0-${suffix}` }),
      "--stop-at", encode({ contentReportId: reportIds.terminal, appealId }),
      "--actor-id", operatorId,
    ];
    const first = await runProductionBackfillCli(args, { db: prisma, write: () => undefined });
    expect(first).toMatchObject({ exitCode: 0, result: { status: "completed", summary: { scanned: 3, applied: 3, mismatch: 0 } } });
    const evidence = await prisma.caseEvidence.findMany({
      where: { OR: [
        { sourceType: "content_report", sourceId: { in: Object.values(reportIds) } },
        { sourceType: "appeal", sourceId: appealId },
      ] },
    });
    expect(evidence).toHaveLength(3);
    const reviewCases = await prisma.adminCase.findMany({ where: { id: { in: evidence.map((row) => row.caseId) } } });
    expect(reviewCases.filter((row) => row.status === "closed" && row.verificationState === "overridden")).toHaveLength(2);
    expect(reviewCases.filter((row) => row.status === "new")).toHaveLength(1);

    const replay = await runProductionBackfillCli(args, { db: prisma, write: () => undefined });
    expect(replay.exitCode).toBe(0);
    await expect(prisma.caseEvidence.count({
      where: { OR: [
        { sourceType: "content_report", sourceId: { in: Object.values(reportIds) } },
        { sourceType: "appeal", sourceId: appealId },
      ] },
    })).resolves.toBe(3);
  });
});
