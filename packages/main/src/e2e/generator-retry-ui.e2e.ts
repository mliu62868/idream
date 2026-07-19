import { expect, test, type Page, type Route } from "@playwright/test";

const failedJobId = "generator-retry-ui-failed-job";

const failedJob = {
  id: failedJobId,
  mode: "image",
  status: "failed",
  costDreamcoins: 5,
  outputCount: 1,
  errorCode: "provider_timeout",
  createdAt: "2026-07-17T12:00:00.000Z",
};

async function acceptAgeGate(page: Page) {
  const baseURL = test.info().project.use.baseURL;
  if (typeof baseURL !== "string") {
    throw new Error("Playwright baseURL is required");
  }
  await page.context().addCookies([
    {
      name: "AdultContentAcceptedOD",
      value: "true",
      url: baseURL,
    },
  ]);
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mountRetryableGenerator(
  page: Page,
  generationConfig?: Record<string, unknown>,
) {
  await acceptAgeGate(page);
  await page.route("**/api/v1/generation/config", (route) =>
    fulfillJson(route, {
      ok: true,
      data: generationConfig ?? {
        viewer: {
          authenticated: true,
          scope: "user:generator-retry-ui",
        },
        entitlements: {},
        dreamcoins: { balance: 100 },
        pricing: {
          image: { baseCost: 5, maxCount: 4 },
          video: { baseCost: null },
        },
        image: {
          availability: { state: "available" },
          orientations: ["4:5"],
          models: [
            {
              id: "generator-retry-ui-image",
              label: "Image",
              orientations: ["4:5"],
              costMultiplier: 1,
              entitlement: null,
              maxCount: 4,
            },
          ],
          recipes: [
            {
              id: "generator-retry-character",
              rowId: "generator-retry-character-row",
              label: "Character",
              mode: "image",
              useCase: "character",
              version: 1,
            },
            {
              id: "generator-retry-freeplay",
              rowId: "generator-retry-freeplay-row",
              label: "Freeplay",
              mode: "image",
              useCase: "freeplay",
              version: 1,
            },
          ],
        },
        video: {
          enabled: false,
          availability: {
            state: "unavailable",
            reason: "feature_disabled",
          },
          requiredEntitlement: "video_generation",
          models: [],
        },
        presets: [],
      },
    }),
  );
  await page.route("**/api/v1/characters?limit=12", (route) =>
    fulfillJson(route, {
      ok: true,
      data: { items: [], nextCursor: null },
    }),
  );
  await page.route("**/api/v1/generation/quote", (route) =>
    fulfillJson(route, {
      ok: true,
      data: {
        quote: {
          mode: "image",
          profileId: "generator-retry-ui-image",
          profileVersion: 1,
          routeFingerprint: "a".repeat(64),
          pricing: {
            ruleId: "generator-retry-ui-price",
            ruleKey: "image-default",
            version: 1,
            effectiveFrom: null,
            fingerprint: "b".repeat(64),
          },
          orientations: ["4:5"],
          defaultOrientation: "4:5",
          maxCount: 4,
          costs: [
            { outputCount: 1, costDreamcoins: 5 },
            { outputCount: 2, costDreamcoins: 10 },
            { outputCount: 3, costDreamcoins: 15 },
            { outputCount: 4, costDreamcoins: 20 },
          ],
          balance: 100,
        },
      },
    }),
  );
  await page.route("**/api/v1/generation/jobs?limit=20", (route) =>
    fulfillJson(route, {
      ok: true,
      data: { items: [failedJob] },
    }),
  );
  await page.route(
    "**/api/v1/generation/jobs/*/retry/quote",
    (route) =>
      fulfillJson(route, {
        ok: true,
        data: {
          quote: {
            mode: "image",
            generationJobId: failedJobId,
            profileId: "hidden-specialized-image-profile",
            profileVersion: 3,
            routeFingerprint: "c".repeat(64),
            pricing: {
              ruleId: "generator-retry-ui-price",
              ruleKey: "image-default",
              version: 2,
              effectiveFrom: null,
              fingerprint: "d".repeat(64),
            },
            outputCount: 1,
            costDreamcoins: 8,
            balance: 100,
          },
        },
      }),
  );
  await page.route("**/api/v1/media?*", (route) =>
    fulfillJson(route, {
      ok: true,
      data: { items: [], nextCursor: null },
    }),
  );
  await page.route("**/api/v1/generation/presets?scope=user", (route) =>
    fulfillJson(route, {
      ok: true,
      data: { items: [] },
    }),
  );
}

test("generator explains unavailable model authority without fake controls", async ({
  page,
}) => {
  let generationPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/generation/jobs"
    ) {
      generationPosts += 1;
    }
  });
  await mountRetryableGenerator(page, {
    viewer: {
      authenticated: true,
      scope: "user:generator-unavailable-ui",
    },
    entitlements: {},
    dreamcoins: { balance: 100 },
    pricing: {
      image: { baseCost: 5, maxCount: null },
      video: { baseCost: null },
    },
    image: {
      availability: {
        state: "unavailable",
        reason: "no_active_model",
      },
      orientations: [],
      models: [],
      recipes: [],
    },
    video: {
      enabled: false,
      availability: {
        state: "unavailable",
        reason: "feature_disabled",
      },
      requiredEntitlement: "video_generation",
      models: [],
      recipes: [],
    },
    presets: [],
  });

  await page.goto("/generate");

  await expect(page.getByTestId("generator-mode-unavailable")).toContainText(
    "no active model is configured",
  );
  await expect(page.getByText("100 coins", { exact: true })).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(page.locator("#generator-orientation")).toBeDisabled();
  await expect(page.locator("#generator-orientation option")).toHaveCount(0);
  await expect(page.locator("#generator-output-count")).toBeDisabled();
  const generateButton = page.getByRole("button", {
    name: "Image generation unavailable",
  });
  await expect(generateButton).toBeDisabled();
  expect(generationPosts).toBe(0);
});

