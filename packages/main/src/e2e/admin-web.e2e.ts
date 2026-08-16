import { expect, test, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { prisma } from "@/server/lib/db";
import { redeemCodeHash } from "@/server/lib/redeem-codes";

function uniqueEmail(tag: string) {
  return `e2e-admin-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

function adminBaseURL() {
  if (process.env.PW_ADMIN_BASE_URL) return process.env.PW_ADMIN_BASE_URL.replace(/\/$/, "");

  const url = new URL(process.env.PW_BASE_URL ?? "http://127.0.0.1:3000");
  const mainPort = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
  url.port = String(mainPort + 1);
  return url.toString().replace(/\/$/, "");
}

async function startDevAdminSession(page: Page, baseURL: string) {
  const response = await page.request.post(`${baseURL}/api/admin-auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
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
    data: { role: "admin", dataClass: "internal" },
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
  return prisma.user.update({
    where: { email },
    data: { role, dataClass: "internal" },
    select: { id: true, email: true },
  });
}

async function expectAdminShellReady(page: Page, heading: string) {
  await expect(page.getByRole("heading", { level: 1, name: heading }).first()).toBeVisible({
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

function platformStatusFromMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const platformAsset = (metadata as { platformAsset?: unknown }).platformAsset;
  if (!platformAsset || typeof platformAsset !== "object" || Array.isArray(platformAsset)) return null;
  const status = (platformAsset as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
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
  const customer = await prisma.user.create({
    data: {
      email: uniqueEmail("customer-filter"),
      displayName: "E2E Customer Filter",
      emailVerified: true,
    },
    select: { id: true, email: true },
  });
  const adminURL = adminBaseURL();
  await startDevAdminSession(page, adminURL);

  const sections = [
    { path: "/admin", heading: "Today", evidence: "Next best actions" },
    { path: "/admin/generation/jobs", heading: "Generation Jobs", evidence: "status" },
    { path: "/admin/generation/models", heading: "Profiles & Rollout", evidence: "Test and publish generation profiles" },
    { path: "/admin/generation/config", heading: "Profiles & Rollout", evidence: "Test and publish generation profiles" },
    { path: "/admin/generation/dead-letter", heading: "Dead-letter", evidence: "Dead-letter Queue" },
    { path: "/admin/ops/providers", heading: "Providers", evidence: "Provider health & cost" },
    { path: "/admin/moderation", heading: "Moderation Cases", evidence: "Reports" },
    { path: "/admin/content", heading: "Featured Merchandising", evidence: "Featured curation" },
    { path: "/admin/content/production", heading: "Creative Runs", evidence: "Creative directions" },
    { path: "/admin/content/assets", heading: "Library", evidence: "Purpose" },
    { path: "/admin/content/placements", heading: "Placements", evidence: "Slot" },
    { path: "/admin/content/official", heading: "Portfolio & Projects", evidence: "Create official character" },
    { path: "/admin/content/templates", heading: "Character Starters", evidence: "Create character template" },
    { path: "/admin/content/tags", heading: "Taxonomy", evidence: "Merge tags" },
    { path: "/admin/content/review-queue", heading: "Character Review", evidence: "Pending submissions" },
    { path: "/admin/cms", heading: "CMS & SEO", evidence: "Create new page draft" },
    { path: "/admin/chat", heading: "Chat Operations", evidence: "CHAT_SERVICE_URL" },
    { path: "/admin/support", heading: "Support Cases", evidence: "Support Requests" },
    { path: "/admin/users", heading: "Customers", evidence: admin.email },
    { path: "/admin/billing", heading: "Billing Operations", evidence: "Subscriptions" },
    { path: "/admin/pricing", heading: "Pricing", evidence: "Pricing Rules" },
    { path: "/admin/promo", heading: "Promotions", evidence: "Create redeem code" },
    { path: "/admin/announcements", heading: "Announcements", evidence: "Create announcement" },
    { path: "/admin/analytics", heading: "Product Health", evidence: "Top events" },
    { path: "/admin/insights", heading: "Funnels & Retention", evidence: "invalid for decisions" },
    { path: "/admin/experiments", heading: "Experiments", evidence: "Directional only" },
    { path: "/admin/risk", heading: "Risk Cases", evidence: "Multi-account device clusters" },
    { path: "/admin/compliance", heading: "Account Requests", evidence: "DSAR" },
    { path: "/admin/approvals", heading: "Approvals", evidence: "Pending approvals" },
    { path: "/admin/audit-log", heading: "Audit Log", evidence: "Audit" },
  ];

  for (const section of sections) {
    await page.goto(`${adminURL}${section.path}`);
    await expectAdminShellReady(page, section.heading);
    if (section.path === "/admin/generation/models") {
      await expect(page.getByText("Engineering diagnostics", { exact: false })).toHaveCount(0);
      await expect(page.getByText("Upload diagnostic model", { exact: false })).toHaveCount(0);
    }
  }

  await page.goto(`${adminURL}/admin/users`);
  await expectAdminShellReady(page, "Customers");
  await page.getByRole("textbox", { name: "Search", exact: true }).fill(customer.email);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const adminRow = page.getByRole("button").filter({ hasText: customer.email });
  await expect(adminRow).toHaveCount(1, { timeout: 15_000 });
  await expect(adminRow).toContainText(customer.email);
  await expect(adminRow).toContainText("E2E Customer Filter");
  await expect(adminRow).toContainText(customer.id);
  await expect(page.getByText("E2E upgrade", { exact: false })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search", exact: true }).fill(admin.email);
  await page.getByRole("combobox", { name: "Language" }).selectOption("zh");
  await expect(page.getByRole("button", { name: "刷新", exact: true }).first()).toBeVisible();
  await page.getByRole("combobox", { name: "语言" }).selectOption("en");
  expect(consoleFailures).toEqual([]);
  await prisma.session.deleteMany({ where: { userId: { in: [admin.id, customer.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [admin.id, customer.id] } } });
});

test("admin content ops requires confirmation for standalone draft placement and archive writes", async ({
  page,
}) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();
  await startDevAdminSession(page, adminURL);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const characterId = `e2e-content-confirm-character-${suffix}`;
  const placementTargetId = `e2e-content-confirm-campaign-${suffix}`;
  const archiveAssetId = `e2e-content-confirm-archive-${suffix}`;
  const placementAssetId = `e2e-content-confirm-placement-${suffix}`;
  const placementBatchId = `e2e-content-confirm-placement-batch-${suffix}`;
  const placementItemId = `e2e-content-confirm-placement-item-${suffix}`;
  const placementJobId = `e2e-content-confirm-placement-job-${suffix}`;
  const placementBatchTitle = `Placement Confirmation ${suffix}`;
  const archiveStorageKey = `e2e/admin/content-ops/${archiveAssetId}.png`;
  const placementStorageKey = `e2e/admin/content-ops/${placementAssetId}.png`;
  const archiveAssetPath = resolveLocalBlobPath(archiveStorageKey);
  const placementAssetPath = resolveLocalBlobPath(placementStorageKey);
  const archiveAssetUrl = `/user-content/${Buffer.from(archiveAssetId, "utf8").toString("base64url")}/content.png`;
  const placementAssetUrl = `/user-content/${Buffer.from(placementAssetId, "utf8").toString("base64url")}/content.png`;
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ak9zP8AAAAASUVORK5CYII=",
    "base64",
  );

  try {
    await Promise.all([
      mkdir(path.dirname(archiveAssetPath), { recursive: true }),
      mkdir(path.dirname(placementAssetPath), { recursive: true }),
    ]);
    await Promise.all([writeFile(archiveAssetPath, tinyPng), writeFile(placementAssetPath, tinyPng)]);

    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: admin.id,
        name: `Content Ops Confirmation ${suffix}`,
        age: 24,
        description: "Content Ops confirmation target",
        visibility: "public",
        status: "approved",
        style: "realistic",
        gender: "female",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.contentProductionBatch.createMany({
      data: [
        {
          id: placementBatchId,
          title: placementBatchTitle,
          purpose: "character_chat",
          targetType: "character",
          targetId: characterId,
          presetIds: [],
          count: 1,
          totalItems: 1,
          completedItems: 1,
          approvedItems: 1,
          status: "completed",
          createdById: admin.id,
        },
      ],
    });
    await prisma.generationJob.create({
      data: {
        id: placementJobId,
        userId: admin.id,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        provider: "pipeline",
      },
    });
    await prisma.generationAttempt.create({
      data: {
        requestId: placementJobId,
        attemptNo: 1,
        provider: "pipeline",
        status: "succeeded",
        finishedAt: new Date(),
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: archiveAssetId,
          ownerId: admin.id,
          type: "image",
          url: archiveAssetUrl,
          thumbnailUrl: archiveAssetUrl,
          storageKey: archiveStorageKey,
          contentType: "image/png",
          width: 800,
          height: 1000,
          prompt: "archive confirmation fixture",
          visibility: "private",
          safetyStatus: "passed",
          metadata: {
            platformAsset: {
              status: "approved",
              purpose: "character_chat",
              tags: ["e2e", "archive"],
              description: "Archive confirmation fixture",
            },
          },
        },
        {
          id: placementAssetId,
          ownerId: admin.id,
          sourceJobId: placementJobId,
          type: "image",
          url: placementAssetUrl,
          thumbnailUrl: placementAssetUrl,
          storageKey: placementStorageKey,
          contentType: "image/png",
          width: 800,
          height: 1000,
          prompt: "placement confirmation fixture",
          visibility: "private",
          safetyStatus: "passed",
          metadata: {
            platformAsset: {
              status: "approved",
              purpose: "character_chat",
              tags: ["e2e", "placement"],
              description: "Placement confirmation fixture",
            },
          },
        },
      ],
    });
    await prisma.contentProductionItem.createMany({
      data: [
        {
          id: placementItemId,
          batchId: placementBatchId,
          jobId: placementJobId,
          mediaAssetId: placementAssetId,
          itemIndex: 0,
          status: "approved",
          tags: ["e2e", "placement"],
          reviewedById: admin.id,
          reviewedAt: new Date(),
        },
      ],
    });
    await prisma.creativeReviewDecision.create({
      data: {
        runItemId: placementItemId,
        artifactId: placementAssetId,
        decision: "approved",
        identityConsistency: "unscored",
        score: 90,
        reason: "Canonical reviewed asset for standalone draft placement",
        reviewerId: admin.id,
      },
    });

    await page.goto(`${adminURL}/admin/content/assets`);
    await expectAdminShellReady(page, "Library");
    await page.getByRole("textbox", { name: "Search by tag, description, or asset ID" }).fill(archiveAssetId);
    const archiveCard = page.locator(`a[href="/admin/content/assets/${archiveAssetId}"]`);
    await expect(archiveCard).toBeVisible({ timeout: 10_000 });
    await archiveCard.click();
    await expect(page.getByRole("heading", { name: archiveAssetId.slice(0, 8), exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    const archiveDialog = page.getByRole("heading", { name: "Archive", exact: true }).locator("..");
    await expect(archiveDialog).toContainText(
      "Assets have no name — type the first 8 characters of the ID to confirm.",
    );
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: archiveAssetId },
        select: { metadata: true },
      }).then((asset) => platformStatusFromMetadata(asset.metadata)),
    ).resolves.toBe("approved");

    await archiveDialog.getByRole("textbox", { name: "Reason (≥3)" }).fill("archive after E2E confirmation");
    await archiveDialog
      .getByRole("textbox", { name: "Type the name to confirm" })
      .fill(archiveAssetId.slice(0, 8));
    await archiveDialog.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByText("archived", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: archiveAssetId },
        select: { metadata: true },
      }).then((asset) => platformStatusFromMetadata(asset.metadata)),
    ).resolves.toBe("archived");

    const archivedPlacementAttempt = await page.request.post(`${adminURL}/api/v1/admin/content/placements`, {
      data: {
        mediaAssetId: archiveAssetId,
        slot: "feed_card",
        targetType: "campaign",
        targetId: placementTargetId,
        status: "draft",
        reason: "should reject archived asset",
      },
    });
    expect(archivedPlacementAttempt.status()).toBe(400);

    await page.goto(`${adminURL}/admin/content/placements`);
    await expectAdminShellReady(page, "Placements");
    await expect(page.getByText("No placements yet.")).toBeVisible();
    await page.getByRole("link", { name: "New placement" }).first().click();
    await expect(page.getByRole("heading", { level: 2, name: "New placement" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Asset" }).locator(`option[value="${archiveAssetId}"]`)).toHaveCount(0);
    await page.getByRole("combobox", { name: "Asset" }).selectOption(placementAssetId);
    await page.getByLabel("Slot").selectOption("feed_card");
    await page.getByLabel("Target type").selectOption("campaign");
    await page.getByLabel("Target ID").fill(placementTargetId);
    await page.getByRole("textbox", { name: "Reason (≥3)" }).fill("create standalone draft E2E asset");
    await expect(
      prisma.mediaAssetPlacement.count({
        where: { mediaAssetId: placementAssetId, targetId: placementTargetId },
      }),
    ).resolves.toBe(0);

    await page.getByRole("button", { name: "Create placement" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "feed_card" })).toBeVisible({
      timeout: 10_000,
    });
    await expect
      .poll(
        async () => {
          const placement = await prisma.mediaAssetPlacement.findFirst({
            where: { mediaAssetId: placementAssetId, targetId: placementTargetId },
            select: { status: true },
          });
          return placement?.status ?? null;
        },
        { timeout: 10_000 },
      )
      .toBe("draft");
    const createdPlacement = await prisma.mediaAssetPlacement.findFirstOrThrow({
      where: { mediaAssetId: placementAssetId, targetId: placementTargetId },
      select: { id: true, status: true },
    });
    expect(createdPlacement.status).toBe("draft");
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId }, select: { imageAssetId: true } }),
    ).resolves.toEqual({ imageAssetId: null });

    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const pauseDialog = page.getByRole("heading", { name: "Pause", exact: true }).locator("..");
    await pauseDialog.getByRole("textbox", { name: "Reason (≥3)" }).fill("pause after E2E verification");
    await expect(
      prisma.mediaAssetPlacement.findUniqueOrThrow({
        where: { id: createdPlacement.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "draft" });

    await pauseDialog.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByText("paused", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(
      prisma.mediaAssetPlacement.findUniqueOrThrow({
        where: { id: createdPlacement.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "paused" });

    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.mediaAssetPlacement.deleteMany({
      where: { mediaAssetId: { in: [archiveAssetId, placementAssetId] } },
    });
    await prisma.creativeReviewDecision.deleteMany({
      where: { runItemId: placementItemId },
    });
    await prisma.contentProductionItem.deleteMany({
      where: { batchId: placementBatchId },
    });
    await prisma.contentProductionBatch.deleteMany({
      where: { id: placementBatchId },
    });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: [archiveAssetId, placementAssetId] } } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: placementJobId } });
    await prisma.generationJob.deleteMany({ where: { id: placementJobId } });
    await Promise.all([rm(archiveAssetPath, { force: true }), rm(placementAssetPath, { force: true })]);
    await prisma.user.deleteMany({ where: { id: admin.id } });
  }
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
    await expectAdminShellReady(page, "Customers");
    await page.getByRole("textbox", { name: "Search", exact: true }).fill(targetId);
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const customerRow = page.getByRole("button").filter({ hasText: targetId });
    await expect(customerRow).toHaveCount(1, { timeout: 15_000 });
    await expect(customerRow.getByText("active", { exact: true })).toBeVisible();

    await page.goto(`${adminURL}/admin/system/access`);
    await expectAdminShellReady(page, "Team Access");
    const targetRow = page.getByRole("row").filter({ hasText: targetId });
    await expect(targetRow).toHaveCount(1, { timeout: 15_000 });
    await expect(targetRow.getByText("active", { exact: true })).toBeVisible();

    await page.getByRole("textbox", { name: "Permission user ID" }).fill(targetId);
    await page.getByRole("combobox", { name: "Permission key" }).selectOption("billing.ledger.adjust");
    await page.getByRole("combobox", { name: "Permission effect" }).selectOption("grant");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("heading", { name: "grant billing.ledger.adjust" })).toBeVisible();
    await page.getByRole("textbox", { name: "Reason", exact: true }).fill("E2E permission grant");
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill("PERMISSION");
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await page
      .getByRole("textbox", { name: "Confirmation", exact: true })
      .fill(`${targetId}:billing.ledger.adjust:grant`);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByTestId("admin-action-status")).toContainText(
      "grant billing.ledger.adjust completed.",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("admin-action-status")).toHaveAttribute("role", "status");
    await expect(page.getByTestId("admin-action-status")).toHaveAttribute("aria-live", "polite");

    await targetRow.getByRole("button", { name: "Suspend" }).click();
    await expect(page.getByRole("heading", { name: `Suspend ${targetId}` })).toBeVisible();
    await page.getByRole("textbox", { name: "Reason", exact: true }).fill("E2E admin suspend smoke");
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill("SUSPENDED");
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill(`${targetId}:suspended`);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByTestId("admin-action-status")).toContainText(
      `Suspend ${targetId} completed.`,
      { timeout: 10_000 },
    );
    await expect(targetRow.getByText("suspended", { exact: true })).toBeVisible();

    await targetRow.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("heading", { name: `Restore ${targetId}` })).toBeVisible();
    await page.getByRole("textbox", { name: "Reason", exact: true }).fill("E2E admin restore smoke");
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill("ACTIVE");
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill(`${targetId}:active`);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByTestId("admin-action-status")).toContainText(
      `Restore ${targetId} completed.`,
      { timeout: 10_000 },
    );
    await expect(targetRow.getByText("active", { exact: true })).toBeVisible();

    await page.goto(`${adminURL}/admin/billing`);
    await expectAdminShellReady(page, "Billing Operations");
    await page.getByLabel("Adjustment user ID").fill(targetId);
    await page.getByLabel("Adjustment delta").fill("37");
    await page.getByRole("button", { name: "Adjust" }).click();
    await expect(page.getByRole("heading", { name: `Adjust ledger ${targetId}` })).toBeVisible();
    await page.getByRole("textbox", { name: "Reason", exact: true }).fill("E2E admin billing adjustment");
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill("ADJUST");
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill(`${targetId}:37`);
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

    const refreshLedgerId = `e2e-shell-refresh-${Date.now()}`;
    await prisma.dreamcoinLedger.create({
      data: {
        id: refreshLedgerId,
        userId: targetId,
        delta: 9,
        balanceAfter: 46,
        reason: "admin_adjust",
        sourceId: "shell-refresh-probe",
        idempotencyKey: refreshLedgerId,
      },
    });
    const subscriptionRoute = "**/api/v2/admin/billing/subscriptions**";
    await page.route(subscriptionRoute, (route) => route.fulfill({
      body: JSON.stringify({
        ok: false,
        error: { code: "dependency_unhealthy", message: "injected subscription read failure" },
      }),
      contentType: "application/json",
      status: 200,
    }));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: refreshLedgerId })).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(page.getByRole("alert").filter({ hasText: "subscriptions authority refresh failed" })).toBeVisible();
    await expect(page.getByText("No subscriptions exist yet", { exact: true })).toBeVisible();
    await page.unroute(subscriptionRoute);
    await page.getByRole("button", { name: "Retry subscriptions" }).click();
    await expect(page.getByText(/Subscriptions: current client snapshot/)).toBeVisible();
    await prisma.dreamcoinLedger.delete({ where: { id: refreshLedgerId } });

    await page.goto(`${adminURL}/admin/audit-log`);
    await expectAdminShellReady(page, "Audit Log");
    await page.getByRole("textbox", { name: "Search audit authority" }).fill(targetId);
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(
      page.getByRole("row").filter({ hasText: targetId }).filter({ hasText: "billing.ledger.adjust" }),
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(
      page.getByRole("row").filter({ hasText: targetId }).filter({ hasText: "user.status.write" }),
    ).toHaveCount(2);
    await expect(
      page.getByRole("row").filter({ hasText: targetId }).filter({ hasText: "admin.permission.grant" }),
    ).toHaveCount(1);

    const [target, ledger, audits] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: targetId }, select: { status: true } }),
      prisma.dreamcoinLedger.findMany({ where: { userId: targetId } }),
      prisma.adminAuditLog.findMany({ where: { actorId: admin.id, targetId } }),
    ]);
    expect(target.status).toBe("active");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ delta: 37, balanceAfter: 37, reason: "admin_adjust" });
    expect(audits.map((audit) => audit.action).sort()).toEqual([
      "admin.permission.grant",
      "billing.ledger.adjust",
      "user.status.write",
      "user.status.write",
    ]);
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { targetId } });
    await prisma.adminUserPermission.deleteMany({ where: { userId: targetId } });
    await prisma.dreamcoinLedger.deleteMany({ where: { userId: targetId } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, targetId] } } });
  }
});

