import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import type { AiFinalizePayload } from "@/server/ai/schemas";
import { drainLocalAiPipeline } from "@/server/ai/local-pipeline";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import {
  api,
  createCharacter,
  createUser,
  dreamcoinBalance,
  expectError,
  expectOk,
  grantCoins,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";

const P = "zt-admin-";

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

async function setupActor(
  role: "admin" | "moderator" | "support" | "ops" | "analyst" | "user",
  suffix: string,
) {
  const id = `${P}${role}-${suffix}`;
  await createUser({ id, role });
  return id;
}

function asInputJson(value: AiFinalizePayload): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

async function writeSafetensorsMetadata(filePath: string, metadata: Record<string, string>) {
  const header = Buffer.from(JSON.stringify({ __metadata__: metadata }), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length), 0);
  await writeFile(filePath, Buffer.concat([length, header]));
}

describe("admin permission keys", () => {
  it("authorizes by permission key instead of coarse admin checks", async () => {
    const admin = await setupActor("admin", "matrix");
    const support = await setupActor("support", "matrix");
    const ops = await setupActor("ops", "matrix");
    const analyst = await setupActor("analyst", "matrix");
    const user = await setupActor("user", "matrix");

    expectOk(await api("GET", "admin/dashboard", { userId: analyst, role: "analyst" }));
    expectOk(await api("GET", "admin/users", { userId: support, role: "support" }));
    expectOk(await api("GET", "admin/generation/model-profiles", { userId: ops, role: "ops" }));
    expectOk(await api("GET", "admin/billing/ledger", { userId: support, role: "support" }));
    expectOk(await api("GET", "admin/audit-log", { userId: admin, role: "admin" }));

    expectError(await api("GET", "admin/users", { userId: analyst, role: "analyst" }), 403);
    expectError(await api("GET", "admin/generation/model-profiles", { userId: support, role: "support" }), 403);
    expectError(await api("GET", "admin/billing/ledger", { userId: ops, role: "ops" }), 403);
    expectError(await api("GET", "admin/dashboard", { userId: user, role: "user" }), 403);
  });
});

describe("admin support request inbox", () => {
  it("lets support staff triage durable help desk requests", async () => {
    const requester = `${P}support-inbox-user`;
    const support = await setupActor("support", "inbox");
    const analyst = await setupActor("analyst", "inbox");
    await createUser({ id: requester });

    const submitted = await api("POST", "support/requests", {
      userId: requester,
      ageGate: true,
      body: {
        category: "generation",
        subject: "Generation queue stuck",
        description: "The generation stayed queued after a browser refresh.",
        diagnosticConsent: true,
        sourcePath: "/helpdesk",
      },
    });
    expectOk(submitted, 201);

    const list = await api("GET", "admin/support/requests", {
      userId: support,
      role: "support",
      query: { status: "received" },
    });
    expectOk(list);
    expect(list.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ticketId: submitted.data.request.ticketId,
          userId: requester,
          userEmail: `${requester}@test.local`,
          category: "generation",
          status: "received",
        }),
      ]),
    );

    const patched = await api("PATCH", `admin/support/requests/${submitted.data.request.ticketId}`, {
      userId: support,
      role: "support",
      body: {
        assignedToId: support,
        priority: 2,
        status: "resolved",
        resolutionNotes: "Confirmed queue recovered and replied to the user.",
        reason: "Resolved support smoke request",
        confirmation: submitted.data.request.ticketId,
      },
    });
    expectOk(patched);
    expect(patched.data.request).toMatchObject({
      assignedToId: support,
      priority: 2,
      resolutionNotes: "Confirmed queue recovered and replied to the user.",
      status: "resolved",
      ticketId: submitted.data.request.ticketId,
    });
    expect(patched.data.request.resolvedAt).toEqual(expect.any(String));

    const defaultList = await api("GET", "admin/support/requests", {
      userId: support,
      role: "support",
    });
    expectOk(defaultList);
    expect(defaultList.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ticketId: submitted.data.request.ticketId,
          status: "resolved",
        }),
      ]),
    );

    const overdueTicketId = `${P}SUP-OVERDUE`;
    await prisma.supportRequest.create({
      data: {
        ticketId: overdueTicketId,
        userId: requester,
        category: "generation",
        subject: "Old generation ticket",
        description: "This ticket should breach the support SLA.",
        priority: 2,
        status: "open",
        createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
      },
    });
    const freshTicketId = `${P}SUP-FRESH`;
    await prisma.supportRequest.create({
      data: {
        ticketId: freshTicketId,
        userId: requester,
        category: "generation",
        subject: "Fresh generation ticket",
        description: "This ticket should remain inside the support SLA.",
        priority: 3,
        status: "open",
      },
    });
    const overdueList = await api("GET", "admin/support/requests", {
      userId: support,
      role: "support",
      query: { status: "active", sla: "overdue" },
    });
    expectOk(overdueList);
    expect(overdueList.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slaState: "overdue",
          ticketId: overdueTicketId,
        }),
      ]),
    );
    expect((overdueList.data.items as Array<{ ticketId: string }>).map((item) => item.ticketId)).not.toContain(
      freshTicketId,
    );

    const escalated = await api("POST", `admin/support/requests/${overdueTicketId}/escalate`, {
      userId: support,
      role: "support",
      body: {
        reason: "SLA breach needs support lead attention",
        confirmation: overdueTicketId,
      },
    });
    expectOk(escalated);
    expect(escalated.data.request).toMatchObject({
      assignedToId: support,
      priority: 1,
      slaEscalatedAt: expect.any(String),
      slaEscalatedById: support,
      slaEscalationReason: "SLA breach needs support lead attention",
      ticketId: overdueTicketId,
    });
    expectError(
      await api("POST", `admin/support/requests/${freshTicketId}/escalate`, {
        userId: support,
        role: "support",
        body: {
          reason: "Fresh ticket should not escalate",
          confirmation: freshTicketId,
        },
      }),
      400,
      "bad_request",
    );

    const audit = await prisma.adminAuditLog.findFirst({
      where: {
        actorId: support,
        action: "support.request.update",
        targetId: submitted.data.request.ticketId,
      },
    });
    expect(audit).not.toBeNull();
    const escalationAudit = await prisma.adminAuditLog.findFirst({
      where: {
        actorId: support,
        action: "support.request.escalate",
        targetId: overdueTicketId,
      },
    });
    expect(escalationAudit).not.toBeNull();

    expectError(
      await api("GET", "admin/support/requests", { userId: analyst, role: "analyst" }),
      403,
    );
  });
});

describe("admin appeal queue", () => {
  it("lets reviewers resolve appeals and restores supported overturned targets", async () => {
    const userId = `${P}appeal-user`;
    const charId = `${P}appeal-char`;
    const admin = await setupActor("admin", "appeal");
    const support = await setupActor("support", "appeal");
    await createUser({ id: userId });
    await createCharacter({ id: charId, creatorId: userId, visibility: "public", status: "removed" });
    const appeal = await prisma.appeal.create({
      data: {
        userId,
        targetType: "character",
        targetId: charId,
        appealText: "Please review the character decision again.",
      },
    });

    const queue = await api("GET", "admin/moderation/queue", {
      userId: admin,
      role: "admin",
    });
    expectOk(queue);
    expect(queue.data.appeals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: appeal.id, status: "open", targetId: charId }),
      ]),
    );

    expectError(
      await api("PATCH", `admin/moderation/appeals/${appeal.id}`, {
        userId: support,
        role: "support",
        body: {
          outcome: "overturned",
          reason: "Support cannot resolve appeals",
          confirmation: "OVERTURN",
        },
      }),
      403,
    );

    const resolved = await api("PATCH", `admin/moderation/appeals/${appeal.id}`, {
      userId: admin,
      role: "admin",
      body: {
        outcome: "overturned",
        notes: "The original decision is overturned.",
        reason: "Appeal accepted after reviewer check",
        confirmation: "OVERTURN",
      },
    });
    expectOk(resolved);
    expect(resolved.data.appeal).toMatchObject({
      id: appeal.id,
      status: "overturned",
      reviewerId: admin,
      targetId: charId,
    });
    expect(resolved.data.appeal.resolvedAt).toEqual(expect.any(String));
    expect(resolved.data.target).toMatchObject({ targetRestored: true });

    const character = await prisma.character.findUniqueOrThrow({ where: { id: charId } });
    expect(character.status).toBe("approved");

    const afterQueue = await api("GET", "admin/moderation/queue", {
      userId: admin,
      role: "admin",
    });
    expectOk(afterQueue);
    expect((afterQueue.data.appeals as Array<{ id: string }>).map((item) => item.id)).not.toContain(
      appeal.id,
    );

    const audit = await prisma.adminAuditLog.findFirst({
      where: { actorId: admin, action: "safety.appeal.decision", targetId: appeal.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.after).toMatchObject({
      status: "overturned",
      targetRestored: true,
    });
    const caseEvidence = await prisma.caseEvidence.findFirstOrThrow({
      where: { sourceType: "appeal", sourceId: appeal.id },
    });
    expect(await prisma.adminCase.findUniqueOrThrow({ where: { id: caseEvidence.caseId } })).toMatchObject({
      status: "resolved",
      verificationState: "passed",
    });
    expect(
      await prisma.decisionRecord.findFirst({
        where: { sourceType: "admin_case", sourceId: caseEvidence.caseId, decision: "overturned" },
      }),
    ).not.toBeNull();

    expectError(
      await api("PATCH", `admin/moderation/appeals/${appeal.id}`, {
        userId: admin,
        role: "admin",
        body: {
          outcome: "upheld",
          reason: "Duplicate terminal appeal decision",
          confirmation: "UPHOLD",
        },
      }),
      409,
    );
  });
});

