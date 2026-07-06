import { expect, test, type Page } from "@playwright/test";

const publicRoutes = [
  { path: "/", title: /ourdream\.ai/i },
  { path: "/explore", title: /explore/i },
  { path: "/create", title: /create/i },
  { path: "/generate", title: /ai image generator/i },
  { path: "/generate/ai-porn", title: /ai porn/i },
  { path: "/chat", title: /chat/i },
  { path: "/custom", title: /dream ai characters|my ai/i },
  { path: "/profile", title: /profile/i },
  { path: "/profile/redeem-code", title: /redeem dreamcoin code/i },
  { path: "/profile/notifications", title: /profile notifications/i },
  { path: "/profile/account-management", title: /account management/i },
  { path: "/upgrade", title: /upgrade/i },
  { path: "/feed", title: /feed/i },
  { path: "/community", title: /community/i },
  { path: "/helpdesk", title: /help desk/i },
  { path: "/ai-girl", title: /ai girl/i },
  { path: "/ai-girlfriend", title: /ai girlfriend/i },
  { path: "/ai-boyfriend", title: /ai boyfriend/i },
  { path: "/affiliate", title: /affiliate/i },
  { path: "/authors/lizzie-od", title: /lizzie od/i },
  { path: "/site/rprp-ai", title: /rprp ai/i },
  { path: "/nude-ai", title: /nude ai/i },
  { path: "/free-ai-girlfriend", title: /free ai girlfriend/i },
  { path: "/lovescape-ai-alternatives", title: /lovescape ai alternatives/i },
  { path: "/resources-hub", title: /resources hub/i },
  { path: "/type", title: /ai girlfriend types/i },
  { path: "/comparison", title: /compare ai girlfriend platforms/i },
  { path: "/videos", title: /ai video guides/i },
  { path: "/ai-instructions", title: /ai instructions/i },
  { path: "/games", title: /ai games/i },
  { path: "/romantasy", title: /ai romantasy/i },
  { path: "/type/anime-ai-girlfriend", title: /anime ai girlfriend/i },
  { path: "/guides/how-to-use-character-ai", title: /how to use character ai/i },
  { path: "/comparison/character-ai-alternative", title: /character ai alternative/i },
  { path: "/videos/ai-porn-videos", title: /ai porn videos/i },
  { path: "/terms", title: /terms/i },
  { path: "/safety/introduction", title: /safety/i },
] as const;

const prohibitedLaunchCopy = [
  "page cloned from",
  "public sitemap route",
  "visual clone",
  "this clone",
  "cloned route",
  "target page",
  "target site",
  "target-site",
  "sitemap coverage",
  "mintlify",
  "out of scope",
] as const;

async function dismissAgeGateIfPresent(page: Page) {
  const enter = page.getByRole("button", { name: /over 18/i });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
    await expect(enter).toBeHidden();
  }
}

