import type { ModerationProvider } from "../types";

const blockedTerms = ["underage", "minor", "csam"];

export class MockModerationProvider implements ModerationProvider {
  async check(input: Parameters<ModerationProvider["check"]>[0]) {
    const lowered = input.content.toLowerCase();
    const blockedTerm = blockedTerms.find((term) => lowered.includes(term));

    if (blockedTerm) {
      return {
        ok: true as const,
        data: {
          status: "blocked" as const,
          policyCode:
            blockedTerm === "csam" ? "potential_underage_content" : "age_under_18",
          confidence: 0.99,
        },
      };
    }

    return {
      ok: true as const,
      data: {
        status: "passed" as const,
        confidence: 0.5,
      },
    };
  }
}
