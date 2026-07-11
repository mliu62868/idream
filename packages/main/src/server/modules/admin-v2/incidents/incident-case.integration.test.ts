import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  backfillGenerationIncidents,
  correlateFailedGenerationAttempt,
  executeIncidentActionPlan,
  previewIncidentActionPlan,
} from "./service";
import { verifyIncidentRecovery } from "./workflow";
import {
  assignReviewCase,
  ensureReviewCaseForReport,
  recordReviewCaseDecision,
  verifyReviewCase,
  backfillReviewCases,
} from "../cases/service";
import { POST as resolveIncident } from "@/app/api/v2/admin/incidents/[id]/commands/resolve/route";
import { POST as closeCase } from "@/app/api/v2/admin/cases/[id]/commands/close/route";
import { GET as getIncident } from "@/app/api/v2/admin/incidents/[id]/route";
import { GET as getCase } from "@/app/api/v2/admin/cases/[id]/route";

describe("Incident and P0 Review Case authority loops", () => {
  const suffix = randomUUID();
  const adminId = `incident-case-admin-${suffix}`;
  const supportId = `incident-case-support-${suffix}`;
  const userA = `incident-user-a-${suffix}`;
  const userB = `incident-user-b-${suffix}`;
  const requestA = `incident-job-a-${suffix}`;
  const requestB = `incident-job-b-${suffix}`;
  const attemptA = `incident-attempt-a-${suffix}`;
  const attemptB = `incident-attempt-b-${suffix}`;
  const incompleteAttempt = `incident-attempt-incomplete-${suffix}`;
  const boundaryAttemptA = `incident-attempt-boundary-a-${suffix}`;
  const boundaryAttemptB = `incident-attempt-boundary-b-${suffix}`;
  const targetId = `reported-target-${suffix}`;
  const reportA = `report-a-${suffix}`;
  const reportB = `report-b-${suffix}`;
  const terminalReport = `report-terminal-${suffix}`;
  const actor = { id: adminId, role: "admin" } as const;
  const createdIncidentIds: string[] = [];
  const createdCaseIds: string[] = [];

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
        { id: supportId, email: `${supportId}@example.test`, role: "support", status: "active" },
        { id: userA, email: `${userA}@example.test`, role: "user", status: "active" },
        { id: userB, email: `${userB}@example.test`, role: "user", status: "active" },
      ],
    });
    await prisma.generationJob.createMany({
      data: [
        { id: requestA, userId: userA, mode: "image", controls: {}, presetIds: [], status: "failed" },
        { id: requestB, userId: userB, mode: "image", controls: {}, presetIds: [], status: "failed" },
      ],
    });
    await prisma.dreamcoinLedger.create({
      data: {
        userId: userA,
        delta: -10,
        balanceAfter: 90,
        reason: "generation_spend",
        sourceId: requestA,
        idempotencyKey: `incident-spend-${suffix}`,
      },
    });
    await prisma.generationAttempt.createMany({
      data: [
        {
          id: attemptA,
          requestId: requestA,
          attemptNo: 1,
          provider: "comfyui",
          profileKey: "portrait-v3",
          workflowKey: "image-edit-v2",
          status: "failed",
          errorClass: "gateway_timeout",
          errorSignature: "provider_timeout",
          retryability: "operator_retry",
          finishedAt: new Date("2026-07-11T10:00:00.000Z"),
        },
        {
          id: attemptB,
          requestId: requestB,
          attemptNo: 1,
          provider: "comfyui",
          profileKey: "portrait-v3",
          workflowKey: "image-edit-v2",
          status: "failed",
          errorClass: "gateway_timeout",
          errorSignature: "provider_timeout",
          retryability: "operator_retry",
          finishedAt: new Date("2026-07-11T10:05:00.000Z"),
        },
        {
          id: incompleteAttempt,
          requestId: requestA,
          attemptNo: 2,
          provider: "comfyui",
          status: "failed",
          errorClass: "gateway_timeout",
          errorSignature: "provider_timeout",
        },
        {
          id: boundaryAttemptA,
          requestId: requestA,
          attemptNo: 3,
          provider: "comfyui",
          profileKey: "portrait-v3",
          workflowKey: "image-edit-v2",
          status: "failed",
          errorClass: "boundary_timeout",
          errorSignature: `boundary-${suffix}`,
          retryability: "operator_retry",
          finishedAt: new Date("2026-07-11T10:00:00.999Z"),
        },
        {
          id: boundaryAttemptB,
          requestId: requestB,
          attemptNo: 2,
          provider: "comfyui",
          profileKey: "portrait-v3",
          workflowKey: "image-edit-v2",
          status: "failed",
          errorClass: "boundary_timeout",
          errorSignature: `boundary-${suffix}`,
          retryability: "operator_retry",
          finishedAt: new Date("2026-07-11T10:00:01.001Z"),
        },
      ],
    });
    await prisma.contentReport.createMany({
      data: [
        {
          id: reportA,
          reporterId: userA,
          targetType: "media",
          targetId,
          category: "policy_violation",
          description: "First immutable report",
          priority: 2,
        },
        {
          id: reportB,
          reporterId: userB,
          targetType: "media",
          targetId,
          category: "policy_violation",
          description: "Second immutable report",
          priority: 3,
        },
        {
          id: terminalReport,
          reporterId: userA,
          targetType: "media",
          targetId,
          category: "legacy_terminal",
          description: "Terminal source must remain immutable evidence",
          status: "closed",
          priority: 3,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.controlPlaneCommandAttempt.deleteMany({
      where: { commandId: { in: (await prisma.controlPlaneCommand.findMany({ where: { actorId: adminId }, select: { id: true } })).map((row) => row.id) } },
    });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId: adminId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: [...createdIncidentIds, ...createdCaseIds] } },
    });
    await prisma.decisionRecord.deleteMany({ where: { ownerId: adminId } });
    const cases = await prisma.adminCase.findMany({ where: { targetId }, select: { id: true } });
    await prisma.caseEvidence.deleteMany({ where: { caseId: { in: cases.map((row) => row.id) } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: cases.map((row) => row.id) } } });
    const occurrences = await prisma.opsIncidentOccurrence.findMany({
      where: { attemptId: { in: [attemptA, attemptB, incompleteAttempt, boundaryAttemptA, boundaryAttemptB] } },
      select: { incidentId: true },
    });
    const incidentIds = [...new Set(occurrences.map((row) => row.incidentId))];
    await prisma.incidentActionPlan.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.opsIncidentOccurrence.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.opsIncident.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { in: [attemptA, attemptB, incompleteAttempt, boundaryAttemptA, boundaryAttemptB] } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: [requestA, requestB] } } });
    await prisma.contentReport.deleteMany({ where: { id: { in: [reportA, reportB, terminalReport] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, supportId, userA, userB] } } });
    await prisma.$disconnect();
  });

  it("correlates stable failures, freezes the occurrence set, executes mitigation, verifies, and resolves", async () => {
    const first = await correlateFailedGenerationAttempt(attemptA);
    createdIncidentIds.push(first.id);
    const second = await correlateFailedGenerationAttempt(attemptB);
    expect(second.id).toBe(first.id);
    expect(second.impact).toMatchObject({ affectedRequests: 2, affectedUsers: 2 });
    expect(await prisma.opsIncidentOccurrence.count({ where: { incidentId: first.id } })).toBe(2);

    const plan = await previewIncidentActionPlan({
      incidentId: first.id,
      action: "retry_eligible",
      actorId: adminId,
    });
    expect(plan.incidentVersion).toBe(2);
    expect(plan.eligibleIds).toHaveLength(2);
    const refundPlan = await previewIncidentActionPlan({
      incidentId: first.id,
      action: "refund",
      actorId: adminId,
    });
    expect(refundPlan.eligibleIds).toHaveLength(1);
    expect(refundPlan.skippedIds).toHaveLength(1);
    const executed = await executeIncidentActionPlan({
      incidentId: first.id,
      actionPlanId: plan.id,
      expectedVersion: 2,
      actor,
      confirmation: `${first.id}:${plan.id}:retry_eligible`,
      idempotencyKey: `execute-${suffix}`,
    });
    expect(executed.status).toBe("succeeded");
    expect(
      await prisma.mainOutboxEvent.count({
        where: { aggregateId: first.id, eventType: "incident.action.retry_eligible.requested.v2" },
      }),
    ).toBe(2);

    const verified = await verifyIncidentRecovery({
      incidentId: first.id,
      actor,
      expectedVersion: 3,
      state: "passed",
      evidenceRefs: ["metrics:success-rate-window", "queue:backlog-window"],
      checks: {
        successRateRecovered: true,
        signatureGrowthStopped: true,
        backlogRecovering: true,
        failedRequestPlanComplete: true,
        settlementReconciled: true,
      },
      requestId: `verify-${suffix}`,
    });
    expect(verified.status).toBe("monitoring");
    const response = await resolveIncident(
      commandRequest(`/api/v2/admin/incidents/${first.id}/commands/resolve`, {
        entityVersion: 4,
        confirmation: `${first.id}:resolve`,
        key: `resolve-${suffix}`,
      }),
      { params: Promise.resolve({ id: first.id }) },
    );
    expect(response.status).toBe(202);
    const commandId = (await response.json()).data.commandId as string;
    expect(await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: commandId } })).toMatchObject({
      status: "succeeded",
    });
    expect(await prisma.opsIncident.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      status: "resolved",
      version: 5,
      activeCorrelationKey: null,
    });
  });

  it("serializes cross-bucket correlation so concurrent failures cannot split one signature", async () => {
    const [left, right] = await Promise.all([
      correlateFailedGenerationAttempt(boundaryAttemptA, { joinGapMs: 1_000 }),
      correlateFailedGenerationAttempt(boundaryAttemptB, { joinGapMs: 1_000 }),
    ]);
    createdIncidentIds.push(left.id);
    expect(right.id).toBe(left.id);
    expect(await prisma.opsIncidentOccurrence.count({ where: { incidentId: left.id } })).toBe(2);
  });

  it("reports insufficient historical evidence instead of inventing an Incident", async () => {
    const report = await backfillGenerationIncidents({
      dryRun: true,
      cursor: attemptB,
      batchSize: 10,
    });
    expect(report.unavailable).toContainEqual({
      attemptId: incompleteAttempt,
      reason: "insufficient_stable_signature",
    });
  });

  it("backfills terminal Review sources as closed Evidence without reopening them", async () => {
    const report = await backfillReviewCases({ dryRun: false, batchSize: 500, actor });
    expect(report.mismatches).toEqual([]);
    const evidence = await prisma.caseEvidence.findFirstOrThrow({
      where: { sourceType: "content_report", sourceId: terminalReport },
    });
    expect(await prisma.adminCase.findUniqueOrThrow({ where: { id: evidence.caseId } })).toMatchObject({
      status: "closed",
      activeKey: null,
      verificationState: "overridden",
    });
  });

  it("aggregates reports into one typed Case and closes only after decision and verification", async () => {
    const sourceA = await prisma.contentReport.findUniqueOrThrow({ where: { id: reportA } });
    const sourceB = await prisma.contentReport.findUniqueOrThrow({ where: { id: reportB } });
    const first = await ensureReviewCaseForReport(prisma, sourceA);
    const second = await ensureReviewCaseForReport(prisma, sourceB);
    expect(second?.id).toBe(first?.id);
    const caseId = first?.id ?? "";
    createdCaseIds.push(caseId);
    const evidence = await prisma.caseEvidence.findMany({ where: { caseId }, orderBy: { sourceId: "asc" } });
    expect(evidence).toHaveLength(2);
    expect(first).toMatchObject({ priority: "high", status: "new", version: 1 });

    await expect(
      assignReviewCase({
        caseId,
        actor: { id: supportId, role: "support" },
        expectedVersion: 1,
        ownerId: supportId,
        reason: "Attempt out-of-scope assignment",
        requestId: `support-scope-${suffix}`,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      assignReviewCase({
        caseId,
        actor,
        expectedVersion: 1,
        ownerId: userA,
        reason: "Attempt invalid owner assignment",
        requestId: `invalid-owner-${suffix}`,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });

    const assigned = await assignReviewCase({
      caseId,
      actor,
      expectedVersion: 1,
      ownerId: adminId,
      reason: "Claim P0 review",
      requestId: `assign-${suffix}`,
    });
    expect(assigned).toMatchObject({ status: "triaged", ownerId: adminId, version: 2 });
    const decided = await prisma.$transaction((tx) =>
      recordReviewCaseDecision(tx, {
        caseId,
        actor,
        expectedVersion: 2,
        decision: "actioned",
        summary: "Applied the reviewed downstream action",
        evidenceRefs: [evidence[0]!.id, evidence[1]!.id],
        requestId: `decision-${suffix}`,
      }),
    );
    expect(decided).toMatchObject({ status: "in_progress", verificationState: "pending", version: 3 });
    const verified = await verifyReviewCase({
      caseId,
      actor,
      expectedVersion: 3,
      state: "passed",
      evidenceRefs: [evidence[0]!.id],
      requestId: `case-verify-${suffix}`,
    });
    expect(verified).toMatchObject({ status: "resolved", verificationState: "passed", version: 4 });

    const response = await closeCase(
      commandRequest(`/api/v2/admin/cases/${caseId}/commands/close`, {
        entityVersion: 4,
        confirmation: `${caseId}:close`,
        key: `close-${suffix}`,
      }),
      { params: Promise.resolve({ id: caseId }) },
    );
    expect(response.status).toBe(202);
    expect(await prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).toMatchObject({
      status: "closed",
      activeKey: null,
      version: 5,
    });
    expect(await prisma.decisionRecord.count({ where: { sourceType: "admin_case", sourceId: caseId } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { targetType: "admin_case", targetId: caseId } })).toBeGreaterThanOrEqual(4);
  });

  it("serves authority detail read models with Evidence, decisions, plans, and activity", async () => {
    const incidentId = createdIncidentIds[0]!;
    const caseId = createdCaseIds[0]!;
    const incidentResponse = await getIncident(authRequest(`/api/v2/admin/incidents/${incidentId}`), {
      params: Promise.resolve({ id: incidentId }),
    });
    const caseResponse = await getCase(authRequest(`/api/v2/admin/cases/${caseId}`), {
      params: Promise.resolve({ id: caseId }),
    });
    expect(incidentResponse.status).toBe(200);
    expect(caseResponse.status).toBe(200);
    const incidentBody = await incidentResponse.json();
    const caseBody = await caseResponse.json();
    expect(incidentBody.data.incident).toMatchObject({ id: incidentId, status: "resolved" });
    expect(incidentBody.data.occurrences).toHaveLength(2);
    expect(incidentBody.data.actionPlans).toHaveLength(2);
    expect(incidentBody.data.activity.length).toBeGreaterThanOrEqual(3);
    expect(caseBody.data.case).toMatchObject({ id: caseId, status: "closed", reportCount: 2 });
    expect(caseBody.data.evidence).toHaveLength(2);
    expect(caseBody.data.evidence.every((item: Record<string, unknown>) => !("snapshot" in item))).toBe(true);
    expect(caseBody.data.decisions).toHaveLength(1);
    expect(caseBody.data.activity.length).toBeGreaterThanOrEqual(4);

    const deniedIncident = await getIncident(
      new Request(`http://localhost/api/v2/admin/incidents/${incidentId}`, {
        headers: { "x-idream-user-id": supportId, "x-idream-role": "support" },
      }),
      { params: Promise.resolve({ id: incidentId }) },
    );
    const deniedCase = await getCase(
      new Request(`http://localhost/api/v2/admin/cases/${caseId}`, {
        headers: { "x-idream-user-id": supportId, "x-idream-role": "support" },
      }),
      { params: Promise.resolve({ id: caseId }) },
    );
    expect(deniedIncident.status).toBe(403);
    expect(deniedCase.status).toBe(403);
  });

  function authRequest(path: string) {
    return new Request(`http://localhost${path}`, {
      headers: { "x-idream-user-id": adminId, "x-idream-role": "admin" },
    });
  }

  function commandRequest(
    path: string,
    input: { entityVersion: number; confirmation: string; key: string },
  ) {
    return new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": adminId,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
        "idempotency-key": input.key,
        "if-match": `"${input.entityVersion}"`,
      },
      body: JSON.stringify({
        entityVersion: input.entityVersion,
        confirmation: input.confirmation,
        reason: { code: "verified", summary: "Verified authority transition" },
      }),
    });
  }
});