describe("generation config control plane", () => {
  const previousModelDiagnostics = process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;

  beforeAll(() => {
    process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED = "true";
  });

  afterAll(() => {
    if (previousModelDiagnostics === undefined) delete process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;
    else process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED = previousModelDiagnostics;
  });

  it("returns active generation config and stamps profile/template versions onto jobs", async () => {
    const userId = `${P}gen-user`;
    const characterId = `${P}gen-char`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, visibility: "public", status: "approved" });
    await grantCoins(userId, 100, "seed");

    const config = await api("GET", "generation/config", { userId, ageGate: true });
    expectOk(config);
    expect(config.data.video.enabled).toBe(false);
    expect(config.data.image.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileId: "profile_image_default_v1",
          entitlement: null,
        }),
      ]),
    );
    expect(JSON.stringify(config.data.image.models)).not.toContain("profile_image_premium_v1");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId, outputCount: 1 },
    });
    expectOk(gen, 202);
    expect(gen.data.job).toMatchObject({
      status: "queued",
      profileId: "profile_image_default_v1",
      profileVersion: 1,
      recipeId: "template_image_character_default",
      recipeVersion: 1,
    });
    await runQueuedGenerationJobs(8);
  });

  it("keeps video visible but disabled by a single feature flag and creates no job", async () => {
    const userId = `${P}video-user`;
    const characterId = `${P}video-char`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, visibility: "public", status: "approved" });
    await grantCoins(userId, 500, "seed");
    await prisma.entitlement.create({
      data: { userId, key: "video_generation", value: true, source: "test" },
    });

    const beforeJobs = await prisma.generationJob.count({ where: { userId } });
    const beforeBalance = await dreamcoinBalance(userId);
    const video = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "video", characterId, outputCount: 1 },
    });
    expectError(video, 403, "forbidden");
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(beforeJobs);
    expect(await dreamcoinBalance(userId)).toBe(beforeBalance);
  });

  it("publishes and rolls back model profiles with audit records", async () => {
    const admin = await setupActor("admin", "profile");
    await prisma.generationModelProfile.create({
      data: {
        id: `${P}profile-v1`,
        profileKey: `${P}profile`,
        label: "Admin Test v1",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "mock-image",
        allowedOrientations: ["1:1"],
        version: 1,
        status: "active",
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });

    const draft = await api("POST", "admin/generation/model-profiles", {
      userId: admin,
      role: "admin",
      body: {
        profileKey: `${P}profile`,
        label: "Admin Test v2",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "mock-image-v2",
        allowedOrientations: ["1:1", "4:5"],
        dryRunSummary: { sampleCount: 20, successRate: 1, consistencyRate: 0.9 },
      },
    });
    expectOk(draft);
    expect(draft.data.profile).toMatchObject({ enabled: false, rolloutPercent: 0, status: "draft" });

    const publish = await api("POST", `admin/generation/model-profiles/${draft.data.profile.id}/publish`, {
      userId: admin,
      role: "admin",
      body: {
        reason: "verified dry run",
        confirmation: "PUBLISH",
      },
    });
    expectError(publish, 400, "bad_request");

    const exactPublish = await api("POST", `admin/generation/model-profiles/${draft.data.profile.id}/publish`, {
      userId: admin,
      role: "admin",
      body: {
        reason: "verified dry run",
        confirmation: draft.data.profile.id,
      },
    });
    expectOk(exactPublish);
    expect(exactPublish.data.profile).toMatchObject({ status: "active", enabled: true, rolloutPercent: 100, version: 2 });
    expect(await prisma.generationModelProfile.findUnique({ where: { id: `${P}profile-v1` } })).toMatchObject({
      status: "archived",
    });

    const rollback = await api("POST", `admin/generation/model-profiles/${exactPublish.data.profile.id}/rollback`, {
      userId: admin,
      role: "admin",
      body: { reason: "regression detected", confirmation: "ROLLBACK" },
    });
    expectError(rollback, 400, "bad_request");

    const exactRollback = await api("POST", `admin/generation/model-profiles/${exactPublish.data.profile.id}/rollback`, {
      userId: admin,
      role: "admin",
      body: { reason: "regression detected", confirmation: exactPublish.data.profile.id },
    });
    expectOk(exactRollback);
    expect(exactRollback.data).toMatchObject({ fromVersion: 2, toVersion: 1 });

    const audits = await prisma.adminAuditLog.findMany({
      where: { actorId: admin, targetType: "generation_model_profile" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((audit) => audit.action)).toEqual(
      expect.arrayContaining([
        "generation.profile.create",
        "generation.profile.publish",
        "generation.profile.rollback",
      ]),
    );
  });

  it("validates workflowKey against known workflow descriptors on create and patch", async () => {
    const admin = await setupActor("admin", "workflow-key");

    const unknownCreate = await api("POST", "admin/generation/model-profiles", {
      userId: admin,
      role: "admin",
      body: {
        profileKey: `${P}workflow-profile`,
        label: "Workflow Key Test",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "mock-image-workflow",
        allowedOrientations: ["1:1"],
        workflowKey: "does-not-exist-workflow",
      },
    });
    expectError(unknownCreate, 400, "bad_request");

    const draft = await api("POST", "admin/generation/model-profiles", {
      userId: admin,
      role: "admin",
      body: {
        profileKey: `${P}workflow-profile`,
        label: "Workflow Key Test",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "mock-image-workflow",
        allowedOrientations: ["1:1"],
        workflowKey: "redcraft-krea2-txt2img",
      },
    });
    expectOk(draft);
    expect(draft.data.profile.workflowKey).toBe("redcraft-krea2-txt2img");
    expect(
      await prisma.generationModelProfile.findUnique({ where: { id: draft.data.profile.id } }),
    ).toMatchObject({ workflowKey: "redcraft-krea2-txt2img" });

    const unknownPatch = await api(
      "PATCH",
      `admin/generation/model-profiles/${draft.data.profile.id}`,
      {
        userId: admin,
        role: "admin",
        body: { workflowKey: "still-does-not-exist" },
      },
    );
    expectError(unknownPatch, 400, "bad_request");

    const clearPatch = await api(
      "PATCH",
      `admin/generation/model-profiles/${draft.data.profile.id}`,
      { userId: admin, role: "admin", body: { workflowKey: null } },
    );
    expectOk(clearPatch);
    expect(clearPatch.data.profile.workflowKey).toBeNull();
    expect(
      await prisma.generationModelProfile.findUnique({ where: { id: draft.data.profile.id } }),
    ).toMatchObject({ workflowKey: null });

    const restorePatch = await api(
      "PATCH",
      `admin/generation/model-profiles/${draft.data.profile.id}`,
      {
        userId: admin,
        role: "admin",
        body: { workflowKey: "redcraft-krea2-txt2img" },
      },
    );
    expectOk(restorePatch);
    expect(restorePatch.data.profile.workflowKey).toBe("redcraft-krea2-txt2img");
  });

  it("routes a generation job through workflowKey when the selected profile has one", async () => {
    const userId = `${P}workflow-route-user`;
    const characterId = `${P}workflow-route-char`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "public",
      status: "approved",
    });
    await grantCoins(userId, 100, "seed");

    const profileKey = `${P}workflow-route-profile`;
    await prisma.generationModelProfile.create({
      data: {
        id: `${P}workflow-route-profile-v1`,
        profileKey,
        label: "Workflow Route Profile",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "mock-image-workflow-route",
        workflowKey: "redcraft-krea2-txt2img",
        allowedOrientations: ["1:1"],
        version: 1,
        status: "active",
        enabled: true,
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId, outputCount: 1, model: profileKey },
    });
    expectOk(gen, 202);
    expect(gen.data.job.profileId).toBe(profileKey);

    const stored = await prisma.generationJob.findUnique({ where: { id: gen.data.job.id } });
    expect(stored?.model).toBe("redcraft-krea2-txt2img");

    await runQueuedGenerationJobs(4);
  });

  it("rejects model profile publish when visual verification failed", async () => {
    const admin = await setupActor("admin", "profile-publish-gate");
    const draft = await prisma.generationModelProfile.create({
      data: {
        id: `${P}profile-bad-visual`,
        profileKey: `${P}profile-bad-visual`,
        label: "Bad visual candidate",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "bad-visual-candidate",
        allowedOrientations: ["1:1"],
        version: 1,
        status: "draft",
        runnerConfig: {
          apiModelId: "bad-visual-candidate",
          verificationStatus: "failed_local_probe_pure_white_output",
        },
        dryRunSummary: {
          sampleCount: 4,
          successRate: 0,
          failureMode: "pure_white_output",
        },
      },
    });

    const publish = await api("POST", `admin/generation/model-profiles/${draft.id}/publish`, {
      userId: admin,
      role: "admin",
      body: {
        reason: "publish bad candidate",
        confirmation: draft.id,
      },
    });

    expectError(publish, 400, "bad_request");
    expect(publish.error?.message).toMatch(/verification status|failureMode/);
    await expect(prisma.generationModelProfile.findUnique({ where: { id: draft.id } })).resolves.toMatchObject({
      status: "draft",
    });
  });

  it("rejects image model profile publish without 20-sample consistency review", async () => {
    const admin = await setupActor("admin", "profile-publish-consistency-gate");
    const draft = await prisma.generationModelProfile.create({
      data: {
        id: `${P}profile-small-sample`,
        profileKey: `${P}profile-small-sample`,
        label: "Small sample candidate",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "small-sample-candidate",
        allowedOrientations: ["1:1"],
        version: 1,
        status: "draft",
        runnerConfig: {
          apiModelId: "small-sample-candidate",
          verificationStatus: "manual_passed",
        },
        dryRunSummary: {
          sampleCount: 6,
          successRate: 1,
          consistencyRate: 1,
        },
      },
    });

    const smallSample = await api("POST", `admin/generation/model-profiles/${draft.id}/publish`, {
      userId: admin,
      role: "admin",
      body: {
        reason: "publish too early",
        confirmation: draft.id,
      },
    });
    expectError(smallSample, 400, "bad_request");
    expect(smallSample.error?.message).toContain("20 dry-run samples");

    await prisma.generationModelProfile.update({
      where: { id: draft.id },
      data: {
        dryRunSummary: {
          sampleCount: 20,
          successRate: 1,
        },
      },
    });
    const missingConsistency = await api("POST", `admin/generation/model-profiles/${draft.id}/publish`, {
      userId: admin,
      role: "admin",
      body: {
        reason: "publish without consistency",
        confirmation: draft.id,
      },
    });
    expectError(missingConsistency, 400, "bad_request");
    expect(missingConsistency.error?.message).toContain("consistencyRate");
  });

  it("rejects managed image model publish without an explicit passed verification status", async () => {
    const admin = await setupActor("admin", "profile-publish-missing-verification");
    const draft = await prisma.generationModelProfile.create({
      data: {
        id: `${P}profile-managed-no-verification`,
        profileKey: `${P}profile-managed-no-verification`,
        label: "Managed model without verification",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "redcraftkrea2redmix_krea2edition",
        sourceModelPath: "/models/checkpoints/redcraftKREA2RedMix_krea2Edition.safetensors",
        allowedOrientations: ["1:1"],
        version: 1,
        status: "draft",
        runnerConfig: {
          apiModelId: "redcraftkrea2redmix_krea2edition",
          diffusionModelPath: "/models/checkpoints/redcraftKREA2RedMix_krea2Edition.safetensors",
        },
        dryRunSummary: {
          sampleCount: 20,
          successRate: 1,
          consistencyRate: 0.9,
        },
      },
    });

    const publish = await api("POST", `admin/generation/model-profiles/${draft.id}/publish`, {
      userId: admin,
      role: "admin",
      body: {
        reason: "try to publish without model verification",
        confirmation: draft.id,
      },
    });

    expectError(publish, 400, "bad_request");
    expect(publish.error?.message).toContain("verification status");
  });

  it("rejects image model publish when runtime components are still missing", async () => {
    const admin = await setupActor("admin", "profile-publish-component-gate");
    const draft = await prisma.generationModelProfile.create({
      data: {
        id: `${P}profile-missing-components`,
        profileKey: `${P}profile-missing-components`,
        label: "Missing runtime components",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "redcraft-krea2-comfyui",
        sourceModelPath: "/models/checkpoints/redcraftKREA2RedMix_krea2Edition.safetensors",
        allowedOrientations: ["1:1"],
        version: 1,
        status: "draft",
        runnerConfig: {
          apiModelId: "redcraft-krea2-comfyui",
          modelPath: "/models/checkpoints/redcraftKREA2RedMix_krea2Edition.safetensors",
          verificationStatus: "manual_passed",
          componentStatus: {
            comfyuiRuntime: "missing_comfyui_runtime",
            krea2Workflow: "not_imported",
          },
        },
        dryRunSummary: {
          sampleCount: 20,
          successRate: 1,
          consistencyRate: 0.9,
        },
      },
    });

    const publish = await api("POST", `admin/generation/model-profiles/${draft.id}/publish`, {
      userId: admin,
      role: "admin",
      body: {
        reason: "try to publish missing components",
        confirmation: draft.id,
      },
    });

    expectError(publish, 400, "bad_request");
    expect(publish.error?.message).toContain("components");
    await expect(prisma.generationModelProfile.findUnique({ where: { id: draft.id } })).resolves.toMatchObject({
      status: "draft",
    });
  });

  it("does not allow draft model profiles to be enabled without publish", async () => {
    const admin = await setupActor("admin", "profile-enable-draft");
    const draft = await api("POST", "admin/generation/model-profiles", {
      userId: admin,
      role: "admin",
      body: {
        profileKey: `${P}draft-enable-guard`,
        label: "Draft enable guard",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "draft-enable-guard",
        allowedOrientations: ["1:1"],
        dryRunSummary: { sampleCount: 20, successRate: 1, consistencyRate: 0.9 },
      },
    });
    expectOk(draft);
    expect(draft.data.profile).toMatchObject({ enabled: false, rolloutPercent: 0, status: "draft" });

    const patch = await api("PATCH", `admin/generation/model-profiles/${draft.data.profile.id}`, {
      userId: admin,
      role: "admin",
      body: { enabled: true, reason: "try enable", confirmation: "ENABLE" },
    });
    expectError(patch, 400, "bad_request");
  });

  it("does not let manual consistency review override failed dry-run evidence", async () => {
    const admin = await setupActor("admin", "profile-publish-merge-gate");
    const draft = await prisma.generationModelProfile.create({
      data: {
        id: `${P}profile-failed-dry-run`,
        profileKey: `${P}profile-failed-dry-run`,
        label: "Failed dry-run candidate",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "failed-dry-run-candidate",
        allowedOrientations: ["1:1"],
        version: 1,
        status: "draft",
        runnerConfig: {
          apiModelId: "failed-dry-run-candidate",
          verificationStatus: "manual_passed",
        },
        dryRunSummary: {
          sampleCount: 4,
          successRate: 0,
          failureMode: "pure_white_output",
        },
      },
    });

    const publish = await api("POST", `admin/generation/model-profiles/${draft.id}/publish`, {
      userId: admin,
      role: "admin",
      body: {
        reason: "try to override failed evidence",
        confirmation: draft.id,
        dryRunSummary: {
          sampleCount: 20,
          successRate: 1,
          consistencyRate: 1,
        },
      },
    });

    expectError(publish, 400, "bad_request");
    expect(publish.error?.message).toContain("failureMode");
    await expect(prisma.generationModelProfile.findUnique({ where: { id: draft.id } })).resolves.toMatchObject({
      status: "draft",
    });
  });

  it("only allows active model profiles to be disabled without editing config fields", async () => {
    const admin = await setupActor("admin", "disable-profile");
    const profileId = `${P}profile-disable`;
    await prisma.generationModelProfile.create({
      data: {
        id: profileId,
        profileKey: `${P}profile-disable-key`,
        label: "Disable Guard",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "mock-image",
        allowedOrientations: ["1:1"],
        version: 1,
        status: "active",
        enabled: true,
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });

    const hijack = await api("PATCH", `admin/generation/model-profiles/${profileId}`, {
      userId: admin,
      role: "admin",
      body: {
        enabled: false,
        pipelineModel: "unexpected-model",
        reason: "pause bad profile",
        confirmation: profileId,
      },
    });
    expectError(hijack, 400, "bad_request");

    const genericDisable = await api("PATCH", `admin/generation/model-profiles/${profileId}`, {
      userId: admin,
      role: "admin",
      body: { enabled: false, reason: "pause bad profile", confirmation: "DISABLE" },
    });
    expectError(genericDisable, 400, "bad_request");

    const disabled = await api("PATCH", `admin/generation/model-profiles/${profileId}`, {
      userId: admin,
      role: "admin",
      body: { enabled: false, reason: "pause bad profile", confirmation: profileId },
    });
    expectOk(disabled);
    expect(await prisma.generationModelProfile.findUnique({ where: { id: profileId } })).toMatchObject({
      enabled: false,
      pipelineModel: "mock-image",
    });
  });

  it("keeps manual model profile creation and config edits behind diagnostics", async () => {
    const admin = await setupActor("admin", "profile-diagnostics-guard");
    const previousDiagnostics = process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;

    try {
      delete process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;

      const create = await api("POST", "admin/generation/model-profiles", {
        userId: admin,
        role: "admin",
        body: {
          profileKey: `${P}manual-create-hidden`,
          label: "Manual create hidden",
          mode: "image",
          runner: "sd_cpp",
          pipelineModel: "manual-create-hidden",
          allowedOrientations: ["1:1"],
          dryRunSummary: { sampleCount: 20, successRate: 1, consistencyRate: 0.9 },
        },
      });
      expectError(create, 404, "not_found");

      const profileId = `${P}profile-diagnostics-guard`;
      await prisma.generationModelProfile.create({
        data: {
          id: profileId,
          profileKey: `${P}profile-diagnostics-guard`,
          label: "Diagnostics guard profile",
          mode: "image",
          runner: "sd_cpp",
          pipelineModel: "mock-image",
          modelFormat: "safetensors",
          defaultWidth: 512,
          defaultHeight: 640,
          allowedOrientations: ["4:5"],
          steps: 20,
          sampler: "euler",
          scheduler: "model_default",
          cfgScale: 1,
          costMultiplier: 1,
          maxCount: 1,
          concurrencyLimit: 1,
          status: "active",
          enabled: true,
          rolloutPercent: 100,
          version: 1,
          dryRunSummary: { sampleCount: 20, successRate: 1, consistencyRate: 0.9 },
          publishedAt: new Date(),
        },
      });

      const configPatch = await api("PATCH", `admin/generation/model-profiles/${profileId}`, {
        userId: admin,
        role: "admin",
        body: {
          pipelineModel: "unexpected-model",
          reason: "try config edit without diagnostics",
          confirmation: "PATCH",
        },
      });
      expectError(configPatch, 404, "not_found");

      const disabled = await api("PATCH", `admin/generation/model-profiles/${profileId}`, {
        userId: admin,
        role: "admin",
        body: {
          enabled: false,
          reason: "pause built-in profile",
          confirmation: profileId,
        },
      });
      expectOk(disabled);
      expect(await prisma.generationModelProfile.findUnique({ where: { id: profileId } })).toMatchObject({
        enabled: false,
        pipelineModel: "mock-image",
      });
    } finally {
      if (previousDiagnostics === undefined) delete process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;
      else process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED = previousDiagnostics;
    }
  });

  it("accepts managed sd_cpp safetensors conversion and LoRA stack metadata", async () => {
    const admin = await setupActor("admin", "sdcpp-profile");
    const draft = await api("POST", "admin/generation/model-profiles", {
      userId: admin,
      role: "admin",
      body: {
        profileKey: `${P}sdcpp-managed`,
        label: "Managed sdcpp import",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "managed-sdcpp",
        sourceModelPath: "/models/checkpoints/managed.safetensors",
        convertedModelPath: "/models/gguf/managed-q8_0.gguf",
        modelFormat: "safetensors",
        allowedOrientations: ["1:1"],
        scheduler: "karras",
        runnerConfig: {
          apiModelId: "managed-sdcpp",
          diffusionModelPath: "/models/checkpoints/managed.safetensors",
          llmPath: "/models/text/qwen.gguf",
          vaePath: "/models/vae/ae.safetensors",
          llmVisionPath: "/models/text/qwen-vision.gguf",
          backend: "vae=cpu",
          conversion: {
            enabled: true,
            targetFormat: "gguf",
            outputPath: "/models/gguf/managed-q8_0.gguf",
            type: "q8_0",
            sourceArg: "diffusion-model",
          },
          loraModelDir: "/models/loras",
          loras: [{ key: "cinematic", path: "/models/loras/cinematic.safetensors", weight: 0.65 }],
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: false,
            initImage: true,
            lora: true,
          },
        },
        dryRunSummary: { sampleCount: 1 },
      },
    });
    expectOk(draft);
    expect(draft.data.profile).toMatchObject({ scheduler: "karras" });
    expect(draft.data.profile.runnerConfig).toMatchObject({
      conversion: { enabled: true, outputPath: "/models/gguf/managed-q8_0.gguf" },
      llmVisionPath: "/models/text/qwen-vision.gguf",
      backend: "vae=cpu",
      loras: [expect.objectContaining({ key: "cinematic", weight: 0.65 })],
      capabilities: {
        textToImage: true,
        stableSeed: true,
        referenceImages: false,
        initImage: true,
        lora: true,
      },
    });

    const dryRun = await api("POST", `admin/generation/model-profiles/${draft.data.profile.id}/dry-run`, {
      userId: admin,
      role: "admin",
      body: { reason: "verify managed import metadata", confirmation: "DRYRUN" },
    });
    expectError(dryRun, 400, "bad_request");

    const exactDryRun = await api("POST", `admin/generation/model-profiles/${draft.data.profile.id}/dry-run`, {
      userId: admin,
      role: "admin",
      body: { reason: "verify managed import metadata", confirmation: draft.data.profile.id },
    });
    expectOk(exactDryRun);
    expect(exactDryRun.data.dryRun).toMatchObject({ status: "pass", total: 2 });

    const invalid = await api("POST", "admin/generation/model-profiles", {
      userId: admin,
      role: "admin",
      body: {
        profileKey: `${P}sdcpp-invalid`,
        label: "Invalid conversion",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "invalid-sdcpp",
        sourceModelPath: "/models/checkpoints/invalid.ckpt",
        convertedModelPath: "/models/gguf/invalid-q8_0.gguf",
        modelFormat: "safetensors",
        allowedOrientations: ["1:1"],
        runnerConfig: {
          conversion: {
            enabled: true,
            targetFormat: "gguf",
            outputPath: "/models/gguf/invalid-q8_0.gguf",
          },
        },
      },
    });
    expectError(invalid, 400, "bad_request");

    const mismatchedApiModel = await api("POST", "admin/generation/model-profiles", {
      userId: admin,
      role: "admin",
      body: {
        profileKey: `${P}sdcpp-api-mismatch`,
        label: "Invalid API model",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "redcraft-model",
        sourceModelPath: "/models/checkpoints/redcraft.safetensors",
        convertedModelPath: "/models/gguf/redcraft-q8_0.gguf",
        modelFormat: "safetensors",
        allowedOrientations: ["1:1"],
        runnerConfig: {
          apiModelId: "stale-default-model",
          diffusionModelPath: "/models/checkpoints/redcraft.safetensors",
        },
      },
    });
    expectError(mismatchedApiModel, 400, "bad_request");

    const invalidKrea2Components = await api("POST", "admin/generation/model-profiles", {
      userId: admin,
      role: "admin",
      body: {
        profileKey: `${P}sdcpp-krea2-wrong-components`,
        label: "Invalid Krea2 components",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "redcraftkrea2redmix-krea2edition",
        sourceModelPath: "/models/checkpoints/redcraftKREA2RedMix_krea2Edition.safetensors",
        modelFormat: "safetensors",
        allowedOrientations: ["1:1"],
        runnerConfig: {
          apiModelId: "redcraftkrea2redmix-krea2edition",
          diffusionModelPath: "/models/checkpoints/redcraftKREA2RedMix_krea2Edition.safetensors",
          llmPath: "/models/z-image-components/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
          vaePath: "/models/z-image-components/split_files/vae/ae.safetensors",
        },
      },
    });
    expectError(invalidKrea2Components, 400, "bad_request");

    const invalidKrea2QwenImageVae = await api("POST", "admin/generation/model-profiles", {
      userId: admin,
      role: "admin",
      body: {
        profileKey: `${P}sdcpp-krea2-qwen-image-vae`,
        label: "Invalid Krea2 qwen image VAE",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "redcraftkrea2redmix-krea2edition",
        sourceModelPath: "/models/checkpoints/redcraftKREA2RedMix_krea2Edition.safetensors",
        modelFormat: "safetensors",
        allowedOrientations: ["1:1"],
        runnerConfig: {
          apiModelId: "redcraftkrea2redmix-krea2edition",
          diffusionModelPath: "/models/checkpoints/redcraftKREA2RedMix_krea2Edition.safetensors",
          llmPath: "/models/krea2/text_encoders/Qwen3VL-4B-Instruct-Q4_K_M.gguf",
          vaePath: "/models/krea2/vae/qwen_image_vae.safetensors",
        },
      },
    });
    expectError(invalidKrea2QwenImageVae, 400, "bad_request");
    expect(invalidKrea2QwenImageVae.error?.message).toContain("wan_2.1_vae");
  });

  it("fails dry-run for non-sdcpp candidates with missing runtime components", async () => {
    const admin = await setupActor("admin", "comfyui-component-dry-run");
    const draft = await api("POST", "admin/generation/model-profiles", {
      userId: admin,
      role: "admin",
      body: {
        profileKey: `${P}comfyui-missing-components`,
        label: "ComfyUI missing components",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "comfyui-missing-components",
        sourceModelPath: "/models/diffusion/darkbeast.safetensors",
        modelFormat: "safetensors",
        allowedOrientations: ["4:5"],
        runnerConfig: {
          apiModelId: "comfyui-missing-components",
          verificationStatus: "missing_flux2_klein_reference_runtime_components",
          componentStatus: {
            flux2Vae: "available",
            flux2BaseModel: "missing",
            qwenTextEncoder: "missing",
          },
        },
      },
    });
    expectOk(draft);

    const dryRun = await api("POST", `admin/generation/model-profiles/${draft.data.profile.id}/dry-run`, {
      userId: admin,
      role: "admin",
      body: { reason: "verify missing components", confirmation: draft.data.profile.id },
    });
    expectOk(dryRun);
    expect(dryRun.data.dryRun).toMatchObject({
      status: "fail",
      passed: 0,
      total: 2,
      sampleCount: 2,
      successRate: 0,
      failureMode: "missing_runtime_components",
    });
    expect(JSON.stringify(dryRun.data.dryRun.samples)).toContain("verificationStatus");
    expect(JSON.stringify(dryRun.data.dryRun.samples)).toContain("flux2BaseModel");
    await expect(
      prisma.generationModelProfile.findUnique({ where: { id: draft.data.profile.id } }),
    ).resolves.toMatchObject({
      dryRunSummary: expect.objectContaining({
        status: "fail",
        failureMode: "missing_runtime_components",
      }),
    });
  });

  it("creates zero-cost admin test image jobs for draft model profiles", async () => {
    const admin = await setupActor("admin", "profile-test-job");
    const beforeBalance = await dreamcoinBalance(admin);
    const draft = await api("POST", "admin/generation/model-profiles", {
      userId: admin,
      role: "admin",
      body: {
        profileKey: `${P}sdcpp-test-job`,
        label: "sdcpp test job draft",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "managed-sdcpp-test",
        sourceModelPath: "/models/checkpoints/test.safetensors",
        convertedModelPath: "/models/gguf/test-q8_0.gguf",
        modelFormat: "safetensors",
        allowedOrientations: ["1:1", "4:5"],
        runnerConfig: {
          apiModelId: "managed-sdcpp-test",
          diffusionModelPath: "/models/checkpoints/test.safetensors",
          llmPath: "/models/text/qwen.gguf",
          vaePath: "/models/vae/ae.safetensors",
          llmVisionPath: "/models/text/qwen-vision.gguf",
          backend: "vae=cpu",
          conversion: {
            enabled: true,
            outputPath: "/models/gguf/test-q8_0.gguf",
            sourceArg: "diffusion-model",
          },
          loras: [{ key: "portrait", path: "/models/loras/portrait.safetensors", weight: 0.5 }],
        },
      },
    });
    expectOk(draft);

    const queued = await api("POST", `admin/generation/model-profiles/${draft.data.profile.id}/test-job`, {
      userId: admin,
      role: "admin",
      body: {
        prompt: "studio portrait, soft lighting",
        orientation: "4:5",
        outputCount: 1,
        reason: "verify generated image effect",
        confirmation: "TEST",
      },
    });
    expectError(queued, 400, "bad_request");

    const exactQueued = await api("POST", `admin/generation/model-profiles/${draft.data.profile.id}/test-job`, {
      userId: admin,
      role: "admin",
      body: {
        prompt: "studio portrait, soft lighting",
        orientation: "4:5",
        outputCount: 1,
        reason: "verify generated image effect",
        confirmation: draft.data.profile.id,
      },
    });
    expectOk(exactQueued, 202);
    expect(exactQueued.data.job).toMatchObject({
      status: "queued",
      costDreamcoins: 0,
      profileId: `${P}sdcpp-test-job`,
      profileVersion: draft.data.profile.version,
    });

    const stored = await prisma.generationJob.findUniqueOrThrow({
      where: { id: exactQueued.data.job.id },
    });
    expect(stored).toMatchObject({
      userId: admin,
      costDreamcoins: 0,
      provider: "sd_cpp",
      orientation: "4:5",
    });
    expect(stored.controls).toMatchObject({
      adminTest: true,
      width: 768,
      height: 960,
      sdcpp: expect.objectContaining({
        apiModelId: "managed-sdcpp-test",
        diffusionModelPath: "/models/checkpoints/test.safetensors",
        vaePath: "/models/vae/ae.safetensors",
        llmVisionPath: "/models/text/qwen-vision.gguf",
        backend: "vae=cpu",
        loras: [expect.objectContaining({ key: "portrait", weight: 0.5 })],
      }),
    });

    await runQueuedGenerationJobs(8);
    const completed = await prisma.generationJob.findUniqueOrThrow({
      where: { id: exactQueued.data.job.id },
      include: { assets: true },
    });
    expect(completed.status).toBe("completed");
    expect(completed.assets).toHaveLength(1);
    expect(completed.assets[0]?.url).toContain("/user-content/");
    expect(await dreamcoinBalance(admin)).toBe(beforeBalance);

    const list = await api("GET", "admin/generation/jobs", {
      userId: admin,
      role: "admin",
      query: { mode: "image", limit: 5 },
    });
    expectOk(list);
    expect(list.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: exactQueued.data.job.id,
          assets: [expect.objectContaining({ id: completed.assets[0]?.id })],
        }),
      ]),
    );
  });

  it("normalizes legacy sd_cpp apiModelId when queueing admin test jobs", async () => {
    const admin = await setupActor("admin", "legacy-sdcpp-test-job");
    const profile = await prisma.generationModelProfile.create({
      data: {
        profileKey: `${P}sdcpp-legacy-test-job`,
        label: "Legacy sdcpp test job draft",
        mode: "image",
        runner: "sd_cpp",
        pipelineModel: "legacy-redcraft-model",
        sourceModelPath: "/models/checkpoints/legacy-redcraft.safetensors",
        convertedModelPath: "/models/gguf/legacy-redcraft-q8_0.gguf",
        modelFormat: "safetensors",
        allowedOrientations: ["1:1"],
        status: "draft",
        runnerConfig: {
          apiModelId: "stale-default-model",
          diffusionModelPath: "/models/checkpoints/legacy-redcraft.safetensors",
          llmPath: "/models/text/qwen.gguf",
          vaePath: "/models/vae/ae.safetensors",
        },
      },
    });

    const queued = await api("POST", `admin/generation/model-profiles/${profile.id}/test-job`, {
      userId: admin,
      role: "admin",
      body: {
        prompt: "legacy profile smoke",
        outputCount: 1,
        reason: "verify legacy config normalization",
        confirmation: profile.id,
      },
    });
    expectOk(queued, 202);
    const jobId = queued.data.job.id as string;
    try {
      const stored = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(stored.model).toBe("legacy-redcraft-model");
      expect(stored.controls).toMatchObject({
        sdcpp: expect.objectContaining({
          apiModelId: "legacy-redcraft-model",
          diffusionModelPath: "/models/checkpoints/legacy-redcraft.safetensors",
        }),
      });
      const queueJob = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`);
      expect(queueJob?.payload).toMatchObject({
        model: "legacy-redcraft-model",
        controls: {
          sdcpp: expect.objectContaining({ apiModelId: "legacy-redcraft-model" }),
        },
      });
    } finally {
      await jobQueue.removeByDedupePrefix(`generation:${jobId}`, ["ai.image.generate"]);
    }
  });

  it("runs content production batches through asset review and placement history", async () => {
    const admin = await setupActor("admin", "content-production");
    const support = await setupActor("support", "content-production");
    const character = await createCharacter({
      id: `${P}production-character`,
      creatorId: admin,
      name: "Production Character",
      visibility: "public",
      status: "approved",
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}production-visual-profile-v1`,
        characterId: character.id,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "same adult woman, amber eyes, long dark hair",
        negativeIdentityPrompt: "different face, different hair color",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        referenceAssetIds: [],
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: `${P}production-profile-v1`,
        profileKey: `${P}production-profile`,
        label: "Production profile",
        mode: "image",
        runner: "pipeline",
        pipelineModel: "mock-image",
        allowedOrientations: ["1:1", "4:5"],
        defaultWidth: 768,
        defaultHeight: 1024,
        version: 1,
        status: "active",
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });
    await prisma.generationRecipe.create({
      data: {
        id: `${P}production-recipe-v1`,
        recipeKey: `${P}production-recipe`,
        label: "Production recipe",
        mode: "image",
        useCase: "character",
        body: "Production character cover recipe.",
        negativeBase: "low quality, watermark",
        presetOrder: [],
        safetyHints: {},
        sampleMatrix: [],
        version: 1,
        status: "active",
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });
    await prisma.pricingRule.create({
      data: {
        id: `${P}image-pricing-v1`,
        ruleKey: `${P}image_pricing`,
        label: "Image pricing",
        mode: "image",
        baseCost: 7,
        multiplier: 1,
        status: "active",
        version: 1,
        effectiveFrom: new Date(),
        publishedAt: new Date(),
      },
    });

    const forbidden = await api("POST", "admin/content/production/batches", {
      userId: support,
      role: "support",
      body: {
        purpose: "character_chat",
        targetType: "character",
        targetId: character.id,
        profileId: `${P}production-profile`,
        recipeId: `${P}production-recipe`,
        count: 1,
      },
    });
    expectError(forbidden, 403);

    const created = await api("POST", "admin/content/production/batches", {
      userId: admin,
      role: "admin",
      body: {
        title: `${P}production-batch`,
        purpose: "character_chat",
        targetType: "character",
        targetId: character.id,
        profileId: `${P}production-profile`,
        recipeId: `${P}production-recipe`,
        orientation: "4:5",
        count: 2,
        brief: "Two cover candidates",
        consistencyMode: "strict",
        reason: "seed production batch",
      },
    });
    expectOk(created, 202);
    expect(created.data.batch).toMatchObject({
      title: `${P}production-batch`,
      totalItems: 2,
      status: "queued",
    });
    const itemIds = created.data.batch.items.map((item: { id: string }) => item.id);
    expect(itemIds).toHaveLength(2);

    const jobs = await prisma.generationJob.findMany({
      where: { sourceType: "content_production_item", sourceId: { in: itemIds } },
      orderBy: { createdAt: "asc" },
    });
    expect(jobs).toHaveLength(2);
    // 成本不变式：每个 job 成本>0 且 batch 估价 = 各 item job 成本之和
    // （不断言精确值：并行测试可能创建更新的 active image PricingRule）
    expect(jobs[0].costDreamcoins).toBeGreaterThan(0);
    expect(jobs[1].costDreamcoins).toBe(jobs[0].costDreamcoins);
    expect(created.data.batch.estimatedCostDreamcoins).toBe(
      jobs[0].costDreamcoins + jobs[1].costDreamcoins,
    );
    expect(jobs[0]).toMatchObject({
      userId: admin,
      profileId: `${P}production-profile`,
      recipeId: `${P}production-recipe`,
      visualProfileId: `${P}production-visual-profile-v1`,
      visualProfileVersion: 1,
      consistencyMode: "strict",
    });
    expect(jobs[0]?.prompt).toContain("Locked identity: same adult woman");
    expect(jobs[0]?.negativePrompt).toContain("different face");
    expect(jobs[0]?.controls).toMatchObject({
      consistencyMode: "strict",
      visualIdentity: expect.objectContaining({
        visualProfileId: `${P}production-visual-profile-v1`,
        visualProfileVersion: 1,
      }),
    });
    expect(jobs[0]?.sourceMeta).toMatchObject({
      batchId: created.data.batch.id,
      purpose: "character_chat",
      targetType: "character",
      targetId: character.id,
    });
    const initialAttempts = await prisma.generationAttempt.findMany({
      where: { requestId: { in: jobs.map((job) => job.id) } },
      orderBy: [{ requestId: "asc" }, { attemptNo: "asc" }],
    });
    expect(initialAttempts).toHaveLength(2);
    expect(initialAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attemptNo: 1, status: "queued", creativeRunItemId: itemIds[0] }),
        expect.objectContaining({ attemptNo: 1, status: "queued", creativeRunItemId: itemIds[1] }),
      ]),
    );
    const initialAttemptEvents = await prisma.generationAttemptEvent.findMany({
      where: { attemptId: { in: initialAttempts.map((attempt) => attempt.id) } },
    });
    expect(initialAttemptEvents).toHaveLength(2);
    expect(initialAttemptEvents.every((event) => event.eventType === "generation.attempt.queued.v1")).toBe(true);
    const dispatchRows = await prisma.mainOutboxEvent.findMany({
      where: {
        aggregateId: created.data.batch.id,
        eventType: "creative.generation.dispatch.v2",
      },
    });
    expect(dispatchRows).toHaveLength(2);
    expect(dispatchRows.every((row) => row.status === "delivered" && row.deliveredAt)).toBe(true);
    await expect(
      prisma.adminAuditLog.findFirst({
        where: {
          actorId: admin,
          action: "content.production.batch.create",
          targetId: created.data.batch.id,
        },
      }),
    ).resolves.toBeTruthy();

    await runQueuedGenerationJobs(12);

    const detail = await api("GET", `admin/content/production/batches/${created.data.batch.id}`, {
      userId: admin,
      role: "admin",
    });
    expectOk(detail);
    expect(detail.data.batch).toMatchObject({ completedItems: 2, status: "reviewing" });
    const generatedItems = detail.data.batch.items as Array<{
      id: string;
      asset: { id: string } | null;
      status: string;
    }>;
    expect(generatedItems.every((item) => item.status === "generated" && item.asset?.id)).toBe(true);

    const approveItemId = generatedItems[0]?.id as string;
    const rejectItemId = generatedItems[1]?.id as string;
    const genericApprove = await api("POST", `admin/content/production/items/${approveItemId}/approve`, {
      userId: admin,
      role: "admin",
      body: {
        tags: ["cover", "winner"],
        description: "Reusable sunset selfie for chat retrieval",
        rating: 5,
        reason: "best cover candidate",
        confirmation: "APPROVE",
      },
    });
    expectError(genericApprove, 400, "bad_request");

    const approve = await api("POST", `admin/content/production/items/${approveItemId}/approve`, {
      userId: admin,
      role: "admin",
      body: {
        tags: ["cover", "winner"],
        description: "Reusable sunset selfie for chat retrieval",
        rating: 5,
        reason: "best cover candidate",
        confirmation: approveItemId,
      },
    });
    expectOk(approve);
    const reject = await api("POST", `admin/content/production/items/${rejectItemId}/reject`, {
      userId: admin,
      role: "admin",
      body: {
        tags: ["discard"],
        reason: "weaker composition",
        confirmation: rejectItemId,
      },
    });
    expectOk(reject);
    const legacyRetry = await api(
      "POST",
      `admin/content/production/items/${rejectItemId}/regenerate`,
      {
        userId: admin,
        role: "admin",
        body: {
          reason: "attempt legacy regeneration",
          confirmation: rejectItemId,
        },
      },
    );
    expectError(legacyRetry, 409, "conflict");
    expect(legacyRetry.error?.details).toMatchObject({
      code: "creative_run_command_required",
      repairPath: `/admin/creative/runs/${created.data.batch.id}`,
    });

    const assetId = approve.data.item.asset.id as string;
    const assets = await api("GET", "admin/content/assets", {
      userId: admin,
      role: "admin",
      query: { status: "approved", purpose: "character_chat" },
    });
    expectOk(assets);
    expect(assets.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assetId,
          platformStatus: "approved",
          purpose: "character_chat",
          tags: ["cover", "winner"],
          description: "Reusable sunset selfie for chat retrieval",
          sourceJob: expect.objectContaining({ sourceType: "content_production_item" }),
        }),
      ]),
    );
    const assetDetail = await api("GET", `admin/content/assets/${assetId}`, { userId: admin, role: "admin" });
    expectOk(assetDetail);
    expect(assetDetail.data.asset).toMatchObject({ id: assetId, platformStatus: "approved" });

    const placement = await api("POST", "admin/content/placements", {
      userId: admin,
      role: "admin",
      body: {
        mediaAssetId: assetId,
        slot: "feed_card",
        targetType: "character",
        targetId: character.id,
        status: "published",
        reason: "publish approved cover",
      },
    });
    expectOk(placement);
    expect(placement.data.placement).toMatchObject({
      mediaAssetId: assetId,
      slot: "feed_card",
      targetId: character.id,
      status: "published",
    });
    const placementDetail = await api("GET", `admin/content/placements/${placement.data.placement.id}`, { userId: admin, role: "admin" });
    expectOk(placementDetail);
    expect(placementDetail.data.placement).toMatchObject({ id: placement.data.placement.id, mediaAssetId: assetId });

    const audits = await prisma.adminAuditLog.findMany({
      where: {
        actorId: admin,
        action: {
          in: [
            "content.production.batch.create",
            "content.production.item.approve",
            "content.production.item.reject",
            "content.placement.publish",
          ],
        },
      },
    });
    expect(audits.map((audit) => audit.action)).toEqual(
      expect.arrayContaining([
        "content.production.batch.create",
        "content.production.item.approve",
        "content.production.item.reject",
        "content.placement.publish",
      ]),
    );
  });

  it("creates per-character pregen packs and lists them", async () => {
    const admin = await setupActor("admin", "character-pregen");
    const support = await setupActor("support", "character-pregen");
    const character = await createCharacter({
      id: `${P}pregen-character`,
      creatorId: admin,
      name: "Pregen Character",
      visibility: "public",
      status: "approved",
    });
    await prisma.generationModelProfile.create({
      data: {
        id: `${P}pregen-profile-v1`,
        profileKey: `${P}pregen-profile`,
        label: "Pregen profile",
        mode: "image",
        runner: "pipeline",
        pipelineModel: "mock-image",
        allowedOrientations: ["4:5"],
        defaultWidth: 768,
        defaultHeight: 1024,
        version: 1,
        status: "active",
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });
    await prisma.generationRecipe.create({
      data: {
        id: `${P}pregen-recipe-v1`,
        recipeKey: `${P}pregen-recipe`,
        label: "Pregen recipe",
        mode: "image",
        useCase: "character",
        body: "Pregen recipe body.",
        negativeBase: "low quality",
        presetOrder: [],
        safetyHints: {},
        sampleMatrix: [],
        version: 1,
        status: "active",
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });

    const forbidden = await api("POST", `admin/content/characters/${character.id}/pregen`, {
      userId: support,
      role: "support",
      body: { pack: "cover", profileId: `${P}pregen-profile` },
    });
    expectError(forbidden, 403);

    const badPack = await api("POST", `admin/content/characters/${character.id}/pregen`, {
      userId: admin,
      role: "admin",
      body: { pack: "poster", profileId: `${P}pregen-profile` },
    });
    expectError(badPack, 400);

    const cover = await api("POST", `admin/content/characters/${character.id}/pregen`, {
      userId: admin,
      role: "admin",
      body: { pack: "cover", profileId: `${P}pregen-profile`, reason: "pregen cover pack" },
    });
    expectOk(cover, 202);
    expect(cover.data.batch).toMatchObject({
      purpose: "character_cover",
      targetType: "character",
      targetId: character.id,
      totalItems: 4,
      status: "queued",
    });
    expect(cover.data.batch.estimatedCostDreamcoins).toBeGreaterThan(0);

    const chat = await api("POST", `admin/content/characters/${character.id}/pregen`, {
      userId: admin,
      role: "admin",
      body: { pack: "chat", profileId: `${P}pregen-profile`, count: 2, reason: "pregen chat pack" },
    });
    expectOk(chat, 202);
    expect(chat.data.batch).toMatchObject({ purpose: "character_chat", totalItems: 2 });

    const listed = await api("GET", `admin/content/characters/${character.id}/pregen`, {
      userId: admin,
      role: "admin",
    });
    expectOk(listed);
    const batchIds = listed.data.items.map((batch: { id: string }) => batch.id);
    expect(batchIds).toContain(cover.data.batch.id);
    expect(batchIds).toContain(chat.data.batch.id);

    const missing = await api("POST", `admin/content/characters/${P}nope/pregen`, {
      userId: admin,
      role: "admin",
      body: { pack: "cover", profileId: `${P}pregen-profile` },
    });
    expectError(missing, 400);
  });

  it("prevents the legacy pregen placement path from bypassing Character Release authority", async () => {
    const admin = await setupActor("admin", "pregen-e2e");
    const character = await createCharacter({
      id: `${P}pregen-e2e-character`,
      creatorId: admin,
      name: "Pregen E2E Character",
      visibility: "public",
      status: "approved",
    });
    await prisma.generationModelProfile.create({
      data: {
        id: `${P}pregen-e2e-profile-v1`,
        profileKey: `${P}pregen-e2e-profile`,
        label: "Pregen e2e profile",
        mode: "image",
        runner: "pipeline",
        pipelineModel: "mock-image",
        // A distinct workflowKey lets us assert the job actually carries it (Step 3b).
        workflowKey: "redcraft-krea2-txt2img",
        allowedOrientations: ["4:5"],
        defaultWidth: 768,
        defaultHeight: 1024,
        version: 1,
        status: "active",
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });
    await prisma.generationRecipe.create({
      data: {
        id: `${P}pregen-e2e-recipe-v1`,
        recipeKey: `${P}pregen-e2e-recipe`,
        label: "Pregen e2e recipe",
        mode: "image",
        useCase: "character",
        body: "Pregen e2e recipe body.",
        negativeBase: "low quality",
        presetOrder: [],
        safetyHints: {},
        sampleMatrix: [],
        version: 1,
        status: "active",
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });

    const cover = await api("POST", `admin/content/characters/${character.id}/pregen`, {
      userId: admin,
      role: "admin",
      body: {
        pack: "cover",
        profileId: `${P}pregen-e2e-profile`,
        recipeId: `${P}pregen-e2e-recipe`,
        count: 1,
        reason: "pregen e2e cover pack",
      },
    });
    expectOk(cover, 202);
    expect(cover.data.batch).toMatchObject({ purpose: "character_cover", totalItems: 1 });
    const batchId = cover.data.batch.id as string;
    const itemIds = cover.data.batch.items.map((item: { id: string }) => item.id);

    // Step 3b: production batch jobs must route through the profile's workflowKey
    // (dual-indexed in gen's registry), same as the P2 generator path — not the raw
    // pipelineModel, which would bypass the intended workflow.
    const jobs = await prisma.generationJob.findMany({
      where: { sourceType: "content_production_item", sourceId: { in: itemIds } },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].model).toBe("redcraft-krea2-txt2img");

    // A generous limit: earlier tests in this file enqueue jobs of their own without
    // draining them, so this drain call also flushes that backlog before reaching ours.
    await runQueuedGenerationJobs(40);

    const listed = await api("GET", `admin/content/characters/${character.id}/pregen`, {
      userId: admin,
      role: "admin",
    });
    expectOk(listed);
    const batch = listed.data.items.find((entry: { id: string }) => entry.id === batchId);
    expect(batch.status).toBe("reviewing");
    const item = batch.items[0];
    expect(item.status).toBe("generated");
    const mediaAssetId = item.asset.id as string;

    const approve = await api("POST", `admin/content/production/items/${item.id}/approve`, {
      userId: admin,
      role: "admin",
      body: { reason: "approve pregen cover", confirmation: item.id },
    });
    expectOk(approve);

    const placementCreate = await api("POST", "admin/content/placements", {
      userId: admin,
      role: "admin",
      body: {
        mediaAssetId,
        slot: "character_avatar",
        targetType: "character",
        targetId: character.id,
        status: "draft",
        reason: "stage pregen cover for publish",
      },
    });
    expectError(placementCreate, 409, "conflict");
    expect(placementCreate.error?.details).toMatchObject({
      code: "character_release_authority_required",
      repairPath: "/admin/characters",
    });

    await expect(prisma.character.findUnique({ where: { id: character.id } })).resolves.toMatchObject({
      imageAssetId: null,
    });
    await expect(prisma.contentProductionItem.findUnique({ where: { id: item.id } })).resolves.toMatchObject({
      status: "approved",
    });
    await expect(prisma.mediaAssetPlacement.count({
      where: { mediaAssetId, slot: "character_avatar" },
    })).resolves.toBe(0);
  });

  it("does not credit the operator's ledger when a production job fails or is blocked", async () => {
    const admin = await setupActor("admin", "production-refund-guard");
    const character = await createCharacter({
      id: `${P}production-refund-character`,
      creatorId: admin,
      name: "Production Refund Character",
      visibility: "public",
      status: "approved",
    });
    await prisma.generationModelProfile.create({
      data: {
        id: `${P}production-refund-profile-v1`,
        profileKey: `${P}production-refund-profile`,
        label: "Production refund profile",
        mode: "image",
        runner: "pipeline",
        pipelineModel: "mock-image",
        allowedOrientations: ["4:5"],
        defaultWidth: 768,
        defaultHeight: 1024,
        version: 1,
        status: "active",
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });
    await prisma.generationRecipe.create({
      data: {
        id: `${P}production-refund-recipe-v1`,
        recipeKey: `${P}production-refund-recipe`,
        label: "Production refund recipe",
        mode: "image",
        useCase: "character",
        body: "Production refund recipe body.",
        negativeBase: "low quality",
        presetOrder: [],
        safetyHints: {},
        sampleMatrix: [],
        version: 1,
        status: "active",
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });
    await prisma.pricingRule.create({
      data: {
        id: `${P}production-refund-pricing-v1`,
        ruleKey: `${P}production_refund_pricing`,
        label: "Production refund pricing",
        mode: "image",
        baseCost: 9,
        multiplier: 1,
        status: "active",
        version: 1,
        effectiveFrom: new Date(),
        publishedAt: new Date(),
      },
    });

    const created = await api("POST", "admin/content/production/batches", {
      userId: admin,
      role: "admin",
      body: {
        title: `${P}production-refund-batch`,
        purpose: "character_chat",
        targetType: "character",
        targetId: character.id,
        profileId: `${P}production-refund-profile`,
        recipeId: `${P}production-refund-recipe`,
        orientation: "4:5",
        count: 2,
        brief: "Force one failure, one moderation block",
        reason: "verify ops jobs never credit the ledger on refund",
      },
    });
    expectOk(created, 202);
    const itemIds = created.data.batch.items.map((item: { id: string }) => item.id);
    expect(itemIds).toHaveLength(2);

    const jobs = await prisma.generationJob.findMany({
      where: { sourceType: "content_production_item", sourceId: { in: itemIds } },
      orderBy: { createdAt: "asc" },
    });
    expect(jobs).toHaveLength(2);
    // Precondition for the regression: ops jobs now carry a real cost even though
    // batch creation never debits a wallet for them.
    expect(jobs[0].costDreamcoins).toBeGreaterThan(0);
    const [failJob, blockJob] = jobs;

    // Never debited on creation: the operator's balance before any failure/finalize.
    const balanceBefore = await dreamcoinBalance(admin);

    await jobQueue.removeByDedupePrefix(`generation:${failJob.id}`, ["ai.image.generate"]);
    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: asInputJson({
        version: 1,
        kind: "generation.failed",
        requestId: `${P}production-refund-fail`,
        generationJobId: failJob.id,
        mode: "image",
        error: { code: "backend_oom", message: "backend out of memory", retryable: false },
      }),
      dedupeKey: `generation-finalize:${failJob.id}:failed`,
    });

    await jobQueue.removeByDedupePrefix(`generation:${blockJob.id}`, ["ai.image.generate"]);
    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: asInputJson({
        version: 1,
        kind: "generation.blocked",
        requestId: `${P}production-refund-block`,
        generationJobId: blockJob.id,
        mode: "image",
        layer: "input",
        policyCode: "moderation_blocked",
        message: "prompt failed moderation",
      }),
      dedupeKey: `generation-finalize:${blockJob.id}:blocked`,
    });

    await drainLocalAiPipeline({
      queues: ["app.ai.finalize"],
      limit: 4,
      workerId: `${P}production-refund-finalizer`,
    });

    const [finalFailJob, finalBlockJob] = await Promise.all([
      prisma.generationJob.findUniqueOrThrow({ where: { id: failJob.id } }),
      prisma.generationJob.findUniqueOrThrow({ where: { id: blockJob.id } }),
    ]);
    expect(finalFailJob.status).toBe("failed");
    expect(finalBlockJob.status).toBe("blocked");

    // The regression: a non-zero costDreamcoins on a never-debited ops job must not
    // mint a "refund" credit into the operator's ledger.
    expect(await dreamcoinBalance(admin)).toBe(balanceBefore);
    expect(
      await prisma.dreamcoinLedger.count({
        where: { reason: "refund", sourceId: { in: [failJob.id, blockJob.id] } },
      }),
    ).toBe(0);

    const failedItem = await prisma.contentProductionItem.findFirstOrThrow({
      where: { id: { in: itemIds }, jobId: failJob.id },
    });
    expect(failedItem.status).toBe("failed");
  });

  it("keeps model import diagnostics disabled by default", async () => {
    const admin = await setupActor("admin", "model-import-disabled");
    const previousDiagnostics = process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;
    try {
      delete process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;
      const list = await api("GET", "admin/generation/model-imports", {
        userId: admin,
        role: "admin",
      });
      expectError(list, 404, "not_found");
    } finally {
      if (previousDiagnostics === undefined) delete process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;
      else process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED = previousDiagnostics;
    }
  });

  it("registers local sdcpp model and LoRA assets for engineering diagnostics", async () => {
    const admin = await setupActor("admin", "model-import");
    const previousRoot = process.env.ADMIN_MODEL_LIBRARY_DIR;
    const previousDiagnostics = process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;
    const root = await mkdtemp(path.join(os.tmpdir(), "idream-model-import-"));
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "idream-model-external-"));
    try {
      process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED = "true";
      process.env.ADMIN_MODEL_LIBRARY_DIR = root;
      const modelPath = path.join(externalRoot, "Chrome Style.safetensors");
      const krea2ModelPath = path.join(externalRoot, "genericKrea2Model.safetensors");
      const redcraftComfyuiPath = path.join(externalRoot, "redcraftKREA2RedMix_krea2Edition.safetensors");
      const loraPath = path.join(externalRoot, "cinematic.safetensors");
      const modelDir = path.join(externalRoot, "model-batch");
      const nestedModelDir = path.join(modelDir, "nested");
      const directoryModelPath = path.join(modelDir, "batch-main.gguf");
      const nestedDirectoryModelPath = path.join(nestedModelDir, "nested-main.safetensors");
      await mkdir(nestedModelDir, { recursive: true });
      await writeFile(modelPath, "model");
      await writeFile(krea2ModelPath, "model");
      await writeSafetensorsMetadata(redcraftComfyuiPath, {
        workflow: "CheckpointLoaderSimple Krea2RedMix-10Steps-fp8-scaled-ComfyUI.safetensors",
        prompt: "ComfyUI fp8 Krea2 smoke metadata",
      });
      await writeFile(loraPath, "lora");
      await writeFile(directoryModelPath, "model");
      await writeFile(nestedDirectoryModelPath, "model");
      await writeFile(path.join(modelDir, "notes.txt"), "ignore");

      const model = await api("POST", "admin/generation/model-imports/register", {
        userId: admin,
        role: "admin",
        body: { kind: "model", path: modelPath, reason: "register local model" },
      });
      expectOk(model);
      expect(model.data.asset).toMatchObject({
        kind: "model",
        format: "safetensors",
        draftPatch: expect.objectContaining({
          sourceModelPath: modelPath,
          diffusionModelPath: modelPath,
          convertedModelPath: path.join(root, "gguf", "chrome_style-q8_0.gguf"),
          conversionEnabled: true,
        }),
      });

      const krea2Model = await api("POST", "admin/generation/model-imports/register", {
        userId: admin,
        role: "admin",
        body: { kind: "model", path: krea2ModelPath, reason: "register local krea2 model" },
      });
      expectOk(krea2Model);
      expect(krea2Model.data.asset).toMatchObject({
        kind: "model",
        format: "safetensors",
        draftPatch: expect.objectContaining({
          runner: "sd_cpp",
          sourceModelPath: krea2ModelPath,
          diffusionModelPath: krea2ModelPath,
          convertedModelPath: "",
          conversionEnabled: false,
          llmPath: expect.stringContaining("Qwen3VL-4B-Instruct-Q4_K_M.gguf"),
          vaePath: expect.stringContaining("wan_2.1_vae.safetensors"),
          backend: "vae=cpu",
          steps: "10",
          sampler: "er_sde",
          scheduler: "simple",
          cfgScale: "1",
        }),
      });

      const redcraftComfyuiModel = await api("POST", "admin/generation/model-imports/register", {
        userId: admin,
        role: "admin",
        body: { kind: "model", path: redcraftComfyuiPath, reason: "register local redcraft comfyui model" },
      });
      expectOk(redcraftComfyuiModel);
      expect(redcraftComfyuiModel.data.asset).toMatchObject({
        kind: "model",
        format: "safetensors",
        draftPatch: expect.objectContaining({
          profileTemplate: "reference_identity_comfyui",
          runner: "comfyui",
          sourceModelPath: redcraftComfyuiPath,
          diffusionModelPath: redcraftComfyuiPath,
          convertedModelPath: "",
          conversionEnabled: false,
          steps: "10",
          sampler: "er_sde",
          scheduler: "simple",
          cfgScale: "1",
          runnerConfig: expect.objectContaining({
            verificationStatus: "requires_comfyui_fp8_krea2_runtime",
            assetFormat: "fp8_scaled_comfyui_checkpoint",
          }),
        }),
      });

      const lora = await api("POST", "admin/generation/model-imports/register", {
        userId: admin,
        role: "admin",
        body: { kind: "lora", path: loraPath, reason: "register local lora" },
      });
      expectOk(lora);
      expect(lora.data.asset.draftPatch).toMatchObject({
        loraModelDir: externalRoot,
        lora: expect.objectContaining({ key: "cinematic", path: loraPath, weight: 1 }),
      });

      const directoryImport = await api("POST", "admin/generation/model-imports/register", {
        userId: admin,
        role: "admin",
        body: { kind: "model", path: modelDir, reason: "register model directory" },
      });
      expectOk(directoryImport);
      expect(directoryImport.data.assets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: directoryModelPath, kind: "model", format: "gguf" }),
          expect.objectContaining({ path: nestedDirectoryModelPath, kind: "model", format: "safetensors" }),
        ]),
      );

      const list = await api("GET", "admin/generation/model-imports", {
        userId: admin,
        role: "admin",
      });
      expectOk(list);
      expect(list.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: modelPath, kind: "model" }),
          expect.objectContaining({ path: krea2ModelPath, kind: "model" }),
          expect.objectContaining({ path: loraPath, kind: "lora" }),
          expect.objectContaining({ path: directoryModelPath, kind: "model" }),
          expect.objectContaining({ path: nestedDirectoryModelPath, kind: "model" }),
        ]),
      );
    } finally {
      if (previousDiagnostics === undefined) delete process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;
      else process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED = previousDiagnostics;
      if (previousRoot === undefined) delete process.env.ADMIN_MODEL_LIBRARY_DIR;
      else process.env.ADMIN_MODEL_LIBRARY_DIR = previousRoot;
      await rm(root, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it("resolves relative admin model library paths from the repo root", async () => {
    const admin = await setupActor("admin", "model-import-relative");
    const previousRoot = process.env.ADMIN_MODEL_LIBRARY_DIR;
    const previousRepoRoot = process.env.IDREAM_REPO_ROOT;
    const previousDiagnostics = process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "idream-model-import-repo-"));
    try {
      process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED = "true";
      process.env.IDREAM_REPO_ROOT = repoRoot;
      process.env.ADMIN_MODEL_LIBRARY_DIR = "relative-models";

      const expectedRoot = path.join(repoRoot, "relative-models");
      const modelPath = path.join(expectedRoot, "checkpoints", "relative.safetensors");
      await mkdir(path.dirname(modelPath), { recursive: true });
      await writeFile(modelPath, "model");

      const list = await api("GET", "admin/generation/model-imports", {
        userId: admin,
        role: "admin",
      });
      expectOk(list);
      expect(list.data.roots.root).toBe(expectedRoot);
      expect(list.data.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: modelPath, kind: "model" })]),
      );
    } finally {
      if (previousDiagnostics === undefined) delete process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED;
      else process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED = previousDiagnostics;
      if (previousRoot === undefined) delete process.env.ADMIN_MODEL_LIBRARY_DIR;
      else process.env.ADMIN_MODEL_LIBRARY_DIR = previousRoot;
      if (previousRepoRoot === undefined) delete process.env.IDREAM_REPO_ROOT;
      else process.env.IDREAM_REPO_ROOT = previousRepoRoot;
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("publishes prompt templates with dry-run evidence and archives the previous active version", async () => {
    const admin = await setupActor("admin", "prompt");
    await prisma.generationRecipe.create({
      data: {
        id: `${P}template-v1`,
        recipeKey: `${P}template`,
        label: "Template v1",
        mode: "image",
        useCase: "character",
        body: "safe body",
        presetOrder: [],
        safetyHints: {},
        sampleMatrix: [],
        version: 1,
        status: "active",
        dryRunSummary: { sampleCount: 1 },
        publishedAt: new Date(),
      },
    });

    const draft = await api("POST", "admin/generation/recipes", {
      userId: admin,
      role: "admin",
      body: {
        recipeKey: `${P}template`,
        label: "Template v2",
        mode: "image",
        useCase: "character",
        body: "safe body v2",
        presetOrder: ["mode"],
        safetyHints: { checked: true },
        sampleMatrix: [{ prompt: "sample" }],
        dryRunSummary: { sampleCount: 2, successRate: 1 },
      },
    });
    expectOk(draft);

    const publish = await api("POST", `admin/generation/recipes/${draft.data.template.id}/publish`, {
      userId: admin,
      role: "admin",
      body: { reason: "sample matrix passed", confirmation: "PUBLISH" },
    });
    expectError(publish, 400, "bad_request");

    const exactPublish = await api("POST", `admin/generation/recipes/${draft.data.template.id}/publish`, {
      userId: admin,
      role: "admin",
      body: { reason: "sample matrix passed", confirmation: draft.data.template.id },
    });
    expectOk(exactPublish);
    expect(exactPublish.data.template).toMatchObject({ status: "active", version: 2 });
    expect(await prisma.generationRecipe.findUnique({ where: { id: `${P}template-v1` } })).toMatchObject({
      status: "archived",
    });
  });
});

