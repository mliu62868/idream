import { describe, expect, it } from "vitest";
import {
  decodeChatServiceProbeEvidence,
  decodeVideoGenerationProbeEvidence,
  decodeVideoH3GenerationProbeEvidence,
} from "./evidence";

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

describe("Video generation probe evidence decoder", () => {
  it.each([
    ["LTX", decodeVideoGenerationProbeEvidence],
    ["MiniMax H3", decodeVideoH3GenerationProbeEvidence],
  ])("preserves the executor-bound source revision for %s", (_label, decode) => {
    const decoded = decode({
      sourceRevision: "abc123",
      terminal: {
        sourceRevision: "abc123",
      },
    });

    expect(decoded.sourceRevision).toBe("abc123");
    expect(decoded.terminal?.sourceRevision).toBe("abc123");
  });
});
