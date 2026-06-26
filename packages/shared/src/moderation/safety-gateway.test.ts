import { describe, expect, it, vi } from "vitest";
import { SafetyGatewayModerationProvider } from "./safety-gateway";

describe("SafetyGatewayModerationProvider", () => {
  it("posts text content to the default moderation endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "passed",
        confidence: 0.42,
      }),
    );
    const provider = new SafetyGatewayModerationProvider({
      serviceUrl: "https://safety.internal.example.com",
      apiKey: "moderation-api-key",
      fetchImpl: fetchMock,
    });

    const result = await provider.check({
      targetType: "text",
      content: "safe prompt",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        status: "passed",
        confidence: 0.42,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://safety.internal.example.com/moderation/check"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer moderation-api-key",
          "content-type": "application/json",
        }),
        body: expect.stringContaining('"targetType":"text"'),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("maps gateway block decisions to policy codes", async () => {
    const provider = new SafetyGatewayModerationProvider({
      serviceUrl: "https://safety.internal.example.com/v1/check",
      fetchImpl: vi.fn(async () =>
        Response.json({
          decision: "block",
          policy_code: "UNDERAGE",
          score: 0.98,
        }),
      ),
    });

    await expect(
      provider.check({ targetType: "text", content: "bad prompt" }),
    ).resolves.toEqual({
      ok: true,
      data: {
        status: "blocked",
        policyCode: "UNDERAGE",
        confidence: 0.98,
      },
    });
  });

  it("accepts boolean flagged responses", async () => {
    const provider = new SafetyGatewayModerationProvider({
      serviceUrl: "https://safety.internal.example.com",
      fetchImpl: vi.fn(async () =>
        Response.json({
          flagged: true,
          categories: ["REAL_PERSON"],
        }),
      ),
    });

    await expect(
      provider.check({ targetType: "image", content: "media://asset-1" }),
    ).resolves.toEqual({
      ok: true,
      data: {
        status: "flagged",
        policyCode: "REAL_PERSON",
        confidence: 0.9,
      },
    });
  });

  it("parses OpenAI-compatible moderation responses", async () => {
    const provider = new SafetyGatewayModerationProvider({
      serviceUrl: "https://safety.internal.example.com",
      fetchImpl: vi.fn(async () =>
        Response.json({
          results: [
            {
              flagged: true,
              categories: { sexual_minors: true },
              category_scores: { sexual_minors: 0.96 },
            },
          ],
        }),
      ),
    });

    await expect(
      provider.check({ targetType: "text", content: "bad prompt" }),
    ).resolves.toEqual({
      ok: true,
      data: {
        status: "flagged",
        policyCode: "sexual_minors",
        confidence: 0.96,
      },
    });
  });

  it("maps transient gateway failures to retryable provider errors", async () => {
    const provider = new SafetyGatewayModerationProvider({
      serviceUrl: "https://safety.internal.example.com",
      fetchImpl: vi.fn(async () =>
        Response.json(
          { error: { code: "overloaded", message: "safety queue is full" } },
          { status: 503 },
        ),
      ),
    });

    await expect(
      provider.check({ targetType: "text", content: "prompt" }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "overloaded",
        message: "safety queue is full",
        retryable: true,
      },
    });
  });

  it("rejects malformed success responses as retryable provider errors", async () => {
    const provider = new SafetyGatewayModerationProvider({
      serviceUrl: "https://safety.internal.example.com",
      fetchImpl: vi.fn(async () => Response.json({ ok: true })),
    });

    await expect(
      provider.check({ targetType: "text", content: "prompt" }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid_moderation_response",
        message: "Moderation response did not include a supported decision",
        retryable: true,
      },
    });
  });
});