describe("pricing control plane", () => {
  it("gates pricing reads/writes by permission key", async () => {
    const admin = await setupActor("admin", "pricing-perm");
    const support = await setupActor("support", "pricing-perm");
    const ops = await setupActor("ops", "pricing-perm");

    // 读 billing.read（admin+support 可见），写 config.pricing.write（admin only）。
    expectOk(await api("GET", "admin/pricing/rules", { userId: support, role: "support" }));
    expectOk(await api("GET", "admin/pricing/rules", { userId: admin, role: "admin" }));
    expectError(await api("GET", "admin/pricing/rules", { userId: ops, role: "ops" }), 403);
    expectError(
      await api("POST", "admin/pricing/rules", {
        userId: support,
        role: "support",
        body: { ruleKey: `${P}noop`, label: "x", mode: "video", baseCost: 10 },
      }),
      403,
    );

    const voice = await api("POST", "admin/pricing/rules", {
      userId: admin,
      role: "admin",
      body: {
        ruleKey: `${P}voice_pricing`,
        label: "Voice overflow",
        mode: "voice",
        baseCost: 2,
        reason: "voice pricing draft",
        confirmation: `${P}voice_pricing`,
      },
    });
    expectOk(voice);
    expect(voice.data.rule).toMatchObject({ mode: "voice", status: "draft" });

    const wrongConfirmation = await api("POST", "admin/pricing/rules", {
      userId: admin,
      role: "admin",
      body: {
        ruleKey: `${P}voice_pricing_wrong`,
        label: "Voice wrong confirmation",
        mode: "voice",
        baseCost: 3,
        reason: "wrong confirmation",
        confirmation: "CREATE",
      },
    });
    expectError(wrongConfirmation, 400, "bad_request");
    expect(await prisma.pricingRule.count({ where: { ruleKey: `${P}voice_pricing_wrong` } })).toBe(0);
  });

  it("publishes and rolls back pricing rules with audit, keeping one active per mode", async () => {
    const admin = await setupActor("admin", "pricing");
    const ruleKey = `${P}video_base`;
    await prisma.pricingRule.create({
      data: {
        id: `${P}pricing-v1`,
        ruleKey,
        label: "Video base v1",
        mode: "video",
        baseCost: 80,
        multiplier: 1,
        version: 1,
        status: "active",
        publishedAt: new Date(),
      },
    });

    const draft = await api("POST", "admin/pricing/rules", {
      userId: admin,
      role: "admin",
      body: {
        ruleKey,
        label: "Video base v2",
        mode: "video",
        baseCost: 60,
        multiplier: 1,
        reason: "create promo price draft",
        confirmation: ruleKey,
      },
    });
    expectOk(draft);
    expect(draft.data.rule).toMatchObject({ status: "draft", version: 2, baseCost: 60 });

    // 只有 draft 能编辑；active 规则改价必须走新 draft + publish。
    const editActive = await api("PATCH", `admin/pricing/rules/${P}pricing-v1`, {
      userId: admin,
      role: "admin",
      body: { baseCost: 70 },
    });
    expectError(editActive, 400, "bad_request");

    const publish = await api("POST", `admin/pricing/rules/${draft.data.rule.id}/publish`, {
      userId: admin,
      role: "admin",
      body: { reason: "promo price drop", confirmation: "PUBLISH" },
    });
    expectError(publish, 400, "bad_request");

    const exactPublish = await api("POST", `admin/pricing/rules/${draft.data.rule.id}/publish`, {
      userId: admin,
      role: "admin",
      body: { reason: "promo price drop", confirmation: draft.data.rule.id },
    });
    expectOk(exactPublish);
    expect(exactPublish.data.rule).toMatchObject({ status: "active", version: 2, baseCost: 60 });
    expect(await prisma.pricingRule.findUnique({ where: { id: `${P}pricing-v1` } })).toMatchObject({
      status: "archived",
    });
    // 不变量：每个 mode 至多一个 active 规则（generationCost 的资金侧 SSoT）。
    expect(
      await prisma.pricingRule.count({ where: { ruleKey, mode: "video", status: "active" } }),
    ).toBe(1);

    const rollback = await api("POST", `admin/pricing/rules/${exactPublish.data.rule.id}/rollback`, {
      userId: admin,
      role: "admin",
      body: { reason: "promo ended", confirmation: "ROLLBACK" },
    });
    expectError(rollback, 400, "bad_request");

    const exactRollback = await api("POST", `admin/pricing/rules/${exactPublish.data.rule.id}/rollback`, {
      userId: admin,
      role: "admin",
      body: { reason: "promo ended", confirmation: exactPublish.data.rule.id },
    });
    expectOk(exactRollback);
    expect(exactRollback.data).toMatchObject({ fromVersion: 2, toVersion: 1 });
    expect(await prisma.pricingRule.findUnique({ where: { id: `${P}pricing-v1` } })).toMatchObject({
      status: "active",
      baseCost: 80,
    });

    const actions = (
      await prisma.adminAuditLog.findMany({
        where: { actorId: admin, targetType: "pricing_rule" },
      })
    ).map((audit) => audit.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "config.pricing.create",
        "config.pricing.publish",
        "config.pricing.rollback",
      ]),
    );
  });
});

