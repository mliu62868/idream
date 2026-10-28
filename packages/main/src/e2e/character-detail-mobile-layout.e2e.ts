import { expect, test } from "@playwright/test";

test("long character names remain readable and actions usable on a phone", async ({ page }) => {
  const name = "AlexandriatheStargazingCartographer";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/characters/melissa-burke" },
  });
  // Exercise the real detail renderer with a valid long name without changing
  // the seeded character or depending on a pre-existing private draft.
  await page.route("**/api/v1/characters/melissa-burke", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.character.name = name;
    payload.data.character.title = name;
    await route.fulfill({ response, json: payload });
  });
  await page.goto("/characters/melissa-burke");
  const heading = page.getByRole("heading", { name, exact: true });
  await expect(heading).toBeVisible();
  // DOM visibility alone does not notice text painted outside the hero's
  // overflow-hidden boundary. Check each rendered glyph fragment instead.
  const clipped = await heading.evaluate((element) => {
    const boundary = element.closest('[data-testid="character-detail-renderer"]')!.getBoundingClientRect();
    const text = element.firstChild!;
    const range = document.createRange();
    for (let index = 0; index < text.textContent!.length; index += 1) {
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const rect = range.getBoundingClientRect();
      if (rect.left < boundary.left - 1 || rect.right > boundary.right + 1) return true;
    }
    return false;
  });
  expect(clipped).toBe(false);
  await expect(page.getByTestId("character-detail-actions").getByRole("button", { name: "Chat" })).toBeVisible();
});
