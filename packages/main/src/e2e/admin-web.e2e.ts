import { expect, test, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { prisma } from "@/server/lib/db";

function uniqueEmail(tag: string) {
  return `e2e-admin-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

function adminBaseURL() {
  if (process.env.PW_ADMIN_BASE_URL) return process.env.PW_ADMIN_BASE_URL.replace(/\/$/, "");

  const url = new URL(process.env.PW_BASE_URL ?? "http://127.0.0.1:3000");
  url.port = "3001";
  return url.toString().replace(/\/$/, "");
}

async function startAdminSession(page: Page) {
  const email = uniqueEmail("web");
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/" },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();

  const signup = await page.request.post("/api/v1/auth/signup", {
    data: {
      email,
      password: "password123",
      name: "E2E Admin Web",
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();

  const user = await prisma.user.update({
    where: { email },
    data: { role: "admin" },
    select: { id: true, email: true },
  });

  return user;
}

async function startRoleSession(page: Page, role: "admin" | "support" | "analyst" | "ops") {
  const email = uniqueEmail(role);
  const ageGate = await page.request.post("/api/v1/age-gate/accept", { data: { sourcePath: "/" } });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  const signup = await page.request.post("/api/v1/auth/signup", {
    data: { email, password: "password123", name: `E2E ${role}` },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  return prisma.user.update({ where: { email }, data: { role }, select: { id: true, email: true } });
}

async function expectAdminShellReady(page: Page, heading: string) {
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Admin access denied")).toHaveCount(0);
  await expect(page.getByText("Loading", { exact: true })).toHaveCount(0, {
    timeout: 20_000,
  });
}

function collectConsoleFailures(page: Page) {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    const isOptionalGeneratedMedia404 =
      message.text().includes("Failed to load resource") && location.url.includes("/user-content/");
    if (isOptionalGeneratedMedia404) return;
    failures.push(location.url ? `${message.text()} (${location.url})` : message.text());
  });
  page.on("pageerror", (error) => {
    failures.push(error.message);
  });
  return failures;
}

test("admin web serves generated media through user-content route", async ({ page }) => {
  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();
  const assetId = `e2e-admin-media-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const storageKey = `e2e/admin/${assetId}.png`;
  const target = resolveLocalBlobPath(storageKey);
  const token = Buffer.from(assetId, "utf8").toString("base64url");

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ak9zP8AAAAASUVORK5CYII=",
      "base64",
    ),
  );

  try {
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerId: admin.id,
        type: "image",
        url: `/user-content/${token}/content.png`,
        thumbnailUrl: `/user-content/${token}/content.png`,
        storageKey,
        contentType: "image/png",
        width: 1,
        height: 1,
        prompt: "admin route media fixture",
        visibility: "private",
        safetyStatus: "passed",
        metadata: { e2e: true, providerKey: storageKey },
      },
    });

    const response = await page.request.get(`${adminURL}/user-content/${token}/content.png`);
    expect(response.status(), await response.text()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
    expect((await response.body()).byteLength).toBeGreaterThan(0);
  } finally {
    await prisma.mediaAsset.deleteMany({ where: { id: assetId } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
    await rm(target, { force: true });
  }
});

