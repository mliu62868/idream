import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/server/lib/db";

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const actorId = "seed-admin-user";
const creativeRunId = `e2e-v2-creative-${suffix}`;
const incidentId = `e2e-v2-incident-${suffix}`;
const caseId = `e2e-v2-case-${suffix}`;
const caseTargetId = `e2e-v2-customer-${suffix}`;
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
    await prisma.contentProductionBatch.create({
      data: {
        id: creativeRunId,
        title: `E2E Creative Run ${suffix}`,
        purpose: "campaign",
        targetType: "campaign",
        targetId: `campaign-${suffix}`,
        presetIds: [],
        totalItems: 0,
        lifecycleState: "active",
        workflowStage: "brief",
        verificationState: "pending",
        ownerId: actorId,
        createdById: actorId,
      },
    });
    await prisma.opsIncident.create({
      data: {
        id: incidentId,
        signature: `provider:profile:e2e-${suffix}`,
        signatureVersion: "v1",
        activeCorrelationKey: `e2e-active-${suffix}`,
        status: "triaged",
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
        id: `e2e-v2-evidence-${suffix}`,
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
    await prisma.caseEvidence.deleteMany({ where: { caseId } });
    await prisma.adminCase.deleteMany({ where: { id: caseId } });
    await prisma.opsIncident.deleteMany({ where: { id: incidentId } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: creativeRunId } });
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

  test("opens Creative, Incident, and Case authority details without losing URL state", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1366, height: 900 });

    await page.goto(`${adminBaseURL()}/admin/creative/runs`);
    await expect(page.locator("#creative-runs-title")).toBeVisible();
    await page.locator(`a[href="/admin/creative/runs/${creativeRunId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/creative/runs/${creativeRunId}$`));
    await expect(page.getByRole("heading", { level: 1, name: `E2E Creative Run ${suffix}` })).toBeVisible();

    await page.goto(`${adminBaseURL()}/admin/ops/incidents?search=${encodeURIComponent(suffix)}`);
    await expect(page.getByRole("heading", { level: 2, name: "Incidents" })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`E2E provider regression ${suffix}`) }).click();
    await expect(page).toHaveURL(new RegExp(`incident=${incidentId}`));
    await expect(page.getByRole("heading", { level: 3, name: `E2E provider regression ${suffix}` })).toBeVisible();

    await page.goto(`${adminBaseURL()}/admin/cases?view=mine&search=${encodeURIComponent(caseTargetId)}`);
    await expect(page.getByRole("heading", { level: 2, name: "Cases" })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(caseTargetId) }).click();
    await expect(page).toHaveURL(new RegExp(`case=${caseId}`));
    await expect(page.getByRole("heading", { level: 4, name: "Evidence" })).toBeVisible();
    await expect(page.getByText("Customer supplied immutable reproduction evidence.")).toBeVisible();

    await expectNoHorizontalOverflow(page);
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
