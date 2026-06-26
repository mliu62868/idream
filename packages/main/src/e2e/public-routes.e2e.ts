import { expect, test, type Page } from "@playwright/test";

const publicRoutes = [
  { path: "/", title: /ourdream\.ai/i },
  { path: "/explore", title: /explore/i },
  { path: "/create", title: /create/i },
  { path: "/generate", title: /generator/i },
  { path: "/generate/ai-porn", title: /ai porn/i },
  { path: "/chat", title: /chat/i },
  { path: "/custom", title: /dream ai characters|my ai/i },
  { path: "/profile", title: /profile/i },
  { path: "/upgrade", title: /upgrade/i },
  { path: "/feed", title: /feed/i },
  { path: "/community", title: /community/i },
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
});
