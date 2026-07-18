import { describe, expect, it } from "vitest";
import { chatImageRequestedPayloadSchema } from "./payloads";

const request = {
  version: 1 as const,
  kind: "chat.image.requested" as const,
  requestId: "request-1",
  attachmentId: "attachment-1",
  sessionId: "session-1",
  messageId: "message-1",
  userId: "user-1",
  characterId: "character-1",
  promptHint: "a sunset selfie",
  conversationContext: "user: send a sunset selfie",
  controls: { orientation: "4:5", outputCount: 1 },
};

describe("chat image request Release pin", () => {
  it("preserves a non-empty pinned Character Release", () => {
    expect(
      chatImageRequestedPayloadSchema.parse({
        ...request,
        characterReleaseId: "release-1",
      }).characterReleaseId,
    ).toBe("release-1");
  });

  it("keeps older requests compatible while rejecting an empty Release pin", () => {
    expect(chatImageRequestedPayloadSchema.parse(request).characterReleaseId).toBeUndefined();
    expect(() =>
      chatImageRequestedPayloadSchema.parse({
        ...request,
        characterReleaseId: "",
      }),
    ).toThrow();
  });
});
