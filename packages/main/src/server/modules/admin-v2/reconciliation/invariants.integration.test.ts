import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderPrometheusMetrics, resetMetricsForTests } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { auditAdminCutoverInvariants } from "./invariants";
import { deriveCreativeRunContinuation } from "../creative/run-state";
import { refreshContentProductionBatchStats } from "@/server/modules/content-production-state";
import { verifyCreativeRetryCommands } from "../creative/retry-executor";

describe("Admin cutover invariant report", () => {
  const suffix = randomUUID();
  const characterId = `invariant-character-${suffix}`;
  const reportId = `invariant-report-${suffix}`;
  const userId = `invariant-user-${suffix}`;
  const jobId = `invariant-job-${suffix}`;
  const attemptId = `invariant-attempt-${suffix}`;
  const supportRequestId = `invariant-support-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
    await prisma.generationJob.create({
      data: { id: jobId, userId, mode: "image", controls: {}, presetIds: [] },
    });
    await prisma.generationAttempt.create({
      data: {
        id: attemptId,
        requestId: jobId,
        attemptNo: 1,
        status: "failed",
        errorCode: "fixture_failure",
        finishedAt: new Date("2026-07-11T11:00:00.000Z"),
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Unserved official fixture",
        age: 25,
        description: "Intentionally violates the serving invariant",
        visibility: "public",
        status: "approved",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.contentReport.create({
      data: {
        id: reportId,
        targetType: "character",
        targetId: characterId,
        category: "fixture",
        status: "open",
      },
    });
    await prisma.supportRequest.create({
      data: {
        id: supportRequestId,
        ticketId: `INV-${suffix}`,
        userId,
        category: "account",
        subject: "Missing typed Case fixture",
        description: "Intentionally violates the open Support Request Case invariant",
        status: "open",
      },
    });
  });

  afterAll(async () => {
    await prisma.contentReport.deleteMany({ where: { id: reportId } });
    await prisma.supportRequest.deleteMany({ where: { id: supportRequestId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("reports concrete violations, including real-time missing terminal event counts", async () => {
    resetMetricsForTests();
    const report = await auditAdminCutoverInvariants(prisma, new Date("2026-07-11T12:00:00.000Z"));
    expect(report).toMatchObject({ qualityState: "invalid", decisionUse: "blocked" });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "official_public_character_without_current_serving_release",
        status: "failed",
        sampleIds: expect.arrayContaining([characterId]),
      }),
      expect.objectContaining({
        key: "open_source_without_case",
        status: "failed",
        sampleIds: expect.arrayContaining([`report:${reportId}`, `support_request:${supportRequestId}`]),
      }),
      expect.objectContaining({
        key: "terminal_attempt_without_unique_terminal_event",
        status: "failed",
        sampleIds: expect.arrayContaining([attemptId]),
      }),
    ]));
    const metrics = renderPrometheusMetrics();
    expect(metrics).toContain(
      `admin_state_invariant_violation_total{invariant="all"} ${report.totalViolations}`,
    );
    const terminalAttemptViolations = report.checks.find(
      (check) => check.key === "terminal_attempt_without_unique_terminal_event",
    )?.violationCount;
    expect(metrics).toContain(
      `admin_state_invariant_violation_total{invariant="terminal_attempt_without_unique_terminal_event"} ${terminalAttemptViolations}`,
    );
    resetMetricsForTests();
  });

  describe("Creative Run projection invariants", () => {
    const runIds: string[] = [];

    afterEach(async () => {
      await prisma.contentProductionBatch.deleteMany({ where: { id: { in: runIds.splice(0) } } });
    });

    async function runFixture(
      purpose: string,
      itemStatuses: string[],
      overrides: {
        status?: string; lifecycleState?: string; workflowStage?: string; verificationState?: string;
        totalItems?: number; completedItems?: number; failedItems?: number; approvedItems?: number;
      } = {},
    ) {
      const continuation = deriveCreativeRunContinuation(itemStatuses, {
        requiresVerifiedPlacement: purpose === "campaign",
        requiresReview: purpose === "model_eval",
      });
      const run = await prisma.contentProductionBatch.create({ data: {
        id: `invariant-run-${randomUUID()}`,
        title: "Projection contract fixture", purpose, presetIds: [], createdById: userId,
        ...continuation,
        totalItems: itemStatuses.length,
        completedItems: itemStatuses.filter((status) => ["generated", "approved", "published"].includes(status)).length,
        failedItems: itemStatuses.filter((status) => status === "failed").length,
        approvedItems: itemStatuses.filter((status) => ["approved", "published"].includes(status)).length,
        ...overrides,
        items: { create: itemStatuses.map((status, itemIndex) => ({ status, itemIndex, tags: [] })) },
      } });
      runIds.push(run.id);
      return run;
    }

    async function projectionCheck() {
      const report = await auditAdminCutoverInvariants(prisma);
      const check = report.checks.find((entry) => entry.key === "creative_run_child_projection_mismatch");
      if (!check) throw new Error("Creative Run projection check missing");
      return check;
    }

    it.each(["character_cover", "character_hero", "character_chat"])("accepts generated %s closed by the canonical generation rule", async (purpose) => {
      const run = await runFixture(purpose, ["generated"]);
      expect(run).toMatchObject({ status: "completed", lifecycleState: "closed", workflowStage: "generation" });
      expect(await projectionCheck()).toMatchObject({ status: "passed", violationCount: 0 });
    });

    it("accepts an ordinary completed run with a generated item and a failed sibling", async () => {
      await runFixture("character_cover", ["generated", "failed"]);
      expect(await projectionCheck()).toMatchObject({ status: "passed", violationCount: 0 });
    });

    it.each(["totalItems", "completedItems", "failedItems", "approvedItems"] as const)("still detects a wrong %s counter in a completed ordinary run", async (counter) => {
      const run = await runFixture("character_cover", ["generated"], { [counter]: counter === "completedItems" ? 0 : 2 });
      expect(await projectionCheck()).toMatchObject({ status: "failed", sampleIds: expect.arrayContaining([run.id]) });
    });

    it("detects an ordinary generated run incorrectly left reviewing", async () => {
      const run = await runFixture("character_hero", ["generated"], { status: "reviewing" });
      expect(await projectionCheck()).toMatchObject({ status: "failed", sampleIds: expect.arrayContaining([run.id]) });
    });

    it("does not accept a closed run with generation still queued", async () => {
      const run = await runFixture("character_chat", ["queued"], { status: "queued", lifecycleState: "closed" });
      expect(await projectionCheck()).toMatchObject({ status: "failed", sampleIds: expect.arrayContaining([run.id]) });
    });

    it("keeps model evaluation active until samples have actual review decisions", async () => {
      const pending = await runFixture("model_eval", ["generated"]);
      expect(pending).toMatchObject({ status: "reviewing", lifecycleState: "active", workflowStage: "review" });
      expect(await projectionCheck()).toMatchObject({ status: "passed", violationCount: 0 });
      await prisma.contentProductionBatch.update({ where: { id: pending.id }, data: { status: "completed", lifecycleState: "closed" } });
      expect(await projectionCheck()).toMatchObject({ status: "failed", sampleIds: expect.arrayContaining([pending.id]) });
    });

    it("accepts a model evaluation completed after review", async () => {
      await runFixture("model_eval", ["approved", "rejected"]);
      expect(await projectionCheck()).toMatchObject({ status: "passed", violationCount: 0 });
    });

    it.each(["generated", "approved"])("does not call a campaign complete while its item is only %s", async (status) => {
      const pending = await runFixture("campaign", [status]);
      expect(pending).toMatchObject({ status: "reviewing", lifecycleState: "active", workflowStage: "placement" });
      expect(await projectionCheck()).toMatchObject({ status: "passed", violationCount: 0 });
      await prisma.contentProductionBatch.update({ where: { id: pending.id }, data: { status: "completed", lifecycleState: "closed" } });
      expect(await projectionCheck()).toMatchObject({ status: "failed", sampleIds: expect.arrayContaining([pending.id]) });
    });

    it("accepts a campaign closed after publication verification", async () => {
      const published = await runFixture("campaign", ["published"]);
      expect(published).toMatchObject({ status: "completed", lifecycleState: "closed", workflowStage: "verification", verificationState: "passed" });
      expect(await projectionCheck()).toMatchObject({ status: "passed", violationCount: 0 });
    });

    it("preserves the zero-success failure invariant", async () => {
      const failed = await runFixture("character_cover", ["failed"], { status: "failed" });
      expect(await projectionCheck()).toMatchObject({ status: "passed", violationCount: 0 });
      await prisma.contentProductionBatch.update({ where: { id: failed.id }, data: { status: "completed" } });
      const report = await auditAdminCutoverInvariants(prisma);
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "creative_succeeded_without_successful_item", status: "failed", sampleIds: expect.arrayContaining([failed.id]) }),
        expect.objectContaining({ key: "creative_run_child_projection_mismatch", status: "failed", sampleIds: expect.arrayContaining([failed.id]) }),
      ]));
    });

    it.each(["character_cover", "character_hero", "character_chat", "campaign"])("projects an all-failed %s through the actual writer without claiming success", async (purpose) => {
      const run = await runFixture(purpose, ["failed"], { status: "queued", lifecycleState: "active" });
      await prisma.$transaction((tx) => refreshContentProductionBatchStats(tx, run.id));
      expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "failed", lifecycleState: "closed", completedItems: 0, failedItems: 1,
      });
      expect(await projectionCheck()).toMatchObject({ status: "passed", violationCount: 0 });
    });

    it.each(["character_cover", "character_hero", "character_chat", "character_video", "identity_calibration"])("projects generated %s through the actual writer without leaving an obsolete review", async (purpose) => {
      const run = await runFixture(purpose, ["generated"], { status: "queued", lifecycleState: "active" });
      await prisma.$transaction((tx) => refreshContentProductionBatchStats(tx, run.id));
      expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "completed", lifecycleState: "closed", workflowStage: "generation", verificationState: "pending", completedItems: 1,
      });
      expect(await projectionCheck()).toMatchObject({ status: "passed", violationCount: 0 });
    });

    it.each(["character_cover", "model_eval", "campaign"])("does not mark an all-rejected %s as a successful completion", async (purpose) => {
      const run = await runFixture(purpose, ["rejected"]);
      expect(run).toMatchObject({ status: "failed", lifecycleState: "closed", completedItems: 0 });
      expect(await projectionCheck()).toMatchObject({ status: "passed", violationCount: 0 });
    });

    it("does not overwrite an all-failed run with success when retry verification fails", async () => {
      const run = await runFixture("character_cover", ["failed"], { status: "failed", verificationState: "verifying" });
      const item = await prisma.contentProductionItem.findFirstOrThrow({ where: { batchId: run.id } });
      const commandId = `invariant-retry-${randomUUID()}`;
      const retryAttemptId = `invariant-retry-attempt-${randomUUID()}`;
      try {
        await prisma.controlPlaneCommand.create({ data: {
          id: commandId, scope: "invariant-fixture", idempotencyKey: commandId,
          commandType: "creative.run.retry_failed", targetType: "creative_run", targetId: run.id,
          actorId: userId, requestId: commandId, requestHash: commandId, status: "verifying", attemptCount: 1,
        } });
        await prisma.controlPlaneCommandAttempt.create({ data: { commandId, attemptNo: 1, status: "running" } });
        await prisma.generationAttempt.create({ data: {
          id: retryAttemptId, requestId: jobId, attemptNo: 2, status: "failed", finishedAt: new Date(),
          sourceCommandId: commandId, creativeRunItemId: item.id,
        } });
        expect(await verifyCreativeRetryCommands(prisma)).toMatchObject({ examined: 1, failed: 1, passed: 0 });
        expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
          status: "failed", lifecycleState: "closed", verificationState: "failed", completedItems: 0,
        });
        expect(await projectionCheck()).toMatchObject({ status: "passed", violationCount: 0 });
      } finally {
        await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: run.id } });
        await prisma.adminAuditLog.deleteMany({ where: { targetId: run.id } });
        await prisma.generationAttempt.deleteMany({ where: { id: retryAttemptId } });
        await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId } });
        await prisma.controlPlaneCommand.deleteMany({ where: { id: commandId } });
      }
    });
  });
});