test("team access hides high-risk controls without their effective permissions", async ({ page }) => {
  const support = await startRoleSession(page, "support");
  const targetId = `e2e-access-readonly-${Date.now()}`;
  await prisma.user.create({
    data: {
      id: targetId,
      email: uniqueEmail("access-readonly"),
      displayName: "Read-only access target",
      emailVerified: true,
    },
  });

  try {
    await page.goto(`${adminBaseURL()}/admin/system/access`);
    await expectAdminShellReady(page, "Team Access");
    const targetRow = page.getByRole("row").filter({ hasText: targetId });
    await expect(targetRow).toHaveCount(1);
    await expect(page.getByText("Permission override", { exact: true })).toHaveCount(0);
    await expect(targetRow.getByRole("button", { name: /Suspend|Restore/ })).toHaveCount(0);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [support.id, targetId] } } });
  }
});

test("admin feature flag toggle requires target-state confirmation", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startAdminSession(page);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const flagKey = `e2e_flag_confirmation_${suffix}`;

  try {
    await prisma.featureFlag.create({
      data: {
        key: flagKey,
        label: "E2E flag confirmation",
        description: "Feature flag confirmation target",
        enabled: false,
        rolloutPercent: 0,
        targetRoles: [],
        targetPlans: [],
      },
    });

    const adminURL = adminBaseURL();
    await page.goto(`${adminURL}/admin/generation/config?tab=settings`);
    await expectAdminShellReady(page, "Profiles & Rollout");
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill(flagKey);
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const flagRow = page.getByRole("row").filter({ hasText: flagKey });
    await expect(flagRow).toHaveCount(1, { timeout: 10_000 });
    await flagRow.getByRole("button", { name: "Enable" }).click();

    await expect(page.getByRole("heading", { name: `Enable ${flagKey}` })).toBeVisible();
    await page.getByRole("textbox", { name: "Reason", exact: true }).fill("E2E feature flag enable");
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill("FLAG");
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill(`${flagKey}:enabled`);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByTestId("admin-action-status")).toContainText(
      `Enable ${flagKey} completed.`,
      { timeout: 10_000 },
    );

    const flag = await prisma.featureFlag.findUniqueOrThrow({ where: { key: flagKey } });
    expect(flag.enabled).toBe(true);
    await prisma.adminAuditLog.findFirstOrThrow({
      where: { actorId: admin.id, action: "config.feature_flag.write", targetId: flagKey },
    });
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { targetId: flagKey } });
    await prisma.featureFlag.deleteMany({ where: { key: flagKey } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
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
    await expectAdminShellReady(page, "Moderation Cases");
    const appealRow = page.locator("tr").filter({ hasText: appeal.id });
    await expect(appealRow).toBeVisible({ timeout: 10_000 });
    await appealRow.getByRole("button", { name: "Overturn" }).click();

    await expect(page.getByRole("heading", { name: `Overturn appeal ${appeal.id}` })).toBeVisible();
    await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Appeal accepted from admin web E2E");
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill("OVERTURN");
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
    await prisma.dreamcoinLedger.create({
      data: {
        userId: ownerId,
        delta: -7,
        balanceAfter: -7,
        reason: "generation_spend",
        sourceId: jobId,
        idempotencyKey: `generation:${jobId}:spend`,
      },
    });

    const adminURL = adminBaseURL();
    await page.goto(`${adminURL}/admin/generation/dead-letter`);
    await expectAdminShellReady(page, "Dead-letter");

    const rowCheckbox = page.getByRole("checkbox", { name: `Select dead-letter job ${jobId}` });
    await expect(rowCheckbox).toBeVisible({ timeout: 20_000 });
    const jobRow = rowCheckbox.locator("xpath=ancestor::tr");
    await expect(jobRow.getByText("reserved", { exact: true })).toBeVisible();
    await rowCheckbox.check();
    await page.getByRole("button", { name: "Discard selected" }).click();

    await expect(page.getByRole("heading", { name: "Discard 1 jobs" })).toBeVisible();
    await page.getByRole("textbox", { name: "Reason", exact: true }).fill(reason);
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill("DISCARD");
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill(jobId);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByTestId("admin-action-status")).toContainText("Discard 1 jobs completed.", {
      timeout: 10_000,
    });

    await expect(page.getByRole("row").filter({ hasText: jobId })).toHaveCount(0, {
      timeout: 10_000,
    });
    const discarded = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(discarded.status).toBe("failed");
    const audit = await prisma.adminAuditLog.findFirst({
      where: { actorId: admin.id, action: "ops.deadletter.discard", reason },
    });
    const ledger = await prisma.dreamcoinLedger.findMany({ where: { sourceId: jobId } });
    const refund = ledger.find((entry) => entry.reason === "refund");
    expect(refund?.delta, JSON.stringify({ audit: audit?.after, ledger }, null, 2)).toBe(7);
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
    await expectAdminShellReady(page, "Support Cases");
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
    await expectAdminShellReady(page, "Support Cases");
    await page.getByRole("button", { name: viewLabel, exact: true }).click();
    const ticketRow = page.getByRole("row").filter({ hasText: ticketId });
    await expect(ticketRow).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByRole("row").filter({ hasText: freshTicketId })).toHaveCount(0);
    await expect(ticketRow.getByText("overdue", { exact: true })).toBeVisible();
    await ticketRow.getByRole("button", { name: "Escalate" }).click();
    await page
      .getByRole("textbox", { name: "Reason", exact: true })
      .fill("Escalated from admin support inbox");
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill(ticketId);
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
    await page
      .getByRole("textbox", { name: "Reason", exact: true })
      .fill("Resolved from admin support inbox");
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill(ticketId);
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