test("generator fails closed when generation recipes are incomplete", async ({
  page,
}) => {
  let generationPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/generation/jobs"
    ) {
      generationPosts += 1;
    }
  });
  await mountRetryableGenerator(page, {
    viewer: {
      authenticated: true,
      scope: "user:generator-recipe-unavailable-ui",
    },
    entitlements: {},
    dreamcoins: { balance: 100 },
    pricing: {
      image: { baseCost: 5, maxCount: null },
      video: { baseCost: null },
    },
    image: {
      availability: {
        state: "unavailable",
        reason: "no_active_recipe",
      },
      orientations: [],
      models: [],
      recipes: [],
    },
    video: {
      enabled: false,
      availability: {
        state: "unavailable",
        reason: "feature_disabled",
      },
      requiredEntitlement: "video_generation",
      models: [],
      recipes: [],
    },
    presets: [],
  });

  await page.goto("/generate");

  await expect(page.getByTestId("generator-mode-unavailable")).toContainText(
    "generation recipes are not fully configured",
  );
  await expect(
    page.getByRole("button", { name: "Image generation unavailable" }),
  ).toBeDisabled();
  expect(generationPosts).toBe(0);
});

test("generator retry locks double-clicks and preserves intent keys across network recovery", async ({
  page,
}) => {
  await mountRetryableGenerator(page);
  const idempotencyKeys: string[] = [];
  let releaseFailedRequest: () => void = () => undefined;
  const failFirstRequest = new Promise<void>((resolve) => {
    releaseFailedRequest = resolve;
  });

  await page.route(
    `**/api/v1/generation/jobs/${failedJobId}/retry`,
    async (route) => {
      const key = route.request().headers()["idempotency-key"];
      if (!key) {
        throw new Error("Generator retry request omitted Idempotency-Key");
      }
      const body = route.request().postDataJSON() as {
        quoteAuthority?: Record<string, unknown>;
      };
      expect(body.quoteAuthority).toEqual({
        profileId: "hidden-specialized-image-profile",
        profileVersion: 3,
        routeFingerprint: "c".repeat(64),
        pricingFingerprint: "d".repeat(64),
        outputCount: 1,
        costDreamcoins: 8,
      });
      idempotencyKeys.push(key);
      if (idempotencyKeys.length === 1) {
        await failFirstRequest;
        await route.abort("failed");
        return;
      }
      await fulfillJson(
        route,
        {
          ok: true,
          data: {
            job: {
              ...failedJob,
              id: `generator-retry-ui-derived-${idempotencyKeys.length}`,
              status: "queued",
              errorCode: null,
            },
          },
        },
        202,
      );
    },
  );

  await page.goto("/generate");
  const failedCard = page.locator(
    `[data-generation-job-id="${failedJobId}"]`,
  );
  await expect(failedCard).toBeVisible();
  const retryButton = failedCard.getByRole("button");
  await expect(retryButton).toHaveText("Retry · 8 coins");
  await expect(retryButton).toBeEnabled();

  await retryButton.dblclick();
  await expect.poll(() => idempotencyKeys.length).toBe(1);
  await expect(retryButton).toHaveText("Retrying…");
  await expect(retryButton).toBeDisabled();
  await page.waitForTimeout(100);
  expect(idempotencyKeys).toHaveLength(1);

  releaseFailedRequest();
  await expect(page.getByTestId("generator-status")).toHaveText(
    "Retry failed. Check your connection and try again.",
  );
  await expect(retryButton).toHaveText("Retry · 8 coins");
  await expect(retryButton).toBeEnabled();

  await retryButton.click();
  await expect.poll(() => idempotencyKeys.length).toBe(2);
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  await expect(page.getByTestId("generator-status")).toHaveText("Retry queued.");
  await expect(retryButton).toBeEnabled();

  await retryButton.click();
  await expect.poll(() => idempotencyKeys.length).toBe(3);
  expect(idempotencyKeys[2]).not.toBe(idempotencyKeys[1]);
  await expect(page.getByTestId("generator-status")).toHaveText("Retry queued.");
});