describe("admin writes are audited", () => {
  it("suspends users, adjusts ledger by append-only entry, and blocks hard-policy flags", async () => {
    const admin = await setupActor("admin", "writes");
    const target = `${P}target-user`;
    await createUser({ id: target });

    const wrongStatusConfirmation = await api("POST", `admin/users/${target}/status`, {
      userId: admin,
      role: "admin",
      body: { status: "suspended", reason: "chargeback risk", confirmation: "SUSPENDED" },
    });
    expectError(wrongStatusConfirmation, 400, "bad_request");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target } })).status).toBe("active");

    const status = await api("POST", `admin/users/${target}/status`, {
      userId: admin,
      role: "admin",
      body: { status: "suspended", reason: "chargeback risk", confirmation: `${target}:suspended` },
    });
    expectOk(status);
    expect(status.data.user.status).toBe("suspended");

    const wrongRoleConfirmation = await api("POST", `admin/users/${target}/role`, {
      userId: admin,
      role: "admin",
      body: { role: "support", reason: "support handoff", confirmation: "ROLE" },
    });
    expectError(wrongRoleConfirmation, 400, "bad_request");

    const roleChange = await api("POST", `admin/users/${target}/role`, {
      userId: admin,
      role: "admin",
      body: { role: "support", reason: "support handoff", confirmation: `${target}:support` },
    });
    expectOk(roleChange);
    expect(roleChange.data.user.role).toBe("support");
    await expect(prisma.mainOutboxEvent.count({
      where: {
        aggregateId: target,
        eventType: { in: ["admin.user.status_changed.v2", "admin.user.role_changed.v2"] },
      },
    })).resolves.toBe(2);

    const wrongAdjustConfirmation = await api("POST", "admin/billing/adjustments", {
      userId: admin,
      role: "admin",
      body: { userId: target, delta: 42, reason: "wrong adjustment confirmation", confirmation: "ADJUST" },
    });
    expectError(wrongAdjustConfirmation, 400, "bad_request");
    expect(await dreamcoinBalance(target)).toBe(0);

    const adjustmentKey = `${P}billing-adjustment-idempotency`;
    const adjust = await api("POST", "admin/billing/adjustments", {
      userId: admin,
      role: "admin",
      headers: { "idempotency-key": adjustmentKey },
      body: { userId: target, delta: 42, reason: "support credit", confirmation: `${target}:42` },
    });
    expectOk(adjust);
    expect(await dreamcoinBalance(target)).toBe(42);
    expect(adjust.data.ledgerEntry.reason).toBe("admin_adjust");
    const replay = await api("POST", "admin/billing/adjustments", {
      userId: admin,
      role: "admin",
      headers: { "idempotency-key": adjustmentKey },
      body: { userId: target, delta: 42, reason: "support credit replay", confirmation: `${target}:42` },
    });
    expectOk(replay);
    expect(replay.data.replayed).toBe(true);
    expect(await dreamcoinBalance(target)).toBe(42);
    await expect(prisma.dreamcoinLedger.count({ where: { idempotencyKey: adjustmentKey } })).resolves.toBe(1);
    await expect(prisma.adminAuditLog.count({
      where: { action: "billing.ledger.adjust", targetId: target },
    })).resolves.toBe(1);
    const conflict = await api("POST", "admin/billing/adjustments", {
      userId: admin,
      role: "admin",
      headers: { "idempotency-key": adjustmentKey },
      body: { userId: target, delta: 43, reason: "conflicting replay", confirmation: `${target}:43` },
    });
    expectError(conflict, 409, "conflict");

    const hardPolicy = await api("PATCH", "admin/feature-flags/age_gate_required", {
      userId: admin,
      role: "admin",
      body: { enabled: false, reason: "test", confirmation: "FLAG" },
    });
    expectError(hardPolicy, 403, "forbidden");
    const camelHardPolicy = await api("PATCH", "admin/feature-flags/minorSafetyBypass", {
      userId: admin,
      role: "admin",
      body: { enabled: true, reason: "test", confirmation: "FLAG" },
    });
    expectError(camelHardPolicy, 403, "forbidden");

    const wrongFlagConfirmation = await api("PATCH", "admin/feature-flags/image_edit", {
      userId: admin,
      role: "admin",
      body: { enabled: true, reason: "wrong flag confirmation", confirmation: "FLAG" },
    });
    expectError(wrongFlagConfirmation, 400, "bad_request");

    const flag = await api("PATCH", "admin/feature-flags/image_edit", {
      userId: admin,
      role: "admin",
      body: { enabled: true, reason: "rollout test", confirmation: "image_edit:enabled" },
    });
    expectOk(flag);

    const auditActions = (
      await prisma.adminAuditLog.findMany({ where: { actorId: admin } })
    ).map((audit) => audit.action);
    expect(auditActions).toEqual(
      expect.arrayContaining([
        "user.status.write",
        "billing.ledger.adjust",
        "config.feature_flag.write",
      ]),
    );
  });

  it("does not discard completed generation jobs", async () => {
    const admin = await setupActor("admin", "discard");
    const target = `${P}discard-user`;
    await createUser({ id: target });
    await prisma.generationJob.create({
      data: {
        id: `${P}completed-job`,
        userId: target,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        costDreamcoins: 10,
        provider: "mock-pipeline",
      },
    });

    const discarded = await api("POST", `admin/generation/jobs/${P}completed-job/discard`, {
      userId: admin,
      role: "admin",
      body: { reason: "should not refund completed work", confirmation: `${P}completed-job` },
    });
    expectError(discarded, 400, "bad_request");
    expect(await prisma.generationJob.findUnique({ where: { id: `${P}completed-job` } })).toMatchObject({
      status: "completed",
    });
    expect(await prisma.dreamcoinLedger.count({ where: { userId: target, reason: "refund" } })).toBe(0);
  });
});

