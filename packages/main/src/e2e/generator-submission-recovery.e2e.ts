import { expect, test, type Page, type Route } from "@playwright/test";

type Viewer = "first" | "second";
type RecordedWrite = { viewer: Viewer; key: string; body: string };

async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
}

// SPEC: this browser test controls the API boundary, including its accepted
// receipts and debit count. It does not claim a database debit or call a model.
async function installSubmissionFixture(page: Page, firstResponse: "lost" | "late" | "uncommitted") {
  const baseURL = test.info().project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Playwright baseURL is required");
  await page.context().addCookies([{ name: "AdultContentAcceptedOD", value: "true", url: baseURL }]);

  let viewer: Viewer = "first";
  const balances: Record<Viewer, number> = { first: 10, second: 10 };
  const writes: RecordedWrite[] = [];
  const configReads: Viewer[] = [];
  const jobReads: Array<{ viewer: Viewer; id: string }> = [];
  const receipts = new Map<string, { body: string; job: {
    id: string; mode: "image"; status: "completed"; costDreamcoins: number;
    outputCount: number; errorCode: null; createdAt: string;
  } }>();
  let releaseFirst!: () => void;
  const firstMayRespond = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let rejectedQuotes = 0;
  let nextCheckStatus: number | null = null;

  await page.route("**/api/v1/age-gate/accept", (route) => json(route, { ok: true, data: {} }));
  await page.route("**/api/v1/me", (route) => json(route, { ok: true, data: {
    user: { id: `recovery-${viewer}` }, ageGate: { accepted: true }, entitlements: {},
  } }));
  await page.route("**/api/v1/characters?**", (route) => json(route, {
    ok: true, data: { items: [], nextCursor: null },
  }));
  await page.route("**/api/v1/media?**", (route) => json(route, {
    ok: true, data: { items: [], nextCursor: null },
  }));
  // All generation routes are handled here; an unexpected write fails locally.
  await page.route("**/api/v1/generation/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const changedRoute = firstResponse !== "late" && viewer === "first" && writes.length > 0;
    const orientation = changedRoute ? "16:9" : "4:5";
    const maxCount = changedRoute ? 1 : 2;
    if (pathname === "/api/v1/generation/config") {
      configReads.push(viewer);
      return json(route, { ok: true, data: {
        viewer: { authenticated: true, scope: `user:recovery-${viewer}` },
        entitlements: { premium_controls: true }, dreamcoins: { balance: balances[viewer] },
        pricing: { image: { baseCost: 5, maxCount }, video: { baseCost: null } },
        image: {
          availability: { state: "available" }, orientations: [orientation],
          models: [{ id: "recovery-image", label: "Image", maxCount, costMultiplier: 1, entitlement: null }],
          recipes: ["character", "freeplay"].map((useCase) => ({
            id: `recovery-${useCase}`, rowId: `recovery-${useCase}-v1`, label: "Image", mode: "image", useCase, version: 1,
          })),
        },
        video: { enabled: false, availability: { state: "unavailable", reason: "feature_disabled" }, requiredEntitlement: "video_generation", models: [] },
        presets: [],
      } });
    }
    if (pathname === "/api/v1/generation/quote") {
      if (changedRoute) {
        rejectedQuotes += 1;
        return json(route, { ok: false, error: { message: "The previous generation route is unavailable." } }, 409);
      }
      return json(route, { ok: true, data: { quote: {
        mode: "image", profileId: "recovery-image", profileVersion: 1,
        routeFingerprint: "a".repeat(64),
        pricing: { ruleId: "recovery-price", ruleKey: "image", version: 1, effectiveFrom: null, fingerprint: "b".repeat(64) },
        orientations: ["4:5"], defaultOrientation: "4:5", maxCount: 2,
        costs: [{ outputCount: 1, costDreamcoins: 5 }, { outputCount: 2, costDreamcoins: 10 }],
        balance: balances[viewer],
      } } });
    }
    if (pathname === "/api/v1/generation/presets") return json(route, { ok: true, data: { items: [] } });
    if (pathname === "/api/v1/generation/jobs" && request.method() === "GET") {
      // A lagging list must not be needed to recover the exact accepted write.
      return json(route, { ok: true, data: { items: [] } });
    }
    if (pathname === "/api/v1/generation/jobs" && request.method() === "POST") {
      const requestViewer = viewer;
      const key = request.headers()["idempotency-key"] ?? "";
      const body = request.postData() ?? "";
      writes.push({ viewer: requestViewer, key, body });
      if (!key) return json(route, { ok: false, error: { message: "Idempotency-Key required" } }, 400);
      if (writes.length === 1 && firstResponse === "uncommitted") return route.abort("failed");
      if (nextCheckStatus !== null) {
        const status = nextCheckStatus;
        nextCheckStatus = null;
        return json(route, { ok: false, error: { message: "The current route cannot accept this request yet." } }, status);
      }
      const receiptKey = `${requestViewer}:${key}`;
      let receipt = receipts.get(receiptKey);
      if (receipt && receipt.body !== body) {
        return json(route, { ok: false, error: { message: "The original request payload changed" } }, 409);
      }
      if (!receipt) {
        const parsed = JSON.parse(body) as { outputCount: number; quoteAuthority?: { costDreamcoins: number } };
        const cost = parsed.quoteAuthority?.costDreamcoins;
        if (typeof cost !== "number" || balances[requestViewer] < cost) {
          return json(route, { ok: false, error: { message: "Not enough coins for a new request" } }, 402);
        }
        balances[requestViewer] -= cost;
        receipt = { body, job: {
          id: `accepted-${requestViewer}-${receipts.size + 1}`, mode: "image", status: "completed",
          costDreamcoins: cost, outputCount: parsed.outputCount, errorCode: null, createdAt: "2026-09-02T00:00:00.000Z",
        } };
        receipts.set(receiptKey, receipt);
      }
      if (writes.length === 1) {
        if (firstResponse === "lost") return route.abort("failed");
        await firstMayRespond;
      }
      return json(route, { ok: true, data: { job: receipt.job, assets: [] } }, 202);
    }
    if (pathname.startsWith("/api/v1/generation/jobs/") && request.method() === "GET") {
      const id = pathname.split("/").at(-1)!;
      jobReads.push({ viewer, id });
      const entry = [...receipts.entries()].find(([key, receipt]) => key.startsWith(`${viewer}:`) && receipt.job.id === id);
      return entry
        ? json(route, { ok: true, data: { job: entry[1].job, assets: [] } })
        : json(route, { ok: false, error: { message: "Job not found" } }, 404);
    }
    return json(route, { ok: false, error: { message: "Unexpected generation request in controlled fixture" } }, 404);
  });

  return {
    balances, writes, receipts, configReads, jobReads, releaseFirst,
    switchViewer() { viewer = "second"; },
    rejectNextCheck(status: number) { nextCheckStatus = status; },
    commitFirst() {
      const first = writes[0];
      const parsed = JSON.parse(first.body) as { outputCount: number; quoteAuthority: { costDreamcoins: number } };
      const cost = parsed.quoteAuthority.costDreamcoins;
      balances.first -= cost;
      receipts.set(`first:${first.key}`, { body: first.body, job: {
        id: "accepted-first-1", mode: "image", status: "completed", costDreamcoins: cost,
        outputCount: parsed.outputCount, errorCode: null, createdAt: "2026-09-02T00:00:00.000Z",
      } });
    },
    rejectedQuoteCount() { return rejectedQuotes; },
  };
}

