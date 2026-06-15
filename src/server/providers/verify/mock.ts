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
}
