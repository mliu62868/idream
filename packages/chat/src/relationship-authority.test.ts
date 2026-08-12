import { describe, expect, it } from "vitest";
import {
  resolveRelationshipLinkage,
  type RelationshipMessage,
} from "./relationship-authority.js";

function message(
  input: Partial<RelationshipMessage> &
    Pick<RelationshipMessage, "id" | "role">,
): RelationshipMessage {
  return {
    sessionId: "session_1",
    status: "sent",
    safetyStatus: "passed",
    attempt: 1,
    content: input.id,
    replyToMessageId: null,
    memoryAuthority: "enabled",
    memoryExtractedAttempt: 0,
    createdAt: new Date("2026-07-18T12:00:00.000Z"),
    deletedAt: null,
    ...input,
  };
}

describe("relationship exchange linkage authority", () => {
  it("does not treat an immutable opening message as an unlinked exchange", () => {
    const result = resolveRelationshipLinkage(
      [
        message({
          id: "opening_1",
          role: "assistant",
          memoryAuthority: "disabled",
          createdAt: new Date("2026-07-18T11:59:00.000Z"),
          runtimeTrace: {
            schemaVersion: 1,
            messageKind: "opening",
            outputAuthority: "immutable_opening",
          },
        }),
        message({ id: "user_1", role: "user" }),
        message({
          id: "assistant_1",
          role: "assistant",
          replyToMessageId: "user_1",
        }),
      ],
      [],
    );

    expect(result.sources.get("assistant_1")?.id).toBe("user_1");
    expect(result.sources.has("opening_1")).toBe(false);
    expect(result.ambiguousAssistantIds).toEqual([]);
  });

  it("does not assign one same-time legacy user to two assistants", () => {
    const result = resolveRelationshipLinkage(
      [
        message({ id: "user_1", role: "user" }),
        message({ id: "assistant_1", role: "assistant" }),
        message({ id: "assistant_2", role: "assistant" }),
      ],
      [],
    );

    expect([...result.sources]).toEqual([]);
    expect(result.ambiguousAssistantIds).toEqual([
      "assistant_1",
      "assistant_2",
    ]);
  });

  it("keeps an exact claim and rejects a legacy row competing for its source", () => {
    const result = resolveRelationshipLinkage(
      [
        message({ id: "user_1", role: "user" }),
        message({
          id: "assistant_exact",
          role: "assistant",
          replyToMessageId: "user_1",
        }),
        message({ id: "assistant_legacy", role: "assistant" }),
      ],
      [],
    );

    expect(result.sources.get("assistant_exact")?.id).toBe("user_1");
    expect(result.sources.has("assistant_legacy")).toBe(false);
    expect(result.ambiguousAssistantIds).toContain("assistant_legacy");
  });

  it("fails both explicit assistants closed when they claim one source", () => {
    const result = resolveRelationshipLinkage(
      [
        message({ id: "user_1", role: "user" }),
        message({
          id: "assistant_1",
          role: "assistant",
          replyToMessageId: "user_1",
        }),
        message({
          id: "assistant_2",
          role: "assistant",
          replyToMessageId: "user_1",
        }),
      ],
      [],
    );

    expect([...result.sources]).toEqual([]);
    expect(result.ambiguousAssistantIds).toEqual([
      "assistant_1",
      "assistant_2",
    ]);
  });
});
