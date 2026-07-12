import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/server/lib/db";

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const actorId = "seed-admin-user";
const creativeRunId = `e2e-v2-creative-${suffix}`;
const creativeItemId = `e2e-v2-creative-item-${suffix}`;
const creativeAssetId = `e2e-v2-creative-asset-${suffix}`;
const incidentId = `e2e-v2-incident-${suffix}`;
const caseId = `e2e-v2-case-${suffix}`;
const caseTargetId = `e2e-v2-customer-${suffix}`;
const caseEvidenceId = `e2e-v2-evidence-${suffix}`;
const characterName = `E2E V2 Companion ${suffix}`;

function adminBaseURL() {
  if (process.env.PW_ADMIN_BASE_URL) return process.env.PW_ADMIN_BASE_URL.replace(/\/$/, "");
  const url = new URL(process.env.PW_BASE_URL ?? "http://127.0.0.1:3000");
  url.port = "3001";
  return url.toString().replace(/\/$/, "");
}

async function login(page: Page) {
  const response = await page.request.post(`${adminBaseURL()}/api/admin-auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

function consoleFailures(page: Page) {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("pageerror", (error) => failures.push(error.message));
  return failures;
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id,
        className: element.className,
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
        text: element.innerText?.slice(0, 80) ?? "",
      }))
      .filter((element) => element.right > window.innerWidth + 1 || element.left < -1)
      .slice(0, 8),
  }));
  expect(metrics.documentWidth, JSON.stringify(metrics, null, 2)).toBeLessThanOrEqual(metrics.viewportWidth + 1);
}

test.describe.serial("Admin v2 operator workspaces", () => {
  test.describe.configure({ retries: 0 });
  test.beforeAll(async () => {
    await prisma.mediaAsset.create({
      data: {
        id: creativeAssetId,
        ownerId: actorId,
        type: "image",
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%23d9d4c7'/%3E%3C/svg%3E",
        visibility: "private",
        safetyStatus: "passed",
        metadata: { source: "admin_v2_playwright" },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: creativeRunId,
        title: `E2E Creative Run ${suffix}`,
        purpose: "campaign",
        targetType: "campaign",
        targetId: `campaign-${suffix}`,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "review",
        verificationState: "pending",
        ownerId: actorId,
        createdById: actorId,
        items: {
          create: {
            id: creativeItemId,
            itemIndex: 0,
            status: "generated",
            mediaAssetId: creativeAssetId,
            tags: [],
          },
        },
      },
    });
    await prisma.opsIncident.create({
      data: {
        id: incidentId,
        signature: `provider:profile:e2e-${suffix}`,
        signatureVersion: "v1",
        activeCorrelationKey: `e2e-active-${suffix}`,
        status: "monitoring",
        severity: "high",
        ownerId: actorId,
        firstSeen: new Date(Date.now() - 60_000),
        lastSeen: new Date(),
        slaDueAt: new Date(Date.now() + 3_600_000),
        impact: { affectedRequests: 3, affectedUsers: 2, failedCostMicros: 1200, refundedDreamcoins: 0 },
        mitigation: { recommendedActions: ["inspect route"] },
        suspectedCause: `E2E provider regression ${suffix}`,
        confidence: 0.8,
      },
    });
    await prisma.adminCase.create({
      data: {
        id: caseId,
        type: "support_request",
        targetType: "user",
        targetId: caseTargetId,
        caseKey: `support:e2e:${suffix}`,
        activeKey: `support_request:user:${caseTargetId}:support:e2e:${suffix}`,
        status: "in_progress",
        priority: "high",
        ownerId: actorId,
        slaDueAt: new Date(Date.now() + 3_600_000),
        resolution: { severity: "high" },
      },
    });
    await prisma.caseEvidence.create({
      data: {
        id: caseEvidenceId,
        caseId,
        sourceType: "support_message",
        sourceId: `support-message-${suffix}`,
        snapshot: { description: "Customer supplied immutable reproduction evidence." },
        occurredAt: new Date(),
      },
    });
  });

  test.afterAll(async () => {
    const characters = await prisma.character.findMany({ where: { name: { startsWith: "E2E V2 Companion " } }, select: { id: true } });
    const characterIds = characters.map((character) => character.id);
    if (characterIds.length > 0) {
      const projects = await prisma.characterProject.findMany({ where: { characterId: { in: characterIds } }, select: { id: true } });
      const projectIds = projects.map((project) => project.id);
      await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: projectIds } } });
      await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: { in: projectIds } } });
      await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: projectIds } } });
      await prisma.controlPlaneCommand.deleteMany({ where: { actorId, targetId: { in: projectIds } } });
      await prisma.characterRevision.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.characterContentVersion.deleteMany({ where: { characterId: { in: characterIds } } });
      await prisma.characterServing.deleteMany({ where: { characterId: { in: characterIds } } });
      await prisma.characterProject.deleteMany({ where: { characterId: { in: characterIds } } });
      await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
    }
    const commandIds = (await prisma.controlPlaneCommand.findMany({
      where: { targetId: { in: [creativeRunId, incidentId, caseId] } },
      select: { id: true },
    })).map((command) => command.id);
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commandIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: commandIds } } });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: [creativeRunId, creativeItemId, incidentId, caseId] } },
    });
    await prisma.adminAuditLog.deleteMany({
      where: { targetId: { in: [creativeRunId, creativeItemId, incidentId, caseId] } },
    });
    await prisma.decisionRecord.deleteMany({ where: { sourceId: caseId } });
    await prisma.incidentPostmortem.deleteMany({ where: { incidentId } });
    await prisma.caseEvidence.deleteMany({ where: { caseId } });
    await prisma.adminCase.deleteMany({ where: { id: caseId } });
    await prisma.opsIncident.deleteMany({ where: { id: incidentId } });
    await prisma.creativeReviewDecision.deleteMany({ where: { runItemId: creativeItemId } });
    await prisma.mediaAssetPlacement.deleteMany({ where: { mediaAssetId: creativeAssetId } });
    await prisma.contentProductionItem.deleteMany({ where: { id: creativeItemId } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: creativeRunId } });
    await prisma.mediaAsset.deleteMany({ where: { id: creativeAssetId } });
    await prisma.$disconnect();
  });

  test("creates and resumes an authoritative Character Project through the responsive wizard", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${adminBaseURL()}/admin/characters/new`);
    await expect(page.getByRole("heading", { level: 1, name: "Create Character Project" })).toBeVisible();
    await page.getByRole("button", { name: "Save positioning & continue" }).click();
    await page.getByLabel("Name").fill(characterName);
    await page.getByRole("button", { name: "Save & continue" }).click();
    await page.getByRole("button", { name: "Save & continue" }).click();
    await page.getByRole("button", { name: "Save & continue" }).click();
    await page.getByRole("button", { name: "Save and open project" }).click();
    await expect(page).toHaveURL(/\/admin\/characters\/[^/?]+/);
    await expect(page.getByRole("heading", { level: 1, name: characterName })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Character workspace" })).toBeVisible();
    await page.getByRole("tab", { name: "project" }).press("ArrowRight");
    await expect(page.getByRole("tab", { name: "preview" })).toHaveAttribute("aria-selected", "true");
    await expectNoHorizontalOverflow(page);
    expect(failures).toEqual([]);
  });

  test("closes Creative, Incident, and Case loops through UI and authoritative facts", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1366, height: 900 });

    await page.goto(`${adminBaseURL()}/admin/creative/runs`);
    await expect(page.locator("#creative-runs-title")).toBeVisible();
    await page.locator(`a[href="/admin/creative/runs/${creativeRunId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/creative/runs/${creativeRunId}$`));
    await expect(page.getByRole("heading", { level: 1, name: `E2E Creative Run ${suffix}` })).toBeVisible();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("approved · passed")).toBeVisible();
    await page.getByLabel("Target type").fill("campaign");
    await page.getByLabel("Target ID").fill(`campaign-${suffix}`);
    await page.getByRole("button", { name: "Publish placement" }).click();
    await expect(page.getByText("feed_card · verifying")).toBeVisible();
    await page.getByRole("button", { name: "Verify live slot" }).click();
    await expect(page.getByText("feed_card · passed")).toBeVisible();

    await expect.poll(async () => prisma.contentProductionBatch.findUnique({
      where: { id: creativeRunId },
      select: { workflowStage: true, verificationState: true, version: true },
    })).toEqual({ workflowStage: "verification", verificationState: "passed", version: 4 });
    await expect.poll(async () => prisma.creativeReviewDecision.count({
      where: { runItemId: creativeItemId, decision: "approved" },
    })).toBe(1);
    await expect.poll(async () => prisma.mediaAssetPlacement.count({
      where: { mediaAssetId: creativeAssetId, status: "published", verificationState: "passed" },
    })).toBe(1);

    await page.goto(`${adminBaseURL()}/admin/ops/incidents?search=${encodeURIComponent(suffix)}`);
    await expect(page.getByRole("heading", { level: 2, name: "Incidents" })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`E2E provider regression ${suffix}`) }).click();
    await expect(page).toHaveURL(new RegExp(`incident=${incidentId}`));
    await expect(page.getByRole("heading", { level: 3, name: `E2E provider regression ${suffix}` })).toBeVisible();
    await page.getByLabel("Audit reason").fill("Recovery window and settlement reviewed");
    await page.getByLabel("Evidence reference").fill(`monitor://e2e/${suffix}`);
    for (const label of [
      "Success rate recovered for the required window",
      "Failure signature stopped growing",
      "Backlog is recovering",
      "Every failed request has a retry or terminal plan",
      "Spend and refunds are reconciled",
    ]) {
      await page.getByLabel(label).check();
    }
    await page.getByRole("button", { name: "Mark recovery verified" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Recovery verification recorded" })).toBeVisible();
    await page.getByRole("button", { name: "Resolve incident" }).click();
    await expect(page.getByRole("heading", { level: 4, name: "Postmortem and close" })).toBeVisible();
    await page.getByLabel("Summary", { exact: true }).fill("Provider route recovered and all affected requests were reconciled.");
    await page.getByLabel("Root cause").fill("Provider route regression");
    await page.getByLabel("Contributing factors (one per line)").fill("Capacity signal lag");
    await page.getByLabel("Corrective actions (one per line)").fill("Add a route-level recovery canary");
    await page.getByLabel("Type close confirmation").fill(`${incidentId}:close`);
    await page.getByRole("button", { name: "Record postmortem and close" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Postmortem recorded and Incident closed" })).toBeVisible();

    await expect.poll(async () => prisma.opsIncident.findUnique({
      where: { id: incidentId },
      select: { status: true, verificationState: true, activeCorrelationKey: true },
    })).toEqual({ status: "closed", verificationState: "passed", activeCorrelationKey: null });
    await expect.poll(async () => prisma.incidentPostmortem.count({
      where: { incidentId, rootCause: "Provider route regression" },
    })).toBe(1);

    await page.goto(`${adminBaseURL()}/admin/cases?view=mine&search=${encodeURIComponent(caseTargetId)}`);
    await expect(page.getByRole("heading", { level: 2, name: "Cases" })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(caseTargetId) }).click();
    await expect(page).toHaveURL(new RegExp(`case=${caseId}`));
    await expect(page.getByRole("heading", { level: 4, name: "Evidence" })).toBeVisible();
    await expect(page.getByText("Customer supplied immutable reproduction evidence.")).toBeVisible();
    await page.getByLabel("Audit reason").fill("Evidence and downstream outcome reviewed");
    await page.getByLabel("Decision", { exact: true }).fill("restore_access");
    await page.getByLabel("Resolution summary").fill("Restored the expected customer access and checked the resulting entitlement.");
    await page.getByRole("button", { name: "Record decision" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Case decision recorded" })).toBeVisible();
    await page.getByRole("button", { name: "Verify outcome" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Downstream outcome verified" })).toBeVisible();
    await page.getByLabel("Type confirmation").fill(`${caseId}:close`);
    await page.getByRole("button", { name: "Close case", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Case close command accepted" })).toBeVisible();

    await expect.poll(async () => prisma.adminCase.findUnique({
      where: { id: caseId },
      select: { status: true, verificationState: true, activeKey: true },
    })).toEqual({ status: "closed", verificationState: "passed", activeKey: null });
    await expect.poll(async () => prisma.decisionRecord.count({
      where: { sourceId: caseId, decision: "restore_access" },
    })).toBe(1);
    await expect.poll(async () => prisma.adminAuditLog.count({
      where: { targetId: { in: [creativeItemId, incidentId, caseId] } },
    })).toBeGreaterThanOrEqual(8);

    await expectNoHorizontalOverflow(page);
    expect(failures).toEqual([]);
  });

  test("projects verified domain outcomes into Today recently resolved with working deep links", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${adminBaseURL()}/admin/today`);
    await expect(page.getByTestId("today-view")).toBeVisible();
    await expect(page.getByText("Authoritative Today projection")).toBeVisible();

    const resolved = page.getByTestId("today-queue-recently-resolved");
    await expect(resolved.getByText(`user ${caseTargetId} is closed`)).toBeVisible();
    await expect(resolved.getByText(`E2E provider regression ${suffix}`)).toBeVisible();
    await resolved.locator(`a[href="/admin/cases/${caseId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/cases/${caseId}$`));
    await expect(page.getByRole("heading", { level: 4, name: "Evidence" })).toBeVisible();

    await page.goto(`${adminBaseURL()}/admin/today`);
    await page.getByTestId("today-queue-recently-resolved").locator(`a[href="/admin/ops/incidents/${incidentId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/ops/incidents/${incidentId}$`));
    await expect(page.getByRole("heading", { level: 3, name: `E2E provider regression ${suffix}` })).toBeVisible();
    expect(failures).toEqual([]);
  });

  test("keeps all four core workspaces usable at 375px and exposes filtered-empty recovery", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 375, height: 812 });
    const routes = [
      ["/admin/characters", "Portfolio & Projects", 1],
      ["/admin/creative/runs", "Creative Runs", 1],
      ["/admin/ops/incidents", "Incidents", 2],
      ["/admin/cases?view=mine", "Cases", 2],
    ] as const;
    for (const [route, heading, level] of routes) {
      await page.goto(`${adminBaseURL()}${route}`);
      const locator = heading === "Creative Runs"
        ? page.locator("#creative-runs-title")
        : heading === "Portfolio & Projects"
          ? page.locator("#character-portfolio-title")
          : page.getByRole("heading", { level, name: heading });
      await expect(locator).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
    await page.getByLabel("Search all cases").fill(`missing-${suffix}`);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("heading", { level: 3, name: "No work matches these filters" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText(caseTargetId)).toBeVisible();
    expect(failures).toEqual([]);
  });
});
