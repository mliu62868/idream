import { describe, expect, it, vi } from "vitest";
import { canonicalJsonHash } from "./modules/admin-v2/shared/idempotency";
import type { AgeAuthorityReader } from "./probe-age-verification";
import { runProbe } from "./probe-age-verification";

const callbackUrl = "https://ourdream.ai/api/v1/age-verification/webhooks/gocam";
const linkBackUrl = "https://ourdream.ai/age-verification/return";
const payload = {
  sessionId: "gocam-session-1",
  userData: "user-1",
  state: "verified",
};

function passingReader(deliveryCount = 2): AgeAuthorityReader {
  return {
    findVerification: vi.fn(async () => ({
      id: "age-row-1",
      userId: "user-1",
      provider: "gocam",
      providerVerificationId: "gocam-session-1",
      status: "verified",
      jurisdiction: "US",
      verifiedAt: new Date("2026-08-11T20:00:00.000Z"),
      metadata: {
        callbackUrl,
        linkBackUrl,
        sessionUrl: "https://go.cam/verify/gocam-session-1",
      },
    })),
    countVerificationEffects: vi.fn(async () => 1),
    findProviderEvents: vi.fn(async ({ targetHash }) => [
      {
        id: "event-row-1",
        providerEventId: "gocam-session-1",
        type: "age.verification",
        payload,
        targetHash,
        processedAt: new Date("2026-08-11T20:00:01.000Z"),
        deliveries: Array.from({ length: deliveryCount }, (_, index) => ({
          deliveryId: `delivery-${index + 1}`,
          payload,
          payloadHash: canonicalJsonHash(payload),
        })),
      },
    ]),
  };
}

describe("probe-age-verification", () => {
  it("audits one real verified product intent and two independent exact replays", async () => {
    const report = await runProbe({
      provider: "gocam",
      serviceUrl: "https://age.example.com",
      callbackUrl,
      linkBackUrl,
      verificationId: "age-row-1",
      authorityReader: passingReader(),
      now: () => new Date("2026-08-11T20:01:00.000Z"),
    });

    expect(report).toMatchObject({
      ok: true,
      checkedAt: "2026-08-11T20:01:00.000Z",
      provider: "gocam",
      jurisdiction: "US",
      providerVerificationId: "gocam-session-1",
      status: "verified",
      url: "https://go.cam/verify/gocam-session-1",
      terminal: {
        authorityVersion: "age_verified_callback_v1",
        verificationId: "age-row-1",
        verificationStatus: "verified",
        callbackUrl,
        linkBackUrl,
        providerEventId: "gocam-session-1",
        providerDeliveryCount: 2,
        replayVerified: true,
      },
      error: null,
    });
  });

  it("keeps terminal evidence red when the provider replay has no independent delivery id", async () => {
    const report = await runProbe({
      provider: "gocam",
      serviceUrl: "https://age.example.com",
      callbackUrl,
      linkBackUrl,
      verificationId: "age-row-1",
      authorityReader: passingReader(1),
    });

    expect(report).toMatchObject({
      ok: false,
      terminal: null,
      error: {
        code: "age_terminal_authority_invalid",
        message: expect.stringContaining(
          "independently identified exact business-payload deliveries",
        ),
      },
    });
  });

  it("rejects route snapshots that do not match the active callback configuration", async () => {
    const report = await runProbe({
      provider: "gocam",
      serviceUrl: "https://age.example.com",
      callbackUrl: "https://ourdream.ai/api/v1/age-verification/webhooks/other",
      linkBackUrl,
      verificationId: "age-row-1",
      authorityReader: passingReader(),
    });

    expect(report).toMatchObject({
      ok: false,
      terminal: null,
      error: {
        code: "age_terminal_authority_invalid",
        message: expect.stringContaining("callback URL snapshot"),
      },
    });
  });

  it("requires an existing product verification identity", async () => {
    const report = await runProbe({
      provider: "gocam",
      serviceUrl: "https://age.example.com",
      callbackUrl,
      linkBackUrl,
      verificationId: null,
    });

    expect(report).toMatchObject({
      ok: false,
      terminal: null,
      error: { code: "age_probe_verification_id_required", retryable: false },
    });
  });
});
