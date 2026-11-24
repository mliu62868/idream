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
  await page.getByRole("button", { name: "Save private draft", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/characters\/[^/?]+\?tab=assets/);
  return new URL(page.url()).pathname.split("/").pop()!;
}

test("follows the Main next step to a same-tab anchor and opens legacy Preview in Release", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1280, height: 620 });
  const characterId = await createDraftThroughWizard(page, `Next Step Anchor ${suffix}`);
  // An active identity and no published references make the reference-set control the next step.
  await prisma.characterVisualProfile.create({ data: {
    characterId,
    status: "active",
    identityPrompt: "Composed radio host with dark wavy hair and warm brown eyes",
    faceTraits: {},
    hairTraits: {},
    bodyTraits: {},
    signatureTraits: {},
    styleTraits: {},
    anchorAssetIds: [],
    adapterRefs: {},
    createdFrom: "operator",
  } });

  const workspace = `${adminBaseURL()}/admin/characters/${characterId}`;
  await page.goto(`${workspace}?tab=visual#visual-identity-version`);
  const referenceSet = page.locator("#visual-reference-set");
  const next = page.getByTestId("character-next-step");
  const link = next.getByRole("link", { name: "Complete image route setup" });
  await expect(link).toHaveAttribute("href", `/admin/characters/${characterId}?tab=visual#visual-reference-set`);
  await expect(referenceSet).not.toBeInViewport();
  await link.click();
  await expect(page).toHaveURL(`${workspace}?tab=visual#visual-reference-set`);
  await expect(referenceSet).toBeInViewport();
  await expect(referenceSet).toBeFocused();
  await expect(next).toHaveCount(0);

  await page.goto(`${workspace}?tab=preview`);
  await expect(page.getByRole("tab", { name: "Release and preview", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#character-panel-release")).toBeVisible();
});

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
    await expect(page.getByRole("button", { name: "Record creation handoff" })).toHaveCount(0);

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

    const draftName = `Ops Walk ${suffix}`;
    await page.getByRole("checkbox", { name: `Select ${draftName}`, exact: true }).first().check();
    await page.getByRole("button", { name: /^Live/ }).click();
    await page.waitForURL(/servingState=live/);
    const selects = page.getByRole("checkbox", { name: /^Select (?!this page)/ });
    await expect(selects.first()).toBeVisible();
    const live = await prisma.characterServing.count({ where: { state: "live" } });
    expect(live).toBeGreaterThan(0);
    await selects.first().check();
    const bulk = page.getByRole("region", { name: "Bulk actions" });
    await expect(bulk).toBeVisible();
    await expect(bulk.getByText("1 selected outside this page")).toBeVisible();
    await shot(page, "bulk-selected");
    const commandsBefore = await prisma.controlPlaneCommand.count({ where: { commandType: "character.serving.pause" } });
    await bulk.getByRole("button", { name: "Pause (1/2)", exact: true }).click();
    // One plain confirmation: nothing to type, nothing to tick.
    const pauseConfirm = page.getByRole("dialog");
    await expect(pauseConfirm).toContainText(`Skipped ${draftName}: Only live characters can be paused.`);
    await pauseConfirm.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(bulk.getByText("Results")).toBeVisible();
    // E2E runs no background worker, so drain the accepted command the way the core flow does.
    await expect.poll(() => prisma.controlPlaneCommand.count({ where: { commandType: "character.serving.pause" } })).toBe(commandsBefore + 1);
    const command = await prisma.controlPlaneCommand.findFirstOrThrow({
      where: { commandType: "character.serving.pause" },
      orderBy: { createdAt: "desc" },
    });
    await drainTargetAdminCommand(prisma, { commandId: command.id, workerId: `playwright-bulk-${suffix}`, leaseMs: 30_000 });
    await expect.poll(() => prisma.characterServing.count({ where: { state: "live" } }), { timeout: 60_000 }).toBe(live - 1);
    await expect(bulk.getByText("Done", { exact: true })).toBeVisible();
    await expect(bulk).toContainText(`Skipped ${draftName}: Only live characters can be paused.`);
    await expect(bulk.getByText("1 selected", { exact: true })).toBeVisible();
    await shot(page, "bulk-result");

    // Resume the same way. This also hands the seeded Character back to later specs.
    await page.goto(`${adminBaseURL()}/admin/characters?servingState=paused`);
    await page.getByRole("checkbox", { name: /^Select (?!this page)/ }).first().check();
    const resumesBefore = await prisma.controlPlaneCommand.count({ where: { commandType: "character.serving.resume" } });
    const resumeBulk = page.getByRole("region", { name: "Bulk actions" });
    await resumeBulk.getByRole("button", { name: "Resume", exact: true }).click();
    await page.getByRole("dialog").getByRole("button").last().click();
    await expect.poll(() => prisma.controlPlaneCommand.count({ where: { commandType: "character.serving.resume" } })).toBe(resumesBefore + 1);
    const resume = await prisma.controlPlaneCommand.findFirstOrThrow({
      where: { commandType: "character.serving.resume" },
      orderBy: { createdAt: "desc" },
    });
    await drainTargetAdminCommand(prisma, { commandId: resume.id, workerId: `playwright-bulk-resume-${suffix}`, leaseMs: 30_000 });
    await expect.poll(() => prisma.characterServing.count({ where: { state: "live" } }), { timeout: 60_000 }).toBe(live);
  });

  test("retains the roster query and refreshes valid imports without leaving the keyboard dialog", async ({ page }) => {
    await login(page);
    const name = `Ops Import ${suffix}`;
    const rejectedName = `Ops Underage ${suffix}`;
    const roster = `${adminBaseURL()}/admin/characters?search=${encodeURIComponent(name)}&servingState=inactive`;
    await page.goto(roster);
    const draftFilter = page.getByRole("group", { name: "Character operations filters" }).getByRole("button", { name: /^Draft/ });
    const queue = page.getByRole("group", { name: "Work queues" }).getByRole("button", { name: /^Ready to publish/ });
    await expect(draftFilter).toHaveAttribute("aria-pressed", "true");
    await queue.click();
    await expect(page).toHaveURL(/servingState=inactive.*workQueue=ready_to_publish/);
    await expect(draftFilter).toHaveAttribute("aria-pressed", "true");
    await expect(queue).toHaveAttribute("aria-pressed", "true");
    await queue.click();
    await expect(page).toHaveURL(roster.replaceAll("%20", "+"));

    const importButton = page.getByRole("button", { name: "Import", exact: true });
    const importedCard = page.getByRole("link", { name: `Open ${name}`, exact: true });
    await expect(importedCard).toHaveCount(0);
    await importButton.click();
    const dialog = page.getByRole("dialog", { name: "Import characters" });
    const json = dialog.getByLabel("Characters as JSON");
    await expect(json).toBeFocused();
    for (const key of ["Tab", "Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    const valid = {
      name, age: 31, gender: "female", characterPromise: "A late-night radio host with a quiet sense of humor.",
      firstMessage: "You can stay until the next song.", stableTraits: ["Dark wavy hair", "Brown eyes"],
    };
    await json.fill(JSON.stringify([valid, { ...valid, name: rejectedName, age: 17 }]));
    await dialog.getByRole("button", { name: "Create 1 private drafts" }).click();
    await expect(dialog.getByText("1 of 2 rows are ready. 1 created.")).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Open draft" })).toHaveCount(1);
    await expect(dialog.getByText("Needs fixing")).toHaveCount(1);
    await shot(page, "import-row-results");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(importButton).toBeFocused();
    await expect(importedCard).toBeVisible();
    expect(await prisma.character.count({ where: { name, visibility: "private", status: "draft" } })).toBe(1);
    expect(await prisma.character.count({ where: { name: rejectedName } })).toBe(0);
    await importedCard.click();
    await expect(page.getByTestId("character-customer-status")).toHaveText("Not live");
    await page.getByRole("link", { name: "Back to character results" }).click();
    await expect(page.getByLabel("Search characters")).toHaveValue(name);
    await expect(draftFilter).toHaveAttribute("aria-pressed", "true");
    await expect(importedCard).toBeVisible();
    await shot(page, "restored-roster");

    await page.getByRole("checkbox", { name: `Select ${name}`, exact: true }).check();
    const bulk = page.getByRole("region", { name: "Bulk actions" });
    const tagPicker = bulk.getByLabel("Tag", { exact: true });
    const firstTag = tagPicker.locator("option").nth(1);
    await expect(firstTag).toHaveAttribute("value", /\S+/);
    const tagId = (await firstTag.getAttribute("value"))!;
    await tagPicker.selectOption(tagId);
    await bulk.getByRole("button", { name: "Add tag", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Add tag", exact: true }).click();
    await expect(bulk.getByText("Done", { exact: true })).toBeVisible();
    const imported = await prisma.character.findFirstOrThrow({ where: { name }, select: { id: true } });
    expect(await prisma.characterTag.count({ where: { characterId: imported.id, tagId } })).toBe(1);
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
