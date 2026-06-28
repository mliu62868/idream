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
      body: { ruleKey, label: "Video base v2", mode: "video", baseCost: 60, multiplier: 1 },
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
    expectOk(publish);
    expect(publish.data.rule).toMatchObject({ status: "active", version: 2, baseCost: 60 });
    expect(await prisma.pricingRule.findUnique({ where: { id: `${P}pricing-v1` } })).toMatchObject({
      status: "archived",
    });
    // 不变量：每个 mode 至多一个 active 规则（generationCost 的资金侧 SSoT）。
    expect(
      await prisma.pricingRule.count({ where: { ruleKey, mode: "video", status: "active" } }),
    ).toBe(1);

    const rollback = await api("POST", `admin/pricing/rules/${publish.data.rule.id}/rollback`, {
      userId: admin,
      role: "admin",
      body: { reason: "promo ended", confirmation: "ROLLBACK" },
    });
    expectOk(rollback);
    expect(rollback.data).toMatchObject({ fromVersion: 2, toVersion: 1 });
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

    const res = await api("POST", "admin/generation/dead-letter/requeue", {
      userId: admin,
      role: "admin",
      body: {
        jobIds: [`${P}dl-rq-failed`, `${P}dl-rq-refunded`, `${P}dl-rq-missing`],
        reason: "provider recovered",
        confirmation: "REQUEUE",
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
    await prisma.dreamcoinLedger.create({
      data: {
        id: `${P}dl-dc-refund`,
        userId: owner,
        delta: 8,
        balanceAfter: 8,
        reason: "refund",
        sourceId: `${P}dl-dc-refunded`,
      },
    });

    const res = await api("POST", "admin/generation/dead-letter/discard", {
      userId: admin,
      role: "admin",
      body: {
        jobIds: [`${P}dl-dc-failed`, `${P}dl-dc-refunded`],
        reason: "permanent provider outage",
        confirmation: "DISCARD",
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
    // 全局窗口聚合，用 >= 兼容并发测试数据。
    expect(overview.data.funnel.signups).toBeGreaterThanOrEqual(1);
    expect(overview.data.funnel.activatedUsers).toBeGreaterThanOrEqual(1);
    expect(overview.data.funnel.payingUsers).toBeGreaterThanOrEqual(1);
    expect(typeof overview.data.funnel.conversionRate).toBe("number");
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
