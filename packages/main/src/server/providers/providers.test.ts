import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRegistry } from "./index";
import { paymentProviderCapabilities } from "./payment/capabilities";
import type { BlobStore } from "./types";
import { PipelineVoiceModel } from "./voice/pipeline";

const oldEnv = { ...process.env };

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env = { ...oldEnv };
});

describe("mock providers", () => {
  it("fails closed for an unknown persisted payment provider", () => {
    expect(paymentProviderCapabilities("legacy-processor")).toEqual({
      billingModel: "unknown",
      renewalCapability: "none",
    });
  });

  it("returns deterministic mock provider results", async () => {
    const registry = createProviderRegistry();

    const image = await registry.image.generate({
      prompt: "portrait",
      count: 2,
      seed: "fixed",
    });
    const repeatedImage = await registry.image.generate({
      prompt: "portrait",
      count: 2,
      seed: "fixed",
    });
    const moderation = await registry.moderation.check({
      targetType: "text",
      content: "safe prompt",
    });
    const payment = await registry.payment.createInvoice({
      orderId: "checkout-1",
      userId: "user-1",
      amountCents: 1999,
      currency: "usd",
    });

    expect(image).toMatchObject({
      ok: true,
      data: {
        assets: [
          {
            key: "mock/images/fixed-1.png",
            width: 256,
            height: 320,
            contentType: "image/png",
            body: expect.any(Uint8Array),
          },
          {
            key: "mock/images/fixed-2.png",
            width: 256,
            height: 320,
            contentType: "image/png",
            body: expect.any(Uint8Array),
          },
        ],
      },
    });
    expect(repeatedImage).toEqual(image);
    expect(moderation).toMatchObject({
      ok: true,
      data: { status: "passed" },
    });
    expect(payment).toMatchObject({
      ok: true,
      data: {
        provider: "mock",
        invoiceId: "mock-invoice-checkout-1",
      },
    });
    expect(registry.payment.capabilities).toEqual({
      billingModel: "prepaid_period",
      renewalCapability: "none",
    });
  });

  it("rejects production startup when launch-critical providers are still mock", async () => {
    vi.resetModules();
    process.env = {
      ...oldEnv,
      APP_ENV: "production",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/idream",
      BETTER_AUTH_URL: "https://ourdream.ai",
      MAIN_WEB_URL: "https://ourdream.ai",
      BETTER_AUTH_SECRET: "production-secret-please-change-0123456789abcdef",
      INTERNAL_TOKEN: "production-internal-token-0123456789",
      CRON_SECRET: "production-cron-token-0123456789",
      CHAT_SERVICE_URL: "https://chat.internal.example",
      CHAT_BFF_SIGNING_SECRET: "production-bff-secret-0123456789abcdef",
      ADMIN_BFF_SIGNING_SECRET: "production-admin-bff-secret-0123456789abcdef",
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

  it("rejects production startup when IMAGE_PROVIDER is still mock", async () => {
    vi.resetModules();
    process.env = {
      ...oldEnv,
      APP_ENV: "production",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/idream",
      BETTER_AUTH_URL: "https://ourdream.ai",
      MAIN_WEB_URL: "https://ourdream.ai",
      BETTER_AUTH_SECRET: "production-secret-please-change-0123456789abcdef",
      INTERNAL_TOKEN: "production-internal-token-0123456789",
      CRON_SECRET: "production-cron-token-0123456789",
      CHAT_SERVICE_URL: "https://chat.internal.example",
      CHAT_BFF_SIGNING_SECRET: "production-bff-secret-0123456789abcdef",
      ADMIN_BFF_SIGNING_SECRET: "production-admin-bff-secret-0123456789abcdef",
      // All launch-critical providers are real except image — image must still be
      // rejected so main's finalizer cannot write placeholder PNGs in production.
      CHAT_PROVIDER: "pipeline",
      PIPELINE_API_URL: "https://pipeline.internal.example.com/v1",
      PIPELINE_API_TOKEN: "production-pipeline-token-0123456789",
      IMAGE_PROVIDER: "mock",
      VOICE_PROVIDER: "pipeline",
      MODERATION_PROVIDER: "safety-gateway",
      MODERATION_SERVICE_URL: "https://safety.internal.example.com",
      MODERATION_API_KEY: "production-moderation-key-0123456789",
      PAYMENT_PROVIDER: "btcpay",
      BTCPAY_BASE_URL: "https://btcpay.example.com",
      BTCPAY_STORE_ID: "store-1",
      BTCPAY_API_KEY: "btcpay-api-key-0123456789",
      BTCPAY_WEBHOOK_SECRET: "btcpay-webhook-secret-0123456789",
      BLOB_PROVIDER: "r2",
      BLOB_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      BLOB_BUCKET: "private-media",
      BLOB_ACCESS_KEY_ID: "access-key",
      BLOB_SECRET_ACCESS_KEY: "secret-key",
      AGE_VERIFICATION_PROVIDER: "gocam",
      AGE_VERIFY_SERVICE_URL: "https://age.internal.example.com",
      AGE_VERIFY_API_KEY: "age-api-key-0123456789",
      AGE_VERIFY_WEBHOOK_SECRET: "age-webhook-secret-0123456789",
      AGE_VERIFY_LINK_BACK_URL: "https://ourdream.ai/age-verification/return",
      AGE_VERIFY_CALLBACK_URL: "https://ourdream.ai/api/v1/age-verification/webhooks/gocam",
    };

    await expect(import("./index")).rejects.toThrow(
      /Production requires non-mock providers:.*IMAGE_PROVIDER/,
    );
  });

  it("parses IMAGE_PROVIDER=backend without throwing (P1 gen backend parity)", async () => {
    vi.resetModules();
    process.env = {
      ...oldEnv,
      IMAGE_PROVIDER: "backend",
      COMFYUI_API_URL: "http://127.0.0.1:8188",
    };

    // Import the env module directly (not the provider registry barrel): this
    // asserts the Zod schema itself accepts IMAGE_PROVIDER=backend, independent of
    // ./index's own separate provider-implementation wiring/validation.
    const { env } = await import("../lib/env");

    expect(env.IMAGE_PROVIDER).toBe("backend");
    expect(env.COMFYUI_API_URL).toBe("http://127.0.0.1:8188");
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

  it("rejects production startup when Better Auth uses IPv6 loopback", async () => {
    vi.resetModules();
    process.env = {
      ...oldEnv,
      APP_ENV: "production",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/idream",
      BETTER_AUTH_URL: "https://[::1]:3000",
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
          status: "New",
          additionalStatus: "None",
          amount: "9.99",
          currency: "USD",
          metadata: { orderId: "checkout-1" },
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
      orderId: "checkout-1",
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
        additionalStatus: "none",
        orderId: "checkout-1",
        amountCents: 999,
        currency: "usd",
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

  it("passes reference images to the pipeline image provider", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ b64_json: Buffer.from("image-bytes", "utf8").toString("base64") }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      IMAGE_PROVIDER: "pipeline",
      PIPELINE_API_URL: "https://pipeline.internal.example.com",
      PIPELINE_IMAGE_MODEL_DEFAULT: "image-model",
    };

    const { createProviderRegistry: createFreshRegistry } = await import("./index");
    const registry = createFreshRegistry();
    const image = await registry.image.generate({
      prompt: "portrait",
      count: 1,
      referenceImages: [
        {
          assetId: "anchor-1",
          role: "identity_anchor",
          contentType: "image/webp",
          width: 1024,
          height: 1280,
          weight: 1.25,
          b64Json: Buffer.from("reference-image", "utf8").toString("base64"),
        },
      ],
    });

    const firstCall = fetchMock.mock.calls[0] as unknown as
      | [Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]]
      | undefined;
    if (!firstCall) throw new Error("fetch was not called");
    const [, init] = firstCall;
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.reference_images).toEqual([
      expect.objectContaining({
        assetId: "anchor-1",
        asset_id: "anchor-1",
        role: "identity_anchor",
        weight: 1.25,
        b64_json: Buffer.from("reference-image", "utf8").toString("base64"),
      }),
    ]);
    expect(image.ok).toBe(true);
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
      PIPELINE_VOICE_API_URL: "https://moss-tts.internal.example.com/v1",
      PIPELINE_API_TOKEN: "pipeline-token",
      PIPELINE_VOICE_API_TOKEN: "voice-token",
      PIPELINE_VOICE_MODEL_DEFAULT: "voice-model",
    };

    const { createProviderRegistry: createFreshRegistry } = await import("./index");
    const registry = createFreshRegistry();
    const result = await registry.voice.synthesize({
      text: "hello",
      voiceId: "mel",
      tone: "Warm and intimate",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        key: "voice/result.mp3",
        durationMs: 1234,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://moss-tts.internal.example.com/v1/audio/speech"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer voice-token",
        }),
        body: expect.stringContaining('"voice":"mel"'),
      }),
    );
    // Local OpenAI-compatible TTS gateways can accept `instructions` but produce
    // degraded audio, so tone is not sent unless the deployment opts in.
    const voiceBody = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]?.[1]?.body;
    expect(voiceBody).not.toContain("instructions");
  });

  it("can opt into pipeline voice instructions for gateways that support them", async () => {
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
      PIPELINE_VOICE_API_URL: "https://moss-tts.internal.example.com/v1",
      PIPELINE_API_TOKEN: "pipeline-token",
      PIPELINE_VOICE_API_TOKEN: "voice-token",
      PIPELINE_VOICE_MODEL_DEFAULT: "voice-model",
      PIPELINE_VOICE_SEND_INSTRUCTIONS: "true",
    };

    const { createProviderRegistry: createFreshRegistry } = await import("./index");
    const registry = createFreshRegistry();
    await registry.voice.synthesize({
      text: "hello",
      voiceId: "mel",
      tone: "Warm and intimate",
    });

    const voiceBody = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]?.[1]?.body;
    expect(voiceBody).toContain('"instructions":"Warm and intimate"');
  });

  it("uses the voice-specific pipeline timeout for slow TTS", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      VOICE_PROVIDER: "pipeline",
      PIPELINE_API_URL: "https://pipeline.internal.example.com/v1",
      PIPELINE_VOICE_API_URL: "https://moss-tts.internal.example.com/v1",
      PIPELINE_API_TOKEN: "pipeline-token",
      PIPELINE_VOICE_API_TOKEN: "voice-token",
      PIPELINE_VOICE_MODEL_DEFAULT: "voice-model",
      PIPELINE_TIMEOUT_MS: "60000",
      PIPELINE_VOICE_TIMEOUT_MS: "300",
    };

    const { createProviderRegistry: createFreshRegistry } = await import("./index");
    const registry = createFreshRegistry();
    const started = Date.now();
    const result = await registry.voice.synthesize({ text: "slow voice", voiceId: "mel" });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "voice_timeout" },
    });
  });

  it("omits the voice instructions field when no tone is provided", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
    );
    const blob: BlobStore = {
      async putPrivate(input) {
        return { ok: true, data: { key: input.key, size: input.body.byteLength } };
      },
      async signGetUrl() {
        return { ok: true, data: { url: "https://cdn.example.com/voice.mp3" } };
      },
      async delete() {
        return { ok: true, data: { deleted: true } };
      },
    };
    const voice = new PipelineVoiceModel({
      baseUrl: "https://moss-tts.internal.example.com/v1",
      apiKey: "voice-token",
      model: "voice-model",
      blob,
      fetchImpl: fetchMock,
    });

    await voice.synthesize({ text: "hello", voiceId: "mel" });

    const voiceBody = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]?.[1]?.body as string;
    expect(voiceBody).not.toContain("instructions");
  });

  it("stores binary pipeline voice responses with an extension matching the content type", async () => {
    const audio = wavBytes(1_000);
    const fetchMock = vi.fn(async () =>
      new Response(audio, {
        headers: {
          "content-type": "audio/wav",
        },
      }),
    );
    const stored: Array<{ key: string; body: Uint8Array; contentType: string }> = [];
    const blob: BlobStore = {
      async putPrivate(input) {
        stored.push({
          key: input.key,
          body: input.body,
          contentType: input.contentType,
        });
        return { ok: true, data: { key: input.key, size: input.body.byteLength } };
      },
      async signGetUrl() {
        return { ok: true, data: { url: "https://cdn.example.com/voice.wav" } };
      },
      async delete() {
        return { ok: true, data: { deleted: true } };
      },
    };
    const voice = new PipelineVoiceModel({
      baseUrl: "https://moss-tts.internal.example.com/v1",
      apiKey: "voice-token",
      model: "voice-model",
      blob,
      fetchImpl: fetchMock,
    });

    const result = await voice.synthesize({
      text: "hello",
      voiceId: "serena",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.key).toMatch(/^voice\/.+\.wav$/);
      expect(result.data.durationMs).toBe(1_000);
    }
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      contentType: "audio/wav",
    });
    expect(stored[0]?.key).toMatch(/^voice\/.+\.wav$/);
    expect(Array.from(stored[0]?.body ?? [])).toEqual(Array.from(audio));
  });

  it("splits long pipeline voice prompts and stores a merged WAV", async () => {
    const audio = wavBytes(1_000);
    const fetchMock = vi.fn(async () =>
      new Response(audio, {
        headers: {
          "content-type": "audio/wav",
        },
      }),
    );
    const stored: Array<{ key: string; body: Uint8Array; contentType: string }> = [];
    const blob: BlobStore = {
      async putPrivate(input) {
        stored.push({
          key: input.key,
          body: input.body,
          contentType: input.contentType,
        });
        return { ok: true, data: { key: input.key, size: input.body.byteLength } };
      },
      async signGetUrl() {
        return { ok: true, data: { url: "https://cdn.example.com/voice.wav" } };
      },
      async delete() {
        return { ok: true, data: { deleted: true } };
      },
    };
    const voice = new PipelineVoiceModel({
      baseUrl: "https://moss-tts.internal.example.com/v1",
      apiKey: "voice-token",
      model: "voice-model",
      maxInputCharsPerRequest: 45,
      blob,
      fetchImpl: fetchMock,
    });

    const result = await voice.synthesize({
      text: "Oh, sweetie... That is clear. Second sentence is also clear and short.",
      voiceId: "serena",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requests = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>).map(
      ([, init]) => {
        const body = JSON.parse(String(init.body)) as { input: string; response_format: string };
        return { input: body.input, response_format: body.response_format };
      },
    );
    expect(requests).toEqual([
      { input: "Oh, sweetie.", response_format: "wav" },
      { input: "That is clear.", response_format: "wav" },
      { input: "Second sentence is also clear and short.", response_format: "wav" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.key).toMatch(/^voice\/.+\.wav$/);
      expect(result.data.durationMs).toBe(3_360);
    }
    expect(stored).toHaveLength(1);
    expect(stored[0]?.contentType).toBe("audio/wav");
    expect(Buffer.from(stored[0]?.body ?? []).subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("trims overlong pipeline voice prompts at sentence boundaries before synthesis", async () => {
    const audio = wavBytes(1_000);
    const fetchMock = vi.fn(async () =>
      new Response(audio, {
        headers: {
          "content-type": "audio/wav",
        },
      }),
    );
    const blob: BlobStore = {
      async putPrivate(input) {
        return { ok: true, data: { key: input.key, size: input.body.byteLength } };
      },
      async signGetUrl() {
        return { ok: true, data: { url: "https://cdn.example.com/voice.wav" } };
      },
      async delete() {
        return { ok: true, data: { deleted: true } };
      },
    };
    const voice = new PipelineVoiceModel({
      baseUrl: "https://moss-tts.internal.example.com/v1",
      apiKey: "voice-token",
      model: "voice-model",
      maxInputChars: 24,
      maxInputCharsPerRequest: 0,
      blob,
      fetchImpl: fetchMock,
    });

    const result = await voice.synthesize({
      text: "First sentence fits. Second sentence should be dropped. Third sentence should also be dropped.",
      voiceId: "serena",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>).map(
      ([, init]) => JSON.parse(String(init.body)) as { input: string },
    )[0];
    expect(request?.input).toBe("First sentence fits.");
    expect(result.ok).toBe(true);
  });

  it("defaults pipeline voice to max-length sentence trimming without chunking", async () => {
    const audio = wavBytes(1_000);
    const fetchMock = vi.fn(async () =>
      new Response(audio, {
        headers: {
          "content-type": "audio/wav",
        },
      }),
    );
    const blob: BlobStore = {
      async putPrivate(input) {
        return { ok: true, data: { key: input.key, size: input.body.byteLength } };
      },
      async signGetUrl() {
        return { ok: true, data: { url: "https://cdn.example.com/voice.wav" } };
      },
      async delete() {
        return { ok: true, data: { deleted: true } };
      },
    };
    const firstSentence = `${"steady ".repeat(100).trim()}.`;
    const secondSentence = `${"tail ".repeat(100).trim()}.`;
    const voice = new PipelineVoiceModel({
      baseUrl: "https://moss-tts.internal.example.com/v1",
      apiKey: "voice-token",
      model: "voice-model",
      blob,
      fetchImpl: fetchMock,
    });

    const result = await voice.synthesize({
      text: `${firstSentence} ${secondSentence}`,
      voiceId: "serena",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>).map(
      ([, init]) => JSON.parse(String(init.body)) as { input: string },
    )[0];
    expect(request?.input).toBe(firstSentence);
    expect(result.ok).toBe(true);
  });

  it("trims an overlong first sentence at clause boundaries", async () => {
    const audio = wavBytes(1_000);
    const fetchMock = vi.fn(async () =>
      new Response(audio, {
        headers: {
          "content-type": "audio/wav",
        },
      }),
    );
    const blob: BlobStore = {
      async putPrivate(input) {
        return { ok: true, data: { key: input.key, size: input.body.byteLength } };
      },
      async signGetUrl() {
        return { ok: true, data: { url: "https://cdn.example.com/voice.wav" } };
      },
      async delete() {
        return { ok: true, data: { deleted: true } };
      },
    };
    const voice = new PipelineVoiceModel({
      baseUrl: "https://moss-tts.internal.example.com/v1",
      apiKey: "voice-token",
      model: "voice-model",
      maxInputChars: 43,
      maxInputCharsPerRequest: 0,
      blob,
      fetchImpl: fetchMock,
    });

    const result = await voice.synthesize({
      text: "First clause fits, second clause would exceed the configured voice limit.",
      voiceId: "serena",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>).map(
      ([, init]) => JSON.parse(String(init.body)) as { input: string },
    )[0];
    expect(request?.input).toBe("First clause fits,");
    expect(result.ok).toBe(true);
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

function wavBytes(durationMs: number) {
  const sampleRate = 8_000;
  const channels = 1;
  const bitsPerSample = 16;
  const samples = Math.max(1, Math.floor((sampleRate * durationMs) / 1_000));
  const dataSize = samples * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buffer);
}
