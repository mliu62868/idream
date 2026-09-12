import { expect, test } from "@playwright/test";

// The browser renders the real Chat component and CSS. Every API is intercepted:
// this layout regression must never create a user, Turn or model request.
for (const viewport of [{ width: 1291, height: 745 }, { width: 390, height: 844 }]) {
  test(`chat auto-follow keeps reply actions above the composer at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let regeneratePosts = 0;
    const messages: Record<string, unknown>[] = [
      { id: "opening:layout", role: "assistant", content: "Welcome back to the rainy cafe.", opening: true, status: "sent" },
      { id: "user-layout", role: "user", content: "Stay here a little longer, beside the rain-streaked window. Tell me one small thing you notice while we wait for the rain to stop.", status: "sent" },
      { id: "assistant-layout", role: "assistant", content: "A drop of rain catches the window light, then slides slowly toward your blue notebook. I lean a little closer, happy to sit here with you.", status: "sent", replyToMessageId: "user-layout", attempt: 1, attachments: [] },
    ];
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      let body: unknown = { ok: true, data: {} };
      let status = 200;
      if (pathname === "/api/v1/me") body = { ok: true, data: { user: { id: "layout-user", email: "layout@example.invalid", displayName: "Layout", image: null }, ageGate: { accepted: true }, entitlements: {}, dreamcoins: { balance: 0 } } };
      if (pathname === "/api/v1/announcements") body = { ok: true, data: { items: [] } };
      if (pathname === "/api/v1/chat/sessions/layout-proof") body = { ok: true, data: { session: { id: "layout-proof", ownerScope: "user:layout-user", title: "Layout proof", characterId: "layout-character", memoryEnabled: false, messages, character: { name: "Mira", canUpdateIdentity: false } } } };
      if (pathname === "/api/v1/chat/sessions/layout-proof/experience") body = { settings: { responseLength: "short", interactionIntensity: "gentle", sceneGeneration: "follow", version: 1 }, editable: true };
      if (pathname === "/api/v1/chat/sessions/layout-proof/messages" && request.method() === "POST") {
        const userMessage = { id: "user-new", role: "user", content: "Another quiet moment?", status: "sent" };
        const assistant = { id: "assistant-new", role: "assistant", content: "Only the soft patter of rain.", status: "sent", replyToMessageId: "user-new", attempt: 1, attachments: [] };
        messages.push(userMessage, assistant);
        body = { ok: true, data: { userMessage, assistant, streamUrl: null } };
        status = 202;
      }
      if (pathname === "/api/v1/messages/assistant-new/regenerate") {
        regeneratePosts += 1;
        body = { assistantMessageId: "assistant-new", status: "sent", attempt: 2, streamUrl: null };
        status = 202;
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/chat/layout-proof");
    await page.getByText("Conversation preferences", { exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Reply length" })).toBeEnabled();
    // A reader returns to the latest exchange before sending. Opening settings
    // alone must not force-scroll them away from the controls they are editing.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight - scrollY)).toBeLessThanOrEqual(120);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Another quiet moment?");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Only the soft patter of rain.", { exact: true })).toBeVisible();
    const regenerate = page.getByRole("button", { name: "Regenerate reply" }).last();
    // DOM visibility alone misses an enabled button hidden beneath sticky UI.
    await expect.poll(() => regenerate.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const composer = document.querySelector('input[aria-label="Message"]')?.closest("form")?.getBoundingClientRect();
      return Boolean(hit && button.contains(hit) && composer && rect.bottom < composer.top);
    })).toBe(true);
    const rect = await regenerate.boundingBox();
    expect(rect).not.toBeNull();
    const response = page.waitForResponse((reply) => reply.request().method() === "POST" && new URL(reply.url()).pathname === "/api/v1/messages/assistant-new/regenerate");
    await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
    expect((await response).status()).toBe(202);
    expect(regeneratePosts).toBe(1);
  });
}
