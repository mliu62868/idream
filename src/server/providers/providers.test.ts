import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "./index";

describe("mock providers", () => {
  it("returns deterministic mock provider results", async () => {
    const registry = createProviderRegistry();

    const image = await registry.image.generate({
      prompt: "portrait",
      count: 2,
      seed: "fixed",
    });
    const moderation = await registry.moderation.check({
      targetType: "text",
      content: "safe prompt",
    });
    const payment = await registry.payment.createInvoice({
      userId: "user-1",
      amountCents: 1999,
      currency: "usd",
    });

    expect(image).toEqual({
      ok: true,
      data: {
        assets: [
          { key: "mock/images/fixed-1.png", width: 1024, height: 1024 },
          { key: "mock/images/fixed-2.png", width: 1024, height: 1024 },
        ],
      },
    });
    expect(moderation).toMatchObject({
      ok: true,
      data: { status: "passed" },
    });
    expect(payment).toMatchObject({
      ok: true,
      data: {
        provider: "mock",
        invoiceId: "mock-invoice-user-1-1999-usd",
      },
    });
  });
});
