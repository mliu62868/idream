import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { POST as publishRelease } from "@/app/api/v2/admin/characters/[id]/releases/[releaseId]/commands/publish/route";
import { POST as retryFailed } from "@/app/api/v2/admin/creative/runs/[id]/commands/retry-failed/route";
import { POST as resolveIncident } from "@/app/api/v2/admin/incidents/[id]/commands/resolve/route";
import { POST as closeCase } from "@/app/api/v2/admin/cases/[id]/commands/close/route";
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/release-executor";

describe("Admin API v2 authoritative command routes", () => {
  const suffix = randomUUID();
  const adminId = `command-admin-${suffix}`;
  const analystId = `command-analyst-${suffix}`;
  const supportId = `command-support-${suffix}`;
  const characterId = `character-${suffix}`;
  const projectId = `project-${suffix}`;
  const releaseId = `release-${suffix}`;
  const runId = `run-${suffix}`;
  const failedItemId = `item-${suffix}`;
  const failedJobId = `job-${suffix}`;
  const creativeProfileId = `creative-profile-${suffix}`;
  const incidentId = `incident-${suffix}`;
  const caseId = `case-${suffix}`;

  function request(
    path: string,
    body: { entityVersion: number; approvalId?: string },
    options: { actorId?: string; role?: string; key?: string; confirmation: string } = {
      confirmation: "",
    },
  ) {
    return new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": options.actorId ?? adminId,
        "x-idream-role": options.role ?? "admin",
        "x-request-id": randomUUID(),
        "idempotency-key": options.key ?? randomUUID(),
        "if-match": `"${body.entityVersion}"`,
      },
      body: JSON.stringify({
        ...body,
        reason: { code: "operator_verified", summary: "Verified command preconditions" },
        confirmation: options.confirmation,
      }),
    });
  }

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
        { id: analystId, email: `${analystId}@example.test`, role: "analyst", status: "active" },
        { id: supportId, email: `${supportId}@example.test`, role: "support", status: "active" },
      ],
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "launch_ready",
        audience: { segment: "test" },
        successCriteria: ["healthy release"],
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `revision-${suffix}`,
        characterContentVersionId: `content-version-${suffix}`,
        visualProfileId: `visual-profile-${suffix}`,
        visualProfileVersion: 1,
        referenceSetRevisionId: `reference-set-${suffix}`,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `snapshot-${suffix}`,
        status: "approved",
        version: 3,
      },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: creativeProfileId,
        profileKey: creativeProfileId,
        label: "Command test creative profile",
        mode: "image",
        runner: "pipeline",
        pipelineModel: "mock-image",
        runnerConfig: { verificationStatus: "passed" },
        allowedOrientations: ["portrait"],
        enabled: true,
        status: "active",
        version: 1,
      },
    });
    await prisma.generationJob.create({
      data: {
        id: failedJobId,
        userId: adminId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        profileId: creativeProfileId,
        profileVersion: 1,
        sourceType: "content_production_item",
        sourceId: failedItemId,
      },
    });
    await prisma.generationAttempt.create({
      data: {
        requestId: failedJobId,
        attemptNo: 1,
        status: "failed",
        retryability: "retryable",
        finishedAt: new Date(),
      },
    });
    await prisma.releaseValidationRun.create({
      data: {
        releaseId,
        snapshotHash: `snapshot-${suffix}`,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        result: "passed",
        finishedAt: new Date(),
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: runId,
        title: "Failed creative run",
        purpose: "character_cover",
        presetIds: [],
        count: 1,
        totalItems: 1,
        failedItems: 1,
        status: "completed",
        version: 2,
        createdById: adminId,
        profileId: creativeProfileId,
        profileVersion: 1,
        items: { create: { id: failedItemId, jobId: failedJobId, itemIndex: 0, status: "failed", tags: [] } },
      },
    });
    await prisma.opsIncident.create({
      data: {
        id: incidentId,
        signature: `provider:timeout:${suffix}`,
        signatureVersion: "v1",
        status: "monitoring",
        severity: "high",
        firstSeen: new Date("2026-07-11T10:00:00.000Z"),
        lastSeen: new Date("2026-07-11T10:05:00.000Z"),
        impact: {},
        mitigation: {},
        verificationState: "passed",
        version: 4,
      },
    });
    await prisma.adminCase.create({
      data: {
        id: caseId,
        type: "support_request",
        targetType: "customer",
        targetId: `customer-${suffix}`,
        caseKey: `support:${suffix}`,
        status: "resolved",
        resolution: { summary: "Customer issue resolved" },
        verificationState: "passed",
        version: 5,
      },
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [releaseId, runId, incidentId, caseId] } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: { in: [adminId, analystId, supportId] } } });
    const commandIds = (
      await prisma.controlPlaneCommand.findMany({
        where: { actorId: { in: [adminId, analystId, supportId] } },
        select: { id: true },
      })
    ).map((row) => row.id);
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commandIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: commandIds } } });
    await prisma.adminActionRequest.deleteMany({ where: { requestedById: adminId } });
    await prisma.adminCase.delete({ where: { id: caseId } });
    await prisma.opsIncident.delete({ where: { id: incidentId } });
    await prisma.contentProductionItem.deleteMany({ where: { batchId: runId } });
    await prisma.contentProductionBatch.delete({ where: { id: runId } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: failedJobId } });
    await prisma.generationJob.delete({ where: { id: failedJobId } });
    await prisma.generationModelProfile.delete({ where: { id: creativeProfileId } });
    await prisma.releaseValidationRun.deleteMany({ where: { releaseId } });
    await prisma.characterRelease.delete({ where: { id: releaseId } });
    await prisma.characterProject.delete({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, analystId, supportId] } } });
    await prisma.$disconnect();
  });

  it("accepts all four commands through their public Route Handler seams", async () => {
    const responses = await Promise.all([
      publishRelease(
        request("/api/v2/admin/characters/x/releases/x/commands/publish", { entityVersion: 3 }, { confirmation: `${characterId}:${releaseId}:publish` }),
        { params: Promise.resolve({ id: characterId, releaseId }) },
      ),
      retryFailed(
        request("/api/v2/admin/creative/runs/x/commands/retry-failed", { entityVersion: 2 }, { confirmation: `${runId}:retry-failed` }),
        { params: Promise.resolve({ id: runId }) },
      ),
      resolveIncident(
        request("/api/v2/admin/incidents/x/commands/resolve", { entityVersion: 4 }, { confirmation: `${incidentId}:resolve` }),
        { params: Promise.resolve({ id: incidentId }) },
      ),
      closeCase(
        request("/api/v2/admin/cases/x/commands/close", { entityVersion: 5 }, { confirmation: `${caseId}:close` }),
        { params: Promise.resolve({ id: caseId }) },
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.map((body) => body.data.status)).toEqual(["accepted", "accepted", "accepted", "accepted"]);
    expect(
      await prisma.controlPlaneCommand.findMany({
        where: { actorId: adminId },
        select: { commandType: true },
        orderBy: { commandType: "asc" },
      }),
    ).toEqual([
      { commandType: "case.close" },
      { commandType: "character.release.publish" },
      { commandType: "creative.run.retry_failed" },
      { commandType: "incident.resolve" },
    ]);
    expect(await prisma.adminAuditLog.count({ where: { actorId: adminId } })).toBe(6);
    const executedStatuses =
      await prisma.controlPlaneCommand.findMany({
        where: { actorId: adminId, commandType: { in: ["incident.resolve", "case.close"] } },
        select: { status: true },
      });
    expect(executedStatuses).toHaveLength(2);
    expect(executedStatuses.every((row) => row.status === "succeeded")).toBe(true);

    // Later cases exercise acceptance-time conflicts independently.
    await prisma.opsIncident.update({
      where: { id: incidentId },
      data: { status: "monitoring", verificationState: "passed", version: 4 },
    });
    await prisma.adminCase.update({
      where: { id: caseId },
      data: { status: "resolved", verificationState: "passed", version: 5 },
    });
  });

  it("replays the same idempotency key and rejects a changed canonical request", async () => {
    const key = randomUUID();
    const first = await retryFailed(
      request("/api/v2/admin/creative/runs/x/commands/retry-failed", { entityVersion: 2 }, { key, confirmation: `${runId}:retry-failed` }),
      { params: Promise.resolve({ id: runId }) },
    );
    const replay = await retryFailed(
      request("/api/v2/admin/creative/runs/x/commands/retry-failed", { entityVersion: 2 }, { key, confirmation: `${runId}:retry-failed` }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect((await replay.json()).data.commandId).toBe((await first.json()).data.commandId);

    const conflict = await resolveIncident(
      request("/api/v2/admin/incidents/x/commands/resolve", { entityVersion: 4 }, { key, confirmation: `${incidentId}:resolve` }),
      { params: Promise.resolve({ id: incidentId }) },
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("idempotency_conflict");
  });

  it("rejects missing permission, stale versions, and unmet domain invariants", async () => {
    const denied = await publishRelease(
      request("/api/v2/admin/characters/x/releases/x/commands/publish", { entityVersion: 3 }, { actorId: analystId, role: "analyst", confirmation: `${characterId}:${releaseId}:publish` }),
      { params: Promise.resolve({ id: characterId, releaseId }) },
    );
    expect(denied.status).toBe(403);

    const stale = await resolveIncident(
      request("/api/v2/admin/incidents/x/commands/resolve", { entityVersion: 99 }, { confirmation: `${incidentId}:resolve` }),
      { params: Promise.resolve({ id: incidentId }) },
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("conflict");

    await prisma.opsIncident.update({ where: { id: incidentId }, data: { verificationState: "failed" } });
    const blocked = await resolveIncident(
      request("/api/v2/admin/incidents/x/commands/resolve", { entityVersion: 4 }, { confirmation: `${incidentId}:resolve` }),
      { params: Promise.resolve({ id: incidentId }) },
    );
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).error.code).toBe("invariant_failed");
    await prisma.opsIncident.update({ where: { id: incidentId }, data: { verificationState: "passed" } });
  });

  it("validates target existence and the required idempotency header", async () => {
    const missingTarget = await closeCase(
      request("/api/v2/admin/cases/missing/commands/close", { entityVersion: 1 }, { confirmation: "missing:close" }),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(missingTarget.status).toBe(404);

    const missingIdempotency = new Request("http://localhost/api/v2/admin/incidents/x/commands/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": adminId,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify({
        entityVersion: 4,
        reason: { code: "operator_verified", summary: "Verified command preconditions" },
        confirmation: `${incidentId}:resolve`,
      }),
    });
    const invalid = await resolveIncident(missingIdempotency, {
      params: Promise.resolve({ id: incidentId }),
    });
    expect(invalid.status).toBe(400);
  });

  it("rejects an approval bound to a different version", async () => {
    const approval = await prisma.adminActionRequest.create({
      data: {
        requestedById: adminId,
        approvedById: `independent-approver-${suffix}`,
        permissionKey: "ops.incident.manage",
        action: "incident.resolve",
        targetType: "ops_incident",
        targetId: incidentId,
        status: "approved",
        payload: {
          commandType: "incident.resolve",
          targetType: "ops_incident",
          targetId: incidentId,
          payloadHash: "wrong-payload-hash",
          expectedVersion: 3,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    const response = await resolveIncident(
      request("/api/v2/admin/incidents/x/commands/resolve", { entityVersion: 4, approvalId: approval.id }, { confirmation: `${incidentId}:resolve` }),
      { params: Promise.resolve({ id: incidentId }) },
    );
    expect(response.status).toBe(403);
  });

  it("enforces effective permission subtype scope on case decisions", async () => {
    await prisma.adminCase.update({ where: { id: caseId }, data: { type: "content_report" } });
    const response = await closeCase(
      request(
        "/api/v2/admin/cases/x/commands/close",
        { entityVersion: 5 },
        {
          actorId: supportId,
          role: "support",
          confirmation: `${caseId}:close`,
        },
      ),
      { params: Promise.resolve({ id: caseId }) },
    );
    expect(response.status).toBe(403);
    await prisma.adminCase.update({ where: { id: caseId }, data: { type: "support_request" } });
  });
});