test("admin Chat Ops isolates authority failures and restores URL filters", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);
  await startAdminSession(page);
  await page.route("**/api/v1/admin/chat/usage**", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ ok: false, error: { code: "upstream_error", message: "usage unavailable" } }),
      contentType: "application/json",
      status: 500,
    });
  });

  const adminURL = adminBaseURL();
  await page.goto(`${adminURL}/admin/chat`);
  await expectAdminShellReady(page, "Chat Operations");
  await expect(page.getByText("Usage: unavailable", { exact: false })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "usage authority refresh failed" })).toBeVisible();
  await expect(page.getByText("Sessions: current client snapshot", { exact: false })).toBeVisible();
  await expect(page.getByText("Chat Service connected", { exact: true })).toBeVisible();

  await page.getByLabel("User ID", { exact: true }).fill("chat-user-1");
  await page.getByRole("combobox", { name: /Session status/ }).selectOption("all");
  await page.getByRole("button", { name: "Filter Chat Ops" }).click();
  await expect(page).toHaveURL(/chatUserId=chat-user-1/);
  await expect(page).toHaveURL(/chatSessionStatus=all/);
  await page.goBack();
  await expect(page.getByLabel("User ID", { exact: true })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: /Session status/ })).toHaveValue("active");
  expect(consoleFailures.filter((message) => !message.includes("/api/v1/admin/chat/usage"))).toEqual([]);
});

