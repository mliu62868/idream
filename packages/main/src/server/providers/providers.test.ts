import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRegistry } from "./index";

const oldEnv = { ...process.env };

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env = { ...oldEnv };
});

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

  it("rejects production startup when launch-critical providers are still mock", async () => {
    vi.resetModules();
    process.env = {
      ...oldEnv,
      APP_ENV: "production",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/idream",
      BETTER_AUTH_URL: "https://ourdream.ai",
      BETTER_AUTH_SECRET: "production-secret-please-change-0123456789abcdef",
      INTERNAL_TOKEN: "production-internal-token-0123456789",
      CRON_SECRET: "production-cron-token-0123456789",
      CHAT_SERVICE_URL: "https://chat.internal.example",
      CHAT_BFF_SIGNING_SECRET: "production-bff-secret-0123456789abcdef",
      CHAT_PROVIDER: "mock",
      VOICE_PROVIDER: "mock",
      MODERATION_PROVIDER: "mock",
      PAYMENT_PROVIDER: "mock",
      BLOB_PROVIDER: "mock",
      AGE_VERIFICATION_PROVIDER: "mock",
    };

    await expect(import("./index")).rejects.toThrow(
      /Production requires non-mock providers:.*BLOB_PROVIDER/,
    );
  });

  it("rejects production startup when Better Auth uses a localhost origin", async () => {
    vi.resetModules();
    process.env = {
      ...oldEnv,
      APP_ENV: "production",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/idream",
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "production-secret-please-change-0123456789abcdef",
      INTERNAL_TOKEN: "production-internal-token-0123456789",
      CRON_SECRET: "production-cron-token-0123456789",
      CHAT_SERVICE_URL: "https://chat.internal.example",
      CHAT_BFF_SIGNING_SECRET: "production-bff-secret-0123456789abcdef",
    };

    await expect(import("./index")).rejects.toThrow("BETTER_AUTH_URL");
  });

  it("can wire an S3-compatible blob provider for generated media storage", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      BLOB_PROVIDER: "r2",
      BLOB_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      BLOB_BUCKET: "private-media",
      BLOB_REGION: "auto",
      BLOB_ACCESS_KEY_ID: "access-key",
      BLOB_SECRET_ACCESS_KEY: "secret-key",
    };

    const { createProviderRegistry: createFreshRegistry } = await import("./index");
    const registry = createFreshRegistry();
    const put = await registry.blob.putPrivate({
      key: "images/user-1/result.webp",
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/webp",
    });
    const signed = await registry.blob.signGetUrl({
      key: "images/user-1/result.webp",
      expiresInSeconds: 60,
    });

    expect(put).toEqual({
      ok: true,
      data: { key: "images/user-1/result.webp", size: 3 },
    });
    expect(signed.ok).toBe(true);
    if (signed.ok) {
      expect(signed.data.url).toContain("X-Amz-Signature=");
      expect(signed.data.url).toContain("/private-media/images/user-1/result.webp");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("can wire BTCPay as the production payment provider", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
        void _input;
        void _init;
        return Response.json({
          id: "btcpay-invoice-1",
          checkoutLink: "https://btcpay.example.com/i/btcpay-invoice-1",
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      PAYMENT_PROVIDER: "btcpay",
      BTCPAY_BASE_URL: "https://btcpay.example.com",
      BTCPAY_STORE_ID: "store-1",
      BTCPAY_API_KEY: "api-key",
      BTCPAY_WEBHOOK_SECRET: "webhook-secret",
    };

    const { createProviderRegistry: createFreshRegistry } = await import("./index");
    const registry = createFreshRegistry();
    const invoice = await registry.payment.createInvoice({
      userId: "user-1",
      amountCents: 999,
      currency: "usd",
      metadata: { planId: "premium" },
    });

    expect(invoice).toEqual({
      ok: true,
      data: {
        provider: "btcpay",
        invoiceId: "btcpay-invoice-1",
        checkoutUrl: "https://btcpay.example.com/i/btcpay-invoice-1",
        status: "created",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("can wire the safety gateway moderation provider", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "blocked",
        policyCode: "UNDERAGE",
        confidence: 0.99,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      MODERATION_PROVIDER: "safety-gateway",
      MODERATION_SERVICE_URL: "https://safety.internal.example.com",
      MODERATION_API_KEY: "moderation-api-key",
    };

    const { createProviderRegistry: createFreshRegistry } = await import("./index");
    const registry = createFreshRegistry();
    const moderation = await registry.moderation.check({
      targetType: "text",
      content: "unsafe prompt",
    });

    expect(moderation).toEqual({
      ok: true,
      data: {
        status: "blocked",
        policyCode: "UNDERAGE",
        confidence: 0.99,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://safety.internal.example.com/moderation/check"),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer moderation-api-key",
        }),
      }),
    );
  });

  it("can wire the pipeline chat provider", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: "Pipeline hello" } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      CHAT_PROVIDER: "pipeline",
      PIPELINE_API_URL: "https://pipeline.internal.example.com/v1",
      PIPELINE_API_TOKEN: "pipeline-token",
      PIPELINE_CHAT_MODEL_DEFAULT: "chat-model",
    };

    const { createProviderRegistry: createFreshRegistry } = await import("./index");
    const registry = createFreshRegistry();
    const chunks = [];
    for await (const chunk of registry.chat.stream({
      messages: [{ role: "user", content: "hello" }],
      characterName: "Mel",
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { delta: "Pipeline hello", done: false },
      { delta: "", done: true },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://pipeline.internal.example.com/v1/chat/completions"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer pipeline-token",
        }),
        body: expect.stringContaining('"model":"chat-model"'),
      }),
    );
  });

  it("can wire the pipeline image provider", async () => {
    vi.resetModules();
    const png = Uint8Array.from([137, 80, 78, 71]);
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ b64_json: Buffer.from(png).toString("base64") }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      IMAGE_PROVIDER: "pipeline",
      PIPELINE_API_URL: "https://pipeline.internal.example.com",
      PIPELINE_API_TOKEN: "pipeline-token",
      PIPELINE_IMAGE_MODEL_DEFAULT: "image-model",
    };

    const { createProviderRegistry: createFreshRegistry } = await import("./index");
    const registry = createFreshRegistry();
    const image = await registry.image.generate({
      prompt: "portrait",
      count: 1,
      seed: "fixed",
      orientation: "1:1",
    });

    expect(image.ok).toBe(true);
    if (image.ok) {
      expect(image.data.assets[0]).toMatchObject({
        key: "pipeline/image-1.png",
        width: 1024,
        height: 1024,
        contentType: "image/png",
      });
      expect(Array.from(image.data.assets[0]?.body ?? [])).toEqual(Array.from(png));
    }
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://pipeline.internal.example.com/images/generations"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer pipeline-token",
        }),
        body: expect.stringContaining('"model":"image-model"'),
      }),
    );
  });

  it("can wire the pipeline voice provider", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () =>
      Response.json({
        key: "voice/result.mp3",
        durationMs: 1234,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      VOICE_PROVIDER: "pipeline",
      PIPELINE_API_URL: "https://pipeline.internal.example.com/v1",
      PIPELINE_API_TOKEN: "pipeline-token",
      PIPELINE_VOICE_MODEL_DEFAULT: "voice-model",
    };

    const { createProviderRegistry: createFreshRegistry } = await import("./index");
    const registry = createFreshRegistry();
    const result = await registry.voice.synthesize({
      text: "hello",
      voiceId: "mel",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        key: "voice/result.mp3",
        durationMs: 1234,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://pipeline.internal.example.com/v1/audio/speech"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer pipeline-token",
        }),
        body: expect.stringContaining('"voice":"mel"'),
      }),
    );
  });

  it("can wire Go.cam age verification through the gateway provider", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () =>
      Response.json({
        sessionId: "gocam-session-1",
        verificationUrl: "https://go.cam/verify/session-1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      AGE_VERIFICATION_PROVIDER: "gocam",
      AGE_VERIFY_SERVICE_URL: "https://age.internal.example.com",
      AGE_VERIFY_API_KEY: "age-api-key",
      AGE_VERIFY_WEBHOOK_SECRET: "age-webhook-secret",
      AGE_VERIFY_LINK_BACK_URL: "https://ourdream.ai/age-verification/return",
      AGE_VERIFY_CALLBACK_URL: "https://ourdream.ai/api/v1/age-verification/webhooks/gocam",
    };

    const { createProviderRegistry: createFreshRegistry } = await import("./index");
    const registry = createFreshRegistry();
    const result = await registry.ageVerification.createSession({
      userId: "user-1",
      jurisdiction: "GB",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        provider: "gocam",
        providerVerificationId: "gocam-session-1",
        status: "pending",
        url: "https://go.cam/verify/session-1",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://age.internal.example.com/sessions"),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer age-api-key",
        }),
        body: expect.stringContaining(
          '"linkBackUrl":"https://ourdream.ai/age-verification/return"',
        ),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        body: expect.stringContaining(
          '"callbackUrl":"https://ourdream.ai/api/v1/age-verification/webhooks/gocam"',
        ),
      }),
    );
  });

  it("rejects Go.cam provider startup without return and callback URLs", async () => {
    vi.resetModules();
    const missingUrlsEnv: NodeJS.ProcessEnv = {
      ...oldEnv,
      AGE_VERIFICATION_PROVIDER: "gocam",
      AGE_VERIFY_SERVICE_URL: "https://age.internal.example.com",
      AGE_VERIFY_API_KEY: "age-api-key",
      AGE_VERIFY_WEBHOOK_SECRET: "age-webhook-secret",
    };
    delete missingUrlsEnv.AGE_VERIFY_LINK_BACK_URL;
    delete missingUrlsEnv.AGE_VERIFY_CALLBACK_URL;
    process.env = missingUrlsEnv;

    await expect(import("./index")).rejects.toThrow(
      "AGE_VERIFY_LINK_BACK_URL is required when AGE_VERIFICATION_PROVIDER=gocam",
    );
  });
});
