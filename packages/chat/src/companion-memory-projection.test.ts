import { describe, expect, it } from "vitest";
import type {
  RelationshipLinkage,
  RelationshipMessage,
} from "./relationship-authority.js";
import { canonicalCompanionMessages } from "./companion-memory-projection.js";

function message(input: Partial<RelationshipMessage> & Pick<RelationshipMessage, "id" | "role">): RelationshipMessage {
  return {
    sessionId: "session-1",
    status: "sent",
    safetyStatus: "passed",
    attempt: 1,
    content: `${input.role}-${input.id}`,
    replyToMessageId: null,
    memoryAuthority: input.role === "assistant" ? "enabled" : "legacy_unknown",
    memoryExtractedAttempt: 0,
    createdAt: new Date(`2026-08-19T12:00:0${input.id.at(-1) ?? "0"}.000Z`),
    deletedAt: null,
    ...input,
  };
}

describe("companion memory projection", () => {
  it("replays only complete, unambiguous, memory-enabled canonical exchanges", () => {
    const user1 = message({ id: "user-1", role: "user" });
    const assistant1 = message({ id: "assistant-2", role: "assistant" });
    const deletedUser = message({
      id: "user-3",
      role: "user",
      deletedAt: new Date("2026-08-19T12:01:00.000Z"),
    });
    const deletedSourceAssistant = message({ id: "assistant-4", role: "assistant" });
    const privateAssistant = message({
      id: "assistant-5",
      role: "assistant",
      memoryAuthority: "disabled",
    });
    const sources = new Map([
      [assistant1.id, user1],
      [deletedSourceAssistant.id, deletedUser],
      [privateAssistant.id, user1],
    ]);
    const linkage: RelationshipLinkage = {
      sources,
      ambiguousAssistantIds: ["assistant-ambiguous"],
      candidateSourceIds: new Map(),
    };

    expect(canonicalCompanionMessages([{
      id: "session-1",
      messages: [privateAssistant, deletedSourceAssistant, assistant1, deletedUser, user1],
      linkage,
    }])).toEqual([
      expect.objectContaining({ id: "user-1", role: "user" }),
      expect.objectContaining({ id: "assistant-2", role: "assistant" }),
    ]);
  });
});