test("admin web loads all control-plane sections and filters users", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);

  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();

  const sections = [
    { path: "/admin", heading: "Dashboard", evidence: "Feature Flags" },
    { path: "/admin/generation/jobs", heading: "Jobs & Incidents", evidence: "status" },
    { path: "/admin/generation/models", heading: "Profiles & Rollout", evidence: "Built-in profiles, test, publish, monitor" },
    { path: "/admin/generation/config", heading: "Profiles & Rollout", evidence: "Built-in profiles, test, publish, monitor" },
    { path: "/admin/generation/dead-letter", heading: "Dead-letter", evidence: "Dead-letter Queue" },
    { path: "/admin/ops/providers", heading: "Provider Health", evidence: "Provider health & cost" },
    { path: "/admin/moderation", heading: "Moderation", evidence: "Reports" },
    { path: "/admin/content", heading: "Content", evidence: "Featured curation" },
    { path: "/admin/content/production", heading: "Production Studio", evidence: "Create production batch" },
    { path: "/admin/content/assets", heading: "Asset Library", evidence: "Purpose" },
    { path: "/admin/content/placements", heading: "Placements", evidence: "Slot" },
    { path: "/admin/content/official", heading: "Official Characters", evidence: "Create official character" },
    { path: "/admin/content/templates", heading: "Templates", evidence: "Create character template" },
    { path: "/admin/content/tags", heading: "Tags", evidence: "Merge tags" },
    { path: "/admin/content/review-queue", heading: "Review Queue", evidence: "Pending submissions" },
    { path: "/admin/cms", heading: "CMS / SEO", evidence: "Create / overwrite page" },
    { path: "/admin/chat", heading: "Chat Ops", evidence: "CHAT_SERVICE_URL" },
    { path: "/admin/support", heading: "Support Requests", evidence: "Support Requests" },
    { path: "/admin/users", heading: "Users", evidence: admin.email },
    { path: "/admin/billing", heading: "Billing", evidence: "Subscriptions" },
    { path: "/admin/pricing", heading: "Pricing", evidence: "Pricing Rules" },
    { path: "/admin/promo", heading: "Promo", evidence: "Create redeem code" },
    { path: "/admin/announcements", heading: "Announcements", evidence: "Create announcement" },
    { path: "/admin/analytics", heading: "Analytics", evidence: "Top events" },
    { path: "/admin/insights", heading: "Insights", evidence: "Retention cohorts" },
    { path: "/admin/experiments", heading: "Experiments", evidence: "Experiments" },
    { path: "/admin/risk", heading: "Risk & Abuse", evidence: "Multi-account device clusters" },
    { path: "/admin/compliance", heading: "Compliance", evidence: "DSAR" },
    { path: "/admin/approvals", heading: "Approvals", evidence: "Pending approvals" },
    { path: "/admin/audit-log", heading: "Audit Log", evidence: "Audit" },
  ];

  for (const section of sections) {
    await page.goto(`${adminURL}${section.path}`);
    await expectAdminShellReady(page, section.heading);
    await expect(page.getByText(section.evidence, { exact: false }).first()).toBeVisible({
      timeout: 10_000,
    });
    if (section.path === "/admin/generation/models") {
      await expect(page.getByText("Engineering diagnostics", { exact: false })).toHaveCount(0);
      await expect(page.getByText("Upload diagnostic model", { exact: false })).toHaveCount(0);
    }
  }

  await page.goto(`${adminURL}/admin/users`);
  await expectAdminShellReady(page, "Users");
  await page.getByRole("textbox", { name: "Filter" }).fill(admin.email);
  const adminRow = page.getByRole("row").filter({ hasText: admin.email });
  await expect(adminRow).toHaveCount(1, { timeout: 10_000 });
  await expect(adminRow.getByText(admin.email, { exact: true })).toBeVisible();
  await expect(adminRow.getByText("E2E Admin Web", { exact: true })).toBeVisible();
  await expect(adminRow.getByText(admin.id, { exact: true })).toBeVisible();
  await expect(page.getByText("E2E upgrade", { exact: false })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Language" }).selectOption("zh");
  await expect(page.getByRole("textbox", { name: "筛选" })).toBeVisible();
  await page.getByRole("combobox", { name: "语言" }).selectOption("en");
  expect(consoleFailures).toEqual([]);
});