async function openTwoImageForm(page: Page) {
  await page.goto("/generate");
  await expect(page.locator("[data-age-gate-content]")).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Generate · 5 coins", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("A quiet cafe portrait before the connection drops");
  await page.locator("#generator-output-count").fill("2");
  await expect(page.getByRole("button", { name: "Generate · 10 coins", exact: true })).toBeEnabled();
}

test("generator checks the accepted original submission after response loss, zero balance and an unavailable route", async ({ page }, testInfo) => {
  const fixture = await installSubmissionFixture(page, "lost");
  await openTwoImageForm(page);
  await page.getByRole("button", { name: "Generate · 10 coins", exact: true }).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  await expect(page.getByTestId("generator-status")).toContainText("Check your connection");
  expect(fixture.receipts.size).toBe(1);
  expect(fixture.balances.first).toBe(0);

  const beforeFocus = fixture.configReads.length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => fixture.configReads.length).toBeGreaterThan(beforeFocus);
  await expect.poll(() => fixture.rejectedQuoteCount()).toBeGreaterThan(0);
  await expect(page.getByText("0 coins", { exact: true })).toBeVisible();
  await expect(page.locator("#generator-output-count")).toHaveValue("2");
  await expect(page.locator("#generator-orientation")).toHaveValue("4:5");
  const check = page.getByRole("button", { name: "Check generation request", exact: true });
  await expect(check).toBeEnabled();
  await check.click();
  await expect(page.locator('[data-generation-job-id="accepted-first-1"]')).toBeVisible();

  expect(fixture.writes).toHaveLength(2);
  expect(fixture.writes[0].key).not.toBe("");
  expect(fixture.writes[1]).toEqual(fixture.writes[0]);
  expect(JSON.parse(fixture.writes[1].body)).toMatchObject({
    outputCount: 2, controls: { orientation: "4:5" },
    quoteAuthority: { profileId: "recovery-image", profileVersion: 1, outputCount: 2, costDreamcoins: 10 },
  });
  expect(fixture.receipts.size).toBe(1);
  expect(fixture.balances.first).toBe(0);
  await testInfo.attach("submission-recovery-fixture-evidence", { contentType: "application/json", body: JSON.stringify({
    evidenceBoundary: "Controlled API receipts and balances; no database debit or model request", writes: fixture.writes,
    acceptedJobs: [...fixture.receipts.values()].map((receipt) => receipt.job.id), balance: fixture.balances.first,
    rejectedQuotes: fixture.rejectedQuoteCount(),
  }, null, 2) });
});

