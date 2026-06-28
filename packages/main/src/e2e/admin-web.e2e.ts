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

async function startRoleSession(page: Page, role: "admin" | "support" | "analyst") {
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
    { path: "/admin/chat", heading: "Chat Ops", evidence: "CHAT_SERVICE_URL" },
    { path: "/admin/users", heading: "Users", evidence: admin.email },
    { path: "/admin/billing", heading: "Billing", evidence: "Subscriptions" },
    { path: "/admin/pricing", heading: "Pricing", evidence: "Pricing Rules" },
    { path: "/admin/promo", heading: "Promo", evidence: "Create redeem code" },
    { path: "/admin/analytics", heading: "Analytics", evidence: "Top events" },
    { path: "/admin/risk", heading: "Risk & Abuse", evidence: "Multi-account device clusters" },
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
  await startRoleSession(page, "admin");
  const ruleKey = `e2e_rule_${Date.now()}`;
  try {
    const create = await page.request.post("/api/v1/admin/pricing/rules", {
      data: { ruleKey, label: "E2E rule", mode: "image", baseCost: 5, multiplier: 1 },
    });
    expect(create.status(), await create.text()).toBe(200);
  } finally {
    await prisma.pricingRule.deleteMany({ where: { ruleKey } });
  }
});

test("admin API forbids under-privileged roles (403 on writes they lack)", async ({ page }) => {
  // support holds content.read but NOT content.takedown.write / config.pricing.write.
  await startRoleSession(page, "support");

  const pricing = await page.request.post("/api/v1/admin/pricing/rules", {
    data: { ruleKey: "e2e_forbidden", label: "x", mode: "image", baseCost: 5, multiplier: 1 },
  });
  expect(pricing.status()).toBe(403);

  const takedown = await page.request.post("/api/v1/admin/content/characters/none/visibility", {
    data: { visibility: "private", reason: "test reason", confirmation: "VISIBILITY" },
  });
  expect(takedown.status()).toBe(403);

  // analyst lacks content.read entirely → read also 403.
  await startRoleSession(page, "analyst");
  const read = await page.request.get("/api/v1/admin/content/characters");
  expect(read.status()).toBe(403);
});
