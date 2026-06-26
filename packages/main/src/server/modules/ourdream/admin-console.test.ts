import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("generation config control plane", () => {
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
      promptTemplateId: "template_image_character_default",
      promptTemplateVersion: 1,
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
        dryRunSummary: { sampleCount: 2, successRate: 1 },
      },
    });
    expectOk(draft);

    const publish = await api("POST", `admin/generation/model-profiles/${draft.data.profile.id}/publish`, {
      userId: admin,
      role: "admin",
      body: {
        reason: "verified dry run",
        confirmation: "PUBLISH",
      },
    });
    expectOk(publish);
    expect(publish.data.profile).toMatchObject({ status: "active", version: 2 });
    expect(await prisma.generationModelProfile.findUnique({ where: { id: `${P}profile-v1` } })).toMatchObject({
      status: "archived",
    });

    const rollback = await api("POST", `admin/generation/model-profiles/${publish.data.profile.id}/rollback`, {
      userId: admin,
      role: "admin",
      body: { reason: "regression detected", confirmation: "ROLLBACK" },
    });
    expectOk(rollback);
    expect(rollback.data).toMatchObject({ fromVersion: 2, toVersion: 1 });

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
        confirmation: "DISABLE",
      },
    });
    expectError(hijack, 400, "bad_request");

    const disabled = await api("PATCH", `admin/generation/model-profiles/${profileId}`, {
      userId: admin,
      role: "admin",
      body: { enabled: false, reason: "pause bad profile", confirmation: "DISABLE" },
    });
    expectOk(disabled);
    expect(await prisma.generationModelProfile.findUnique({ where: { id: profileId } })).toMatchObject({
      enabled: false,
      pipelineModel: "mock-image",
    });
  });

  it("publishes prompt templates with dry-run evidence and archives the previous active version", async () => {
    const admin = await setupActor("admin", "prompt");
    await prisma.generationPromptTemplate.create({
      data: {
        id: `${P}template-v1`,
        templateKey: `${P}template`,
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

    const draft = await api("POST", "admin/generation/prompt-templates", {
      userId: admin,
      role: "admin",
      body: {
        templateKey: `${P}template`,
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

    const publish = await api("POST", `admin/generation/prompt-templates/${draft.data.template.id}/publish`, {
      userId: admin,
      role: "admin",
      body: { reason: "sample matrix passed", confirmation: "PUBLISH" },
    });
    expectOk(publish);
    expect(publish.data.template).toMatchObject({ status: "active", version: 2 });
    expect(await prisma.generationPromptTemplate.findUnique({ where: { id: `${P}template-v1` } })).toMatchObject({
      status: "archived",
    });
  });
});

describe("admin writes are audited", () => {
  it("suspends users, adjusts ledger by append-only entry, and blocks hard-policy flags", async () => {
    const admin = await setupActor("admin", "writes");
    const target = `${P}target-user`;
    await createUser({ id: target });

    const status = await api("POST", `admin/users/${target}/status`, {
      userId: admin,
      role: "admin",
      body: { status: "suspended", reason: "chargeback risk", confirmation: "SUSPENDED" },
    });
    expectOk(status);
    expect(status.data.user.status).toBe("suspended");

    const adjust = await api("POST", "admin/billing/adjustments", {
      userId: admin,
      role: "admin",
      body: { userId: target, delta: 42, reason: "support credit", confirmation: "ADJUST" },
    });
    expectOk(adjust);
    expect(await dreamcoinBalance(target)).toBe(42);
    expect(adjust.data.ledgerEntry.reason).toBe("admin_adjust");

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

    const flag = await api("PATCH", "admin/feature-flags/image_edit", {
      userId: admin,
      role: "admin",
      body: { enabled: true, reason: "rollout test", confirmation: "FLAG" },
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
      body: { reason: "should not refund completed work", confirmation: "DISCARD" },
    });
    expectError(discarded, 400, "bad_request");
    expect(await prisma.generationJob.findUnique({ where: { id: `${P}completed-job` } })).toMatchObject({
      status: "completed",
    });
    expect(await prisma.dreamcoinLedger.count({ where: { userId: target, reason: "refund" } })).toBe(0);
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
        confirmation: "VIEW",
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
        confirmation: "VIEW",
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

    const allowed = await api("POST", "admin/support/plaintext/view", {
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