test("generator ignores an old viewer's late accepted response and starts the new viewer with a fresh key", async ({ page }, testInfo) => {
  const fixture = await installSubmissionFixture(page, "late");
  try {
    await openTwoImageForm(page);
    await page.getByRole("button", { name: "Generate · 10 coins", exact: true }).click();
    await expect.poll(() => fixture.writes.length).toBe(1);
    fixture.switchViewer();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => fixture.configReads.includes("second")).toBe(true);
    await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Generate · 10 coins", exact: true })).toBeEnabled();
    const oldResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/generation/jobs" &&
      response.request().headers()["idempotency-key"] === fixture.writes[0].key,
    );
    fixture.releaseFirst();
    const deliveredOldResponse = await oldResponse;
    expect(deliveredOldResponse.status()).toBe(202);
    await deliveredOldResponse.finished();
    await expect(page.getByRole("button", { name: "Check generation request", exact: true })).toHaveCount(0);
    await expect(page.locator('[data-generation-job-id="accepted-first-1"]')).toHaveCount(0);

    await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("The second viewer's own request");
    await page.getByRole("button", { name: "Generate · 10 coins", exact: true }).click();
    await expect(page.locator('[data-generation-job-id="accepted-second-2"]')).toBeVisible();
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[1].viewer).toBe("second");
    expect(fixture.writes[1].key).not.toBe(fixture.writes[0].key);
    expect(fixture.jobReads).not.toContainEqual({ viewer: "second", id: "accepted-first-1" });
    expect(fixture.balances).toEqual({ first: 0, second: 0 });
    expect(fixture.receipts.size).toBe(2);
    await testInfo.attach("viewer-isolation-fixture-evidence", { contentType: "application/json", body: JSON.stringify({
      evidenceBoundary: "Controlled API viewer/receipt boundary; no real account switch or model request",
      writes: fixture.writes, jobReads: fixture.jobReads, balances: fixture.balances,
    }, null, 2) });
  } finally {
    fixture.releaseFirst();
  }
});

test("generator reload keeps the original request through a pre-commit 409 and leaving the page", async ({ page }, testInfo) => {
  const fixture = await installSubmissionFixture(page, "uncommitted");
  await openTwoImageForm(page);
  await page.getByRole("button", { name: "Generate · 10 coins", exact: true }).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  await expect(page.getByTestId("generator-status")).toContainText("Check your connection");
  expect(fixture.receipts.size).toBe(0);

  await page.reload();
  const pending = page.getByTestId("generation-pending-requests");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("2 outputs · 4:5 · 10 coins");
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("");
  expect(fixture.writes).toHaveLength(1);
  fixture.rejectNextCheck(409);
  await pending.getByRole("button", { name: "Check original request", exact: true }).click();
  await expect.poll(() => fixture.writes.length).toBe(2);
  await expect(page.getByTestId("generator-status")).toContainText("original request is kept");
  await expect(pending).toBeVisible();
  expect(fixture.receipts.size).toBe(0);

  fixture.commitFirst();
  await page.goto("about:blank");
  await page.goto("/generate");
  await expect(pending).toBeVisible();
  await expect(page.getByText("0 coins", { exact: true })).toBeVisible();
  await pending.getByRole("button", { name: "Check original request", exact: true }).click();
  await expect(page.locator('[data-generation-job-id="accepted-first-1"]')).toBeVisible();
  await expect(pending).toHaveCount(0);
  expect(fixture.writes).toHaveLength(3);
  expect(fixture.writes[1]).toEqual(fixture.writes[0]);
  expect(fixture.writes[2]).toEqual(fixture.writes[0]);
  expect(fixture.balances.first).toBe(0);
  expect(fixture.receipts.size).toBe(1);
  await testInfo.attach("reload-recovery-fixture-evidence", { contentType: "application/json", body: JSON.stringify({
    evidenceBoundary: "Real document reload/navigation; controlled delayed commit and one debit, no database or model request",
    writes: fixture.writes, acceptedJobs: [...fixture.receipts.values()].map((receipt) => receipt.job.id), balance: fixture.balances.first,
  }, null, 2) });
});
