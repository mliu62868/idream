import { expect, test, type Page } from "@playwright/test";

const publicRoutes = [
  { path: "/", title: /ourdream\.ai/i },
  { path: "/explore", title: /ourdream\.ai/i },
  { path: "/create", title: /create/i },
  { path: "/generate", title: /ai image generator/i },
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
  { path: "/resources-hub", title: /resources hub/i },
  { path: "/comparison", title: /compare ai girlfriend platforms/i },
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
      if (route.path === "/explore") {
        await expect(page).toHaveURL(/\/$/);
      }
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
          .filter((image) => {
            const styles = window.getComputedStyle(image);
            const bounds = image.getBoundingClientRect();
            const userVisible =
              styles.display !== "none" &&
              styles.visibility !== "hidden" &&
              Number(styles.opacity) > 0 &&
              bounds.width > 0 &&
              bounds.height > 0;

            return userVisible && image.complete && image.naturalWidth === 0;
          })
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

  test("unpublished route inventory does not render generic fake content", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/guides/how-to-use-character-ai");
    for (const path of [
      "/guides/how-to-use-character-ai",
      "/generate/ai-porn",
      "/comparison/character-ai-alternative",
      "/affiliate",
      "/games",
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { name: "Page not found", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.locator('meta[name="robots"][content*="noindex" i]').count(),
        )
        .toBeGreaterThan(0);
    }
  });

  test("comparison hub explains feature differences and mirrors the live plan authority", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/comparison");
    const plansResponse = await page.request.get("/api/v1/plans");
    const plansBody = await plansResponse.text();
    expect(plansResponse.ok(), plansBody).toBeTruthy();
    const plansPayload = JSON.parse(plansBody) as {
      data?: {
        items?: Array<{
          billingPeriod: string;
          includedDreamcoins: number;
          name: string;
          priceCents: number;
          slug: string;
        }>;
      };
    };
    const plans = plansPayload.data?.items ?? [];
    expect(plans.length).toBeGreaterThan(0);

    await page.goto("/comparison");
    await dismissAgeGateIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /compare ai companion platforms by the workflow/i }),
    ).toBeVisible();
    await expect(page.getByText("Image generation tools", { exact: true })).toBeVisible();
    await expect(page.getByText("Live plan snapshot", { exact: true })).toBeVisible();
    const planCards = page.getByTestId("comparison-plan-card");
    await expect(planCards).toHaveCount(plans.length);
    for (const [index, plan] of plans.entries()) {
      const card = planCards.nth(index);
      await expect(card).toContainText(plan.name);
      await expect(card).toContainText(`$${(plan.priceCents / 100).toFixed(2)}`);
      await expect(card).toContainText(
        `${plan.includedDreamcoins.toLocaleString()} dreamcoins`,
      );
      await expect(
        card.getByRole("link", { name: `View ${plan.name}` }),
      ).toHaveAttribute(
        "href",
        `/upgrade?plan=${encodeURIComponent(plan.slug)}&billing=${encodeURIComponent(plan.billingPeriod)}`,
      );
    }
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
    await expect(
      page.getByRole("link", { name: "Character Cards", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Character Card Creator", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator('a[href="/guides/sillytavern-setup-guide"]')
        .getByRole("heading", {
          name: "SillyTavern Setup Guide",
          exact: true,
        }),
    ).toBeVisible();

    const visibleCopy = await page.locator("main").innerText();
    expect(visibleCopy).not.toContain("how-to-use-character-ai");
    expect(visibleCopy).not.toContain("character-ai-alternative");
  });

  test("community campaign failure is explicit and does not impersonate authority", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/community");
    await page.route("**/api/v1/community/campaigns", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { message: "Campaign authority unavailable" },
        }),
      }),
    );

    await page.goto("/community");
    await expect(
      page.getByTestId("community-campaign-authority-status"),
    ).toHaveText("Campaigns unavailable · Editorial community overview");
    await expect(
      page.getByTestId("community-campaign-authority-status"),
    ).not.toHaveText("Live community campaign");
  });

  test("unpublished library collections remain unpublished", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/games");

    for (const path of ["/games", "/romantasy"]) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { name: "Page not found", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.locator('meta[name="robots"][content*="noindex" i]').count(),
        )
        .toBeGreaterThan(0);
    }
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

  test("help desk support links only promise local, available destinations", async ({
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

    const policiesLink = supportLinks.getByRole("link", { name: "Policies" });
    await expect(policiesLink).toHaveAttribute("href", "/terms");
    await expect(policiesLink).toHaveAttribute("data-link-kind", "internal");
    await expect(policiesLink.locator("svg.lucide-arrow-right")).toHaveCount(1);
    await expect(supportLinks.locator('a[data-link-kind="external"]')).toHaveCount(0);
  });

  test("global navigation and footer omit unconfigured external identities", async ({ page }) => {
    await startSignedInAdultSession(page, "/helpdesk");
    await page.goto("/helpdesk");
    await dismissAgeGateIfPresent(page);

    await expect(
      page.locator("aside").getByRole("link", { name: "Discord" }),
    ).toHaveCount(0);

    const sidebarHelpDesk = page.locator("aside").getByRole("link", { name: "Help Desk" });
    await expect(sidebarHelpDesk).toHaveAttribute("href", "/helpdesk");
    await expect(sidebarHelpDesk).toHaveAttribute("data-link-kind", "internal");
    await expect(sidebarHelpDesk).not.toHaveAttribute("target", "_blank");

    const footer = page.locator("footer");
    const helpDesk = footer.locator('a[href="/helpdesk"]');
    await expect(helpDesk).toHaveAttribute("href", "/helpdesk");
    await expect(helpDesk).toHaveAttribute("data-link-kind", "internal");
    await expect(helpDesk).not.toHaveAttribute("target", "_blank");
    await expect(footer.locator('a[data-link-kind="external"]')).toHaveCount(0);
  });

  test("unpublished marketing inventory fails closed instead of rendering invented content", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/ai-girl");

    const unpublishedMarketingRoutes = [
      "/ai-girl",
      "/ai-girlfriend",
      "/ai-boyfriend",
      "/affiliate",
      "/authors/lizzie-od",
      "/site/rprp-ai",
      "/nude-ai",
      "/free-ai-girlfriend",
      "/lovescape-ai-alternatives",
    ] as const;

    for (const routePath of unpublishedMarketingRoutes) {
      await page.goto(routePath);
      await expect(
        page.getByRole("heading", { name: "Page not found", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.locator('meta[name="robots"][content*="noindex" i]').count(),
        )
        .toBeGreaterThan(0);
      await expect(
        page.getByRole("link", { name: "Create your AI", exact: true }),
      ).toHaveAttribute(
        "href",
        "/create",
      );
    }
  });

  test("SEO authority exposes only canonical published routes", async ({ page }) => {
    await startSignedInAdultSession(page, "/resources-hub");

    const robots = await page.request.get("/robots.txt");
    expect(robots.ok(), await robots.text()).toBeTruthy();
    const robotsText = await robots.text();
    expect(robotsText).toContain("Disallow: /api/");
    expect(robotsText).toContain("Disallow: /chat/");
    expect(robotsText).toContain("Sitemap:");

    const sitemap = await page.request.get("/sitemap.xml");
    expect(sitemap.ok(), await sitemap.text()).toBeTruthy();
    const sitemapText = await sitemap.text();
    const origin = new URL(sitemap.url()).origin;
    expect(sitemapText).toContain(`<loc>${origin}/resources-hub</loc>`);
    expect(sitemapText).toContain(`<loc>${origin}/guides/character-cards</loc>`);
    expect(sitemapText).not.toContain(`<loc>${origin}/games</loc>`);
    expect(sitemapText).not.toContain(`<loc>${origin}/ai-girl</loc>`);

    await page.goto("/resources-hub");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `${origin}/resources-hub`,
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      `${origin}/resources-hub`,
    );
    const robotsContent = await page
      .locator('meta[name="robots"]')
      .getAttribute("content");
    expect(robotsContent).not.toContain("noindex");
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

    await expect(page.getByRole("link", { name: "Compare upgrade plans" })).toBeVisible({
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
    await expect(
      page.getByText("Image generation tools", { exact: true }),
    ).toBeVisible();
    const comparisonCopy = await page.evaluate(() => document.body.innerText.toLowerCase());
    expect(comparisonCopy).not.toContain("image and video tools");
    expect(comparisonCopy).toContain("image generation tools");

    const plansResponse = await page.request.get("/api/v1/plans");
    const plansPayload = (await plansResponse.json()) as {
      data: {
        items: Array<{
          billingPeriod: string;
          includedDreamcoins: number;
          name: string;
          priceCents: number;
        }>;
      };
    };
    await page.goto("/upgrade");
    for (const plan of plansPayload.data.items) {
      const planCard = page.locator("article").filter({
        has: page.getByRole("heading", {
          name: `${plan.name} ${plan.billingPeriod}`,
          exact: true,
        }),
      });
      await expect(planCard).toBeVisible({ timeout: 10_000 });
      await expect(planCard).toContainText(
        `$${(plan.priceCents / 100).toFixed(2)}`,
      );
      await expect(planCard).toContainText(
        `${plan.includedDreamcoins.toLocaleString()} dreamcoins`,
      );
    }
    const planCardCopy = (await page.locator("article").allInnerTexts()).join("\n").toLowerCase();
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
