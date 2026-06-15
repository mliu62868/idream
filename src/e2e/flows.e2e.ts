import { expect, test, type Page } from "@playwright/test";

// SPEC (docs/architecture/11-testing.md §5): L4 critical user journeys against a
// real `next dev` server + seeded dev.db + mock providers. UI flows drive the
// browser; the product-path flow drives the real /api/v1 surface through the
// browser context (real proxy + route handlers + cookies), covering chat,
// generation, billing, and moderation end-to-end.

async function dismissAgeGate(page: Page) {
  const enter = page.getByRole("button", { name: /over 18/i });
  // The gate is rendered by a client effect, so wait for it rather than racing it.
  try {
    await enter.waitFor({ state: "visible", timeout: 8000 });
  } catch {
    return; // already accepted (cookie present) — no gate shown
  }
  await enter.click();
  await expect(enter).toBeHidden();
}

function uniqueEmail(tag: string) {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

test("flow 1: age gate → explore grid → character detail", async ({ page }) => {
  await page.goto("/");

  const enter = page.getByRole("button", { name: /over 18/i });
  await expect(enter).toBeVisible();
  await enter.click();
  await expect(enter).toBeHidden();

  const firstCard = page.locator('a[href^="/characters/"]').first();
  await expect(firstCard).toBeVisible();
  await firstCard.click();

  await expect(page).toHaveURL(/\/characters\//);
  // Detail fetched successfully (age gate cookie present) → action buttons render.
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
});

test("flow 2: signup through the UI creates an authenticated session", async ({ page }) => {
  const email = uniqueEmail("signup");
  await page.goto("/signup");
  await dismissAgeGate(page);

  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("password123");
  await page.getByRole("button", { name: /join free/i }).click();

  // AuthWorkspace redirects to "/" on success.
  await page.waitForURL("http://127.0.0.1:3000/");

  // The session cookie (shared with page.request) authenticates /me.
  const me = await page.request.get("/api/v1/me");
  const body = await me.json();
  expect(body.data.user?.email).toBe(email);
  expect(body.data.dreamcoins.balance).toBe(250);
});

test("flow 3/5/6/7: chat, generation, billing, and moderation via the real server", async ({
  page,
}) => {
  const ctx = page.request;
  const email = uniqueEmail("api");

  // Age gate must come first — proxy 403s every other /api/v1 path until accepted.
  await ctx.post("/api/v1/age-gate/accept", { data: { sourcePath: "/" } });
  const signup = await ctx.post("/api/v1/auth/signup", {
    data: { email, password: "password123", name: "E2E API" },
  });
  expect(signup.ok()).toBeTruthy();

  const list = await ctx.get("/api/v1/characters", { params: { limit: 1 } });
  const characterId = (await list.json()).data.items[0].id as string;

  // Flow 3 — chat: send a message and confirm history survives a reload.
  const session = await ctx.post("/api/v1/chat/sessions", { data: { characterId } });
  const sessionId = (await session.json()).data.session.id as string;
  const sent = await ctx.post(`/api/v1/chat/sessions/${sessionId}/messages`, {
    data: { content: "hello from e2e" },
  });
  expect((await sent.json()).data.assistant.role).toBe("assistant");
  const reload = await ctx.get(`/api/v1/chat/sessions/${sessionId}`);
  const messages = (await reload.json()).data.session.messages as unknown[];
  expect(messages.length).toBeGreaterThanOrEqual(2);

  // Flow 5 — generation: the signup bonus (250) covers an image job; media lands.
  const gen = await ctx.post("/api/v1/generation/jobs", {
    data: { mode: "image", characterId, outputCount: 1 },
  });
  expect((await gen.json()).data.job.status).toBe("completed");
  const media = await ctx.get("/api/v1/media");
  expect(((await media.json()).data.items as unknown[]).length).toBeGreaterThan(0);

  // Flow 6 — billing: mock checkout activates the premium entitlement server-side.
  const checkout = await ctx.post("/api/v1/billing/checkout", {
    data: { slug: "premium", billingPeriod: "monthly", autoConfirm: true },
  });
  expect(checkout.ok()).toBeTruthy();
  const me = await ctx.get("/api/v1/me");
  expect((await me.json()).data.entitlements.premium_controls).toBe(true);

  // Flow 7 — moderation: report a character, then confirm it in the admin queue.
  const report = await ctx.post(`/api/v1/characters/${characterId}/report`, {
    data: { category: "spam", description: "e2e report" },
  });
  const reportId = (await report.json()).data.report.id as string;

  const queue = await ctx.get("/api/v1/admin/moderation/queue", {
    headers: { "x-idream-user-id": "seed-admin-user", "x-idream-role": "admin" },
  });
  const reports = (await queue.json()).data.reports as Array<{ id: string }>;
  expect(reports.some((r) => r.id === reportId)).toBe(true);
});

test("smoke: creator and generator workspaces render", async ({ page }) => {
  await page.goto("/create");
  await dismissAgeGate(page);
  await expect(page.locator("main")).toBeVisible();
  await expect(page).toHaveURL(/\/create/);

  await page.goto("/generate");
  await dismissAgeGate(page);
  await expect(page.locator("main")).toBeVisible();
  await expect(page).toHaveURL(/\/generate/);
});