function uniqueEmail(routePath: string) {
  const slug = routePath === "/" ? "home" : routePath.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `e2e-route-${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

async function startSignedInAdultSession(page: Page, routePath: string) {
  await page.request.post("/api/v1/age-gate/accept", { data: { sourcePath: routePath } });
  const signup = await page.request.post("/api/v1/auth/signup", {
    data: {
      email: uniqueEmail(routePath),
      password: "password123",
      name: "Route Smoke",
    },
  });
  expect(signup.ok()).toBeTruthy();
}

test.describe("public route smoke", () => {
  for (const route of publicRoutes) {
    test(`${route.path} renders without 404, broken images, or console errors`, async ({
      page,
    }) => {
      await startSignedInAdultSession(page, route.path);

      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
      });

      await page.goto(route.path);
      await dismissAgeGateIfPresent(page);
      await expect(page).toHaveTitle(route.title);
      await expect(page.locator("main")).toBeVisible();

      const routeHealth = await page.evaluate((prohibitedPhrases) => {
        const bodyText = document.body?.innerText ?? "";
        const metaDescription =
          document
            .querySelector('meta[name="description"]')
            ?.getAttribute("content") ?? "";
        const searchableText = `${bodyText}\n${metaDescription}`.toLowerCase();
        const brokenImages = Array.from(document.images)
          .filter((image) => image.complete && image.naturalWidth === 0)
          .map((image) => image.currentSrc || image.src || image.alt || "unknown");

        return {
          brokenImages,
          prohibitedCopy: prohibitedPhrases.filter((phrase) =>
            searchableText.includes(phrase),
          ),
          is404:
            document.title.includes("404") ||
            bodyText.includes("404") ||
            bodyText.includes("This page could not be found"),
        };
      }, [...prohibitedLaunchCopy]);

      expect(routeHealth.is404).toBe(false);
      expect(routeHealth.brokenImages).toEqual([]);
      expect(routeHealth.prohibitedCopy).toEqual([]);
      expect(pageErrors).toEqual([]);
      expect(consoleErrors.filter((message) => !message.includes("favicon"))).toEqual([]);
    });
  }

  test("/terms exposes the promised policy index", async ({ page }) => {
    await startSignedInAdultSession(page, "/terms");
    await page.goto("/terms");
    await dismissAgeGateIfPresent(page);

    await expect(page.getByRole("heading", { name: /12 policy routes/i })).toBeVisible();
    const policyLinks = page.getByTestId("terms-policy-links").locator("a");
    await expect(policyLinks).toHaveCount(12);
    await expect(
      page.getByTestId("terms-policy-links").getByRole("link", { name: /Acceptable use/i }),
    ).toHaveAttribute("href", "/safety/policies/acceptable-use");
    await expect(
      page.getByTestId("terms-policy-links").getByRole("link", { name: /Appeals/i }),
    ).toHaveAttribute("href", "/safety/moderation/appeals");
    await expect(
      page.getByTestId("terms-action-links").getByRole("link", { name: /Help Desk/i }),
    ).toHaveAttribute("href", "/helpdesk");
  });

  test("guide article pages expose readable content sections and FAQ", async ({ page }) => {
    await startSignedInAdultSession(page, "/guides/character-cards");
    await page.goto("/guides/character-cards");
    await dismissAgeGateIfPresent(page);

    await expect(
      page.getByRole("heading", { name: "Character Cards", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "FAQ", exact: true })).toHaveAttribute(
      "href",
      "#faq",
    );
    await expect(
      page.getByRole("heading", { name: "What should a character card include?" }),
    ).toBeVisible();
    await expect(page.getByText("A strong character card is a compact profile")).toBeVisible();
    await expect(page.getByText("Name, age, role, and relationship to the user.")).toBeVisible();

    const articleText = await page.locator("article").innerText();
    expect(articleText).not.toContain(
      "Ourdream combines adult character discovery, private chat, companion creation, generation tools",
    );
  });

  test("comparison pages explain feature and pricing differences with CTAs", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/comparison/character-ai-alternative");
    await page.goto("/comparison/character-ai-alternative");
    await dismissAgeGateIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /compare character ai by the workflow/i }),
    ).toBeVisible();
    await expect(page.getByText("Image generation tools", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Premium monthly is $19.99 with 1,500 dreamcoins", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Deluxe monthly is $59.99 with 6,000 dreamcoins", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /compare premium/i })).toHaveAttribute(
      "href",
      "/upgrade?plan=premium&billing=monthly",
    );
    await expect(page.getByRole("link", { name: /see plans/i })).toHaveAttribute(
      "href",
      "/upgrade",
    );
    await expect(page.getByRole("link", { name: /create a companion/i })).toHaveAttribute(
      "href",
      "/create",
    );
  });

  test("resources hub shows readable route titles instead of raw slugs", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/resources-hub");
    await page.goto("/resources-hub");
    await dismissAgeGateIfPresent(page);

    await expect(
      page.getByRole("heading", { name: "Resources Hub", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /How To Use Character AI/i })).toBeVisible();
    await expect(
      page.getByText("How To Use Character AI explains the workflow", {
        exact: false,
      }),
    ).toBeVisible();

    const visibleCopy = await page.locator("main").innerText();
    expect(visibleCopy).not.toContain("how-to-use-character-ai");
    expect(visibleCopy).not.toContain("character-ai-alternative");
  });

  test("library routes without child paths still expose curated cards", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/games");

    await page.goto("/games");
    await dismissAgeGateIfPresent(page);
    await expect(
      page.getByRole("heading", { name: "AI Games", exact: true }),
    ).toBeVisible();
    await expect(page.locator('main a[href="/generator/ai-roleplay-generator"]')).toBeVisible();
    await expect(page.locator('main a[href="/sex-chat/ai-sex-chat-roleplay"]')).toBeVisible();
    await expect(page.locator('main a[href="/type/roleplay-ai-girlfriend"]')).toBeVisible();

    await page.goto("/romantasy");
    await dismissAgeGateIfPresent(page);
    await expect(
      page.getByRole("heading", { name: "AI Romantasy", exact: true }),
    ).toBeVisible();
    await expect(page.locator('main a[href="/guides/character-card-creator"]')).toBeVisible();
    await expect(page.locator('main a[href="/type/angel-ai-girlfriend"]')).toBeVisible();
    await expect(page.locator('main a[href="/type/goth-ai-girlfriend"]')).toBeVisible();
  });

  test("/terms is readable before age-gate acceptance", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/terms");

    await expect(page.getByRole("heading", { name: /12 policy routes/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /over 18/i })).toHaveCount(0);
    await expect(page.getByTestId("terms-policy-links").locator("a")).toHaveCount(12);
    await expect(
      page.getByTestId("terms-policy-links").getByRole("link", { name: /Acceptable use/i }),
    ).toHaveAttribute("href", "/safety/policies/acceptable-use");
  });

  test("/safety policy pages are readable before age-gate acceptance", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/safety/policies/acceptable-use");

    await expect(page).toHaveTitle(/acceptable use/i);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByRole("button", { name: /over 18/i })).toHaveCount(0);
  });

  test("safety pages expose real mobile navigation and no dead header controls", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.context().clearCookies();
    await page.goto("/safety/policies/acceptable-use");

    await expect(page).toHaveTitle(/acceptable use/i);
    await expect(page.getByRole("button", { name: /over 18/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /toggle dark mode/i })).toHaveCount(0);
    await expect(page.getByText("Search...")).toHaveCount(0);

    const mobileNav = page.locator("details").filter({ hasText: "Navigation" });
    await mobileNav.getByText("Navigation", { exact: true }).click();
    await expect(mobileNav.getByRole("link", { name: "Acceptable use", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(mobileNav.getByRole("link", { name: "Appeals", exact: true })).toHaveAttribute(
      "href",
      "/safety/moderation/appeals",
    );
  });

  test("help desk support links distinguish internal routes from external community", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/helpdesk");
    await page.goto("/helpdesk");
    await dismissAgeGateIfPresent(page);

    const supportLinks = page.getByTestId("helpdesk-support-links");
    const accountLink = supportLinks.getByRole("link", { name: "Account & billing" });
    await expect(accountLink).toHaveAttribute("href", "/profile");
    await expect(accountLink).toHaveAttribute("data-link-kind", "internal");
    await expect(accountLink).not.toHaveAttribute("target", "_blank");
    await expect(accountLink.locator("svg.lucide-arrow-right")).toHaveCount(1);
    await expect(accountLink.locator("svg.lucide-external-link")).toHaveCount(0);

    const trustLink = supportLinks.getByRole("link", { name: "Trust contact" });
    await expect(trustLink).toHaveAttribute("href", "/safety/contact");
    await expect(trustLink).toHaveAttribute("data-link-kind", "internal");
    await expect(trustLink).not.toHaveAttribute("target", "_blank");
    await expect(trustLink.locator("svg.lucide-arrow-right")).toHaveCount(1);
    await expect(trustLink.locator("svg.lucide-external-link")).toHaveCount(0);

    const discordLink = supportLinks.locator('a[data-link-kind="external"]').filter({
      hasText: "Discord",
    });
    await expect(discordLink).toHaveAttribute("href", "https://discord.gg/P47YU7je5D");
    await expect(discordLink).toHaveAttribute("data-link-kind", "external");
    await expect(discordLink).toHaveAttribute("target", "_blank");
    await expect(discordLink).toHaveAttribute("rel", "noopener noreferrer");
    await expect(discordLink.locator("svg.lucide-external-link")).toHaveCount(1);
    await expect(discordLink.locator("svg.lucide-arrow-right")).toHaveCount(0);
  });

  test("global navigation and footer expose external links explicitly", async ({ page }) => {
    await startSignedInAdultSession(page, "/helpdesk");
    await page.goto("/helpdesk");
    await dismissAgeGateIfPresent(page);

    const sidebarDiscord = page.locator("aside").getByRole("link", { name: "Discord" });
    await expect(sidebarDiscord).toHaveAttribute("href", "https://discord.gg/P47YU7je5D");
    await expect(sidebarDiscord).toHaveAttribute("data-link-kind", "external");
    await expect(sidebarDiscord).toHaveAttribute("target", "_blank");
    await expect(sidebarDiscord).toHaveAttribute("rel", "noopener noreferrer");
    await expect(sidebarDiscord.locator("svg.lucide-external-link")).toHaveCount(1);

    const sidebarHelpDesk = page.locator("aside").getByRole("link", { name: "Help Desk" });
    await expect(sidebarHelpDesk).toHaveAttribute("href", "/helpdesk");
    await expect(sidebarHelpDesk).toHaveAttribute("data-link-kind", "internal");
    await expect(sidebarHelpDesk).not.toHaveAttribute("target", "_blank");

    const footer = page.locator("footer");
    const helpCentre = footer.locator('a[href="https://help.ourdream.ai/"]');
    await expect(helpCentre).toHaveAttribute("href", "https://help.ourdream.ai/");
    await expect(helpCentre).toHaveAttribute("data-link-kind", "external");
    await expect(helpCentre).toHaveAttribute("target", "_blank");
    await expect(helpCentre).toHaveAttribute("rel", "noopener noreferrer");

    const helpDesk = footer.locator('a[href="/helpdesk"]');
    await expect(helpDesk).toHaveAttribute("href", "/helpdesk");
    await expect(helpDesk).toHaveAttribute("data-link-kind", "internal");
    await expect(helpDesk).not.toHaveAttribute("target", "_blank");

    const footerDiscord = footer.getByLabel("Discord");
    await expect(footerDiscord).toHaveAttribute("href", "https://discord.gg/P47YU7je5D");
    await expect(footerDiscord).toHaveAttribute("data-link-kind", "external");
    await expect(footerDiscord).toHaveAttribute("target", "_blank");
    await expect(footerDiscord).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("promised catch-all marketing and comparison pages keep More active", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/ai-girl");

    const promisedContentRoutes = [
      "/ai-girl",
      "/affiliate",
      "/authors/lizzie-od",
      "/site/rprp-ai",
      "/nude-ai",
      "/free-ai-girlfriend",
      "/lovescape-ai-alternatives",
    ] as const;

    for (const routePath of promisedContentRoutes) {
      await page.goto(routePath);
      await dismissAgeGateIfPresent(page);
      await expect(page.locator("main")).toBeVisible();
      await expect(page.locator("aside").getByRole("link", { name: "More" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page.locator("aside").getByRole("link", { name: "Explore" })).not.toHaveAttribute(
        "aria-current",
        "page",
      );
    }
  });

  test("account shell routes expose exactly one current sidebar destination", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/profile");

    const cases = [
      { path: "/custom", current: ["My AI"], heading: "My AI" },
      { path: "/profile", current: ["Profile"], heading: "Profile" },
      { path: "/profile/notifications", current: ["Profile"], heading: "Profile" },
      { path: "/upgrade", current: ["Upgrade"] },
    ] as const;

    for (const item of cases) {
      await page.goto(item.path);
      await dismissAgeGateIfPresent(page);
      await expect(page.locator("main")).toBeVisible();
      if ("heading" in item) {
        await expect(page.getByRole("heading", { name: item.heading })).toBeVisible();
      }
      const currentLabels = await page.evaluate(() =>
        Array.from(document.querySelectorAll('aside a[aria-current="page"]')).map((link) =>
          (link.textContent ?? "").replace(/\s+/g, " ").trim(),
        ),
      );
      expect(currentLabels).toEqual(item.current);
    }
  });

test("active app copy avoids unavailable video and unsupported sale promises", async ({
  page,
}) => {
  await startSignedInAdultSession(page, "/");
  await page.goto("/");
  await dismissAgeGateIfPresent(page);

  const homeCopy = await page.evaluate(() => document.body.innerText.toLowerCase());
  expect(homeCopy).not.toContain("chat, image, and video tools");
  expect(homeCopy).not.toContain("generating images and videos");
  expect(homeCopy).not.toContain("image and video generation access");
  expect(homeCopy).not.toContain("75% pride sale");

  await expect(page.getByRole("link", { name: "Pride offer - view plans" })).toBeVisible({
    timeout: 10_000,
  });
  const homePromotionalLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a, img"))
      .map((element) =>
        [
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
          element.getAttribute("src"),
        ].join(" "),
      )
      .join(" ")
      .toLowerCase(),
  );
  expect(homePromotionalLabels).toContain("pride offer");
  expect(homePromotionalLabels).not.toContain("75%");
  expect(homePromotionalLabels).not.toContain("pride sale");
  expect(homePromotionalLabels).not.toContain("pride-card-female");
  expect(homePromotionalLabels).not.toContain("pride-banner-female");

  await page.goto("/generate");
    await expect(page).toHaveTitle(/ai image generator/i);
    const generateMetadata = await page.evaluate(() => ({
      title: document.title.toLowerCase(),
      description:
        document.querySelector('meta[name="description"]')?.getAttribute("content")?.toLowerCase() ??
        "",
    }));
    expect(generateMetadata.title).not.toContain("video");
    expect(generateMetadata.description).not.toContain("video");

    await page.goto("/comparison");
    const comparisonCopy = await page.evaluate(() => document.body.innerText.toLowerCase());
    expect(comparisonCopy).not.toContain("image and video tools");
    expect(comparisonCopy).toContain("image generation tools");

    await page.goto("/upgrade");
    await expect(page.locator("article").filter({ hasText: "Premium monthly" })).toBeVisible({
      timeout: 10_000,
    });
    const planCardCopy = (await page.locator("article").allInnerTexts()).join("\n").toLowerCase();
    expect(planCardCopy).toContain("includes 1,500 dreamcoins");
    expect(planCardCopy).toContain("unlimited text messages & audio");
    expect(planCardCopy).not.toContain("video");
    expect(planCardCopy).not.toContain("videos");
  });

  test("my ai metadata does not market deferred group chats or packs as active features", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/custom");
    await page.goto("/custom");
    await dismissAgeGateIfPresent(page);

    const metadata = await page.evaluate(() => ({
      description:
        document.querySelector('meta[name="description"]')?.getAttribute("content")?.toLowerCase() ??
        "",
    }));

    expect(metadata.description).not.toContain("group chats, packs");
    expect(metadata.description).toContain("deferred group-chat and pack tabs");
  });
});
