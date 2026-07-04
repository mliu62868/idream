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

  test("active app copy does not promise video tools while video generation is disabled", async ({
    page,
  }) => {
    await startSignedInAdultSession(page, "/");
    await page.goto("/");
    await dismissAgeGateIfPresent(page);

    const homeCopy = await page.evaluate(() => document.body.innerText.toLowerCase());
    expect(homeCopy).not.toContain("chat, image, and video tools");
    expect(homeCopy).not.toContain("generating images and videos");
    expect(homeCopy).not.toContain("image and video generation access");

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
  });
});
