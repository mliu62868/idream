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
    { path: "/admin/moderation", heading: "Moderation", evidence: "Reports" },
    { path: "/admin/users", heading: "Users", evidence: admin.email },
    { path: "/admin/billing", heading: "Billing", evidence: "Ledger" },
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
