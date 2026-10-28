import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 390, height: 844 }, { width: 1200, height: 755 }]) {
  test(`gallery image remains clickable with feedback at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const age = await page.request.post("/api/v1/age-gate/accept", { data: { sourcePath: "/generate" } });
    expect(age.ok()).toBe(true);
    const signup = await page.request.post("/api/v1/auth/signup", { data: {
      email: `gallery-hit-${viewport.width}-${Date.now()}@example.test`,
      password: "Gallery-test-password-2026!", name: "Gallery hit test",
    } });
    expect(signup.ok()).toBe(true);
    await page.route("**/api/v1/media?*", async (route) => {
      const response = await route.fetch();
      const url = new URL(route.request().url());
      if (url.searchParams.get("type") !== "image") return route.fulfill({ response });
      const payload = await response.json();
      payload.data.items = [{
        id: "gallery-hit-test", type: "image", url: "/images/ourdream/card-melissa-burke.webp",
        thumbnailUrl: "/images/ourdream/card-melissa-burke.webp", prompt: "Test image", liked: false,
        intentFeedbackAvailable: true, provenance: { sourceType: "variation", label: "Variation" },
      }];
      payload.data.nextCursor = null;
      await route.fulfill({ response, json: payload });
    });
    await page.goto("/generate");
    if (viewport.width < 1024) await page.getByRole("button", { name: "Gallery", exact: true }).click();
    const card = page.locator('[data-testid="gallery-media-card"][data-media-id="gallery-hit-test"]');
    const preview = card.getByRole("button", { name: "View image larger" });
    const feedback = card.getByRole("button", { name: "Report intent mismatch" });
    await expect(preview).toBeVisible();
    await expect(feedback).toBeVisible();
    await preview.scrollIntoViewIfNeeded();
    // A visible element can still be obstructed by another button at its centre.
    const centreIsPreview = await preview.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element;
    });
    expect(centreIsPreview).toBe(true);
    await preview.click();
    await expect(page.getByRole("dialog", { name: "Image creation" })).toBeVisible();
    await page.getByRole("dialog", { name: "Image creation" }).getByRole("button", { name: "Close" }).click();
    await feedback.click();
    await expect(page.getByRole("textbox", { name: "Correction direction" })).toBeVisible();
  });
}
