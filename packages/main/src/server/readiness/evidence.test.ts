import { describe, expect, it } from "vitest";
import { decodeChatServiceProbeEvidence } from "./evidence";

describe("Chat service probe evidence decoder", () => {
  it("preserves result-bound memory search evidence from the shared contract", () => {
    const decoded = decodeChatServiceProbeEvidence({
      conversation: {
        getSession: {
          dsh: {
            ok: true,
            memorySearchEvidenceMatches: 1,
          },
        },
      },
    });

    expect(decoded.conversation?.getSession?.dsh?.memorySearchEvidenceMatches).toBe(1);
  });
});
