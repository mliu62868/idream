import type { AgeVerificationProvider } from "../types";

export class MockAgeVerificationProvider implements AgeVerificationProvider {
  async createSession(input: Parameters<AgeVerificationProvider["createSession"]>[0]) {
    return {
      ok: true as const,
      data: {
        provider: "mock" as const,
        providerVerificationId: `mock-age-${input.userId}`,
        status: "not_required" as const,
      },
    };
  }

  async parseWebhook(input: Parameters<AgeVerificationProvider["parseWebhook"]>[0]) {
    const payload = isRecord(input.payload) ? input.payload : {};
    const status = typeof payload.status === "string" ? payload.status : "verified";
    return {
      ok: true as const,
      data: {
        providerEventId: input.providerEventId,
        userId: typeof payload.userId === "string" ? payload.userId : undefined,
        providerVerificationId:
          typeof payload.providerVerificationId === "string"
            ? payload.providerVerificationId
            : undefined,
        status: normalizeStatus(status),
      },
    };
  }
}

function normalizeStatus(value: string): "pending" | "verified" | "failed" | "expired" {
  if (value === "pending" || value === "verified" || value === "failed" || value === "expired") {
    return value;
  }
  return "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