test("admin users and billing actions write audit trail and clear adjustment form", async ({
  page,
}) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startAdminSession(page);
  const targetId = `e2e-admin-billing-target-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const targetEmail = uniqueEmail("billing-target");

  await prisma.user.create({
    data: {
      id: targetId,
      email: targetEmail,
      emailVerified: true,
      displayName: "Billing Target",
    },
  });

  try {
    const adminURL = adminBaseURL();
    await page.goto(`${adminURL}/admin/users`);
    await expectAdminShellReady(page, "Users");
    await page.getByRole("textbox", { name: "Filter" }).fill(targetId);
    const targetRow = page.getByRole("row").filter({ hasText: targetId });
    await expect(targetRow).toHaveCount(1, { timeout: 10_000 });
    await expect(targetRow.getByText("active", { exact: true })).toBeVisible();

    await targetRow.getByRole("button", { name: "Suspend" }).click();
    await expect(page.getByRole("heading", { name: `Suspend ${targetId}` })).toBeVisible();
    await page.getByLabel("Reason").fill("E2E admin suspend smoke");
    await page.getByLabel("Confirmation").fill("SUSPENDED");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByTestId("admin-action-status")).toContainText(
      `Suspend ${targetId} completed.`,
      { timeout: 10_000 },
    );
    await expect(targetRow.getByText("suspended", { exact: true })).toBeVisible();

    await targetRow.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("heading", { name: `Restore ${targetId}` })).toBeVisible();
    await page.getByLabel("Reason").fill("E2E admin restore smoke");
    await page.getByLabel("Confirmation").fill("ACTIVE");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByTestId("admin-action-status")).toContainText(
      `Restore ${targetId} completed.`,
      { timeout: 10_000 },
    );
    await expect(targetRow.getByText("active", { exact: true })).toBeVisible();

    await page.goto(`${adminURL}/admin/billing`);
    await expectAdminShellReady(page, "Billing");
    await page.getByLabel("Adjustment user ID").fill(targetId);
    await page.getByLabel("Adjustment delta").fill("37");
    await page.getByRole("button", { name: "Adjust" }).click();
    await expect(page.getByRole("heading", { name: `Adjust ledger ${targetId}` })).toBeVisible();
    await page.getByLabel("Reason").fill("E2E admin billing adjustment");
    await page.getByLabel("Confirmation").fill("ADJUST");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByTestId("admin-action-status")).toContainText(
      `Adjust ledger ${targetId} completed.`,
      { timeout: 10_000 },
    );
    await expect(page.getByLabel("Adjustment user ID")).toHaveValue("");
    await expect(page.getByLabel("Adjustment delta")).toHaveValue("");
    const ledgerRow = page.getByRole("row").filter({ hasText: targetId });
    await expect(ledgerRow).toHaveCount(1, { timeout: 10_000 });
    await expect(ledgerRow.getByText("admin_adjust", { exact: true })).toBeVisible();
    await expect(ledgerRow.getByText("37", { exact: true })).toHaveCount(2);

    await page.goto(`${adminURL}/admin/audit-log`);
    await expectAdminShellReady(page, "Audit Log");
    await page.getByRole("textbox", { name: "Filter" }).fill(targetId);
    await expect(
      page.getByRole("row").filter({ hasText: targetId }).filter({ hasText: "billing.ledger.adjust" }),
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(
      page.getByRole("row").filter({ hasText: targetId }).filter({ hasText: "user.status.write" }),
    ).toHaveCount(2);

    const [target, ledger, audits] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: targetId }, select: { status: true } }),
      prisma.dreamcoinLedger.findMany({ where: { userId: targetId } }),
      prisma.adminAuditLog.findMany({ where: { actorId: admin.id, targetId } }),
    ]);
    expect(target.status).toBe("active");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ delta: 37, balanceAfter: 37, reason: "admin_adjust" });
    expect(audits.map((audit) => audit.action).sort()).toEqual([
      "billing.ledger.adjust",
      "user.status.write",
      "user.status.write",
    ]);
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { targetId } });
    await prisma.dreamcoinLedger.deleteMany({ where: { userId: targetId } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, targetId] } } });
  }
});

test("admin moderation resolves appeals from the web queue", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const appealerEmail = uniqueEmail("appeal");
  const appealer = await prisma.user.create({
    data: {
      email: appealerEmail,
      name: "Appeal Owner",
      displayName: "Appeal Owner",
      emailVerified: true,
    },
    select: { id: true },
  });
  const characterId = `e2e-appeal-character-${suffix}`;
  await prisma.character.create({
    data: {
      id: characterId,
      creatorId: appealer.id,
      name: `E2E Appeal ${suffix}`,
      age: 24,
      description: "Appeal target character",
      visibility: "public",
      status: "removed",
      appearance: {},
      advancedDetails: {},
    },
  });
  const appeal = await prisma.appeal.create({
    data: {
      userId: appealer.id,
      targetType: "character",
      targetId: characterId,
      appealText: "Please overturn the removed character decision.",
    },
  });

  try {
    await page.goto(`${adminURL}/admin/moderation`);
    await expectAdminShellReady(page, "Moderation");
    const appealRow = page.locator("tr").filter({ hasText: appeal.id });
    await expect(appealRow).toBeVisible({ timeout: 10_000 });
    await appealRow.getByRole("button", { name: "Overturn" }).click();

    await expect(page.getByRole("heading", { name: `Overturn appeal ${appeal.id}` })).toBeVisible();
    await page.getByLabel("Reason").fill("Appeal accepted from admin web E2E");
    await page.getByLabel("Confirmation").fill("OVERTURN");
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(appealRow).toHaveCount(0, { timeout: 10_000 });
    const updatedAppeal = await prisma.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
    expect(updatedAppeal.status).toBe("overturned");
    expect(updatedAppeal.reviewerId).toBe(admin.id);
    expect(updatedAppeal.resolvedAt).toBeTruthy();
    const updatedCharacter = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    expect(updatedCharacter.status).toBe("approved");
    await prisma.adminAuditLog.findFirstOrThrow({
      where: { actorId: admin.id, action: "safety.appeal.decision", targetId: appeal.id },
    });
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { targetId: appeal.id } });
    await prisma.appeal.deleteMany({ where: { id: appeal.id } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, appealer.id] } } });
  }
});

test("admin dead-letter queue discards failed jobs with refund audit", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startRoleSession(page, "admin");
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const ownerId = `e2e-dl-owner-${suffix}`;
  const jobId = `e2e-dl-discard-${suffix}`;
  const reason = `E2E discard provider outage ${suffix}`;

  try {
    await prisma.user.create({
      data: {
        id: ownerId,
        email: uniqueEmail("dead-letter-owner"),
        emailVerified: true,
        displayName: "Dead-letter Owner",
      },
    });
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId: ownerId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        costDreamcoins: 7,
        errorCode: "provider_timeout",
      },
    });

    const adminURL = adminBaseURL();
    await page.goto(`${adminURL}/admin/generation/dead-letter`);
    await expectAdminShellReady(page, "Dead-letter");
    await page.getByRole("textbox", { name: "Filter" }).fill(jobId);

    const jobRow = page.getByRole("row").filter({ hasText: jobId });
    await expect(jobRow).toHaveCount(1, { timeout: 10_000 });
    await expect(jobRow.getByText("reserved", { exact: true })).toBeVisible();
    const rowCheckbox = jobRow.locator('input[type="checkbox"]');
    await expect(rowCheckbox).toHaveCount(1);
    await rowCheckbox.check();
    await page.getByRole("button", { name: "Discard selected" }).click();

    await expect(page.getByRole("heading", { name: "Discard 1 jobs" })).toBeVisible();
    await page.getByLabel("Reason").fill(reason);
    await page.getByLabel("Confirmation").fill("DISCARD");
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(page.getByRole("row").filter({ hasText: jobId })).toHaveCount(0, {
      timeout: 10_000,
    });
    const discarded = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(discarded.status).toBe("refunded");
    const refund = await prisma.dreamcoinLedger.findFirst({
      where: { sourceId: jobId, reason: "refund" },
    });
    expect(refund?.delta).toBe(7);
    const audit = await prisma.adminAuditLog.findFirst({
      where: { actorId: admin.id, action: "ops.deadletter.discard", reason },
    });
    expect(audit?.targetType).toBe("generation_job_batch");
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({
      where: { actorId: admin.id, action: "ops.deadletter.discard", reason },
    });
    await prisma.dreamcoinLedger.deleteMany({ where: { sourceId: jobId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, ownerId] } } });
  }
});

test("admin support inbox resolves a help desk request", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);

  const support = await startRoleSession(page, "support");
  const requester = await prisma.user.create({
    data: {
      email: uniqueEmail("support-requester"),
      emailVerified: true,
      displayName: "Support Requester",
    },
    select: { id: true },
  });
  const ticketId = `SUP-E2E${Date.now().toString().slice(-8)}`;
  const freshTicketId = `SUP-FR${Date.now().toString().slice(-8)}`;
  const supportNeedle = `E2E SLA generation ${Date.now()}`;
  const viewLabel = `E2E support view ${Date.now()}`;
  try {
    await prisma.supportRequest.create({
      data: {
        ticketId,
        userId: requester.id,
        category: "generation",
        subject: `${supportNeedle} overdue`,
        description: "The generated image stayed queued after refresh.",
        diagnosticConsent: true,
        priority: 2,
        sourcePath: "/helpdesk",
        status: "open",
        createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
      },
    });
    await prisma.supportRequest.create({
      data: {
        ticketId: freshTicketId,
        userId: requester.id,
        category: "generation",
        subject: `${supportNeedle} fresh`,
        description: "The generated image was recently reported.",
        diagnosticConsent: true,
        priority: 3,
        sourcePath: "/helpdesk",
        status: "open",
      },
    });

    const adminURL = adminBaseURL();
    await page.goto(`${adminURL}/admin/support`);
    await expectAdminShellReady(page, "Support Requests");
    await page.getByRole("textbox", { name: "Support search" }).fill(supportNeedle);
    await page.getByRole("combobox", { name: "Support status" }).selectOption("active");
    await page.getByRole("combobox", { name: "Support SLA" }).selectOption("overdue");
    await page.getByRole("textbox", { name: "Support category" }).fill("generation");
    await page.getByRole("textbox", { name: "Support saved view label" }).fill(viewLabel);
    await page.getByRole("button", { name: "Save view" }).click();
    await expect(page.getByRole("button", { name: viewLabel, exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await page.reload();
    await expectAdminShellReady(page, "Support Requests");
    await page.getByRole("button", { name: viewLabel, exact: true }).click();
    const ticketRow = page.getByRole("row").filter({ hasText: ticketId });
    await expect(ticketRow).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByRole("row").filter({ hasText: freshTicketId })).toHaveCount(0);
    await expect(ticketRow.getByText("overdue", { exact: true })).toBeVisible();
    await ticketRow.getByRole("button", { name: "Escalate" }).click();
    await page.getByLabel("Reason").fill("Escalated from admin support inbox");
    await page.getByLabel("Confirmation").fill(ticketId);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(ticketRow.getByText("Escalated from admin support inbox")).toBeVisible({
      timeout: 10_000,
    });
    await expect(ticketRow.getByText(support.email)).toBeVisible();

    const storedView = await prisma.adminSavedView.findFirst({
      where: { ownerId: support.id, scope: "support.requests", label: viewLabel },
    });
    expect(storedView?.filters).toMatchObject({
      category: "generation",
      query: supportNeedle,
      sla: "overdue",
      status: "active",
    });
    await page.getByRole("button", { name: `Delete saved view ${viewLabel}`, exact: true }).click();
    await expect(page.getByRole("button", { name: viewLabel, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Reset filters" }).click();
    await page.getByRole("textbox", { name: "Support search" }).fill(ticketId);

    await ticketRow.getByRole("button", { name: "Resolve" }).click();
    await page.getByLabel("Reason").fill("Resolved from admin support inbox");
    await page.getByLabel("Confirmation").fill(ticketId);
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(ticketRow.getByText("resolved", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    const updated = await prisma.supportRequest.findUniqueOrThrow({ where: { ticketId } });
    expect(updated.status).toBe("resolved");
    expect(updated.assignedToId).toBe(support.id);
    expect(updated.priority).toBe(1);
    expect(updated.resolutionNotes).toBe("Resolved from admin support inbox");
    expect(updated.resolvedAt).toBeTruthy();
    expect(updated.slaEscalatedAt).toBeTruthy();
    expect(updated.slaEscalatedById).toBe(support.id);
    expect(updated.slaEscalationReason).toBe("Escalated from admin support inbox");
    const audit = await prisma.adminAuditLog.findFirst({
      where: { actorId: support.id, action: "support.request.update", targetId: ticketId },
    });
    expect(audit).not.toBeNull();
    const escalationAudit = await prisma.adminAuditLog.findFirst({
      where: { actorId: support.id, action: "support.request.escalate", targetId: ticketId },
    });
    expect(escalationAudit).not.toBeNull();
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminSavedView.deleteMany({
      where: { ownerId: support.id, scope: "support.requests", label: viewLabel },
    });
    await prisma.supportRequest.deleteMany({ where: { ticketId: { in: [ticketId, freshTicketId] } } });
    await prisma.user.deleteMany({ where: { id: requester.id } });
  }
});

test("admin review queue saves and applies moderation views", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);

  const admin = await startRoleSession(page, "admin");
  const suffix = Date.now().toString();
  const viewLabel = `E2E reported ${suffix}`;
  const reportedCharacterId = `e2e-review-reported-${suffix}`;
  const cleanCharacterId = `e2e-review-clean-${suffix}`;
  const reportedName = `Reported Queue ${suffix}`;
  const cleanName = `Clean Queue ${suffix}`;
  const submitter = await prisma.user.create({
    data: {
      email: uniqueEmail("review-submitter"),
      emailVerified: true,
      displayName: "Review Submitter",
    },
    select: { id: true },
  });
  const reporter = await prisma.user.create({
    data: {
      email: uniqueEmail("review-reporter"),
      emailVerified: true,
      displayName: "Review Reporter",
    },
    select: { id: true },
  });

  try {
    await prisma.character.createMany({
      data: [
        {
          id: reportedCharacterId,
          creatorId: submitter.id,
          name: reportedName,
          age: 24,
          description: "A reported queue submission seeded for saved-view testing.",
          visibility: "public",
          status: "pending_review",
          style: "realistic",
          gender: "female",
          appearance: {},
          advancedDetails: {},
        },
        {
          id: cleanCharacterId,
          creatorId: submitter.id,
          name: cleanName,
          age: 24,
          description: "A clean queue submission seeded for saved-view testing.",
          visibility: "public",
          status: "pending_review",
          style: "anime",
          gender: "female",
          appearance: {},
          advancedDetails: {},
        },
      ],
    });
    await prisma.characterSubmission.createMany({
      data: [
        { characterId: reportedCharacterId, submitterId: submitter.id, status: "pending" },
        { characterId: cleanCharacterId, submitterId: submitter.id, status: "pending" },
      ],
    });
    await prisma.contentReport.create({
      data: {
        reporterId: reporter.id,
        targetType: "character",
        targetId: reportedCharacterId,
        category: "quality",
        description: "Seeded report for review queue saved-view E2E.",
      },
    });

    const adminURL = adminBaseURL();
    await page.goto(`${adminURL}/admin/content/review-queue`);
    await expectAdminShellReady(page, "Review Queue");
    await expect(page.getByRole("row").filter({ hasText: reportedName })).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(page.getByRole("row").filter({ hasText: cleanName })).toHaveCount(1);

    await page.getByRole("button", { name: "Reported", exact: true }).click();
    await page.getByRole("textbox", { name: "Search review queue" }).fill(reportedName);
    await page.getByRole("textbox", { name: "Saved view label" }).fill(viewLabel);
    await page.getByRole("button", { name: "Save view" }).click();
    await expect(page.getByRole("button", { name: viewLabel, exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await page.reload();
    await expectAdminShellReady(page, "Review Queue");
    await page.getByRole("button", { name: viewLabel, exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: reportedName })).toHaveCount(1);
    await expect(page.getByRole("row").filter({ hasText: cleanName })).toHaveCount(0);
    await expect(page.getByText(/^1\/\d+$/)).toBeVisible();

    const storedView = await prisma.adminSavedView.findFirst({
      where: { ownerId: admin.id, scope: "moderation.review_queue", label: viewLabel },
    });
    expect(storedView?.filters).toMatchObject({
      query: reportedName,
      reportFilter: "reported",
    });

    await page.getByRole("button", { name: `Delete saved view ${viewLabel}`, exact: true }).click();
    await expect(page.getByRole("button", { name: viewLabel, exact: true })).toHaveCount(0);
    const deletedView = await prisma.adminSavedView.findFirst({
      where: { ownerId: admin.id, scope: "moderation.review_queue", label: viewLabel },
    });
    expect(deletedView).toBeNull();
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminSavedView.deleteMany({
      where: { ownerId: admin.id, scope: "moderation.review_queue", label: viewLabel },
    });
    await prisma.contentReport.deleteMany({
      where: { targetType: "character", targetId: { in: [reportedCharacterId, cleanCharacterId] } },
    });
    await prisma.characterSubmission.deleteMany({
      where: { characterId: { in: [reportedCharacterId, cleanCharacterId] } },
    });
    await prisma.character.deleteMany({ where: { id: { in: [reportedCharacterId, cleanCharacterId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [submitter.id, reporter.id] } } });
  }
});

test("admin review queue approves a pending character submission", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);

  const admin = await startRoleSession(page, "admin");
  const suffix = Date.now().toString();
  const characterId = `e2e-review-approve-${suffix}`;
  const characterName = `Approve Queue ${suffix}`;
  const submitter = await prisma.user.create({
    data: {
      email: uniqueEmail("review-approve-submitter"),
      emailVerified: true,
      displayName: "Review Approval Submitter",
    },
    select: { id: true },
  });

  try {
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: submitter.id,
        name: characterName,
        age: 24,
        description: "A pending queue submission seeded for approval testing.",
        visibility: "public",
        status: "pending_review",
        style: "realistic",
        gender: "female",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterSubmission.create({
      data: { characterId, submitterId: submitter.id, status: "pending" },
    });

    const adminURL = adminBaseURL();
    await page.goto(`${adminURL}/admin/content/review-queue`);
    await expectAdminShellReady(page, "Review Queue");
    await page.getByRole("textbox", { name: "Search review queue" }).fill(characterName);
    const row = page.getByRole("row").filter({ hasText: characterName });
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    await row.getByRole("button", { name: "Approve", exact: true }).click();

    await expect(page.getByRole("heading", { name: `Approve ${characterName}` })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByPlaceholder("Review note (optional, shown to creator)").fill("Approved by E2E review queue.");
    await page.getByPlaceholder("Audit reason (≥3)").fill("e2e approval");
    await page.getByPlaceholder("Type REVIEW to confirm").fill("REVIEW");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();

    await expect(row).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText("No submissions match filters")).toBeVisible();

    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    expect(character.status).toBe("approved");
    expect(character.visibility).toBe("public");
    const submission = await prisma.characterSubmission.findFirstOrThrow({ where: { characterId } });
    expect(submission.status).toBe("approved");
    expect(submission.reviewerId).toBe(admin.id);
    expect(submission.reviewReason).toBe("Approved by E2E review queue.");
    const audit = await prisma.adminAuditLog.findFirst({
      where: { actorId: admin.id, action: "content.submission.review", targetId: characterId },
    });
    expect(audit).not.toBeNull();
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { targetId: characterId } });
    await prisma.characterSubmission.deleteMany({ where: { characterId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: submitter.id } });
  }
});

test("admin API allows an authorized write (admin creates a pricing draft)", async ({ page }) => {
  const adminURL = adminBaseURL();
  await startRoleSession(page, "admin");
  const ruleKey = `e2e_rule_${Date.now()}`;
  try {
    const create = await page.request.post(`${adminURL}/api/v1/admin/pricing/rules`, {
      data: { ruleKey, label: "E2E rule", mode: "image", baseCost: 5, multiplier: 1 },
    });
    expect(create.status(), await create.text()).toBe(200);
  } finally {
    await prisma.pricingRule.deleteMany({ where: { ruleKey } });
  }
});

test("admin API creates an official character and runs AI assist", async ({ page }) => {
  const adminURL = adminBaseURL();
  await startRoleSession(page, "admin");
  const name = `E2E Official ${Date.now()}`;
  let createdId: string | undefined;
  try {
    const create = await page.request.post(`${adminURL}/api/v1/admin/content/official`, {
      data: {
        name,
        age: 24,
        gender: "female",
        style: "realistic",
        description: "A warm cinematic companion created during the E2E run.",
        tags: ["e2e-official"],
        reason: "e2e official create",
      },
    });
    expect(create.status(), await create.text()).toBe(200);
    const body = (await create.json()) as { data?: { character?: { id?: string } } };
    createdId = body.data?.character?.id;
    expect(createdId).toBeTruthy();

    // §8 AI 辅助：一句话 seed → 非空 description + personality。
    const assist = await page.request.post(`${adminURL}/api/v1/admin/content/character-assist`, {
      data: { seed: "shy bookish painter who loves rainy nights", gender: "female", style: "realistic" },
    });
    expect(assist.status(), await assist.text()).toBe(200);
    const assistBody = (await assist.json()) as { data?: { description?: string } };
    expect((assistBody.data?.description ?? "").length).toBeGreaterThan(0);
  } finally {
    if (createdId) await prisma.character.delete({ where: { id: createdId } }).catch(() => {});
    await prisma.tag.deleteMany({ where: { slug: "e2e-official" } });
  }
});

test("admin API forbids under-privileged roles (403 on writes they lack)", async ({ page }) => {
  const adminURL = adminBaseURL();
  // support holds content.read but NOT content.takedown.write / config.pricing.write.
  await startRoleSession(page, "support");

  const pricing = await page.request.post(`${adminURL}/api/v1/admin/pricing/rules`, {
    data: { ruleKey: "e2e_forbidden", label: "x", mode: "image", baseCost: 5, multiplier: 1 },
  });
  expect(pricing.status()).toBe(403);

  const takedown = await page.request.post(
    `${adminURL}/api/v1/admin/content/characters/none/visibility`,
    { data: { visibility: "private", reason: "test reason", confirmation: "VISIBILITY" } },
  );
  expect(takedown.status()).toBe(403);

  // support lacks content.official.write → official create + AI assist both 403.
  const official = await page.request.post(`${adminURL}/api/v1/admin/content/official`, {
    data: {
      name: "x",
      age: 24,
      gender: "female",
      style: "realistic",
      description: "x",
      tags: [],
      reason: "test reason",
    },
  });
  expect(official.status()).toBe(403);

  const assist = await page.request.post(`${adminURL}/api/v1/admin/content/character-assist`, {
    data: { seed: "a cheerful barista" },
  });
  expect(assist.status()).toBe(403);

  // analyst lacks content.read entirely → read also 403.
  await startRoleSession(page, "analyst");
  const read = await page.request.get(`${adminURL}/api/v1/admin/content/characters`);
  expect(read.status()).toBe(403);
});

test("admin API Phase 3: CMS write (admin) + compliance/analytics gating", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);
  const adminURL = adminBaseURL();
  await startRoleSession(page, "admin");
  const path = `/e2e-cms-${Date.now()}`;
  try {
    const create = await page.request.post(`${adminURL}/api/v1/admin/cms/pages`, {
      data: {
        path,
        title: "E2E CMS page",
        description: "e2e",
        body: {
          heading: "Hello CMS",
          intro: "Published CMS content should keep the app shell.",
          sections: [{ heading: "Proof", paragraphs: ["CMS content renders in product navigation."] }],
          cta: { label: "Explore", href: "/" },
        },
        contentStatus: "draft",
        reason: "e2e cms create",
        confirmation: "CMS",
      },
    });
    expect(create.status(), await create.text()).toBe(200);

    const publish = await page.request.post(`${adminURL}/api/v1/admin/cms/pages/publish`, {
      data: {
        path,
        contentStatus: "published",
        reason: "e2e cms publish",
        confirmation: "PUBLISH",
      },
    });
    expect(publish.status(), await publish.text()).toBe(200);

    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Hello CMS" })).toBeVisible();
    await expect(page.getByLabel("Search characters, guides, and generators")).toBeVisible();
    await expect(page.locator("aside").getByRole("link", { name: "Create", exact: true })).toBeVisible();
    await expect(page.locator("aside").getByRole("link", { name: "Generate", exact: true })).toBeVisible();
    await expect(page.locator("footer")).toContainText("OURDREAM.AI");
    await expect(page.locator("article").getByRole("link", { name: "Explore", exact: true })).toHaveAttribute("href", "/");
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.routePage.deleteMany({ where: { path } });
  }

  // support has compliance.read (export ok) but NOT compliance.write (erase 403).
  await startRoleSession(page, "support");
  const erase = await page.request.post(
    `${adminURL}/api/v1/admin/compliance/users/none/erase`,
    { data: { reason: "test erase", confirmation: "ERASE" } },
  );
  expect(erase.status()).toBe(403);

  // analyst holds analytics.export → retention ok; lacks compliance.read → age list 403.
  await startRoleSession(page, "analyst");
  const retention = await page.request.get(`${adminURL}/api/v1/admin/analytics/retention`);
  expect(retention.status()).toBe(200);
  const ageList = await page.request.get(`${adminURL}/api/v1/admin/compliance/age-verifications`);
  expect(ageList.status()).toBe(403);
});

test("admin API Phase 4: announcement write (admin) + public read + growth gating", async ({
  page,
}) => {
  const adminURL = adminBaseURL();
  await startRoleSession(page, "admin");
  try {
    const create = await page.request.post(`${adminURL}/api/v1/admin/announcements`, {
      data: {
        title: "E2E banner",
        body: "hello from e2e",
        href: "https://help.ourdream.ai/",
        level: "info",
        active: true,
        reason: "e2e banner",
        confirmation: "ANNOUNCE",
      },
    });
    expect(create.status(), await create.text()).toBe(200);

    // public read (main app, no auth) sees the active announcement
    const pub = await page.request.get("/api/v1/announcements");
    expect(pub.status()).toBe(200);
    const pubBody = (await pub.json()) as {
      data?: { items?: Array<{ href?: string; title?: string }> };
    };
    const announcement = pubBody.data?.items?.find((a) => a.title === "E2E banner");
    expect(announcement?.href).toBe("https://help.ourdream.ai/");

    await page.goto("/");
    const banner = page.getByTestId("announcement-banner");
    await expect(banner).toContainText("E2E banner");
    const link = banner.getByTestId("announcement-link");
    await expect(link).toHaveAttribute("data-link-kind", "external");
    await expect(link).toHaveAttribute("href", "https://help.ourdream.ai/");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  } finally {
    // 新功能、无真实公告：清掉整个 key,保证 beta 站不残留 e2e banner。
    await prisma.appSetting.deleteMany({ where: { key: "announcements" } });
  }

  // analyst lacks growth.promo.write → announcement create 403
  await startRoleSession(page, "analyst");
  const annForbidden = await page.request.post(`${adminURL}/api/v1/admin/announcements`, {
    data: { title: "x", body: "y", reason: "test reason", confirmation: "ANNOUNCE" },
  });
  expect(annForbidden.status()).toBe(403);

  // ops lacks analytics.export → experiments 403
  await startRoleSession(page, "ops");
  const expForbidden = await page.request.get(`${adminURL}/api/v1/admin/experiments`);
  expect(expForbidden.status()).toBe(403);
});