describe("dead-letter operations console", () => {
  async function makeJob(id: string, userId: string, status: string, cost = 10, errorCode?: string) {
    return prisma.generationJob.create({
      data: {
        id,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        status,
        costDreamcoins: cost,
        errorCode,
      },
    });
  }

  it("lists failed/blocked jobs with refund state and gates reads", async () => {
    const ops = await setupActor("ops", "dl-list");
    const analyst = await setupActor("analyst", "dl-list");
    const owner = `${P}dl-owner`;
    await createUser({ id: owner });
    await makeJob(`${P}dl-failed`, owner, "failed", 10, "provider_timeout");
    await makeJob(`${P}dl-blocked`, owner, "blocked", 10);
    await makeJob(`${P}dl-done`, owner, "completed", 10);

    expectError(
      await api("GET", "admin/generation/dead-letter", { userId: analyst, role: "analyst" }),
      403,
    );

    const list = await api("GET", "admin/generation/dead-letter", { userId: ops, role: "ops" });
    expectOk(list);
    const items = list.data.items as Array<{ id: string; ledgerState: string }>;
    const ids = items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([`${P}dl-failed`, `${P}dl-blocked`]));
    expect(ids).not.toContain(`${P}dl-done`);
    expect(items.find((item) => item.id === `${P}dl-failed`)?.ledgerState).toBe("reserved");
  });

  it("batch requeues failed jobs, skips refunded/missing, writes one audit", async () => {
    const admin = await setupActor("admin", "dl-requeue");
    const owner = `${P}dl-rq-owner`;
    await createUser({ id: owner });
    await makeJob(`${P}dl-rq-failed`, owner, "failed", 5);
    await prisma.generationAttempt.create({
      data: {
        id: `${P}dl-rq-attempt-1`,
        requestId: `${P}dl-rq-failed`,
        attemptNo: 1,
        status: "failed",
        retryability: "operator_retry",
        finishedAt: new Date(),
      },
    });
    await makeJob(`${P}dl-rq-refunded`, owner, "failed", 5);
    await prisma.dreamcoinLedger.create({
      data: {
        id: `${P}dl-rq-refund`,
        userId: owner,
        delta: 5,
        balanceAfter: 5,
        reason: "refund",
        sourceId: `${P}dl-rq-refunded`,
      },
    });

    const requeueIds = [`${P}dl-rq-failed`, `${P}dl-rq-refunded`, `${P}dl-rq-missing`];
    const wrongConfirmation = await api("POST", "admin/generation/dead-letter/requeue", {
      userId: admin,
      role: "admin",
      body: {
        jobIds: requeueIds,
        reason: "wrong batch requeue confirmation",
        confirmation: "REQUEUE",
      },
    });
    expectError(wrongConfirmation, 400, "bad_request");
    expect(await prisma.generationJob.findUnique({ where: { id: `${P}dl-rq-failed` } })).toMatchObject({
      status: "failed",
    });

    const res = await api("POST", "admin/generation/dead-letter/requeue", {
      userId: admin,
      role: "admin",
      body: {
        jobIds: requeueIds,
        reason: "provider recovered",
        confirmation: requeueIds.join(","),
      },
    });
    expectOk(res);
    expect(res.data.requeued).toEqual([`${P}dl-rq-failed`]);
    const skipped = Object.fromEntries(
      (res.data.skipped as Array<{ id: string; reason: string }>).map((s) => [s.id, s.reason]),
    );
    expect(skipped[`${P}dl-rq-refunded`]).toBe("refunded");
    expect(skipped[`${P}dl-rq-missing`]).toBe("not_found");
    expect(await prisma.generationJob.findUnique({ where: { id: `${P}dl-rq-failed` } })).toMatchObject({
      status: "queued",
    });
    expect(await prisma.generationAttempt.findMany({
      where: { requestId: `${P}dl-rq-failed` },
      orderBy: { attemptNo: "asc" },
    })).toEqual([
      expect.objectContaining({ id: `${P}dl-rq-attempt-1`, attemptNo: 1, status: "failed" }),
      expect.objectContaining({ attemptNo: 2, status: "queued" }),
    ]);
    expect(await prisma.mainOutboxEvent.findFirst({
      where: { aggregateId: `${P}dl-rq-failed`, eventType: "generation.retry.dispatch.v2" },
    })).toMatchObject({ status: "pending" });
    expect(await prisma.adminAuditLog.findFirst({
      where: { actorId: admin, action: "ops.deadletter.requeue.item", targetId: `${P}dl-rq-failed` },
    })).not.toBeNull();
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { actorId: admin, action: "ops.deadletter.requeue" },
    });
    expect(audit.targetType).toBe("generation_job_batch");
  });

  it("batch discards with idempotent refund and writes one audit", async () => {
    const admin = await setupActor("admin", "dl-discard");
    const owner = `${P}dl-dc-owner`;
    await createUser({ id: owner });
    await makeJob(`${P}dl-dc-failed`, owner, "failed", 8);
    await makeJob(`${P}dl-dc-refunded`, owner, "blocked", 8);
    await prisma.dreamcoinLedger.createMany({ data: [
      { id: `${P}dl-dc-spend-failed`, userId: owner, delta: -8, balanceAfter: -8, reason: "generation_spend", sourceId: `${P}dl-dc-failed` },
      { id: `${P}dl-dc-spend-refunded`, userId: owner, delta: -8, balanceAfter: -16, reason: "generation_spend", sourceId: `${P}dl-dc-refunded` },
    ] });
    await prisma.dreamcoinLedger.create({
      data: {
        id: `${P}dl-dc-refund`,
        userId: owner,
        delta: 8,
        balanceAfter: -8,
        reason: "refund",
        sourceId: `${P}dl-dc-refunded`,
      },
    });

    const discardIds = [`${P}dl-dc-failed`, `${P}dl-dc-refunded`];
    const wrongConfirmation = await api("POST", "admin/generation/dead-letter/discard", {
      userId: admin,
      role: "admin",
      body: {
        jobIds: discardIds,
        reason: "wrong batch discard confirmation",
        confirmation: "DISCARD",
      },
    });
    expectError(wrongConfirmation, 400, "bad_request");
    expect(
      await prisma.dreamcoinLedger.count({ where: { sourceId: `${P}dl-dc-failed`, reason: "refund" } }),
    ).toBe(0);

    const res = await api("POST", "admin/generation/dead-letter/discard", {
      userId: admin,
      role: "admin",
      body: {
        jobIds: discardIds,
        reason: "permanent provider outage",
        confirmation: discardIds.join(","),
      },
    });
    expectOk(res);
    expect(res.data.discarded).toEqual(
      expect.arrayContaining([`${P}dl-dc-failed`, `${P}dl-dc-refunded`]),
    );
    expect(res.data.refunded).toEqual([`${P}dl-dc-failed`]);
    // 幂等：每个 job 至多一条 refund。
    expect(
      await prisma.dreamcoinLedger.count({ where: { sourceId: `${P}dl-dc-refunded`, reason: "refund" } }),
    ).toBe(1);
    expect(
      await prisma.dreamcoinLedger.count({ where: { sourceId: `${P}dl-dc-failed`, reason: "refund" } }),
    ).toBe(1);
    expect(
      await prisma.adminAuditLog.count({ where: { actorId: admin, action: "ops.deadletter.discard" } }),
    ).toBe(1);
    const afterDiscard = await api("GET", "admin/generation/dead-letter", { userId: admin, role: "admin" });
    expectOk(afterDiscard);
    expect((afterDiscard.data.items as Array<{ id: string }>).map((item) => item.id)).not.toContain(`${P}dl-dc-failed`);
  });
});

