import { expect, test, type Page } from "@playwright/test";

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

test("home presents product capabilities without unverified scale claims", async ({
  page,
}) => {
  await acceptAgeGate(page);
  await page.route("**/api/v1/characters?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { items: [], nextCursor: null },
      }),
    });
  });
  await page.route("**/api/v1/tags**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { items: [] } }),
    });
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: "One character, connected across every creative surface",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Discover", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Create", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Continue", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("63M+");
  await expect(page.locator("main")).not.toContainText("10M+");
});

test("chat start panel shows at most three characters from the public catalog", async ({
  page,
}) => {
  await acceptAgeGate(page);
  await page.route("**/api/v1/chat/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
  await page.route("**/api/v1/characters?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          items: [
            publicCharacter("authority-one", "Authority One", "101"),
            publicCharacter("authority-two", "Authority Two", "202"),
            publicCharacter("authority-three", "Authority Three", "303"),
            publicCharacter("authority-four", "Authority Four", "404"),
          ],
          nextCursor: null,
        },
      }),
    });
  });

  await page.goto("/chat");

  await expect(page.getByRole("heading", { name: "No chats yet" })).toBeVisible();
  const featuredCards = page.getByTestId("chat-hub-character-card");
  await expect(featuredCards).toHaveCount(3);
  await expect(featuredCards.nth(0)).toContainText("Authority One");
  await expect(featuredCards.nth(0)).toContainText("101 chats");
  await expect(featuredCards.nth(1)).toContainText("Authority Two");
  await expect(featuredCards.nth(2)).toContainText("Authority Three");
  await expect(page.getByText("Authority Four", { exact: true })).toHaveCount(0);
});

test("chat start panel exposes a loading state without blocking sessions", async ({
  page,
}) => {
  await acceptAgeGate(page);
  await page.route("**/api/v1/chat/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
  let releaseCharacters: () => void = () => undefined;
  const charactersReady = new Promise<void>((resolve) => {
    releaseCharacters = resolve;
  });
  await page.route("**/api/v1/characters?**", async (route) => {
    await charactersReady;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { items: [], nextCursor: null },
      }),
    });
  });

  await page.goto("/chat");

  await expect(page.getByRole("heading", { name: "No chats yet" })).toBeVisible();
  await expect(page.getByTestId("chat-hub-featured-status")).toHaveText(
    "Loading featured characters...",
  );
  releaseCharacters();
  await expect(page.getByTestId("chat-hub-featured-status")).toHaveText(
    "No public characters are available yet.",
  );
});

test("chat start panel explains when the public catalog is empty", async ({
  page,
}) => {
  await acceptAgeGate(page);
  await page.route("**/api/v1/chat/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
  await page.route("**/api/v1/characters?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { items: [], nextCursor: null },
      }),
    });
  });

  await page.goto("/chat");

  await expect(page.getByRole("heading", { name: "No chats yet" })).toBeVisible();
  await expect(page.getByTestId("chat-hub-featured-status")).toHaveText(
    "No public characters are available yet.",
  );
  await expect(page.getByTestId("chat-hub-character-card")).toHaveCount(0);
});

test("chat sessions remain usable when featured characters cannot load", async ({
  page,
}) => {
  await acceptAgeGate(page);
  await page.route("**/api/v1/chat/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
  await page.route("**/api/v1/characters?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 503,
      body: JSON.stringify({
        ok: false,
        error: { message: "catalog unavailable" },
      }),
    });
  });

  await page.goto("/chat");

  await expect(page.getByRole("heading", { name: "No chats yet" })).toBeVisible();
  await expect(page.getByTestId("chat-hub-featured-status")).toHaveText(
    "Featured characters are temporarily unavailable.",
  );
  await expect(
    page
      .getByTestId("chat-hub-start-panel")
      .getByRole("link", { name: "Explore characters", exact: true }),
  ).toBeVisible();
});

test("marketing character strip renders only public catalog results", async ({
  page,
}) => {
  await acceptAgeGate(page);
  await page.route("**/api/v1/characters?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          items: [
            publicCharacter("strip-one", "Strip One", "11"),
            publicCharacter("strip-two", "Strip Two", "22"),
            publicCharacter("strip-three", "Strip Three", "33"),
            publicCharacter("strip-four", "Strip Four", "44"),
            publicCharacter("strip-five", "Strip Five", "55"),
          ],
          nextCursor: null,
        },
      }),
    });
  });

  await page.goto("/ai-girl");

  const characterCards = page.getByTestId("public-character-strip-card");
  await expect(characterCards).toHaveCount(4);
  await expect(characterCards.nth(0)).toContainText("Strip One");
  await expect(characterCards.nth(1)).toContainText("Strip Two");
  await expect(characterCards.nth(2)).toContainText("Strip Three");
  await expect(characterCards.nth(3)).toContainText("Strip Four");
  await expect(page.getByText("Strip Five", { exact: true })).toHaveCount(0);
});

