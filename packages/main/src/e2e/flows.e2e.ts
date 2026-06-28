import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// SPEC (docs/architecture/11-testing.md §5): L4 critical user journeys against a
// real `next dev` server + seeded Postgres + configured providers. UI flows drive the
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

function internalToken() {
  return process.env.INTERNAL_TOKEN ?? "development-internal-token";
}

type GenerationJobStatus =
  | "queued"
  | "moderating_input"
  | "running"
  | "moderating_output"
  | "completed"
  | "failed"
  | "blocked"
  | "refunded";

type GenerationJobResponse = {
  data: {
    job: {
      id: string;
      status: GenerationJobStatus;
      errorCode?: string | null;
    };
  };
};

async function getGenerationJob(ctx: APIRequestContext, jobId: string) {
  const generated = await ctx.get(`/api/v1/generation/jobs/${jobId}`);
  expect(generated.ok()).toBeTruthy();
  return (await generated.json()) as GenerationJobResponse;
}

async function drainUntilGenerationCompletes(ctx: APIRequestContext, jobId: string) {
  let lastJob: GenerationJobResponse["data"]["job"] | undefined;
  const deadline = Date.now() + 90_000;

  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const current = await getGenerationJob(ctx, jobId);
    lastJob = current.data.job;
    if (lastJob.status === "completed") return current;
    if (["failed", "blocked", "refunded"].includes(lastJob.status)) {
      throw new Error(
        `Generation job ${jobId} reached terminal status ${lastJob.status} (${lastJob.errorCode ?? "no error code"})`,
      );
    }

    const worker = await ctx.post("/api/internal/worker", {
      headers: { authorization: `Bearer ${internalToken()}` },
      timeout: 90_000,
    });
    expect(worker.ok()).toBeTruthy();

    const generated = await getGenerationJob(ctx, jobId);
    lastJob = generated.data.job;
    if (lastJob.status === "completed") return generated;
    if (["failed", "blocked", "refunded"].includes(lastJob.status)) {
      throw new Error(
        `Generation job ${jobId} reached terminal status ${lastJob.status} (${lastJob.errorCode ?? "no error code"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `Generation job ${jobId} did not complete after draining worker batches; last status: ${lastJob?.status ?? "unknown"}`,
  );
}

test("flow 1: age gate → explore grid → character detail", async ({ page }) => {
  const preGateApiRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/api/v1/") &&
      url.pathname !== "/api/v1/me" &&
      url.pathname !== "/api/v1/age-gate/accept"
    ) {
      preGateApiRequests.push(url.pathname);
    }
  });

  await page.goto("/");

  const enter = page.getByRole("button", { name: /over 18/i });
  await expect(enter).toBeVisible();
  await expect(page.locator("main")).toHaveCount(0);
  await expect(page.locator('a[href^="/characters/"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  await expect(page.getByRole("link", { name: "Leave site" })).toHaveAttribute(
    "href",
    "https://www.google.com/",
  );
  await page.waitForTimeout(300);
  expect(preGateApiRequests).toEqual([]);
  await enter.click();
  await expect(enter).toBeHidden();

  const firstCard = page.locator('a[href^="/characters/"]').first();
  await expect(firstCard).toBeVisible();
  await firstCard.click();

  await expect(page).toHaveURL(/\/characters\//);
  // Detail fetched successfully (age gate cookie present) → action buttons render.
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
});

test("age gate blocks generator workspace and protected API fetches before acceptance", async ({
  page,
}) => {
  const preGateApiRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/api/v1/") &&
      url.pathname !== "/api/v1/me" &&
      url.pathname !== "/api/v1/age-gate/accept"
    ) {
      preGateApiRequests.push(url.pathname);
    }
  });

  await page.goto("/generate");

  const enter = page.getByRole("button", { name: /over 18/i });
  await expect(enter).toBeVisible();
  await expect(page.locator("main")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(preGateApiRequests).toEqual([]);
});

test("age gate restores the API cookie from prior browser acceptance", async ({
  context,
  page,
}) => {
  await context.clearCookies();
  await page.addInitScript(() => {
    localStorage.setItem("AdultContentAcceptedOD", "true");
  });

  await page.goto("/");

  const firstCard = page.locator('a[href^="/characters/"]').first();
  await expect(firstCard).toBeVisible();
  await firstCard.click();

  await expect(page).toHaveURL(/\/characters\//);
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
});

test("flow 2: signup through the UI creates an authenticated session", async ({ page }) => {
  const email = uniqueEmail("signup");
  await page.goto("/signup");
  await dismissAgeGate(page);

  await page.getByLabel("Display name").fill("E2E Signup User");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("password123");
  await page.getByRole("button", { name: /join free/i }).click();

  // AuthWorkspace redirects to "/" on success.
  await expect(page).toHaveURL(/\/$/);

  // The session cookie (shared with page.request) authenticates /me.
  const me = await page.request.get("/api/v1/me");
  const body = await me.json();
  expect(body.data.user?.email).toBe(email);
  expect(body.data.dreamcoins.balance).toBe(250);
});

test("flow 3: chat session persists through the real server", async ({ page }) => {
  const ctx = page.request;
  const email = uniqueEmail("chat");

  await ctx.post("/api/v1/age-gate/accept", { data: { sourcePath: "/" } });
  const signup = await ctx.post("/api/v1/auth/signup", {
    data: { email, password: "password123", name: "E2E Chat" },
  });
  expect(signup.ok()).toBeTruthy();

  const list = await ctx.get("/api/v1/characters", { params: { limit: 1 } });
  const characterId = (await list.json()).data.items[0].id as string;

  const session = await ctx.post("/api/v1/chat/sessions", { data: { characterId } });
  expect(session.ok()).toBeTruthy();
  const sessionId = (await session.json()).data.session.id as string;

  const sent = await ctx.post(`/api/v1/chat/sessions/${sessionId}/messages`, {
    data: { content: "hello from e2e" },
  });
  expect(sent.ok()).toBeTruthy();
  expect((await sent.json()).data.assistant.role).toBe("assistant");

  const reloaded = await ctx.get(`/api/v1/chat/sessions/${sessionId}`);
  expect(reloaded.ok()).toBeTruthy();
  const messages = (await reloaded.json()).data.session.messages as Array<{ role: string }>;
  expect(messages.map((message) => message.role)).toEqual(
    expect.arrayContaining(["user", "assistant"]),
  );

  // Rename the session (US-CH-04; the session-list drawer posts this same PATCH).
  const renamed = await ctx.patch(`/api/v1/chat/sessions/${sessionId}`, {
    data: { title: "Renamed by e2e" },
  });
  expect(renamed.ok(), await renamed.text()).toBeTruthy();
  const afterRename = await ctx.get(`/api/v1/chat/sessions/${sessionId}`);
  expect((await afterRename.json()).data.session.title).toBe("Renamed by e2e");
});

test("flow 4/5/6: generation, billing, and moderation via the real server", async ({
  page,
}) => {
  test.setTimeout(120_000);
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

  // Flow 4 — generation: the signup bonus (250) covers an image job; media lands.
  const gen = await ctx.post("/api/v1/generation/jobs", {
    data: { mode: "image", characterId, outputCount: 1 },
  });
  const genBody = await gen.json();
  expect(gen.status()).toBe(202);
  expect(genBody.data.job.status).toBe("queued");
  await drainUntilGenerationCompletes(ctx, genBody.data.job.id as string);
  const media = await ctx.get("/api/v1/media");
  expect(((await media.json()).data.items as unknown[]).length).toBeGreaterThan(0);

  // Flow 5 — billing: mock checkout activates the premium entitlement server-side.
  const checkout = await ctx.post("/api/v1/billing/checkout", {
    data: { slug: "premium", billingPeriod: "monthly", autoConfirm: true },
  });
  expect(checkout.ok()).toBeTruthy();
  const me = await ctx.get("/api/v1/me");
  expect((await me.json()).data.entitlements.premium_controls).toBe(true);

  // Flow 6 — moderation: report a character, then confirm it in the admin queue.
  const report = await ctx.post(`/api/v1/characters/${characterId}/report`, {
    data: { category: "spam", description: "e2e report" },
  });
  const reportId = (await report.json()).data.report.id as string;

  const queue = await ctx.get("/api/v1/admin/moderation/queue", {
    headers: { "x-idream-user-id": "seed-admin-user", "x-idream-role": "admin" },
    params: { id: reportId },
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

test("flow 8: admin control-plane API routes respond", async ({ page }) => {
  const headers = {
    "x-idream-user-id": "seed-admin-user",
    "x-idream-role": "admin",
  };

  const dashboard = await page.request.get("/api/v1/admin/dashboard", { headers });
  expect(dashboard.ok()).toBeTruthy();
  expect((await dashboard.json()).data.metrics.generation).toBeTruthy();

  const profiles = await page.request.get("/api/v1/admin/generation/model-profiles", { headers });
  expect(profiles.ok()).toBeTruthy();
  expect((await profiles.json()).data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ profileKey: "profile_image_default_v1" }),
    ]),
  );

  const audit = await page.request.get("/api/v1/admin/audit-log", { headers });
  expect(audit.ok()).toBeTruthy();
  expect(Array.isArray((await audit.json()).data.items)).toBe(true);
});