test("admin support plaintext panel views consent-scoped generation prompt", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);

  const support = await startRoleSession(page, "support");
  const owner = await prisma.user.create({
    data: {
      email: uniqueEmail("plaintext-owner"),
      emailVerified: true,
      displayName: "Plaintext Owner",
    },
    select: { id: true },
  });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const jobId = `e2e-plaintext-job-${suffix}`;
  const ticketId = `SUP-PT${Date.now().toString().slice(-8)}`;
  const prompt = `E2E consent scoped prompt ${suffix}`;
  const negativePrompt = `E2E redacted negative ${suffix}`;
  const reason = "Consent scoped plaintext support review";

  try {
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId: owner.id,
        mode: "image",
        prompt,
        negativePrompt,
        controls: {},
        presetIds: [],
        status: "failed",
        costDreamcoins: 0,
      },
    });
    await prisma.supportConsentGrant.create({
      data: {
        userId: owner.id,
        ticketId,
        targetType: "generation_job",
        targetId: jobId,
        scope: { fields: ["prompt"] },
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        createdById: support.id,
      },
    });

    const adminURL = adminBaseURL();
    await page.goto(`${adminURL}/admin/support`);
    await expectAdminShellReady(page, "Support Cases");
    await expect(page.getByRole("heading", { name: "Plaintext access" })).toBeVisible();

    await page.getByRole("combobox", { name: "Target type" }).selectOption("generation_job");
    await page.getByRole("textbox", { name: "Plaintext target ID" }).fill(jobId);
    await page.getByRole("textbox", { name: "Consent ticket ID" }).fill(ticketId);
    await page.getByRole("textbox", { name: "Plaintext reason" }).fill(reason);
    await page.getByRole("textbox", { name: "Plaintext confirmation" }).fill("VIEW");
    await expect(page.getByRole("button", { name: "View plaintext" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Plaintext confirmation" }).fill(jobId);
    await page.getByRole("button", { name: "View plaintext" }).click();

    await expect(page.getByTestId("admin-plaintext-status")).toContainText("Plaintext access logged.", {
      timeout: 10_000,
    });
    const result = page.getByTestId("admin-plaintext-result");
    await expect(result).toContainText(prompt);
    await expect(result).toContainText(ticketId);
    await expect(result).not.toContainText(negativePrompt);

    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { actorId: support.id, action: "support.plaintext.view", targetId: jobId },
      orderBy: { createdAt: "desc" },
    });
    const auditPayload = JSON.stringify({ before: audit.before, after: audit.after });
    expect(auditPayload).toContain("prompt");
    expect(auditPayload).toContain(ticketId);
    expect(auditPayload).not.toContain(prompt);
    expect(auditPayload).not.toContain(negativePrompt);
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { targetId: jobId } });
    await prisma.supportConsentGrant.deleteMany({ where: { targetType: "generation_job", targetId: jobId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: { in: [support.id, owner.id] } } });
  }
});

test("admin approval decisions require request-id confirmation", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();
  const requester = await prisma.user.create({
    data: {
      email: uniqueEmail("approval-requester"),
      emailVerified: true,
      displayName: "Approval Requester",
      role: "admin",
    },
    select: { id: true },
  });
  const approval = await prisma.adminActionRequest.create({
    data: {
      requestedById: requester.id,
      permissionKey: "billing.ledger.adjust",
      action: "billing.ledger.adjust",
      targetType: "user",
      targetId: requester.id,
      payload: { delta: 250 },
      status: "pending",
      reason: "E2E pending approval",
    },
  });

  try {
    await page.goto(`${adminURL}/admin/approvals`);
    await expectAdminShellReady(page, "Approvals");
    const row = page.getByRole("row").filter({ hasText: approval.id });
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    await row.getByRole("button", { name: "Approve" }).click();

    await expect(page.getByRole("heading", { name: `Approve ${approval.id}` })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole("textbox", { name: "Reason", exact: true }).fill("E2E approval decision");
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill("APPROVE");
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill(approval.id);
    await expect(page.getByRole("button", { name: "Confirm" })).toBeEnabled();
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(page.getByTestId("admin-action-status")).toContainText(
      `Approve ${approval.id} completed.`,
      { timeout: 10_000 },
    );
    await expect(
      prisma.adminActionRequest.findUniqueOrThrow({
        where: { id: approval.id },
        select: { status: true, approvedById: true },
      }),
    ).resolves.toEqual({ status: "approved", approvedById: admin.id });
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { targetId: requester.id } });
    await prisma.adminActionRequest.deleteMany({ where: { id: approval.id } });
    await prisma.session.deleteMany({ where: { userId: { in: [admin.id, requester.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, requester.id] } } });
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
    await expectAdminShellReady(page, "Character Review");
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
    await expectAdminShellReady(page, "Character Review");
    await page.getByRole("button", { name: viewLabel, exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: reportedName })).toHaveCount(1);
    await expect(page.getByRole("row").filter({ hasText: cleanName })).toHaveCount(0);
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
    const seededSubmission = await prisma.characterSubmission.create({
      data: { characterId, submitterId: submitter.id, status: "pending" },
    });

    const adminURL = adminBaseURL();
    await page.goto(`${adminURL}/admin/content/review-queue`);
    await expectAdminShellReady(page, "Character Review");
    await page.getByRole("textbox", { name: "Search review queue" }).fill(characterName);
    const row = page.getByRole("row").filter({ hasText: characterName });
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    await row.getByRole("button", { name: "Approve", exact: true }).click();

    await expect(page.getByRole("heading", { name: `Approve ${characterName}` })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByPlaceholder("Review note (optional, shown to creator)").fill("Approved by E2E review queue.");
    await page.getByPlaceholder("Audit reason (≥3)").fill("e2e approval");
    await page.getByPlaceholder(`Type ${seededSubmission.id} to confirm`).fill("REVIEW");
    await expect(page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
    await page.getByPlaceholder(`Type ${seededSubmission.id} to confirm`).fill(seededSubmission.id);
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
    const create = await page.request.post(`${adminURL}/api/v2/admin/pricing/rules`, {
      headers: { "idempotency-key": crypto.randomUUID() },
      data: {
        ruleKey,
        label: "E2E rule",
        mode: "image",
        baseCost: 5,
        multiplier: 1,
        reason: "E2E pricing draft",
        confirmation: ruleKey,
      },
    });
    expect(create.status(), await create.text()).toBe(200);
  } finally {
    await prisma.pricingRule.deleteMany({ where: { ruleKey } });
  }
});

