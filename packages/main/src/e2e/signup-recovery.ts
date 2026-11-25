import { expect, type Page } from "@playwright/test";

export async function completeSignupRecoveryCode(page: Page) {
  await expect(page.getByRole("heading", { name: "Save your recovery code" })).toBeVisible();
  const code = page.getByTestId("account-recovery-code");
  await expect(code).toHaveText(/\S{20,}/);
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(code).toBeHidden();
}
