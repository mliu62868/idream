import { expect, test, type Page } from "@playwright/test";
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

test("admin web loads all control-plane sections and filters users", async ({ page }) => {
  const consoleFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleFailures.push(message.text());
  });
  page.on("pageerror", (error) => {
    consoleFailures.push(error.message);
  });

  const admin = await startAdminSession(page);
  const adminURL = adminBaseURL();

  const sections = [
    { path: "/admin", heading: "Dashboard", evidence: "Feature Flags" },
    { path: "/admin/generation/jobs", heading: "Generation Jobs", evidence: "status" },
    { path: "/admin/generation/config", heading: "Generation Config", evidence: "Model Profiles" },
    { path: "/admin/generation/dead-letter", heading: "Dead-letter", evidence: "Dead-letter Queue" },
    { path: "/admin/ops/providers", heading: "Provider Health", evidence: "Provider health & cost" },
    { path: "/admin/moderation", heading: "Moderation", evidence: "Reports" },
    { path: "/admin/content", heading: "Content", evidence: "Featured curation" },
    { path: "/admin/content/official", heading: "Official Characters", evidence: "Create official character" },
    { path: "/admin/content/templates", heading: "Templates", evidence: "Create character template" },
    { path: "/admin/content/tags", heading: "Tags", evidence: "Merge tags" },
    { path: "/admin/content/review-queue", heading: "Review Queue", evidence: "Pending submissions" },
    { path: "/admin/cms", heading: "CMS / SEO", evidence: "Create / overwrite page" },
    { path: "/admin/chat", heading: "Chat Ops", evidence: "CHAT_SERVICE_URL" },
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
  expect(consoleFailures).toEqual([]);
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
  const adminURL = adminBaseURL();
  await startRoleSession(page, "admin");
  const path = `/e2e-cms-${Date.now()}`;
  try {
    const create = await page.request.post(`${adminURL}/api/v1/admin/cms/pages`, {
      data: {
        path,
        title: "E2E CMS page",
        description: "e2e",
        body: { heading: "Hello", sections: [] },
        contentStatus: "draft",
        reason: "e2e cms create",
        confirmation: "CMS",
      },
    });
    expect(create.status(), await create.text()).toBe(200);
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
    const pubBody = (await pub.json()) as { data?: { items?: Array<{ title?: string }> } };
    expect(pubBody.data?.items?.some((a) => a.title === "E2E banner")).toBe(true);
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