test("marketing pages keep a useful next step when the public catalog is empty", async ({
  page,
}) => {
  await acceptAgeGate(page);
  await page.route("**/api/v1/characters?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { items: [], nextCursor: null },
      }),
    });
  });

  await page.goto("/ai-girl");

  await expect(page.getByTestId("public-character-strip-status")).toContainText(
    "The public showcase is being curated",
  );
  await expect(
    page
      .getByTestId("public-character-strip-status")
      .getByRole("link", { name: "Create a character" }),
  ).toHaveAttribute("href", "/create");
});

test("marketing pages keep their calls to action when the catalog is unavailable", async ({
  page,
}) => {
  await acceptAgeGate(page);
  await page.route("**/api/v1/characters?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 503,
      body: JSON.stringify({
        ok: false,
        error: { message: "catalog unavailable" },
      }),
    });
  });

  await page.goto("/ai-girl");

  await expect(page.getByTestId("public-character-strip-status")).toContainText(
    "Character showcase is temporarily unavailable",
  );
  await expect(
    page
      .getByTestId("public-character-strip-status")
      .getByRole("link", { name: "Create a character" }),
  ).toHaveAttribute("href", "/create");
});

test("comparison plan snapshot reflects only the plans authority", async ({
  page,
}) => {
  await acceptAgeGate(page);
  await page.route("**/api/v1/plans", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          items: [
            {
              id: "plan-honest-plus",
              slug: "honest-plus",
              name: "Honest Plus",
              billingPeriod: "monthly",
              priceCents: 1234,
              includedDreamcoins: 321,
            },
            {
              id: "plan-honest-max",
              slug: "honest-max",
              name: "Honest Max",
              billingPeriod: "yearly",
              priceCents: 9876,
              includedDreamcoins: 6543,
            },
          ],
        },
      }),
    });
  });

  await page.goto("/comparison/character-ai-alternative");

  const planCards = page.getByTestId("comparison-plan-card");
  await expect(planCards).toHaveCount(2);
  await expect(planCards.nth(0)).toContainText("Honest Plus");
  await expect(planCards.nth(0)).toContainText("$12.34");
  await expect(planCards.nth(0)).toContainText("321 dreamcoins");
  await expect(planCards.nth(1)).toContainText("Honest Max");
  await expect(planCards.nth(1)).toContainText("$98.76");
  await expect(planCards.nth(1)).toContainText("6,543 dreamcoins");
  await expect(
    planCards.nth(0).getByRole("link", { name: "View Honest Plus" }),
  ).toHaveAttribute("href", "/upgrade?plan=honest-plus&billing=monthly");
  await expect(page.locator("main")).not.toContainText("$19.99");
  await expect(page.locator("main")).not.toContainText("$59.99");
  await expect(page.locator("main")).not.toContainText("1,500 dreamcoins");
});

test("comparison page stays useful when no plans are available", async ({
  page,
}) => {
  await acceptAgeGate(page);
  await page.route("**/api/v1/plans", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { items: [] },
      }),
    });
  });

  await page.goto("/comparison/character-ai-alternative");

  await expect(page.getByTestId("comparison-plans-status")).toContainText(
    "No upgrade plans are available right now.",
  );
  await expect(
    page
      .getByTestId("comparison-plans-status")
      .getByRole("link", { name: "Open Upgrade" }),
  ).toHaveAttribute("href", "/upgrade");
});

test("comparison page keeps a truthful fallback when plans cannot load", async ({
  page,
}) => {
  await acceptAgeGate(page);
  await page.route("**/api/v1/plans", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 503,
      body: JSON.stringify({
        ok: false,
        error: { message: "plans unavailable" },
      }),
    });
  });

  await page.goto("/comparison/character-ai-alternative");

  await expect(page.getByTestId("comparison-plans-status")).toContainText(
    "Plan details are temporarily unavailable.",
  );
  await expect(
    page
      .getByTestId("comparison-plans-status")
      .getByRole("link", { name: "Open Upgrade" }),
  ).toHaveAttribute("href", "/upgrade");
});

function publicCharacter(id: string, title: string, chats: string) {
  return {
    id,
    title,
    age: "25",
    description: `${title} description`,
    likes: "12",
    chats,
    creator: "Public Creator",
    creatorId: "public-creator",
    creatorName: "Public Creator",
    image: "/images/ourdream/card-sarah-mercer.webp",
  };
}
