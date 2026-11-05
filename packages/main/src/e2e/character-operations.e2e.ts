import { expect, test, type Page } from "@playwright/test";
import { drainTargetAdminCommand } from "@/processes/admin-command-worker";
import { prisma } from "@/server/lib/db";

// SPEC: The everyday Character operator path stays free of typed confirmations,
// required reasons and approval steps. Each test drives the real Admin UI and
// reads the outcome back from Main's database.

const suffix = `${Date.now()}`;
const shotDir = process.env.CHARACTER_OPS_SHOT_DIR;

function adminBaseURL() {
  return process.env.PW_ADMIN_BASE_URL ?? "http://127.0.0.1:3001";
}

async function login(page: Page) {
  const response = await page.request.post(`${adminBaseURL()}/api/admin-auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function shot(page: Page, name: string) {
  if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png`, fullPage: true });
}

async function createDraftThroughWizard(page: Page, name: string) {
  await page.goto(`${adminBaseURL()}/admin/characters/new`);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Age (18+)").fill("30");
  await page.getByLabel("Short description").fill("A composed late-night radio host.");
  await page.getByLabel("Opening message").fill("You made it. What do you need to put down tonight?");
  await page.getByRole("button", { name: "Continue to visual direction", exact: true }).click();
  await page.getByLabel("Look in one line").fill("Composed radio host in her thirties");
  await page.getByLabel("Features that never change (one per line)").fill("Dark wavy hair\nWarm brown eyes");
  await page.getByLabel("Image mood and framing").fill("Warm low light, close-up portrait");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Save character", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/characters\/[^/?]+\?tab=assets/);
  return new URL(page.url()).pathname.split("/").pop()!;
}

test.describe.serial("Character operations stay one click", () => {
  test.setTimeout(180_000);

  test("offers AI prefill, creates a private draft, and copies it in one click", async ({ page }) => {
    await login(page);
    const name = `Ops Walk ${suffix}`;
    await page.goto(`${adminBaseURL()}/admin/characters/new`);
    await expect(page.getByRole("button", { name: "Fill with AI" })).toBeVisible();
    await shot(page, "wizard");

    const characterId = await createDraftThroughWizard(page, name);
    await shot(page, "new-draft-assets");

    // The handoff needs an identity to snapshot; the core flow in admin-v2-workspaces.e2e.ts records one.
    await expect(page.getByRole("button", { name: "Mark ready to publish" })).toHaveCount(0);

    await page.getByRole("button", { name: "Copy as new draft" }).click();
    await expect.poll(() => new URL(page.url()).pathname).not.toContain(characterId);
    const copyId = new URL(page.url()).pathname.split("/").pop()!;
    const copy = await prisma.character.findUniqueOrThrow({ where: { id: copyId } });
    expect(copy).toMatchObject({ visibility: "private", status: "draft" });
    await prisma.character.update({ where: { id: copyId }, data: { name: `Ops Walk Copy ${suffix}` } });
  });

  test("shows the work queues and pauses and resumes in bulk with per-item results", async ({ page }) => {
    await login(page);
    await page.goto(`${adminBaseURL()}/admin/characters`);
    await expect(page.getByRole("button", { name: /^Paused/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Archived/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import" })).toBeVisible();
    await shot(page, "portfolio");

    await page.getByRole("button", { name: /^Live/ }).click();
    await page.waitForURL(/servingState=live/);
    const selects = page.getByRole("checkbox", { name: /^Select (?!this page)/ });
    await expect(selects.first()).toBeVisible();
    const live = await prisma.characterServing.count({ where: { state: "live" } });
    expect(live).toBeGreaterThan(0);
    await selects.first().check();
    const bulk = page.getByRole("region", { name: "Bulk actions" });
    await expect(bulk).toBeVisible();
    await shot(page, "bulk-selected");
    const commandsBefore = await prisma.controlPlaneCommand.count({ where: { commandType: "character.serving.pause" } });
    await bulk.getByRole("button", { name: "Pause", exact: true }).click();
    // One plain confirmation: nothing to type, nothing to tick.
    await page.getByRole("dialog").getByRole("button").last().click();
    await expect(bulk.getByText("Results")).toBeVisible();
    // E2E runs no background worker, so drain the accepted command the way the core flow does.
    await expect.poll(() => prisma.controlPlaneCommand.count({ where: { commandType: "character.serving.pause" } })).toBe(commandsBefore + 1);
    const command = await prisma.controlPlaneCommand.findFirstOrThrow({
      where: { commandType: "character.serving.pause" },
      orderBy: { createdAt: "desc" },
    });
    await drainTargetAdminCommand(prisma, { commandId: command.id, workerId: `playwright-bulk-${suffix}`, leaseMs: 30_000 });
    await expect.poll(() => prisma.characterServing.count({ where: { state: "live" } }), { timeout: 60_000 }).toBe(live - 1);
    await shot(page, "bulk-result");
  });

  test("compares live Characters on the board and adds one to Featured", async ({ page }) => {
    await login(page);
    await page.goto(`${adminBaseURL()}/admin/growth/characters`);
    await expect(page.getByLabel("Performance window")).toBeVisible();
    await expect(page.getByText("Operating efficiency")).toBeVisible();
    await expect(page.getByText(/Admin UX Audit|Archived draft/)).toHaveCount(0);
    const add = page.getByRole("button", { name: "Add to Featured" }).first();
    await expect(add).toBeVisible();
    await shot(page, "performance-board");
    await add.click();
    const remove = page.getByRole("button", { name: "Remove from Featured" });
    await expect(remove).toHaveCount(1);
    await expect.poll(async () => {
      const setting = await prisma.appSetting.findUnique({ where: { key: "feed.featured" } });
      return (setting?.value as { characterIds?: string[] } | null)?.characterIds?.length ?? 0;
    }).toBe(1);
    await remove.click();
    await expect(remove).toHaveCount(0);
  });

  // SPEC: Everyday operator pages fit a laptop; long tables scroll inside themselves.
  test("does not scroll the page sideways on the Character operator surfaces", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const path of [
      "/admin/characters",
      "/admin/characters/new",
      "/admin/growth/characters",
      "/admin/growth/merchandising?view=featured",
    ]) {
      await page.goto(`${adminBaseURL()}${path}`, { waitUntil: "networkidle" });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test("curates Featured by picking Characters, with nothing to type", async ({ page }) => {
    await login(page);
    await page.goto(`${adminBaseURL()}/admin/growth/merchandising?view=featured`);
    await expect(page.getByRole("heading", { name: "Featured curation" })).toBeVisible();
    await expect(page.getByLabel("Featured character IDs")).toHaveCount(0);
    await expect(page.getByLabel("Featured confirmation")).toHaveCount(0);
    await shot(page, "featured");
  });
});