test("admin API creates an official character and fails mock AI assist closed", async ({ page }) => {
  const adminURL = adminBaseURL();
  await startRoleSession(page, "admin");
  const name = `E2E Official ${Date.now()}`;
  let createdId: string | undefined;
  try {
    const create = await page.request.post(`${adminURL}/api/v1/admin/content/official`, {
      headers: { "idempotency-key": `e2e-official-create-${Date.now()}` },
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

    // A mock chat provider must never return operator-saveable creative fields.
    const assist = await page.request.post(`${adminURL}/api/v1/admin/content/character-assist`, {
      data: { seed: "shy bookish painter who loves rainy nights", gender: "female", style: "realistic" },
    });
    expect(assist.status(), await assist.text()).toBe(503);
    const assistBody = (await assist.json()) as {
      error?: { code?: string };
      data?: unknown;
    };
    expect(assistBody.error?.code).toBe("unavailable");
    expect(assistBody.data).toBeUndefined();
  } finally {
    if (createdId) await prisma.character.delete({ where: { id: createdId } }).catch(() => {});
    await prisma.tag.deleteMany({ where: { slug: "e2e-official" } });
  }
});

test("admin character templates require inline confirmation for public writes", async ({
  page,
}) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const templateName = `E2E Template Confirm ${suffix}`;
  let templateId: string | undefined;

  try {
    await page.goto(`${adminURL}/admin/content/templates`);
    await expectAdminShellReady(page, "Character Starters");
    const createTemplateLink = page
      .getByRole("link", { name: "New starter template" })
      .first();
    await expect(createTemplateLink).toHaveAttribute(
      "href",
      "/admin/content/templates/new",
    );
    await page.goto(`${adminURL}/admin/content/templates/new`);
    await expect(page.getByRole("heading", { level: 2, name: "New starter template" })).toBeVisible();
    await page.getByLabel("Name (≥1)").fill(templateName);
    await page.getByLabel("Summary (≤200)").fill("Template confirmation test");
    await page.getByRole("button", { name: "Save template draft" }).click();
    await expect(page.getByRole("heading", { level: 2, name: templateName })).toBeVisible({ timeout: 10_000 });
    const template = await prisma.characterTemplate.findFirstOrThrow({
      where: { name: templateName },
      select: { id: true, isActive: true },
    });
    templateId = template.id;
    expect(template.isActive).toBe(false);

    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const publishDialog = page.getByRole("dialog", { name: "Publish" });
    const confirmPublish = publishDialog.getByRole("button", { name: "Publish", exact: true });
    await publishDialog.getByRole("textbox", { name: "Reason (≥3)" }).fill("E2E template publish");
    await expect(confirmPublish).toBeDisabled();
    await publishDialog.getByRole("textbox", { name: "Type the name to confirm" }).fill(templateName);
    await expect(confirmPublish).toBeEnabled();
    await confirmPublish.click();
    await expect(page.getByText("Published", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(
      prisma.characterTemplate.findUniqueOrThrow({ where: { id: templateId }, select: { isActive: true } }),
    ).resolves.toEqual({ isActive: true });

    await page.getByRole("button", { name: "Offline", exact: true }).click();
    const offlineDialog = page.getByRole("dialog", { name: "Offline" });
    const confirmOffline = offlineDialog.getByRole("button", { name: "Offline", exact: true });
    await offlineDialog.getByRole("textbox", { name: "Reason (≥3)" }).fill("E2E template offline");
    await expect(confirmOffline).toBeDisabled();
    await offlineDialog.getByRole("textbox", { name: "Type the name to confirm" }).fill(templateName);
    await expect(confirmOffline).toBeEnabled();
    await confirmOffline.click();
    await expect(page.getByText("Inactive", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(
      prisma.characterTemplate.findUniqueOrThrow({ where: { id: templateId }, select: { isActive: true } }),
    ).resolves.toEqual({ isActive: false });

    expect(consoleFailures).toEqual([]);
  } finally {
    if (templateId) {
      await prisma.adminAuditLog.deleteMany({ where: { targetId: templateId } });
      await prisma.characterTemplate.deleteMany({ where: { id: templateId } });
    }
    await prisma.session.deleteMany({ where: { userId: admin.id } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
  }
});

test("admin tag taxonomy metadata edits require typed confirmation", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const slug = `aaa-e2e-tag-confirm-${suffix}`;
  const initialLabel = `E2E Tag Confirm ${suffix}`;
  const updatedLabel = `E2E Tag Confirm Updated ${suffix}`;
  const tag = await prisma.tag.create({
    data: {
      slug,
      label: initialLabel,
      category: "aaa-e2e",
      isSensitive: false,
      isMutedByDefault: false,
    },
  });
  const sourceTag = await prisma.tag.create({
    data: {
      slug: `aaa-e2e-merge-source-${suffix}`,
      label: `E2E Merge Source ${suffix}`,
      category: "aaa-e2e",
      isSensitive: false,
      isMutedByDefault: false,
    },
  });
  const targetTag = await prisma.tag.create({
    data: {
      slug: `aaa-e2e-merge-target-${suffix}`,
      label: `E2E Merge Target ${suffix}`,
      category: "aaa-e2e",
      isSensitive: false,
      isMutedByDefault: false,
    },
  });

  try {
    await page.goto(`${adminURL}/admin/content/tags`);
    await expectAdminShellReady(page, "Taxonomy");
    const row = page.getByRole("row").filter({ hasText: slug });
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.getByRole("button", { name: "Edit" }).click();
    await row.getByPlaceholder("Label").fill(updatedLabel);
    await row.getByRole("button", { name: "Save changes" }).click();
    const renameDialog = page.getByRole("dialog", { name: "Save changes" });
    const save = renameDialog.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();
    await expect(
      prisma.tag.findUniqueOrThrow({
        where: { id: tag.id },
        select: { label: true, isSensitive: true },
      }),
    ).resolves.toEqual({ label: initialLabel, isSensitive: false });

    await renameDialog.getByRole("textbox", { name: "Reason (≥3)" }).fill("E2E tag metadata confirmation");
    await expect(save).toBeEnabled();
    await save.click();

    await expect(row.getByText(updatedLabel, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(
      prisma.tag.findUniqueOrThrow({
        where: { id: tag.id },
        select: { label: true, isSensitive: true },
      }),
    ).resolves.toEqual({ label: updatedLabel, isSensitive: false });

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.tag.update", targetId: tag.id },
      orderBy: { createdAt: "desc" },
      select: { reason: true },
    });
    expect(audit?.reason).toBe("E2E tag metadata confirmation");

    await page.getByLabel("Source tag").selectOption(sourceTag.id);
    await page.getByLabel("Target tag").selectOption(targetTag.id);
    const merge = page.getByRole("button", { name: "Merge", exact: true });
    await expect(merge).toBeEnabled();
    await merge.click();
    const mergeDialog = page.getByRole("dialog", { name: "Merge tags" });
    const confirmMerge = mergeDialog.getByRole("button", { name: "Merge", exact: true });
    await mergeDialog.getByRole("textbox", { name: "Reason (≥3)" }).fill("E2E tag merge confirmation");
    await mergeDialog.getByRole("textbox", { name: "Type the name to confirm" }).fill("wrong-target");
    await expect(confirmMerge).toBeDisabled();
    await mergeDialog.getByRole("textbox", { name: "Type the name to confirm" }).fill(targetTag.label);
    await expect(confirmMerge).toBeEnabled();
    await confirmMerge.click();
    await expect(page.getByText("Merged", { exact: false })).toBeVisible({ timeout: 10_000 });
    await expect(prisma.tag.findUnique({ where: { id: sourceTag.id } })).resolves.toBeNull();
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: [tag.id, sourceTag.id, targetTag.id] } } });
    await prisma.characterTag.deleteMany({ where: { tagId: { in: [tag.id, sourceTag.id, targetTag.id] } } });
    await prisma.tag.deleteMany({ where: { id: { in: [tag.id, sourceTag.id, targetTag.id] } } });
    await prisma.session.deleteMany({ where: { userId: admin.id } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
  }
});

test("admin pricing and promo creation require typed confirmation", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const ruleKey = `e2e_pricing_confirm_${suffix}`;
  const code = `E2E-PROMO-${suffix}`;
  const codeHash = redeemCodeHash(code);
  let pricingRuleId: string | undefined;
  let redeemCodeId: string | undefined;

  try {
    await page.goto(`${adminURL}/admin/pricing`);
    await expectAdminShellReady(page, "Pricing");
    await page.getByRole("textbox", { name: "Rule Key", exact: true }).fill(ruleKey);
    await page.getByRole("textbox", { name: "Label", exact: true }).fill("E2E pricing confirmation");
    await page.getByRole("textbox", { name: "Base Cost (coins)", exact: true }).fill("7");
    await page.getByRole("textbox", { name: "Multiplier", exact: true }).fill("1");
    await page.getByRole("textbox", { name: "Reason (≥3)", exact: true }).fill("E2E pricing create confirmation");
    const createDraft = page.getByRole("button", { name: "Create Draft" });
    await expect(createDraft).toBeDisabled();
    await page.getByRole("textbox", { name: "Confirm rule key", exact: true }).fill("wrong-key");
    await expect(createDraft).toBeDisabled();
    await expect(prisma.pricingRule.count({ where: { ruleKey } })).resolves.toBe(0);

    await page.getByRole("textbox", { name: "Confirm rule key", exact: true }).fill(ruleKey);
    await expect(createDraft).toBeEnabled();
    await createDraft.click();
    await expect.poll(() => prisma.pricingRule.count({ where: { ruleKey } })).toBe(1);
    const pricingRule = await prisma.pricingRule.findFirstOrThrow({
      where: { ruleKey },
      select: { id: true, status: true, baseCost: true },
    });
    pricingRuleId = pricingRule.id;
    expect(pricingRule).toMatchObject({ status: "draft", baseCost: 7 });
    await expect(page.getByRole("row").filter({ hasText: ruleKey })).toBeVisible({ timeout: 10_000 });
    const pricingAudit = await prisma.adminAuditLog.findFirst({
      where: { action: "config.pricing.create", targetId: pricingRuleId },
      orderBy: { createdAt: "desc" },
      select: { reason: true },
    });
    expect(pricingAudit?.reason).toBe("E2E pricing create confirmation");

    await page.goto(`${adminURL}/admin/promo`);
    await expectAdminShellReady(page, "Promotions");
    await page.getByRole("textbox", { name: "Code (≥4)", exact: true }).fill(code);
    await page.getByRole("textbox", { name: "Dreamcoins", exact: true }).fill("42");
    await page.getByRole("textbox", { name: "Max uses (blank=∞)", exact: true }).fill("3");
    await page.getByRole("textbox", { name: "Reason (≥3)", exact: true }).fill("E2E promo create confirmation");
    const createCode = page.getByRole("button", { name: "Create", exact: true });
    await expect(createCode).toBeDisabled();
    await page.getByRole("textbox", { name: "Redeem code confirmation" }).fill("CREATE");
    await expect(createCode).toBeDisabled();
    await expect(prisma.redeemCode.count({ where: { codeHash } })).resolves.toBe(0);

    await page.getByRole("textbox", { name: "Redeem code confirmation" }).fill(code);
    await expect(createCode).toBeEnabled();
    await createCode.click();
    await expect.poll(() => prisma.redeemCode.count({ where: { codeHash } })).toBe(1);
    const redeemCode = await prisma.redeemCode.findUniqueOrThrow({
      where: { codeHash },
      select: { id: true, status: true, reward: true, maxRedemptions: true },
    });
    redeemCodeId = redeemCode.id;
    expect(redeemCode.status).toBe("active");
    expect(redeemCode.maxRedemptions).toBe(3);
    await expect(page.getByRole("row").filter({ hasText: redeemCodeId })).toBeVisible({ timeout: 10_000 });
    const promoAudit = await prisma.adminAuditLog.findFirst({
      where: { action: "promo.redeem_code.create", targetId: redeemCodeId },
      orderBy: { createdAt: "desc" },
      select: { reason: true },
    });
    expect(promoAudit?.reason).toBe("E2E promo create confirmation");
    expect(consoleFailures).toEqual([]);
  } finally {
    if (pricingRuleId) await prisma.adminAuditLog.deleteMany({ where: { targetId: pricingRuleId } });
    if (redeemCodeId) {
      await prisma.adminAuditLog.deleteMany({ where: { targetId: redeemCodeId } });
      await prisma.redeemCodeRedemption.deleteMany({ where: { redeemCodeId } });
      await prisma.redeemCode.deleteMany({ where: { id: redeemCodeId } });
    } else {
      await prisma.redeemCode.deleteMany({ where: { codeHash } });
    }
    await prisma.pricingRule.deleteMany({ where: { ruleKey } });
    await prisma.session.deleteMany({ where: { userId: admin.id } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
  }
});

test("admin featured curation requires typed target confirmation", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const featuredId = `e2e-featured-confirm-${suffix}`;
  const secondId = `e2e-featured-second-${suffix}`;
  let previousFeatured: {
    value: unknown;
    version: number;
    status: string;
  } | null = null;

  try {
    previousFeatured = await prisma.appSetting.findUnique({
      where: { key: "feed.featured" },
      select: { value: true, version: true, status: true },
    });
    await prisma.appSetting.deleteMany({ where: { key: "feed.featured" } });
    await prisma.character.createMany({
      data: [
        {
          id: featuredId,
          creatorId: admin.id,
          name: `Featured Confirm ${suffix}`,
          age: 25,
          description: "Featured confirmation target",
          visibility: "public",
          status: "approved",
          style: "realistic",
          gender: "female",
          appearance: {},
          advancedDetails: {},
        },
        {
          id: secondId,
          creatorId: admin.id,
          name: `Featured Second ${suffix}`,
          age: 26,
          description: "Featured confirmation second target",
          visibility: "public",
          status: "approved",
          style: "realistic",
          gender: "female",
          appearance: {},
          advancedDetails: {},
        },
      ],
    });

    await page.goto(`${adminURL}/admin/content`);
    await expectAdminShellReady(page, "Featured Merchandising");
    await page.getByPlaceholder("char_a, char_b").fill(`${featuredId}, ${secondId}`);
    await page.getByPlaceholder("Reason (≥3 chars)").fill("E2E featured curation confirmation");
    const saveFeatured = page.getByRole("button", { name: "Save featured" });
    await expect(saveFeatured).toBeDisabled();
    await page.getByRole("textbox", { name: "Featured confirmation" }).fill("FEATURED");
    await expect(saveFeatured).toBeDisabled();
    await expect(prisma.appSetting.findUnique({ where: { key: "feed.featured" } })).resolves.toBeNull();

    await page.getByRole("textbox", { name: "Featured confirmation" }).fill(`${featuredId},${secondId}`);
    await expect(saveFeatured).toBeEnabled();
    await saveFeatured.click();
    await expect.poll(async () => {
      const setting = await prisma.appSetting.findUnique({ where: { key: "feed.featured" } });
      return {
        characterIds:
          (setting?.value as { characterIds?: string[] } | null)
            ?.characterIds ?? [],
        version: setting?.version ?? 0,
      };
    }).toEqual({
      characterIds: [featuredId, secondId],
      version: 1,
    });
    await expect(page.getByRole("row").filter({ hasText: featuredId }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("row").filter({ hasText: secondId }).first()).toBeVisible({ timeout: 10_000 });

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.featured.write", targetId: "feed.featured" },
      orderBy: { createdAt: "desc" },
      select: { reason: true, after: true },
    });
    expect(audit?.reason).toBe("E2E featured curation confirmation");
    expect(
      (audit?.after as {
        configuredCharacterIds?: string[];
        settingVersion?: number;
      })?.configuredCharacterIds,
    ).toEqual([featuredId, secondId]);
    expect(
      (audit?.after as { settingVersion?: number })?.settingVersion,
    ).toBe(1);
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { action: "content.featured.write", targetId: "feed.featured" } });
    await prisma.character.deleteMany({ where: { id: { in: [featuredId, secondId] } } });
    if (previousFeatured) {
      await prisma.appSetting.upsert({
        where: { key: "feed.featured" },
        update: {
          value: previousFeatured.value as never,
          version: previousFeatured.version,
          status: previousFeatured.status,
        },
        create: {
          key: "feed.featured",
          value: previousFeatured.value as never,
          version: previousFeatured.version,
          status: previousFeatured.status,
        },
      });
    } else {
      await prisma.appSetting.deleteMany({ where: { key: "feed.featured" } });
    }
    await prisma.session.deleteMany({ where: { userId: admin.id } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
  }
});

test("admin API forbids under-privileged roles (403 on writes they lack)", async ({ page }) => {
  const adminURL = adminBaseURL();
  // support holds content.read but NOT content.takedown.write / config.pricing.write.
  await startRoleSession(page, "support");

  const pricing = await page.request.post(`${adminURL}/api/v2/admin/pricing/rules`, {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: {
      ruleKey: "e2e_forbidden",
      label: "x",
      mode: "image",
      baseCost: 5,
      multiplier: 1,
      reason: "E2E forbidden pricing write",
      confirmation: "e2e_forbidden",
    },
  });
  expect(pricing.status()).toBe(403);

  const takedown = await page.request.post(
    `${adminURL}/api/v1/admin/content/characters/none/visibility`,
    { data: { visibility: "private", reason: "test reason", confirmation: "none:visibility:private" } },
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
        description:
          "An end-to-end CMS guide proving that validated editorial content can move safely from draft to publication.",
        body: {
          heading: "Hello CMS",
          intro:
            "Published CMS content keeps the application shell while the body remains governed by the validated editorial contract.",
          sections: [
            {
              heading: "Navigation proof",
              paragraphs: [
                "The published article renders inside the product navigation and keeps every primary route available to the reader.",
              ],
            },
            {
              heading: "Publication proof",
              paragraphs: [
                "The page becomes public only after its complete article body and current database version pass the publication command.",
              ],
            },
          ],
          cta: { label: "Explore", href: "/" },
        },
        reason: "e2e cms create",
        confirmation: path,
      },
    });
    const createdPayload = (await create.json()) as {
      data?: { page?: { updatedAt?: string } };
    };
    expect(create.status(), JSON.stringify(createdPayload)).toBe(200);
    const expectedUpdatedAt = createdPayload.data?.page?.updatedAt;
    expect(typeof expectedUpdatedAt).toBe("string");

    const publish = await page.request.post(`${adminURL}/api/v1/admin/cms/pages/publish`, {
      data: {
        path,
        contentStatus: "published",
        expectedUpdatedAt,
        reason: "e2e cms publish",
        confirmation: path,
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
    `${adminURL}/api/v2/admin/compliance/users/none/erase`,
    { data: { reason: "test erase", confirmation: "none" } },
  );
  expect(erase.status()).toBe(403);

  // analyst holds analytics.export → retention ok; lacks compliance.read → age list 403.
  await startRoleSession(page, "analyst");
  const retention = await page.request.get(`${adminURL}/api/v1/admin/analytics/retention`);
  expect(retention.status()).toBe(200);
  const ageList = await page.request.get(`${adminURL}/api/v2/admin/compliance/age-verifications`);
  expect(ageList.status()).toBe(403);
});

test("admin CMS UI requires typed confirmation for publish changes", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  const admin = await startRoleSession(page, "admin");
  const adminURL = adminBaseURL();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const routePath = `/e2e-cms-confirm-${suffix}`;

  try {
    const create = await page.request.post(`${adminURL}/api/v1/admin/cms/pages`, {
      data: {
        path: routePath,
        title: "E2E CMS confirmation page",
        description:
          "An end-to-end confirmation page with complete editorial content for the CMS publication workflow.",
        body: {
          heading: "Confirmation page",
          intro:
            "This complete draft proves that an operator must type the exact route before a versioned CMS publication can proceed.",
          sections: [
            {
              heading: "Typed confirmation",
              paragraphs: [
                "The status command remains disabled until the operator provides a reason and types the exact page path shown in the row.",
              ],
            },
            {
              heading: "Version protection",
              paragraphs: [
                "The interface sends the row version loaded from Main so a stale browser cannot overwrite a newer editorial decision.",
              ],
            },
          ],
        },
        reason: "E2E CMS confirmation create",
        confirmation: routePath,
      },
    });
    expect(create.status(), await create.text()).toBe(200);

    await page.goto(`${adminURL}/admin/cms`);
    await expectAdminShellReady(page, "CMS & SEO");

    const row = page.getByRole("row").filter({ hasText: routePath });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole("button", { name: "Publish" }).click();

    const confirmPublish = page.getByRole("button", { name: "Confirm publish change" });
    await expect(confirmPublish).toBeDisabled();
    await page.getByRole("textbox", { name: "CMS publish reason" }).fill("E2E publish CMS page");
    await expect(confirmPublish).toBeDisabled();
    await page.getByRole("textbox", { name: "CMS publish confirmation" }).fill("WRONG");
    await expect(confirmPublish).toBeDisabled();
    await page.getByRole("textbox", { name: "CMS publish confirmation" }).fill("PUBLISH");
    await expect(confirmPublish).toBeDisabled();
    await page.getByRole("textbox", { name: "CMS publish confirmation" }).fill(routePath);
    await expect(confirmPublish).toBeEnabled();
    await confirmPublish.click();
    await expect(row).toContainText("published", { timeout: 10_000 });

    await row.getByRole("button", { name: "Unpublish" }).click();
    await expect(confirmPublish).toBeDisabled();
    await page.getByRole("textbox", { name: "CMS publish reason" }).fill("E2E unpublish CMS page");
    await page.getByRole("textbox", { name: "CMS publish confirmation" }).fill(routePath);
    await expect(confirmPublish).toBeEnabled();
    await confirmPublish.click();
    await expect(row).toContainText("draft", { timeout: 10_000 });

    expect(dialogs).toEqual([]);
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { targetId: routePath } });
    await prisma.routePage.deleteMany({ where: { path: routePath } });
    await prisma.session.deleteMany({ where: { userId: admin.id } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
  }
});

test("admin insights configuration check UI requires typed confirmation", async ({ page }) => {
  const consoleFailures = collectConsoleFailures(page);
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  const admin = await startRoleSession(page, "admin");
  const adminURL = adminBaseURL();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const profile = await prisma.generationModelProfile.create({
    data: {
      profileKey: `e2e-insights-dryrun-${suffix}`,
      label: "E2E Insights Configuration Check",
      pipelineModel: "test-model",
      allowedOrientations: ["1:1"],
      status: "draft",
    },
    select: { id: true },
  });

  try {
    await page.goto(`${adminURL}/admin/insights`);
    await expectAdminShellReady(page, "Funnels & Retention");

    await page.getByRole("textbox", { name: "Model profile id" }).fill(profile.id);
    await page.getByRole("button", { name: "Configuration check" }).click();

    const confirmDryRun = page.getByRole("button", {
      name: "Confirm configuration check",
    });
    await expect(confirmDryRun).toBeDisabled();
    await page
      .getByRole("textbox", { name: "Configuration check reason" })
      .fill("E2E profile configuration check");
    await expect(confirmDryRun).toBeDisabled();
    await page
      .getByRole("textbox", { name: "Configuration check confirmation" })
      .fill("WRONG");
    await expect(confirmDryRun).toBeDisabled();
    await page
      .getByRole("textbox", { name: "Configuration check confirmation" })
      .fill("DRYRUN");
    await expect(confirmDryRun).toBeDisabled();
    await page
      .getByRole("textbox", { name: "Configuration check confirmation" })
      .fill(profile.id);
    await expect(confirmDryRun).toBeEnabled();
    await confirmDryRun.click();
    await expect(
      page.getByText(
        "Configuration check pass: 2/2 configuration cases passed. No provider call was made.",
      ),
    ).toBeVisible({ timeout: 10_000 });

    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: {
        actorId: admin.id,
        action: "generation.profile.dry_run",
        targetId: profile.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.reason).toBe("E2E profile configuration check");
    await expect
      .poll(async () => {
        const refreshed = await prisma.generationModelProfile.findUnique({
          where: { id: profile.id },
          select: { dryRunSummary: true },
        });
        return JSON.stringify(refreshed?.dryRunSummary ?? {});
      })
      .toContain("\"status\":\"pass\"");
    expect(dialogs).toEqual([]);
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { targetId: profile.id } });
    await prisma.generationModelProfile.deleteMany({ where: { id: profile.id } });
    await prisma.session.deleteMany({ where: { userId: admin.id } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
  }
});

test("admin compliance UI requires typed confirmations for destructive actions", async ({
  page,
}) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startRoleSession(page, "admin");
  const adminURL = adminBaseURL();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const targetId = `e2e-compliance-target-${suffix}`;
  const ageUserId = `e2e-compliance-age-${suffix}`;

  await prisma.user.createMany({
    data: [
      {
        id: targetId,
        email: uniqueEmail("compliance-target"),
        emailVerified: true,
        displayName: "Compliance Target",
      },
      {
        id: ageUserId,
        email: uniqueEmail("compliance-age"),
        emailVerified: true,
        displayName: "Compliance Age",
      },
    ],
  });
  const ageVerification = await prisma.ageVerification.create({
    data: {
      userId: ageUserId,
      provider: "mock",
      status: "pending",
      jurisdiction: "US-CA",
      metadata: {},
    },
  });

  try {
    await page.goto(`${adminURL}/admin/compliance`);
    await expectAdminShellReady(page, "Account Requests");

    await page.getByRole("textbox", { name: "User ID" }).fill(targetId);
    await page.getByRole("button", { name: "Export" }).click();
    await expect(page.locator("pre")).toContainText(targetId);

    await page.getByRole("button", { name: "Erase", exact: true }).click();
    const confirmErase = page.getByRole("button", { name: "Confirm erase" });
    await expect(confirmErase).toBeDisabled();
    await page.getByRole("textbox", { name: "Erase reason" }).fill("E2E compliance erasure");
    await expect(confirmErase).toBeDisabled();
    await page.getByRole("textbox", { name: "Erase confirmation" }).fill("WRONG");
    await expect(confirmErase).toBeDisabled();
    await page.getByRole("textbox", { name: "Erase confirmation" }).fill("ERASE");
    await expect(confirmErase).toBeDisabled();
    await page.getByRole("textbox", { name: "Erase confirmation" }).fill(targetId);
    await expect(confirmErase).toBeEnabled();
    await confirmErase.click();
    await expect(page.getByText("Erasure requested.")).toBeVisible();
    await expect(prisma.user.findUnique({ where: { id: targetId } })).resolves.toMatchObject({
      status: "deleted",
    });

    const ageRow = page.getByRole("row").filter({ hasText: ageUserId });
    await expect(ageRow).toBeVisible({ timeout: 10_000 });
    await ageRow.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(ageVerification.id)).toBeVisible();
    const confirmOverride = page.getByRole("button", { name: "Confirm override" });
    await expect(confirmOverride).toBeDisabled();
    await page.getByRole("textbox", { name: "Override reason" }).fill("E2E age verification review");
    await expect(confirmOverride).toBeDisabled();
    await page.getByRole("textbox", { name: "Override confirmation" }).fill("OVERRIDE");
    await expect(confirmOverride).toBeDisabled();
    await page.getByRole("textbox", { name: "Override confirmation" }).fill(ageVerification.id);
    await expect(confirmOverride).toBeEnabled();
    const overrideResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/api/v2/admin/compliance/age-verifications/${ageVerification.id}/override`),
    );
    await confirmOverride.click();
    await expect.poll(async () => (await overrideResponse).status()).toBe(200);
    await expect(page.getByText("Age verification updated.")).toBeVisible();
    await expect(page.getByText("Unauthorized")).toHaveCount(0);
    await expect
      .poll(async () => {
        const row = await prisma.ageVerification.findUnique({ where: { id: ageVerification.id } });
        return row?.status;
      })
      .toBe("verified");
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({
      where: { targetId: { in: [targetId, ageVerification.id] } },
    });
    await prisma.ageVerification.deleteMany({ where: { id: ageVerification.id } });
    await prisma.session.deleteMany({ where: { userId: { in: [admin.id, targetId, ageUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, targetId, ageUserId] } } });
  }
});

test("admin announcements UI requires typed confirmation for create, update, and delete", async ({
  page,
}) => {
  const consoleFailures = collectConsoleFailures(page);
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  const admin = await startRoleSession(page, "admin");
  const adminURL = adminBaseURL();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const title = `E2E announcement confirm ${suffix}`;
  let announcementId: string | undefined;

  try {
    await prisma.appSetting.deleteMany({ where: { key: "announcements" } });
    await page.goto(`${adminURL}/admin/announcements`);
    await expectAdminShellReady(page, "Announcements");

    await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
    await page.getByRole("textbox", { name: "Body", exact: true }).fill("Announcement confirmation smoke");
    await page.getByRole("textbox", { name: "Link URL (optional)" }).fill("/helpdesk");
    await page.getByPlaceholder("Reason (≥3)").fill("E2E create announcement confirmation");
    const createButton = page.getByRole("button", { name: "Create" });
    await expect(createButton).toBeDisabled();
    await page.getByRole("textbox", { name: "Announcement create confirmation" }).fill("ANNOUNCE");
    await expect(createButton).toBeDisabled();
    await expect(prisma.appSetting.findUnique({ where: { key: "announcements" } })).resolves.toBeNull();
    await page.getByRole("textbox", { name: "Announcement create confirmation" }).fill(title);
    await expect(createButton).toBeEnabled();
    await createButton.click();

    const row = page.getByRole("row").filter({ hasText: title });
    await expect(row).toBeVisible({ timeout: 10_000 });
    const setting = await prisma.appSetting.findUniqueOrThrow({ where: { key: "announcements" } });
    const created = (setting.value as { items?: Array<{ id?: string; title?: string }> }).items?.find(
      (item) => item.title === title,
    );
    announcementId = created?.id;
    expect(announcementId).toBeTruthy();
    await row.getByRole("button", { name: "Deactivate" }).click();

    const confirmUpdate = page.getByRole("button", { name: "Confirm update" });
    await expect(confirmUpdate).toBeDisabled();
    await page.getByRole("textbox", { name: "Announcement action reason" }).fill("E2E deactivate announcement");
    await expect(confirmUpdate).toBeDisabled();
    await page.getByRole("textbox", { name: "Announcement action confirmation" }).fill("WRONG");
    await expect(confirmUpdate).toBeDisabled();
    await page.getByRole("textbox", { name: "Announcement action confirmation" }).fill("ANNOUNCE");
    await expect(confirmUpdate).toBeDisabled();
    await page.getByRole("textbox", { name: "Announcement action confirmation" }).fill(announcementId ?? "");
    await expect(confirmUpdate).toBeEnabled();
    await confirmUpdate.click();
    await expect(row).toContainText("no", { timeout: 10_000 });

    await row.getByRole("button", { name: "Delete announcement" }).click();
    const confirmDelete = page.getByRole("button", { name: "Confirm delete" });
    await expect(confirmDelete).toBeDisabled();
    await page.getByRole("textbox", { name: "Announcement action reason" }).fill("E2E delete announcement");
    await page.getByRole("textbox", { name: "Announcement action confirmation" }).fill("DELETE");
    await expect(confirmDelete).toBeDisabled();
    await page.getByRole("textbox", { name: "Announcement action confirmation" }).fill(announcementId ?? "");
    await expect(confirmDelete).toBeEnabled();
    await confirmDelete.click();
    await expect(row).toHaveCount(0, { timeout: 10_000 });

    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: {
        actorId: admin.id,
        action: "growth.announcement.delete",
        targetId: announcementId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.reason).toBe("E2E delete announcement");
    expect(dialogs).toEqual([]);
    expect(consoleFailures).toEqual([]);
  } finally {
    if (announcementId) await prisma.adminAuditLog.deleteMany({ where: { targetId: announcementId } });
    await prisma.appSetting.deleteMany({ where: { key: "announcements" } });
    await prisma.session.deleteMany({ where: { userId: admin.id } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
  }
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
        confirmation: "E2E banner",
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