describe("generation and Creative Run truth containment", () => {
  it("keeps failed legacy completedAt out of the success timeline and retry set", async () => {
    const admin = await setupActor("admin", "generation-truth");
    const owner = `${P}generation-truth-owner`;
    await createUser({ id: owner });
    const failedAt = new Date("2026-01-02T03:04:05.000Z");
    const failedJob = await prisma.generationJob.create({
      data: {
        id: `${P}generation-truth-failed`,
        userId: owner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        errorCode: "provider_timeout",
        completedAt: failedAt,
        events: {
          create: {
            type: "failed",
            message: "Provider timed out",
            metadata: {},
            createdAt: failedAt,
          },
        },
      },
    });

    const detail = await api("GET", `admin/generation/jobs/${failedJob.id}`, {
      userId: admin,
      role: "admin",
    });
    expectOk(detail);
    expect(detail.data.timeline.map((entry: { type: string }) => entry.type)).toEqual(["failed"]);
    expect(detail.data.state).toMatchObject({
      executionOutcome: "failed",
      terminalSource: "event",
      retryEligibility: { eligible: true },
    });

    const artifactJob = await prisma.generationJob.create({
      data: {
        id: `${P}generation-truth-artifact`,
        userId: owner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        errorCode: "ingest_timeout",
        completedAt: failedAt,
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: `${P}generation-truth-asset`,
        ownerId: owner,
        sourceJobId: artifactJob.id,
        type: "image",
        url: "https://example.test/generation-truth.png",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    const artifactDetail = await api("GET", `admin/generation/jobs/${artifactJob.id}`, {
      userId: admin,
      role: "admin",
    });
    expectOk(artifactDetail);
    expect(artifactDetail.data.state).toMatchObject({
      executionOutcome: "succeeded",
      retryEligibility: { eligible: false, reason: "successful_artifact_exists" },
    });
    expectError(
      await api("POST", `admin/generation/jobs/${artifactJob.id}/requeue`, {
        userId: admin,
        role: "admin",
        body: {
          reason: "must not duplicate a successful artifact",
          confirmation: artifactJob.id,
        },
      }),
      409,
      "conflict",
    );
  });

  it("exposes 0/4, 1/4, and 4/4 child-fact outcomes through the Admin API", async () => {
    const admin = await setupActor("admin", "creative-truth");

    async function createRun(suffix: string, successfulCount: number) {
      const batch = await prisma.contentProductionBatch.create({
        data: {
          id: `${P}creative-truth-${suffix}`,
          title: `Creative truth ${suffix}`,
          purpose: "campaign",
          targetType: "none",
          presetIds: [],
          count: 4,
          totalItems: 4,
          status: "completed",
          createdById: admin,
        },
      });
      for (let index = 0; index < 4; index += 1) {
        const succeeded = index < successfulCount;
        const job = await prisma.generationJob.create({
          data: {
            id: `${batch.id}-job-${index}`,
            userId: admin,
            mode: "image",
            controls: {},
            presetIds: [],
            status: succeeded ? "completed" : "failed",
            errorCode: succeeded ? null : "provider_timeout",
            costDreamcoins: 5,
            sourceType: "content_production_item",
            sourceId: `${batch.id}-item-${index}`,
          },
        });
        const asset = succeeded
          ? await prisma.mediaAsset.create({
              data: {
                id: `${batch.id}-asset-${index}`,
                ownerId: admin,
                sourceJobId: job.id,
                type: "image",
                url: `https://example.test/${batch.id}-${index}.png`,
                safetyStatus: "passed",
                metadata: {},
              },
            })
          : null;
        await prisma.contentProductionItem.create({
          data: {
            id: `${batch.id}-item-${index}`,
            batchId: batch.id,
            jobId: job.id,
            mediaAssetId: asset?.id,
            itemIndex: index,
            status: succeeded ? "approved" : "failed",
            tags: [],
          },
        });
      }
      return batch;
    }

    const fixtures = await Promise.all([
      createRun("zero", 0),
      createRun("partial", 1),
      createRun("full", 4),
    ]);
    const expected = ["failed", "partially_succeeded", "succeeded"];
    for (const [index, batch] of fixtures.entries()) {
      const detail = await api("GET", `admin/content/production/batches/${batch.id}`, {
        userId: admin,
        role: "admin",
      });
      expectOk(detail);
      expect(detail.data.batch.status).toBe("completed");
      expect(detail.data.batch.state).toMatchObject({
        executionOutcome: expected[index],
        legacyState: "completed",
        counts: {
          generated: index === 0 ? 0 : index === 1 ? 1 : 4,
          failed: index === 0 ? 4 : index === 1 ? 3 : 0,
          total: 4,
        },
      });
    }
  });
});

describe("billing operations", () => {
  it("lists subscriptions with plan + status and gates by billing.read", async () => {
    const support = await setupActor("support", "billing-subs");
    const ops = await setupActor("ops", "billing-subs");
    const owner = `${P}sub-owner`;
    await createUser({ id: owner });
    // 复用 seed 的 premium 套餐，避免 (slug, billingPeriod) 唯一约束碰撞。
    const plan = await prisma.plan.findFirstOrThrow({ where: { slug: "premium" } });
    await prisma.subscription.create({
      data: {
        id: `${P}sub-1`,
        userId: owner,
        planId: plan.id,
        provider: "mock",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    // ops 无 billing.read。
    expectError(await api("GET", "admin/billing/subscriptions", { userId: ops, role: "ops" }), 403);

    const list = await api("GET", "admin/billing/subscriptions", {
      userId: support,
      role: "support",
      query: { userId: owner },
    });
    expectOk(list);
    expect(list.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${P}sub-1`,
          plan: "premium",
          status: "active",
          provider: "mock",
        }),
      ]),
    );
  });

  it("reconciles ledger by reason over the window with one active-subscription count", async () => {
    const admin = await setupActor("admin", "billing-recon");
    const owner = `${P}recon-owner`;
    await createUser({ id: owner });
    await prisma.dreamcoinLedger.create({
      data: {
        id: `${P}recon-grant`,
        userId: owner,
        delta: 250,
        balanceAfter: 250,
        reason: "signup_bonus",
        sourceId: `${P}recon-grant`,
      },
    });
    await prisma.dreamcoinLedger.create({
      data: {
        id: `${P}recon-spend-1`,
        userId: owner,
        delta: -5,
        balanceAfter: 245,
        reason: "generation_spend",
        sourceId: `${P}recon-spend-1`,
      },
    });
    await prisma.dreamcoinLedger.create({
      data: {
        id: `${P}recon-spend-2`,
        userId: owner,
        delta: -5,
        balanceAfter: 240,
        reason: "generation_spend",
        sourceId: `${P}recon-spend-2`,
      },
    });

    const recon = await api("GET", "admin/billing/reconciliation", { userId: admin, role: "admin" });
    expectOk(recon);
    // 全局窗口聚合，断言用 >=/<= 以兼容并发测试数据。
    const byReason = Object.fromEntries(
      (recon.data.byReason as Array<{ reason: string; totalDelta: number; count: number }>).map(
        (row) => [row.reason, row],
      ),
    );
    expect(byReason.signup_bonus?.totalDelta).toBeGreaterThanOrEqual(250);
    expect(byReason.generation_spend?.totalDelta).toBeLessThanOrEqual(-10);
    expect(recon.data.totals.entries).toBeGreaterThanOrEqual(3);
    expect(typeof recon.data.activeSubscriptions).toBe("number");
  });
});

describe("analytics overview", () => {
  it("aggregates funnel/economy and gates by analytics.export", async () => {
    const analyst = await setupActor("analyst", "analytics");
    const ops = await setupActor("ops", "analytics");
    const owner = `${P}an-owner`;
    await createUser({ id: owner });
    const plan = await prisma.plan.findFirstOrThrow({ where: { slug: "premium" } });
    await prisma.subscription.create({
      data: { id: `${P}an-sub`, userId: owner, planId: plan.id, provider: "mock", status: "active" },
    });
    await prisma.generationJob.create({
      data: {
        id: `${P}an-job`,
        userId: owner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        costDreamcoins: 5,
      },
    });
    await prisma.dreamcoinLedger.create({
      data: {
        id: `${P}an-grant`,
        userId: owner,
        delta: 100,
        balanceAfter: 100,
        reason: "subscription_grant",
        sourceId: `${P}an-grant`,
      },
    });
    await prisma.dreamcoinLedger.create({
      data: {
        id: `${P}an-spend`,
        userId: owner,
        delta: -5,
        balanceAfter: 95,
        reason: "generation_spend",
        sourceId: `${P}an-job`,
      },
    });

    // ops 无 analytics.export。
    expectError(await api("GET", "admin/analytics/overview", { userId: ops, role: "ops" }), 403);

    const overview = await api("GET", "admin/analytics/overview", {
      userId: analyst,
      role: "analyst",
    });
    expectOk(overview);
    // Phase 0 truth containment: exact signups remain visible, but the old
    // generation-as-activation and cross-window conversion are invalid.
    expect(overview.data.funnel.signups).toBeGreaterThanOrEqual(1);
    expect(overview.data.funnel).toMatchObject({
      activatedUsers: null,
      payingUsers: null,
      conversionRate: null,
      qualityState: "invalid",
      validForDecisions: false,
    });
    expect(overview.data.funnel.legacyObserved).toMatchObject({
      activatedUsers: expect.any(Number),
      payingUsers: expect.any(Number),
      conversionRate: expect.any(Number),
    });
    expect(overview.data.generation.total).toBeGreaterThanOrEqual(1);
    expect(overview.data.economy.coinsGranted).toBeGreaterThanOrEqual(100);
    expect(overview.data.economy.coinsSpent).toBeLessThanOrEqual(-5);
    const eventNames = (overview.data.topEvents as Array<{ name: string }>).map((e) => e.name);
    expect(Array.isArray(eventNames)).toBe(true);
  });
});

describe("risk / abuse overview", () => {
  it("flags multi-account device clusters, referral farming, and adjust anomalies", async () => {
    const support = await setupActor("support", "abuse");
    const ops = await setupActor("ops", "abuse");

    // 多账号：同 anonymousId 下两个账号各一条 signup 事件。
    const anon = `${P}device-shared`;
    const accountA = `${P}abuse-a`;
    const accountB = `${P}abuse-b`;
    await createUser({ id: accountA });
    await createUser({ id: accountB });
    await prisma.analyticsEvent.create({
      data: { id: `${P}ev-a`, userId: accountA, anonymousId: anon, name: "signup", props: {} },
    });
    await prisma.analyticsEvent.create({
      data: { id: `${P}ev-b`, userId: accountB, anonymousId: anon, name: "signup", props: {} },
    });

    // Referral 薅取：一个 inviter 三条邀请。
    const inviter = `${P}abuse-inviter`;
    await createUser({ id: inviter });
    for (let i = 0; i < 3; i += 1) {
      await prisma.referral.create({
        data: { id: `${P}ref-${i}`, inviterId: inviter, code: `${P}code-${i}` },
      });
    }

    // 异常 admin_adjust：一个用户两条人工调整。
    const adjusted = `${P}abuse-adjusted`;
    await createUser({ id: adjusted });
    await prisma.dreamcoinLedger.create({
      data: { id: `${P}adj-1`, userId: adjusted, delta: 500, balanceAfter: 500, reason: "admin_adjust", sourceId: `${P}adj-1` },
    });
    await prisma.dreamcoinLedger.create({
      data: { id: `${P}adj-2`, userId: adjusted, delta: 500, balanceAfter: 1000, reason: "admin_adjust", sourceId: `${P}adj-2` },
    });

    // ops 无 billing.read。
    expectError(await api("GET", "admin/risk/abuse", { userId: ops, role: "ops" }), 403);

    const res = await api("GET", "admin/risk/abuse", { userId: support, role: "support" });
    expectOk(res);

    const cluster = (res.data.deviceClusters as Array<{ anonymousId: string; accountCount: number; userIds: string[] }>).find(
      (item) => item.anonymousId === anon,
    );
    expect(cluster?.accountCount).toBe(2);
    expect(cluster?.userIds).toEqual(expect.arrayContaining([accountA, accountB]));

    const referral = (res.data.referralAbuse as Array<{ inviterId: string; referralCount: number }>).find(
      (item) => item.inviterId === inviter,
    );
    expect(referral?.referralCount).toBeGreaterThanOrEqual(3);

    const anomaly = (res.data.adjustAnomalies as Array<{ userId: string; count: number; totalDelta: number }>).find(
      (item) => item.userId === adjusted,
    );
    expect(anomaly?.count).toBe(2);
    expect(anomaly?.totalDelta).toBe(1000);
  });
});

describe("provider ops dashboard", () => {
  it("aggregates per-provider success rate, cost, and latency; gates by ops.queue.read", async () => {
    const ops = await setupActor("ops", "prov");
    const analyst = await setupActor("analyst", "prov");
    const owner = `${P}prov-owner`;
    await createUser({ id: owner });
    const provider = `${P}runner`;
    const t0 = new Date();
    await prisma.generationJob.create({
      data: {
        id: `${P}prov-c1`,
        userId: owner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        costDreamcoins: 5,
        provider,
        createdAt: t0,
        completedAt: new Date(t0.getTime() + 2000),
      },
    });
    await prisma.generationJob.create({
      data: {
        id: `${P}prov-c2`,
        userId: owner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        costDreamcoins: 5,
        provider,
        createdAt: t0,
        completedAt: new Date(t0.getTime() + 4000),
      },
    });
    await prisma.generationJob.create({
      data: {
        id: `${P}prov-f1`,
        userId: owner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        costDreamcoins: 5,
        provider,
      },
    });

    // analyst 无 ops.queue.read。
    expectError(await api("GET", "admin/ops/providers", { userId: analyst, role: "analyst" }), 403);

    const res = await api("GET", "admin/ops/providers", { userId: ops, role: "ops" });
    expectOk(res);
    const row = (res.data.providers as Array<Record<string, number | string>>).find(
      (item) => item.provider === provider,
    );
    expect(row).toBeTruthy();
    expect(row?.total).toBe(3);
    expect(row?.completed).toBe(2);
    expect(row?.failed).toBe(1);
    expect(row?.successRate).toBe(67); // round(2/3*100)
    expect(row?.coinsCost).toBe(15);
    expect(row?.avgCostPerJob).toBe(5);
    expect(row?.latencySamples).toBe(2);
    expect(Number(row?.latencyP95Ms)).toBeGreaterThanOrEqual(2000);
  });
});

describe("user permission overrides", () => {
  it("grants, revokes, and clears effective permissions with audit; admin-only", async () => {
    const admin = await setupActor("admin", "perm-mgr");
    const support = await setupActor("support", "perm-target");

    // baseline：support 无 billing.ledger.adjust。
    expectError(
      await api("POST", "admin/billing/adjustments", {
        userId: support,
        role: "support",
        body: { userId: support, delta: 1, reason: "noop baseline", confirmation: `${support}:1` },
      }),
      403,
    );

    // 管理 override 是 admin only：support 不能自授。
    expectError(
      await api("POST", `admin/users/${support}/permissions`, {
        userId: support,
        role: "support",
        body: {
          permissionKey: "billing.ledger.adjust",
          effect: "grant",
          reason: "self grant attempt",
          confirmation: `${support}:billing.ledger.adjust:grant`,
        },
      }),
      403,
    );

    const wrongGrantConfirmation = await api("POST", `admin/users/${support}/permissions`, {
      userId: admin,
      role: "admin",
      body: {
        permissionKey: "billing.ledger.adjust",
        effect: "grant",
        reason: "wrong grant confirmation",
        confirmation: "PERMISSION",
      },
    });
    expectError(wrongGrantConfirmation, 400, "bad_request");
    expect(await prisma.adminUserPermission.count({ where: { userId: support } })).toBe(0);

    // admin 授予 support billing.ledger.adjust → 现在能调整 ledger。
    expectOk(
      await api("POST", `admin/users/${support}/permissions`, {
        userId: admin,
        role: "admin",
        body: {
          permissionKey: "billing.ledger.adjust",
          effect: "grant",
          reason: "temp finance cover",
          confirmation: `${support}:billing.ledger.adjust:grant`,
        },
      }),
    );
    expectOk(
      await api("POST", "admin/billing/adjustments", {
        userId: support,
        role: "support",
        body: { userId: support, delta: 1, reason: "granted adjust", confirmation: `${support}:1` },
      }),
    );

    // revoke billing.read → support 看不了 ledger。
    expectOk(
      await api("POST", `admin/users/${support}/permissions`, {
        userId: admin,
        role: "admin",
        body: {
          permissionKey: "billing.read",
          effect: "revoke",
          reason: "scope down",
          confirmation: `${support}:billing.read:revoke`,
        },
      }),
    );
    expectError(await api("GET", "admin/billing/ledger", { userId: support, role: "support" }), 403);

    const list = await api("GET", `admin/users/${support}/permissions`, {
      userId: admin,
      role: "admin",
    });
    expectOk(list);
    expect(list.data.effective).toContain("billing.ledger.adjust");
    expect(list.data.effective).not.toContain("billing.read");

    // clear revoke → billing.read 恢复。
    expectOk(
      await api("POST", `admin/users/${support}/permissions`, {
        userId: admin,
        role: "admin",
        body: {
          permissionKey: "billing.read",
          effect: "clear",
          reason: "restore",
          confirmation: `${support}:billing.read:clear`,
        },
      }),
    );
    expectOk(await api("GET", "admin/billing/ledger", { userId: support, role: "support" }));

    // 未知 key 拒绝。
    expectError(
      await api("POST", `admin/users/${support}/permissions`, {
        userId: admin,
        role: "admin",
        body: {
          permissionKey: "not.a.real.key",
          effect: "grant",
          reason: "bad key",
          confirmation: `${support}:not.a.real.key:grant`,
        },
      }),
      400,
    );

    const actions = (
      await prisma.adminAuditLog.findMany({
        where: { actorId: admin, targetType: "user", targetId: support },
      })
    ).map((audit) => audit.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "admin.permission.grant",
        "admin.permission.revoke",
        "admin.permission.clear",
      ]),
    );
    await expect(prisma.mainOutboxEvent.count({
      where: { aggregateId: support, eventType: "admin.user.permission_changed.v2" },
    })).resolves.toBe(3);
  });
});

describe("support plaintext gate", () => {
  it("requires consent or legal hold and redacts audit payloads", async () => {
    const support = await setupActor("support", "plaintext");
    const owner = `${P}plain-owner`;
    await createUser({ id: owner });
    const job = await prisma.generationJob.create({
      data: {
        id: `${P}plain-job`,
        userId: owner,
        mode: "image",
        prompt: "secret prompt text",
        negativePrompt: "secret negative",
        controls: {},
        presetIds: [],
        status: "failed",
        costDreamcoins: 10,
        provider: "mock-pipeline",
        errorCode: "provider_failed",
      },
    });

    const denied = await api("POST", "admin/support/plaintext/view", {
      userId: support,
      role: "support",
      body: {
        targetType: "generation_job",
        targetId: job.id,
        ticketId: `${P}ticket`,
        reason: "debug user issue",
        confirmation: job.id,
      },
    });
    expectError(denied, 403, "forbidden");

    const wrongOwner = `${P}plain-wrong-owner`;
    await createUser({ id: wrongOwner });
    await prisma.supportConsentGrant.create({
      data: {
        id: `${P}wrong-owner-grant`,
        userId: wrongOwner,
        ticketId: `${P}wrong-ticket`,
        targetType: "generation_job",
        targetId: job.id,
        scope: { fields: ["prompt", "negativePrompt"] },
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        createdById: support,
      },
    });
    const wrongOwnerGrant = await api("POST", "admin/support/plaintext/view", {
      userId: support,
      role: "support",
      body: {
        targetType: "generation_job",
        targetId: job.id,
        ticketId: `${P}wrong-ticket`,
        reason: "debug user issue",
        confirmation: job.id,
      },
    });
    expectError(wrongOwnerGrant, 403, "forbidden");

    await prisma.supportConsentGrant.create({
      data: {
        id: `${P}grant`,
        userId: owner,
        ticketId: `${P}ticket`,
        targetType: "generation_job",
        targetId: job.id,
        scope: { fields: ["prompt"] },
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        createdById: support,
      },
    });

    const genericView = await api("POST", "admin/support/plaintext/view", {
      userId: support,
      role: "support",
      body: {
        targetType: "generation_job",
        targetId: job.id,
        ticketId: `${P}ticket`,
        reason: "debug user issue",
        confirmation: "VIEW",
      },
    });
    expectError(genericView, 400, "bad_request");

    const allowed = await api("POST", "admin/support/plaintext/view", {
      userId: support,
      role: "support",
      body: {
        targetType: "generation_job",
        targetId: job.id,
        ticketId: `${P}ticket`,
        reason: "debug user issue",
        confirmation: job.id,
      },
    });
    expectOk(allowed);
    expect(allowed.data.plaintext.prompt).toBe("secret prompt text");
    expect(allowed.data.plaintext.negativePrompt).toBeUndefined();

    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { actorId: support, action: "support.plaintext.view" },
    });
    expect(JSON.stringify(audit)).not.toContain("secret prompt text");
    expect(JSON.stringify(audit)).not.toContain("secret negative");
    expect(JSON.stringify(audit.after)).toContain("viewedFields");
  });
});

// ───────────────────────── Phase 2 admin capabilities (ADMIN_PHASE2_DESIGN) ─────────────────────────

describe("admin saved views (F1)", () => {
  it("are owner-scoped: create/list/delete only touch the actor's own views", async () => {
    const a = await setupActor("admin", "sv-a");
    const b = await setupActor("admin", "sv-b");

    const created = await api("POST", "admin/saved-views", {
      userId: a,
      role: "admin",
      body: { scope: "moderation", label: "My queue", filters: { status: "open" } },
    });
    expectOk(created);
    const viewId = created.data.view.id as string;

    const listA = await api("GET", "admin/saved-views", { userId: a, role: "admin", query: { scope: "moderation" } });
    expectOk(listA);
    expect(listA.data.items).toHaveLength(1);

    // B cannot see A's view, and cannot delete it (owner-scoped → 404).
    const listB = await api("GET", "admin/saved-views", { userId: b, role: "admin", query: { scope: "moderation" } });
    expectOk(listB);
    expect(listB.data.items).toHaveLength(0);
    expectError(await api("DELETE", `admin/saved-views/${viewId}`, { userId: b, role: "admin" }), 404);

    expectOk(await api("DELETE", `admin/saved-views/${viewId}`, { userId: a, role: "admin" }));
    const listAfter = await api("GET", "admin/saved-views", { userId: a, role: "admin", query: { scope: "moderation" } });
    expect(listAfter.data.items).toHaveLength(0);
  });
});

describe("admin content/character governance (F2)", () => {
  it("lists, filters, and takes down characters with audit + permission gating", async () => {
    const admin = await setupActor("admin", "content");
    const ops = await setupActor("ops", "content"); // lacks content.read
    const charId = `${P}gov-char`;
    await createCharacter({ id: charId, name: "Governable", visibility: "public", status: "approved" });

    // ops lacks content.read → 403 on both read and write.
    expectError(await api("GET", "admin/content/characters", { userId: ops, role: "ops" }), 403);
    expectError(
      await api("POST", `admin/content/characters/${charId}/visibility`, {
        userId: ops,
        role: "ops",
        body: { visibility: "private", reason: "test", confirmation: `${charId}:visibility:private` },
      }),
      403,
    );

    const list = await api("GET", "admin/content/characters", {
      userId: admin,
      role: "admin",
      query: { search: "Governable" },
    });
    expectOk(list);
    expect(list.data.items.some((c: { id: string }) => c.id === charId)).toBe(true);

    const detail = await api("GET", `admin/content/characters/${charId}`, { userId: admin, role: "admin" });
    expectOk(detail);
    expect(detail.data.character.id).toBe(charId);

    const wrongVisibility = await api("POST", `admin/content/characters/${charId}/visibility`, {
      userId: admin,
      role: "admin",
      body: { visibility: "private", reason: "valid reason", confirmation: "VISIBILITY" },
    });
    expectError(wrongVisibility, 400, "bad_request");
    expect((await prisma.character.findUniqueOrThrow({ where: { id: charId } })).visibility).toBe("public");

    const privateVisibility = await api("POST", `admin/content/characters/${charId}/visibility`, {
      userId: admin,
      role: "admin",
      body: {
        visibility: "private",
        reason: "hide public listing",
        confirmation: `${charId}:visibility:private`,
      },
    });
    expectOk(privateVisibility);
    expect(privateVisibility.data.character.visibility).toBe("private");

    const visibilityAudit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.visibility.write", targetId: charId },
    });
    expect(visibilityAudit).not.toBeNull();

    const wrongStatus = await api("POST", `admin/content/characters/${charId}/status`, {
      userId: admin,
      role: "admin",
      body: { status: "removed", reason: "policy violation", confirmation: "STATUS" },
    });
    expectError(wrongStatus, 400, "bad_request");
    expect((await prisma.character.findUniqueOrThrow({ where: { id: charId } })).status).toBe("approved");

    // Takedown: set status=removed (typed+reason), audited.
    const removed = await api("POST", `admin/content/characters/${charId}/status`, {
      userId: admin,
      role: "admin",
      body: { status: "removed", reason: "policy violation", confirmation: `${charId}:status:removed` },
    });
    expectOk(removed);
    expect(removed.data.character.status).toBe("removed");

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.status.write", targetId: charId },
    });
    expect(audit).not.toBeNull();
  });
});

describe("admin content/character chat image tool toggle (P4 Task 6)", () => {
  it("gates on content.production.write, merges advancedDetails immutably, and audits", async () => {
    const admin = await setupActor("admin", "chattool");
    const support = await setupActor("support", "chattool");
    const charId = `${P}chat-tool-char`;
    await createCharacter({ id: charId, name: "Chat Tool Char" });
    await prisma.character.update({
      where: { id: charId },
      data: { advancedDetails: { personality: "shy", hobbies: ["reading"] } },
    });

    const forbidden = await api("POST", `admin/content/characters/${charId}/chat-tools`, {
      userId: support,
      role: "support",
      body: { imageToolEnabled: false, reason: "toggle chat image tool" },
    });
    expectError(forbidden, 403);

    const badBody = await api("POST", `admin/content/characters/${charId}/chat-tools`, {
      userId: admin,
      role: "admin",
      body: { imageToolEnabled: false },
    });
    expectError(badBody, 400);

    const disable = await api("POST", `admin/content/characters/${charId}/chat-tools`, {
      userId: admin,
      role: "admin",
      body: { imageToolEnabled: false, reason: "toggle chat image tool" },
    });
    expectOk(disable);

    const afterDisable = await prisma.character.findUniqueOrThrow({ where: { id: charId } });
    expect(afterDisable.advancedDetails).toMatchObject({
      imageToolEnabled: false,
      personality: "shy",
      hobbies: ["reading"],
    });

    const enable = await api("POST", `admin/content/characters/${charId}/chat-tools`, {
      userId: admin,
      role: "admin",
      body: { imageToolEnabled: true, reason: "toggle chat image tool" },
    });
    expectOk(enable);

    const afterEnable = await prisma.character.findUniqueOrThrow({ where: { id: charId } });
    expect(afterEnable.advancedDetails).toMatchObject({
      imageToolEnabled: true,
      personality: "shy",
      hobbies: ["reading"],
    });

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.chat-tools.write", targetId: charId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();

    const missing = await api("POST", `admin/content/characters/${P}nope/chat-tools`, {
      userId: admin,
      role: "admin",
      body: { imageToolEnabled: false, reason: "toggle chat image tool" },
    });
    expectError(missing, 404);
  });
});

describe("admin featured curation (F3)", () => {
  afterAll(async () => {
    await prisma.appSetting.deleteMany({ where: { key: "feed.featured" } });
  });

  it("only keeps public+approved ids and surfaces them first in the public feed", async () => {
    const admin = await setupActor("admin", "feat");
    const user = await setupActor("user", "feat");
    const hot = `${P}feat-hot`;
    const cold = `${P}feat-cold`;
    const priv = `${P}feat-priv`;
    await createCharacter({ id: hot, name: "Hot", chats: 999, visibility: "public", status: "approved" });
    await createCharacter({ id: cold, name: "Cold", chats: 0, visibility: "public", status: "approved" });
    await createCharacter({ id: priv, name: "Priv", visibility: "private", status: "draft" });

    // Feature the cold (low-traffic) one + a private one; private must be dropped.
    const put = await api("PUT", "admin/content/featured", {
      userId: admin,
      role: "admin",
      body: { characterIds: [cold, priv], reason: "promo push", confirmation: `${cold},${priv}` },
    });
    expectOk(put);
    expect(put.data.characterIds).toEqual([cold]);
    expect(put.data.skipped).toContain(priv);

    const wrongConfirmation = await api("PUT", "admin/content/featured", {
      userId: admin,
      role: "admin",
      body: { characterIds: [hot], reason: "wrong confirmation", confirmation: "FEATURED" },
    });
    expectError(wrongConfirmation, 400, "bad_request");
    const settingAfterWrong = await prisma.appSetting.findUniqueOrThrow({ where: { key: "feed.featured" } });
    expect((settingAfterWrong.value as { characterIds?: string[] }).characterIds).toEqual([cold]);

    // Public feed: the featured public+approved character appears first; private picks are absent.
    const feed = await api("GET", "feed", { userId: user, role: "user", ageGate: true });
    expectOk(feed);
    const ids: string[] = (
      feed.data.items as Array<{ type: string; character?: { id: string } }>
    )
      .filter((item) => item.type === "character")
      .map((item) => item.character?.id)
      .filter((id): id is string => Boolean(id));
    expect(ids[0]).toBe(cold);
    expect(ids).not.toContain(priv);
  });
});

describe("admin promo: redeem codes + referrals (F4)", () => {
  it("creates/lists/disables redeem codes (no plaintext) with permission gating", async () => {
    const admin = await setupActor("admin", "promo");
    const analyst = await setupActor("analyst", "promo"); // has growth.promo.read, not write
    const ops = await setupActor("ops", "promo"); // has neither

    expectError(await api("GET", "admin/promo/redeem-codes", { userId: ops, role: "ops" }), 403);

    const created = await api("POST", "admin/promo/redeem-codes", {
      userId: admin,
      role: "admin",
      body: {
        code: `${P}WELCOME50`,
        reward: { dreamcoins: 50, note: "welcome" },
        maxRedemptions: 100,
        reason: "launch promo",
        confirmation: `${P}WELCOME50`,
      },
    });
    expectOk(created);
    const codeId = created.data.id as string;

    const wrongConfirmation = await api("POST", "admin/promo/redeem-codes", {
      userId: admin,
      role: "admin",
      body: {
        code: `${P}WRONGCONFIRM`,
        reward: { dreamcoins: 25 },
        maxRedemptions: 10,
        reason: "wrong confirmation",
        confirmation: "CREATE",
      },
    });
    expectError(wrongConfirmation, 400, "bad_request");

    // analyst can read, cannot write.
    expectOk(await api("GET", "admin/promo/redeem-codes", { userId: analyst, role: "analyst" }));
    expectError(
      await api("POST", `admin/promo/redeem-codes/${codeId}/disable`, {
        userId: analyst,
        role: "analyst",
        body: { reason: "x", confirmation: "DISABLE" },
      }),
      403,
    );

    // Plaintext code never returned by list.
    const list = await api("GET", "admin/promo/redeem-codes", { userId: admin, role: "admin" });
    expect(JSON.stringify(list.json)).not.toContain("WELCOME50");

    const redeemer = `${P}promo-redeemer`;
    await createUser({ id: redeemer });
    const redeemed = await api("POST", "redeem-codes/redeem", {
      userId: redeemer,
      body: { code: `${P}WELCOME50` },
    });
    expectOk(redeemed);
    expect(redeemed.data.dreamcoins).toBe(50);

    const listAfterRedeem = await api("GET", "admin/promo/redeem-codes", {
      userId: admin,
      role: "admin",
    });
    expectOk(listAfterRedeem);
    const listedCreatedCode = (listAfterRedeem.data.items as Array<{ id: string; redemptions: number }>).find(
      (item) => item.id === codeId,
    );
    expect(listedCreatedCode?.redemptions).toBe(1);

    const disabled = await api("POST", `admin/promo/redeem-codes/${codeId}/disable`, {
      userId: admin,
      role: "admin",
      body: { reason: "fraud", confirmation: "DISABLE" },
    });
    expectError(disabled, 400, "bad_request");

    const exactDisabled = await api("POST", `admin/promo/redeem-codes/${codeId}/disable`, {
      userId: admin,
      role: "admin",
      body: { reason: "fraud", confirmation: codeId },
    });
    expectOk(exactDisabled);
    expect(exactDisabled.data.status).toBe("disabled");

    // Audit must not leak the plaintext code.
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "promo.redeem_code.create", targetId: codeId },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain("WELCOME50");

    expectOk(await api("GET", "admin/promo/referrals", { userId: admin, role: "admin" }));
  });
});

describe("admin dual-approval (F5)", () => {
  it("enforces requester holds the key, approver differs from requester, single-shot state", async () => {
    const a1 = await setupActor("admin", "appr-1");
    const a2 = await setupActor("admin", "appr-2");
    const support = await setupActor("support", "appr"); // lacks config.pricing.write & approval.review
    const targetId = `${P}rule`;
    const requestConfirmation = `${targetId}:config.pricing.publish`;

    // Requester must hold the target key: support cannot request config.pricing.write.
    expectError(
      await api("POST", "admin/approvals", {
        userId: support,
        role: "support",
        body: {
          permissionKey: "config.pricing.write",
          action: "config.pricing.publish",
          targetType: "pricing_rule",
          targetId,
          payload: { baseCost: 4 },
          reason: "drop image price",
          confirmation: requestConfirmation,
        },
      }),
      403,
    );

    const genericRequest = await api("POST", "admin/approvals", {
      userId: a1,
      role: "admin",
      body: {
        permissionKey: "config.pricing.write",
        action: "config.pricing.publish",
        targetType: "pricing_rule",
        targetId,
        payload: { baseCost: 4 },
        reason: "drop image price",
        confirmation: "REQUEST",
      },
    });
    expectError(genericRequest, 400, "bad_request");

    const created = await api("POST", "admin/approvals", {
      userId: a1,
      role: "admin",
      body: {
        permissionKey: "config.pricing.write",
        action: "config.pricing.publish",
        targetType: "pricing_rule",
        targetId,
        payload: { baseCost: 4 },
        reason: "drop image price",
        confirmation: requestConfirmation,
      },
    });
    expectOk(created);
    const reqId = created.data.request.id as string;

    // support lacks approval.review → 403.
    expectError(
      await api("POST", `admin/approvals/${reqId}/approve`, {
        userId: support,
        role: "support",
        body: { reason: "ok", confirmation: reqId },
      }),
      403,
    );

    // Requester cannot self-approve.
    expectError(
      await api("POST", `admin/approvals/${reqId}/approve`, {
        userId: a1,
        role: "admin",
        body: { reason: "self", confirmation: reqId },
      }),
      400,
    );

    const genericApprove = await api("POST", `admin/approvals/${reqId}/approve`, {
      userId: a2,
      role: "admin",
      body: { reason: "looks right", confirmation: "APPROVE" },
    });
    expectError(genericApprove, 400, "bad_request");

    // A different admin approves.
    const approved = await api("POST", `admin/approvals/${reqId}/approve`, {
      userId: a2,
      role: "admin",
      body: { reason: "looks right", confirmation: reqId },
    });
    expectOk(approved);
    expect(approved.data.request.status).toBe("approved");
    expect(approved.data.request.approvedById).toBe(a2);

    // Cannot re-decide a settled request.
    expectError(
      await api("POST", `admin/approvals/${reqId}/reject`, {
        userId: a2,
        role: "admin",
        body: { reason: "again", confirmation: reqId },
      }),
      400,
    );

    const pending = await api("GET", "admin/approvals", { userId: a1, role: "admin", query: { status: "pending" } });
    expectOk(pending);
    expect(pending.data.items.some((r: { id: string }) => r.id === reqId)).toBe(false);
  });
});

describe("admin chat ops proxy (F6)", () => {
  it("gates on chat.ops.read and degrades when chat service is not configured", async () => {
    const admin = await setupActor("admin", "chatops");
    const analyst = await setupActor("analyst", "chatops"); // lacks chat.ops.read

    expectError(await api("GET", "admin/chat/overview", { userId: analyst, role: "analyst" }), 403);

    const overview = await api("GET", "admin/chat/overview", { userId: admin, role: "admin" });
    expectOk(overview);
    expect(typeof overview.data.configured).toBe("boolean");

    const sessions = await api("GET", "admin/chat/sessions", { userId: admin, role: "admin" });
    expectOk(sessions);
    expect(Array.isArray(sessions.data.items)).toBe(true);

    const usage = await api("GET", "admin/chat/usage", { userId: admin, role: "admin" });
    expectOk(usage);
    expect(Array.isArray(usage.data.items)).toBe(true);
  });
});

// ───────────────────────── Phase 3: CMS · 合规 · 生成质量/流程 (ADMIN_PHASE3_DESIGN) ─────────────────────────

describe("admin CMS / SEO (T1)", () => {
  const path = `/${P}cms-landing`;
  afterAll(async () => {
    await prisma.routePage.deleteMany({ where: { path: { startsWith: `/${P}cms` } } });
  });

  it("CRUD + publish with permission gating and audit", async () => {
    const admin = await setupActor("admin", "cms");
    const analyst = await setupActor("analyst", "cms"); // lacks content.cms.write

    expectError(
      await api("POST", "admin/cms/pages", {
        userId: analyst,
        role: "analyst",
        body: { path, title: "X", description: "d", reason: "x", confirmation: path },
      }),
      403,
    );

    expectError(
      await api("POST", "admin/cms/pages", {
        userId: admin,
        role: "admin",
        body: {
          path,
          title: "AI Girlfriend Guide",
          description: "Everything about AI companions.",
          reason: "seed cms page",
          confirmation: "CMS",
        },
      }),
      400,
    );

    const created = await api("POST", "admin/cms/pages", {
      userId: admin,
      role: "admin",
      body: {
        path,
        title: "AI Girlfriend Guide",
        description: "Everything about AI companions.",
        body: { heading: "Guide", sections: [{ heading: "Intro", paragraphs: ["Hello."] }] },
        contentStatus: "draft",
        reason: "seed cms page",
        confirmation: path,
      },
    });
    expectOk(created);

    // bad confirmation → 400
    expectError(
      await api("PATCH", "admin/cms/pages", {
        userId: admin,
        role: "admin",
        body: { path, title: "Y", reason: "valid edit reason", confirmation: "CMS" },
      }),
      400,
    );

    const patched = await api("PATCH", "admin/cms/pages", {
      userId: admin,
      role: "admin",
      body: { path, title: "AI Girlfriend Guide Updated", reason: "valid edit reason", confirmation: path },
    });
    expectOk(patched);
    expect(patched.data.page.title).toBe("AI Girlfriend Guide Updated");

    expectError(
      await api("POST", "admin/cms/pages/publish", {
        userId: admin,
        role: "admin",
        body: { path, contentStatus: "published", reason: "go live", confirmation: "PUBLISH" },
      }),
      400,
    );

    const published = await api("POST", "admin/cms/pages/publish", {
      userId: admin,
      role: "admin",
      body: { path, contentStatus: "published", reason: "go live", confirmation: path },
    });
    expectOk(published);
    expect(published.data.page.contentStatus).toBe("published");

    const got = await api("GET", "admin/cms/pages", { userId: admin, role: "admin", query: { path } });
    expectOk(got);
    expect(got.data.page.title).toBe("AI Girlfriend Guide Updated");

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "cms.page.publish", targetId: path },
    });
    expect(audit).not.toBeNull();
  });
});

describe("admin compliance: DSAR + age verification (T2)", () => {
  it("exports/erases users and overrides age verification with gating", async () => {
    const admin = await setupActor("admin", "comp");
    const support = await setupActor("support", "comp"); // has compliance.read, not write
    const target = `${P}comp-target`;
    await createUser({ id: target });

    // export: support (read) ok; analyst-like ops would 403 but support has read.
    const exported = await api("GET", `admin/compliance/users/${target}/export`, {
      userId: support,
      role: "support",
    });
    expectOk(exported);
    expect(exported.data.export.user.id).toBe(target);

    // erase: support lacks compliance.write → 403
    expectError(
      await api("POST", `admin/compliance/users/${target}/erase`, {
        userId: support,
        role: "support",
        body: { reason: "dsar request", confirmation: target },
      }),
      403,
    );

    const genericErase = await api("POST", `admin/compliance/users/${target}/erase`, {
      userId: admin,
      role: "admin",
      body: { reason: "dsar erasure request", confirmation: "ERASE" },
    });
    expectError(genericErase, 400, "bad_request");

    const erased = await api("POST", `admin/compliance/users/${target}/erase`, {
      userId: admin,
      role: "admin",
      body: { reason: "dsar erasure request", confirmation: target },
    });
    expectOk(erased);
    expect(erased.data.erased).toBe(true);
    // idempotent second erase
    const again = await api("POST", `admin/compliance/users/${target}/erase`, {
      userId: admin,
      role: "admin",
      body: { reason: "dsar erasure request retry", confirmation: target },
    });
    expectOk(again);
    expect(again.data.idempotent).toBe(true);

    // age verification override
    const avUser = `${P}comp-av`;
    await createUser({ id: avUser });
    const av = await prisma.ageVerification.create({
      data: { userId: avUser, provider: "mock", status: "pending", metadata: {} },
    });
    const list = await api("GET", "admin/compliance/age-verifications", {
      userId: admin,
      role: "admin",
      query: { status: "pending" },
    });
    expectOk(list);
    const genericOverride = await api("POST", `admin/compliance/age-verifications/${av.id}/override`, {
      userId: admin,
      role: "admin",
      body: { status: "verified", reason: "manual appeal approved", confirmation: "OVERRIDE" },
    });
    expectError(genericOverride, 400, "bad_request");

    const override = await api("POST", `admin/compliance/age-verifications/${av.id}/override`, {
      userId: admin,
      role: "admin",
      body: { status: "verified", reason: "manual appeal approved", confirmation: av.id },
    });
    expectOk(override);
    expect(override.data.ageVerification.status).toBe("verified");
  });
});

describe("admin generation health + dry-run (T4)", () => {
  it("aggregates profile health and writes a dry-run summary", async () => {
    const admin = await setupActor("admin", "genh");
    const support = await setupActor("support", "genh"); // lacks generation.config.read
    const jobUser = `${P}genh-user`;
    await createUser({ id: jobUser });
    const profile = await prisma.generationModelProfile.create({
      data: {
        profileKey: `${P}genh-profile`,
        label: "Health profile",
        pipelineModel: "test-model",
        allowedOrientations: ["1:1", "4:5"],
        status: "active",
      },
    });
    await prisma.generationJob.createMany({
      data: [
        { userId: jobUser, mode: "image", controls: {}, presetIds: [], profileId: profile.profileKey, status: "completed", completedAt: new Date() },
        { userId: jobUser, mode: "image", controls: {}, presetIds: [], profileId: profile.id, status: "failed" },
      ],
    });

    expectError(
      await api("GET", `admin/generation/model-profiles/${profile.id}/health`, { userId: support, role: "support" }),
      403,
    );

    const health = await api("GET", `admin/generation/model-profiles/${profile.id}/health`, {
      userId: admin,
      role: "admin",
    });
    expectOk(health);
    expect(health.data.metrics.total).toBeGreaterThanOrEqual(2);
    expect(health.data.metrics.successRate).toBeLessThanOrEqual(100);

    const dryRun = await api("POST", `admin/generation/model-profiles/${profile.id}/dry-run`, {
      userId: admin,
      role: "admin",
      body: { reason: "pre-publish check", confirmation: "DRYRUN" },
    });
    expectError(dryRun, 400, "bad_request");

    const exactDryRun = await api("POST", `admin/generation/model-profiles/${profile.id}/dry-run`, {
      userId: admin,
      role: "admin",
      body: { reason: "pre-publish check", confirmation: profile.id },
    });
    expectOk(exactDryRun);
    expect(exactDryRun.data.dryRun.status).toBe("pass");
    const refreshed = await prisma.generationModelProfile.findUnique({ where: { id: profile.id } });
    expect(refreshed?.dryRunSummary).not.toBeNull();
  });

  it("preserves existing failureMode when writing a new dry-run summary", async () => {
    const admin = await setupActor("admin", "genh-preserve-failure");
    const profile = await prisma.generationModelProfile.create({
      data: {
        profileKey: `${P}genh-failure-profile`,
        label: "Failure preserving profile",
        pipelineModel: "test-model",
        allowedOrientations: ["1:1"],
        status: "draft",
        dryRunSummary: {
          source: "real_image_probe",
          sampleCount: 1,
          successRate: 0,
          failureMode: "pure_white_output",
        },
      },
    });

    const dryRun = await api("POST", `admin/generation/model-profiles/${profile.id}/dry-run`, {
      userId: admin,
      role: "admin",
      body: { reason: "pre-publish check", confirmation: profile.id },
    });
    expectOk(dryRun);
    expect(dryRun.data.dryRun).toMatchObject({
      status: "pass",
      failureMode: "pure_white_output",
    });
    await expect(
      prisma.generationModelProfile.findUnique({ where: { id: profile.id } }),
    ).resolves.toMatchObject({
      dryRunSummary: expect.objectContaining({
        status: "pass",
        failureMode: "pure_white_output",
      }),
    });
  });
});

describe("admin dual-approval hard enforcement (T4)", () => {
  afterAll(async () => {
    await prisma.featureFlag.deleteMany({ where: { key: "dual_approval_enforced" } });
  });

  it("blocks high-risk ledger adjust without an approved request, allows with, rejects reuse", async () => {
    const a1 = await setupActor("admin", "dual1");
    const a2 = await setupActor("admin", "dual2");
    const target = `${P}dual-user`;
    await createUser({ id: target });

    await prisma.featureFlag.upsert({
      where: { key: "dual_approval_enforced" },
      update: { enabled: true },
      create: { key: "dual_approval_enforced", label: "Dual approval", enabled: true, targetRoles: [], targetPlans: [] },
    });
    try {
      const big = { userId: target, delta: 5000, reason: "large comp", confirmation: `${target}:5000` };

      // no approval → 403
      expectError(await api("POST", "admin/billing/adjustments", { userId: a1, role: "admin", body: big }), 403);

      // create + approve a matching request
      const req = await api("POST", "admin/approvals", {
        userId: a1,
        role: "admin",
        body: {
          permissionKey: "billing.ledger.adjust",
          action: "billing.ledger.adjust",
          targetType: "user",
          targetId: target,
          payload: { delta: 5000 },
          reason: "approve large comp",
          confirmation: `${target}:billing.ledger.adjust`,
        },
      });
      expectOk(req);
      expectOk(
        await api("POST", `admin/approvals/${req.data.request.id}/approve`, {
          userId: a2,
          role: "admin",
          body: { reason: "approved ok", confirmation: req.data.request.id },
        }),
      );

      // with approval → ok (consumes credential)
      expectOk(await api("POST", "admin/billing/adjustments", { userId: a1, role: "admin", body: big }));

      // reuse → credential consumed → 403
      expectError(await api("POST", "admin/billing/adjustments", { userId: a1, role: "admin", body: big }), 403);

      const concurrentReq = await api("POST", "admin/approvals", {
        userId: a1,
        role: "admin",
        body: {
          permissionKey: "billing.ledger.adjust",
          action: "billing.ledger.adjust",
          targetType: "user",
          targetId: target,
          payload: { delta: 5000 },
          reason: "approve concurrent comp",
          confirmation: `${target}:billing.ledger.adjust`,
        },
      });
      expectOk(concurrentReq);
      expectOk(
        await api("POST", `admin/approvals/${concurrentReq.data.request.id}/approve`, {
          userId: a2,
          role: "admin",
          body: { reason: "approved once", confirmation: concurrentReq.data.request.id },
        }),
      );

      const concurrent = await Promise.all([
        api("POST", "admin/billing/adjustments", { userId: a1, role: "admin", body: big }),
        api("POST", "admin/billing/adjustments", { userId: a1, role: "admin", body: big }),
      ]);
      expect(concurrent.filter((res) => res.status === 200)).toHaveLength(1);
      expect(concurrent.filter((res) => res.status === 403)).toHaveLength(1);
    } finally {
      await prisma.featureFlag.deleteMany({ where: { key: "dual_approval_enforced" } });
    }
  });
});

describe("admin analytics export + retention (T4)", () => {
  it("returns CSV payload and retention cohorts", async () => {
    const admin = await setupActor("admin", "axp");
    const ops = await setupActor("ops", "axp"); // lacks analytics.export

    expectError(await api("GET", "admin/analytics/export", { userId: ops, role: "ops" }), 403);

    const csv = await api("GET", "admin/analytics/export", { userId: admin, role: "admin" });
    expectOk(csv);
    expect(typeof csv.data.csv).toBe("string");
    expect(csv.data.csv).toContain("section");

    const retention = await api("GET", "admin/analytics/retention", { userId: admin, role: "admin" });
    expectOk(retention);
    expect(retention.data).toMatchObject({ qualityState: "invalid", validForDecisions: false });
    expect(Array.isArray(retention.data.items)).toBe(true);
  });
});

// ───────────────────────── Phase 4: Growth Ops (公告 + 实验度量) ─────────────────────────

describe("admin announcements (Phase 4)", () => {
  afterAll(async () => {
    await prisma.appSetting.deleteMany({ where: { key: "announcements" } });
  });

  it("CRUD + public read filters active, with permission gating", async () => {
    const admin = await setupActor("admin", "ann");
    const analyst = await setupActor("analyst", "ann"); // has growth.promo.read, not write
    const ops = await setupActor("ops", "ann"); // lacks growth.promo.read

    // ops lacks growth.promo.read → list 403
    expectError(await api("GET", "admin/announcements", { userId: ops, role: "ops" }), 403);
    // analyst can't write
    expectError(
      await api("POST", "admin/announcements", {
        userId: analyst,
        role: "analyst",
        body: { title: "x", body: "y", reason: "test promo", confirmation: "ANNOUNCE" },
      }),
      403,
    );
    expectError(
      await api("POST", "admin/announcements", {
        userId: admin,
        role: "admin",
        body: {
          title: "Unsafe link",
          body: "bad protocol",
          href: "javascript:alert(1)",
          reason: "reject unsafe link",
          confirmation: "Unsafe link",
        },
      }),
      400,
    );
    expectError(
      await api("POST", "admin/announcements", {
        userId: admin,
        role: "admin",
        body: {
          title: "Wrong confirmation",
          body: "should not create",
          reason: "reject wrong confirmation",
          confirmation: "ANNOUNCE",
        },
      }),
      400,
    );

    const created = await api("POST", "admin/announcements", {
      userId: admin,
      role: "admin",
      body: {
        title: "Launch sale",
        body: "50% off this week",
        href: "https://help.ourdream.ai/",
        level: "promo",
        active: true,
        reason: "promo launch",
        confirmation: "Launch sale",
      },
    });
    expectOk(created);
    const id = created.data.announcement.id as string;

    // analyst can read (has growth.promo.read)
    expectOk(await api("GET", "admin/announcements", { userId: analyst, role: "analyst" }));

    // public read (no auth) includes the active one
    const pub = await api("GET", "announcements", {});
    expectOk(pub);
    const publicItem = pub.data.items.find((a: { id: string }) => a.id === id) as
      | { href?: string }
      | undefined;
    expect(publicItem?.href).toBe("https://help.ourdream.ai/");

    const wrongUpdateConfirmation = await api("PATCH", `admin/announcements/${id}`, {
      userId: admin,
      role: "admin",
      body: { active: false, reason: "pause promo wrong", confirmation: "ANNOUNCE" },
    });
    expectError(wrongUpdateConfirmation, 400, "bad_request");

    // deactivate → public excludes
    expectOk(
      await api("PATCH", `admin/announcements/${id}`, {
        userId: admin,
        role: "admin",
        body: { active: false, reason: "pause promo", confirmation: id },
      }),
    );
    const pub2 = await api("GET", "announcements", {});
    expect(pub2.data.items.some((a: { id: string }) => a.id === id)).toBe(false);

    expectError(await api("DELETE", `admin/announcements/${id}`, { userId: admin, role: "admin" }), 400);
    expectError(
      await api("DELETE", `admin/announcements/${id}`, {
        userId: admin,
        role: "admin",
        body: { reason: "wrong delete confirmation", confirmation: "DELETE" },
      }),
      400,
      "bad_request",
    );

    // delete → gone
    expectOk(
      await api("DELETE", `admin/announcements/${id}`, {
        userId: admin,
        role: "admin",
        body: { reason: "delete promo", confirmation: id },
      }),
    );
    const list = await api("GET", "admin/announcements", { userId: admin, role: "admin" });
    expect(list.data.items.some((a: { id: string }) => a.id === id)).toBe(false);

    // audit (no plaintext concern) recorded
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "growth.announcement.create", targetId: id },
    });
    expect(audit).not.toBeNull();
  });
});

describe("admin experiments (Phase 4)", () => {
  it("lists flags with directional metrics, gated by analytics.export", async () => {
    const admin = await setupActor("admin", "exp");
    const ops = await setupActor("ops", "exp"); // lacks analytics.export

    expectError(await api("GET", "admin/experiments", { userId: ops, role: "ops" }), 403);

    const res = await api("GET", "admin/experiments", { userId: admin, role: "admin" });
    expectOk(res);
    expect(Array.isArray(res.data.items)).toBe(true);
    expect(typeof res.data.note).toBe("string");
  });
});

describe("admin generation metrics rollup (P3)", () => {
  it("aggregates generation metrics by profile, recipe, source and placements", async () => {
    const admin = await setupActor("admin", "generation-metrics");
    const support = await setupActor("support", "generation-metrics");
    const profileId = `${P}metrics-profile`;
    const recipeId = `${P}metrics-recipe`;
    const base = {
      userId: admin,
      mode: "image",
      controls: {},
      presetIds: [],
      profileId,
      profileVersion: 1,
      recipeId,
      recipeVersion: 1,
      sourceType: "content_production_item",
    } as const;
    await prisma.generationJob.create({
      data: {
        ...base,
        id: `${P}metrics-job-1`,
        sourceId: `${P}metrics-src-1`,
        status: "completed",
        costDreamcoins: 7,
      },
    });
    // completedAt is set via a follow-up update (not at create time) so it is
    // guaranteed to be >= the DB-assigned createdAt (avoids a negative duration
    // from clock skew between the JS `new Date()` and Postgres's `now()`).
    await prisma.generationJob.update({
      where: { id: `${P}metrics-job-1` },
      data: { completedAt: new Date() },
    });
    await prisma.generationJob.create({
      data: {
        ...base,
        id: `${P}metrics-job-2`,
        sourceId: `${P}metrics-src-2`,
        status: "failed",
        costDreamcoins: 7,
      },
    });

    const forbidden = await api("GET", "admin/generation/metrics", {
      userId: support,
      role: "support",
    });
    expectError(forbidden, 403);

    const metrics = await api("GET", "admin/generation/metrics", {
      userId: admin,
      role: "admin",
      query: { days: 7 },
    });
    expectOk(metrics);
    const profileRow = metrics.data.profiles.find(
      (row: { profileId: string }) => row.profileId === profileId,
    );
    expect(profileRow).toMatchObject({
      total: 2,
      completed: 1,
      failed: 1,
      costDreamcoins: 14,
    });
    expect(profileRow.avgDurationMs).toBeGreaterThanOrEqual(0);
    const recipeRow = metrics.data.recipes.find(
      (row: { recipeId: string }) => row.recipeId === recipeId,
    );
    expect(recipeRow).toMatchObject({ total: 2, completed: 1, failed: 1 });
    const sourceRow = metrics.data.sources.find(
      (row: { sourceType: string }) => row.sourceType === "content_production_item",
    );
    expect(sourceRow.total).toBeGreaterThanOrEqual(2);
  });

  it("rolls up placement impression/click events and remix count", async () => {
    const admin = await setupActor("admin", "generation-metrics-engagement");
    const placementId = `${P}placement-1`;
    await prisma.analyticsEvent.create({
      data: {
        id: `${P}impression-1`,
        name: "placement_impression",
        props: { placementId, slot: "campaign" },
      },
    });
    await prisma.analyticsEvent.create({
      data: {
        id: `${P}impression-2`,
        name: "placement_impression",
        props: { placementId, slot: "campaign" },
      },
    });
    await prisma.analyticsEvent.create({
      data: {
        id: `${P}click-1`,
        name: "placement_click",
        props: { placementId, slot: "campaign" },
      },
    });
    await prisma.analyticsEvent.create({
      data: { id: `${P}remix-1`, name: "feed_item_remixed", props: {} },
    });
    await prisma.analyticsEvent.create({
      data: { id: `${P}remix-2`, name: "feed_item_remixed", props: {} },
    });

    const metrics = await api("GET", "admin/generation/metrics", {
      userId: admin,
      role: "admin",
      query: { days: 7 },
    });
    expectOk(metrics);
    const engagementRow = metrics.data.placementEngagement.find(
      (row: { placementId: string | null }) => row.placementId === placementId,
    );
    expect(engagementRow).toMatchObject({ slot: "campaign", impressions: 2, clicks: 1 });
    expect(metrics.data.remix.total).toBeGreaterThanOrEqual(2);
  });
});
