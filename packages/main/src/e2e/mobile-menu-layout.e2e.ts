import { expect, test } from "@playwright/test";

test("mobile navigation remains reachable and dismissible in a short landscape viewport", async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await page.request.post("/api/v1/age-gate/accept", { data: { sourcePath: "/generate" } });
  await page.goto("/generate");
  const button = page.getByRole("button", { name: "Open navigation menu" });
  await button.click();
  const nav = page.getByRole("navigation", { name: "App navigation" });
  const lastLink = nav.getByRole("link", { name: "Upgrade", exact: true });
  await lastLink.focus();
  // Focusing the final item must scroll the menu, leaving the link above the
  // fixed bottom navigation rather than merely present in the accessibility tree.
  await expect.poll(() => lastLink.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const bottomNav = document.querySelector('[aria-label="Primary mobile navigation"]')!.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.top >= 0 && rect.bottom <= bottomNav.top && Boolean(hit && element.contains(hit));
  })).toBe(true);
  await page.keyboard.press("Escape");
  await expect(nav).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");
});
