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
  const adminURL = adminBaseURL();

  const sections = [
    { path: "/admin", heading: "Dashboard", evidence: "Feature Flags" },
    { path: "/admin/generation/jobs", heading: "Jobs & Incidents", evidence: "status" },
    { path: "/admin/generation/models", heading: "Model Profiles", evidence: "Built-in profiles, test, publish, monitor" },
    { path: "/admin/generation/config", heading: "Model Profiles", evidence: "Built-in profiles, test, publish, monitor" },
    { path: "/admin/generation/dead-letter", heading: "Dead-letter", evidence: "Dead-letter Queue" },
    { path: "/admin/ops/providers", heading: "Provider Health", evidence: "Provider health & cost" },
    { path: "/admin/moderation", heading: "Moderation", evidence: "Reports" },
    { path: "/admin/content", heading: "Featured", evidence: "Featured curation" },
    { path: "/admin/content/production", heading: "Image Production", evidence: "Creative directions" },
    { path: "/admin/content/assets", heading: "Image Library", evidence: "Purpose" },
    { path: "/admin/content/placements", heading: "Placements", evidence: "Slot" },
    { path: "/admin/content/official", heading: "Official Characters", evidence: "Create official character" },
    { path: "/admin/content/templates", heading: "Character Starters", evidence: "Create character template" },
    { path: "/admin/content/tags", heading: "Tags", evidence: "Merge tags" },
    { path: "/admin/content/review-queue", heading: "Character Review", evidence: "Pending submissions" },
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

test("admin content ops requires confirmation for public placement and archive writes", async ({
  page,
}) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const characterId = `e2e-content-confirm-character-${suffix}`;
  const archiveAssetId = `e2e-content-confirm-archive-${suffix}`;
  const placementAssetId = `e2e-content-confirm-placement-${suffix}`;
  const archiveBatchId = `e2e-content-confirm-archive-batch-${suffix}`;
  const placementBatchId = `e2e-content-confirm-placement-batch-${suffix}`;
  const archiveBatchTitle = `Archive Confirmation ${suffix}`;
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
          id: archiveBatchId,
          title: archiveBatchTitle,
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
          batchId: archiveBatchId,
          mediaAssetId: archiveAssetId,
          itemIndex: 0,
          status: "approved",
          tags: ["e2e", "archive"],
          reviewedById: admin.id,
          reviewedAt: new Date(),
        },
        {
          batchId: placementBatchId,
          mediaAssetId: placementAssetId,
          itemIndex: 0,
          status: "approved",
          tags: ["e2e", "placement"],
          reviewedById: admin.id,
          reviewedAt: new Date(),
        },
      ],
    });

    await page.goto(`${adminURL}/admin/content/assets`);
    await expectAdminShellReady(page, "Image Library");
    const archiveCard = page.locator("article").filter({ hasText: archiveBatchTitle });
    await expect(archiveCard).toBeVisible({ timeout: 10_000 });
    await archiveCard.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText("Press Confirm archive asset to archive this asset.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: archiveAssetId },
        select: { metadata: true },
      }).then((asset) => platformStatusFromMetadata(asset.metadata)),
    ).resolves.toBe("approved");

    await archiveCard.getByRole("button", { name: "Confirm archive" }).click();
    await expect(archiveCard.getByText("archived", { exact: true })).toBeVisible({
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
        slot: "character_avatar",
        targetType: "character",
        targetId: characterId,
        status: "published",
        reason: "should reject archived asset",
      },
    });
    expect(archivedPlacementAttempt.status()).toBe(400);

    await page.goto(`${adminURL}/admin/content/placements`);
    await expectAdminShellReady(page, "Placements");
    await expect(page.getByLabel("Asset").locator(`option[value="${archiveAssetId}"]`)).toHaveCount(0);
    await page.getByLabel("Asset").selectOption(placementAssetId);
    await page.getByLabel("Target ID").fill(characterId);
    await page.getByRole("button", { name: "Create placement" }).click();
    await expect(page.getByText("Press Confirm create placement to publish this placement.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      prisma.mediaAssetPlacement.count({
        where: { mediaAssetId: placementAssetId, targetId: characterId },
      }),
    ).resolves.toBe(0);

    await page.getByRole("button", { name: "Confirm create placement" }).click();
    const placementRow = page.locator("article").filter({ hasText: placementAssetId });
    await expect(placementRow).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        async () => {
          const placement = await prisma.mediaAssetPlacement.findFirst({
            where: { mediaAssetId: placementAssetId, targetId: characterId },
            select: { status: true },
          });
          return placement?.status ?? null;
        },
        { timeout: 10_000 },
      )
      .toBe("published");
    const createdPlacement = await prisma.mediaAssetPlacement.findFirstOrThrow({
      where: { mediaAssetId: placementAssetId, targetId: characterId },
      select: { id: true, status: true },
    });
    expect(createdPlacement.status).toBe("published");
    await expect(
      prisma.character.findUniqueOrThrow({
        where: { id: characterId },
        select: { imageAssetId: true },
      }),
    ).resolves.toEqual({ imageAssetId: placementAssetId });

    await placementRow.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Press Confirm pause placement to update this placement.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      prisma.mediaAssetPlacement.findUniqueOrThrow({
        where: { id: createdPlacement.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "published" });

    await placementRow.getByRole("button", { name: "Confirm pause" }).click();
    await expect(placementRow.getByText("paused", { exact: true })).toBeVisible({ timeout: 10_000 });
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
    await prisma.contentProductionItem.deleteMany({
      where: { batchId: { in: [archiveBatchId, placementBatchId] } },
    });
    await prisma.contentProductionBatch.deleteMany({
      where: { id: { in: [archiveBatchId, placementBatchId] } },
    });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: [archiveAssetId, placementAssetId] } } });
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
    await expectAdminShellReady(page, "Users");
    await page.getByRole("textbox", { name: "Filter" }).fill(targetId);
    const targetRow = page.getByRole("row").filter({ hasText: targetId });
    await expect(targetRow).toHaveCount(1, { timeout: 10_000 });
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
    await expectAdminShellReady(page, "Billing");
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

    await page.goto(`${adminURL}/admin/audit-log`);
    await expectAdminShellReady(page, "Audit Log");
    await page.getByRole("textbox", { name: "Filter" }).fill(targetId);
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
    await expectAdminShellReady(page, "Model Profiles");
    await page.getByRole("textbox", { name: "Filter" }).fill(flagKey);
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
    await expectAdminShellReady(page, "Moderation");
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
    await page.getByRole("textbox", { name: "Reason", exact: true }).fill(reason);
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill("DISCARD");
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Confirmation", exact: true }).fill(jobId);
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
    await expectAdminShellReady(page, "Support Requests");
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
    const create = await page.request.post(`${adminURL}/api/v1/admin/pricing/rules`, {
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

test("admin official characters and templates require inline confirmation for public writes", async ({
  page,
}) => {
  const consoleFailures = collectConsoleFailures(page);
  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const officialName = `E2E Official Confirm ${suffix}`;
  const templateName = `E2E Template Confirm ${suffix}`;
  let officialId: string | undefined;
  let templateId: string | undefined;

  try {
    await page.goto(`${adminURL}/admin/content/official`);
    await expectAdminShellReady(page, "Official Characters");
    await page.getByPlaceholder("Name (1-80)").fill(officialName);
    await page.getByPlaceholder("Age (≥18)").fill("28");
    await page.getByPlaceholder("Description (1-1500)").fill("A cinematic official companion for confirmation testing.");
    await page.getByPlaceholder("Reason (≥3, for audit)").fill("E2E official confirmation create");

    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("Press Confirm create official character to publish this official character.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(prisma.character.count({ where: { name: officialName } })).resolves.toBe(0);

    await page.getByRole("button", { name: "Confirm create official character" }).click();
    const officialRow = page.getByRole("row").filter({ hasText: officialName });
    await expect(officialRow).toBeVisible({ timeout: 10_000 });
    const official = await prisma.character.findFirstOrThrow({
      where: { name: officialName, source: "official" },
      select: { id: true, status: true, visibility: true },
    });
    officialId = official.id;
    expect(official).toMatchObject({ status: "approved", visibility: "public" });

    await officialRow.getByPlaceholder("Reason (≥3)").fill("E2E archive official");
    await officialRow.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText("Press Confirm archive official character to update this official character.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: officialId }, select: { status: true } }),
    ).resolves.toEqual({ status: "approved" });

    await officialRow.getByRole("button", { name: "Confirm archive" }).click();
    await expect(officialRow.getByText("archived", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: officialId }, select: { status: true } }),
    ).resolves.toEqual({ status: "archived" });

    await officialRow.getByPlaceholder("Reason (≥3)").fill("E2E publish official");
    await officialRow.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByText("Press Confirm publish official character to update this official character.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: officialId }, select: { status: true } }),
    ).resolves.toEqual({ status: "archived" });

    await officialRow.getByRole("button", { name: "Confirm publish" }).click();
    await expect(officialRow.getByText("approved", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: officialId }, select: { status: true } }),
    ).resolves.toEqual({ status: "approved" });

    await page.goto(`${adminURL}/admin/content/templates`);
    await expectAdminShellReady(page, "Character Starters");
    await page.getByPlaceholder("Name (≥1)").fill(templateName);
    await page.getByPlaceholder("Summary (≤200)").fill("Template confirmation test");
    await page.getByPlaceholder("Reason (≥3)").fill("E2E template confirmation create");

    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("Press Confirm create template to publish this character template.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(prisma.characterTemplate.count({ where: { name: templateName } })).resolves.toBe(0);

    await page.getByRole("button", { name: "Confirm create template" }).click();
    const templateRow = page.getByRole("row").filter({ hasText: templateName });
    await expect(templateRow).toBeVisible({ timeout: 10_000 });
    const template = await prisma.characterTemplate.findFirstOrThrow({
      where: { name: templateName },
      select: { id: true, isActive: true },
    });
    templateId = template.id;
    expect(template.isActive).toBe(true);

    await templateRow.getByRole("button", { name: "Offline" }).click();
    await expect(page.getByRole("heading", { name: "Confirm offline template" })).toBeVisible();
    await expect(
      prisma.characterTemplate.findUniqueOrThrow({ where: { id: templateId }, select: { isActive: true } }),
    ).resolves.toEqual({ isActive: true });
    const confirmOffline = page.getByRole("button", { name: "Confirm offline" });
    await expect(confirmOffline).toBeDisabled();
    await page.getByRole("textbox", { name: "Template action reason" }).fill("E2E template offline");
    await expect(confirmOffline).toBeDisabled();
    await page.getByRole("textbox", { name: "Template action confirmation" }).fill("OFFLINE");
    await expect(confirmOffline).toBeDisabled();
    await page.getByRole("textbox", { name: "Template action confirmation" }).fill(templateId);
    await expect(confirmOffline).toBeEnabled();
    await confirmOffline.click();
    await expect(templateRow.getByText("offline", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(
      prisma.characterTemplate.findUniqueOrThrow({ where: { id: templateId }, select: { isActive: true } }),
    ).resolves.toEqual({ isActive: false });

    await templateRow.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByRole("heading", { name: "Confirm publish template" })).toBeVisible();
    const confirmPublish = page.getByRole("button", { name: "Confirm publish" });
    await expect(confirmPublish).toBeDisabled();
    await page.getByRole("textbox", { name: "Template action reason" }).fill("E2E template publish");
    await page.getByRole("textbox", { name: "Template action confirmation" }).fill("PUBLISH");
    await expect(confirmPublish).toBeDisabled();
    await page.getByRole("textbox", { name: "Template action confirmation" }).fill(templateId);
    await expect(confirmPublish).toBeEnabled();
    await confirmPublish.click();
    await expect(templateRow.getByText("active", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(
      prisma.characterTemplate.findUniqueOrThrow({ where: { id: templateId }, select: { isActive: true } }),
    ).resolves.toEqual({ isActive: true });

    expect(consoleFailures).toEqual([]);
  } finally {
    if (officialId) {
      await prisma.adminAuditLog.deleteMany({ where: { targetId: officialId } });
      await prisma.characterVisualProfile.deleteMany({ where: { characterId: officialId } });
      await prisma.characterStats.deleteMany({ where: { characterId: officialId } });
      await prisma.characterTag.deleteMany({ where: { characterId: officialId } });
      await prisma.character.deleteMany({ where: { id: officialId } });
    }
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
    await expectAdminShellReady(page, "Tags");
    const row = page.getByRole("row").filter({ hasText: slug });
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.getByRole("button", { name: "Edit" }).click();
    await row.getByPlaceholder("Label").fill(updatedLabel);
    await row.getByPlaceholder("Reason (≥3)").fill("E2E tag metadata confirmation");
    const save = row.getByRole("button", { name: "Confirm save" });
    await expect(save).toBeDisabled();
    await row.getByRole("textbox", { name: "Tag edit confirmation" }).fill("wrong-slug");
    await expect(save).toBeDisabled();
    await expect(
      prisma.tag.findUniqueOrThrow({
        where: { id: tag.id },
        select: { label: true, isSensitive: true },
      }),
    ).resolves.toEqual({ label: initialLabel, isSensitive: false });

    await row.getByRole("textbox", { name: "Tag edit confirmation" }).fill(slug);
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
    await page.getByPlaceholder("Reason (≥3)").fill("E2E tag merge confirmation");
    const merge = page.getByRole("button", { name: "Merge", exact: true });
    await expect(merge).toBeDisabled();
    await page.getByPlaceholder("Type source:target IDs").fill("MERGE");
    await expect(merge).toBeDisabled();
    await page.getByPlaceholder("Type source:target IDs").fill(`${sourceTag.id}:${targetTag.id}`);
    await expect(merge).toBeEnabled();
    await merge.click();
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
    await expectAdminShellReady(page, "Promo");
    await page.getByPlaceholder("Code (≥4)").fill(code);
    await page.getByPlaceholder("Dreamcoins").fill("42");
    await page.getByPlaceholder("Max uses (blank=∞)").fill("3");
    await page.getByPlaceholder("Reason (≥3)").fill("E2E promo create confirmation");
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
  let previousFeatured: unknown = null;

  try {
    previousFeatured = (await prisma.appSetting.findUnique({ where: { key: "feed.featured" } }))?.value ?? null;
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
    await expectAdminShellReady(page, "Featured");
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
      return (setting?.value as { characterIds?: string[] } | null)?.characterIds ?? [];
    }).toEqual([featuredId, secondId]);
    await expect(page.getByRole("row").filter({ hasText: featuredId }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("row").filter({ hasText: secondId }).first()).toBeVisible({ timeout: 10_000 });

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.featured.write", targetId: "feed.featured" },
      orderBy: { createdAt: "desc" },
      select: { reason: true, after: true },
    });
    expect(audit?.reason).toBe("E2E featured curation confirmation");
    expect((audit?.after as { characterIds?: string[] })?.characterIds).toEqual([featuredId, secondId]);
    expect(consoleFailures).toEqual([]);
  } finally {
    await prisma.adminAuditLog.deleteMany({ where: { action: "content.featured.write", targetId: "feed.featured" } });
    await prisma.character.deleteMany({ where: { id: { in: [featuredId, secondId] } } });
    if (previousFeatured) {
      await prisma.appSetting.upsert({
        where: { key: "feed.featured" },
        update: { value: previousFeatured as never },
        create: { key: "feed.featured", value: previousFeatured as never },
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

  const pricing = await page.request.post(`${adminURL}/api/v1/admin/pricing/rules`, {
    data: { ruleKey: "e2e_forbidden", label: "x", mode: "image", baseCost: 5, multiplier: 1 },
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
        description: "e2e",
        body: {
          heading: "Hello CMS",
          intro: "Published CMS content should keep the app shell.",
          sections: [{ heading: "Proof", paragraphs: ["CMS content renders in product navigation."] }],
          cta: { label: "Explore", href: "/" },
        },
        contentStatus: "draft",
        reason: "e2e cms create",
        confirmation: path,
      },
    });
    expect(create.status(), await create.text()).toBe(200);

    const publish = await page.request.post(`${adminURL}/api/v1/admin/cms/pages/publish`, {
      data: {
        path,
        contentStatus: "published",
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
    `${adminURL}/api/v1/admin/compliance/users/none/erase`,
    { data: { reason: "test erase", confirmation: "none" } },
  );
  expect(erase.status()).toBe(403);

  // analyst holds analytics.export → retention ok; lacks compliance.read → age list 403.
  await startRoleSession(page, "analyst");
  const retention = await page.request.get(`${adminURL}/api/v1/admin/analytics/retention`);
  expect(retention.status()).toBe(200);
  const ageList = await page.request.get(`${adminURL}/api/v1/admin/compliance/age-verifications`);
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
        description: "e2e confirmation",
        body: { heading: "Confirmation page" },
        contentStatus: "draft",
        reason: "E2E CMS confirmation create",
        confirmation: routePath,
      },
    });
    expect(create.status(), await create.text()).toBe(200);

    await page.goto(`${adminURL}/admin/cms`);
    await expectAdminShellReady(page, "CMS / SEO");

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

test("admin insights dry-run UI requires typed confirmation", async ({ page }) => {
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
      label: "E2E Insights Dry-run",
      pipelineModel: "test-model",
      allowedOrientations: ["1:1"],
      status: "draft",
    },
    select: { id: true },
  });

  try {
    await page.goto(`${adminURL}/admin/insights`);
    await expectAdminShellReady(page, "Insights");

    await page.getByRole("textbox", { name: "Model profile id" }).fill(profile.id);
    await page.getByRole("button", { name: "Dry-run" }).click();

    const confirmDryRun = page.getByRole("button", { name: "Confirm dry-run" });
    await expect(confirmDryRun).toBeDisabled();
    await page.getByRole("textbox", { name: "Dry-run reason" }).fill("E2E profile dry-run check");
    await expect(confirmDryRun).toBeDisabled();
    await page.getByRole("textbox", { name: "Dry-run confirmation" }).fill("WRONG");
    await expect(confirmDryRun).toBeDisabled();
    await page.getByRole("textbox", { name: "Dry-run confirmation" }).fill("DRYRUN");
    await expect(confirmDryRun).toBeDisabled();
    await page.getByRole("textbox", { name: "Dry-run confirmation" }).fill(profile.id);
    await expect(confirmDryRun).toBeEnabled();
    await confirmDryRun.click();
    await expect(page.getByText("Dry-run pass: 2/2 samples passed.")).toBeVisible({
      timeout: 10_000,
    });

    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: {
        actorId: admin.id,
        action: "generation.profile.dry_run",
        targetId: profile.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.reason).toBe("E2E profile dry-run check");
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
    await expectAdminShellReady(page, "Compliance");

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
        response.url().includes(`/api/v1/admin/compliance/age-verifications/${ageVerification.id}/override`),
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
