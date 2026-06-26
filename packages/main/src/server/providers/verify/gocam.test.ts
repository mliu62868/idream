import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GoCamAgeVerificationProvider } from "./gocam";

function signature(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("GoCamAgeVerificationProvider", () => {
  it("creates a verification session through the age gateway", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        sessionId: "gocam-session-1",
        verificationUrl: "https://go.cam/verify/session-1",
        status: "pending",
      }),
    );
    const provider = new GoCamAgeVerificationProvider({
      serviceUrl: "https://age.internal.example.com",
      apiKey: "age-api-key",
      webhookSecret: "age-webhook-secret",
      linkBackUrl: "https://ourdream.ai/age-verification/return",
      callbackUrl: "https://ourdream.ai/api/v1/age-verification/webhooks/gocam",
      fetchImpl: fetchMock,
    });

    const result = await provider.createSession({
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
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer age-api-key",
        }),
        body: expect.stringContaining('"jurisdiction":"GB"'),
      }),
    );
  });

  it("parses signed verification callbacks", async () => {
    const provider = new GoCamAgeVerificationProvider({
      serviceUrl: "https://age.internal.example.com",
      apiKey: "age-api-key",
      webhookSecret: "age-webhook-secret",
      fetchImpl: vi.fn(),
    });
    const rawBody = JSON.stringify({
      sessionId: "gocam-session-1",
      userData: "user-1",
      state: "verified",
    });

    await expect(
      provider.parseWebhook({
        providerEventId: "fallback-event",
        rawBody,
        payload: JSON.parse(rawBody) as unknown,
        signature: signature("age-webhook-secret", rawBody),
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        providerEventId: "gocam-session-1",
        userId: "user-1",
        providerVerificationId: "gocam-session-1",
        status: "verified",
      },
    });
  });

  it("rejects unsigned verification callbacks", async () => {
    const provider = new GoCamAgeVerificationProvider({
      serviceUrl: "https://age.internal.example.com",
      apiKey: "age-api-key",
      webhookSecret: "age-webhook-secret",
      fetchImpl: vi.fn(),
    });

    await expect(
      provider.parseWebhook({
        providerEventId: "event-1",
        rawBody: "{}",
        payload: {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid_signature",
        message: "Go.cam age webhook signature is required",
        retryable: false,
      },
    });
  });
});
