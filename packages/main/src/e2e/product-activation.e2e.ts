import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

// UI fixtures isolate layout and navigation from model quality and purchases.
// Persistence, delivery visibility and media audience are covered by the
// chat-session integration tests; these screenshots do not certify providers.
for (const viewport of [{ width: 392, height: 853 }, { width: 1440, height: 1000 }]) {
  test(`discovery, returning chats and plan comparison at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const baseURL = testInfo.project.use.baseURL!;
    await page.context().addCookies([{ name: "AdultContentAcceptedOD", value: "true", url: baseURL }]);
    const writes: string[] = [];
    page.on("request", request => {
      if (request.method() === "POST" && /\/api\/v1\/(generation\/jobs|billing\/checkout)$/.test(new URL(request.url()).pathname)) writes.push(request.url());
    });
    const ok = (data: unknown) => JSON.stringify({ ok: true, data });
    const character = { id: "pm-fixture", title: "Mira", age: "28", description: "A photographer planning a quiet walk through the city.", likes: "0", chats: "0", creator: "iDream", image: "/images/ourdream/card-sophie.webp" };
    await page.route("**/api/v1/me", route => route.fulfill({ contentType: "application/json", body: ok({ user: { id: "pm-viewer", displayName: "PM Viewer", email: "pm-viewer@example.test", image: null } }) }));
    await page.route("**/api/v1/characters?**", route => route.fulfill({ contentType: "application/json", body: ok({ items: [character], nextCursor: null }) }));
    await page.route("**/api/v1/tags**", route => route.fulfill({ contentType: "application/json", body: ok({ items: [] }) }));
    await page.route("**/api/v1/chat/sessions", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([
      { id: "pm-current", title: "Mira", status: "active", characterId: character.id, memoryEnabled: true, lastMessageAt: "2026-10-28T12:00:00.000Z", characterImage: character.image, lastMessage: { id: "pm-reply", role: "assistant", content: "Shall we continue our walk through the garden?" } },
      { id: "pm-archived", title: "An earlier story", status: "archived", characterId: character.id, memoryEnabled: true, lastMessageAt: "2026-10-27T12:00:00.000Z", lastMessage: null },
    ]) }));

    await page.goto("/");
    const card = page.getByRole("link", { name: /Mira, age 28/ });
    await expect(card).toBeVisible();
    await expect(page.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
    const firstCardTop = (await card.boundingBox())!.y;
    if (viewport.width < 768) {
      expect(firstCardTop).toBeLessThan(310);
      const filters = page.getByRole("button", { name: "Filters: Female", exact: true });
      await expect(page.getByLabel("Gender filter", { exact: true })).toBeHidden();
      await filters.click();
      await page.getByLabel("Style filter", { exact: true }).selectOption("anime");
      await expect(page).toHaveURL(/style=anime/);
      await page.getByRole("button", { name: "Filters: Female, Anime", exact: true }).click();
      await expect(page.getByLabel("Style filter", { exact: true })).toBeHidden();
    } else {
      await expect(page.getByLabel("Gender filter", { exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("01-discover.png") });

    await page.goto("/chat");
    const current = page.getByTestId("chat-hub-session").filter({ hasText: "Mira" });
    await expect(current).toContainText("Shall we continue our walk through the garden?");
    await expect(current.getByTestId("chat-hub-continue")).toHaveText("Continue chat");
    await expect(current).toHaveAttribute("href", "/chat/pm-current");
    const archived = page.getByTestId("chat-hub-session").filter({ hasText: "An earlier story" });
    await expect(archived).toBeHidden();
    await page.getByText("Archived chats (1)", { exact: true }).click();
    await expect(archived).toBeVisible();
    await expect(archived).toHaveAttribute("href", "/chat/pm-archived");
    await page.getByText("Archived chats (1)", { exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("02-return.png") });

    await page.goto("/upgrade?returnTo=%2Fchat%2Fpm-current");
    await page.getByRole("button", { name: "Monthly", exact: true }).click();
    await expect(page.getByRole("article")).toHaveCount(2);
    await expect(page.getByRole("article", { name: "Premium monthly", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Yearly", exact: true }).click();
    await expect(page.getByRole("article")).toHaveCount(2);
    await expect(page.getByRole("article", { name: "Premium yearly", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Yearly", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("article", { name: "Premium yearly", exact: true })).toBeVisible();
    await expect(page.getByTestId("upgrade-return-link")).toHaveAttribute("href", "/chat/pm-current");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("03-upgrade.png"), fullPage: true });

    const model = { id: "pm-image", label: "Image", maxCount: 1, costMultiplier: 1, entitlement: null };
    await page.route("**/api/v1/generation/config", route => route.fulfill({ contentType: "application/json", body: ok({
      viewer: { authenticated: true, scope: "user:pm-viewer" }, entitlements: { premium_controls: false }, dreamcoins: { balance: 100 },
      pricing: { image: { baseCost: 5, maxCount: 1 }, video: { baseCost: null } },
      image: { availability: { state: "available" }, models: [model], orientations: ["4:5"], editModels: [],
        recipes: ["character", "freeplay"].map(useCase => ({ id: `image-${useCase}`, rowId: `image-${useCase}-v1`, label: "Image", mode: "image", useCase, version: 1 })) },
      video: { enabled: false, availability: { state: "unavailable", reason: "feature_disabled" }, models: [], requiredEntitlement: "video_generation" },
    }) }));
    await page.route("**/api/v1/generation/quote", route => route.fulfill({ contentType: "application/json", body: ok({ quote: {
      mode: "image", profileId: model.id, profileVersion: 1, routeFingerprint: "a".repeat(64),
      pricing: { ruleId: "image-price", ruleKey: "image", version: 1, effectiveFrom: null, fingerprint: "b".repeat(64) },
      orientations: ["4:5"], defaultOrientation: "4:5", maxCount: 1, costs: [{ outputCount: 1, costDreamcoins: 5 }], balance: 100, identityLocked: false,
    } }) }));
    await page.route("**/api/v1/generation/presets**", route => route.fulfill({ contentType: "application/json", body: ok({ items: [] }) }));
    await page.route("**/api/v1/generation/jobs?**", route => route.fulfill({ contentType: "application/json", body: ok({ items: [], nextCursor: null }) }));
    await page.route("**/api/v1/media?**", route => route.fulfill({ contentType: "application/json", body: ok({ items: [], nextCursor: null }) }));
    await page.goto("/generate");
    await expect(page.getByRole("button", { name: "Quiet morning", exact: true })).toBeEnabled();
    if (viewport.width >= 768) await expect(page.getByText("Unauthorized", { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("04-generate.png"), fullPage: true });
    await page.getByRole("button", { name: "Quiet morning", exact: true }).click();
    const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
    await expect(prompt).toHaveValue(/sunlit kitchen/);
    await expect(prompt).toBeFocused();
    await prompt.fill("A quiet balcony at dawn");
    await expect(page.getByRole("button", { name: "Quiet morning", exact: true })).toHaveCount(0);
    await expect(prompt).toHaveValue("A quiet balcony at dawn");
    expect(writes).toEqual([]);
    await writeFile(testInfo.outputPath("verification.json"), JSON.stringify({ sourceRevision: process.env.IDREAM_SOURCE_REVISION, viewport, firstCardTop, writes, scope: "fixture UI only; no provider, payment or retention claim" }, null, 2));
  });
}
