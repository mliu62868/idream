import { describe, expect, it } from "vitest";
import type { ChatImageRequestedPayload } from "@idream/shared/contracts";
import { chatImageMayReuse } from "./chat-image-reuse";

function payload(requestedNudity: "unspecified" | "none" | "full"): ChatImageRequestedPayload {
  return {
    version: 1,
    kind: "chat.image.requested",
    requestId: "request-1",
    attachmentId: "attachment-1",
    sessionId: "session-1",
    messageId: "message-1",
    userId: "user-1",
    characterId: "character-1",
    characterReleaseId: "release-1",
    promptHint: "selfie beside a rainy window",
    conversationContext: null,
    intent: { requestedNudity },
    controls: { orientation: "4:5", outputCount: 1 },
  };
}

describe("Chat image reuse authority", () => {
  it("never semantically reuses an asset for an explicit nudity boundary", () => {
    expect(chatImageMayReuse(payload("full"))).toBe(false);
    expect(chatImageMayReuse(payload("none"))).toBe(false);
    expect(chatImageMayReuse(payload("unspecified"))).toBe(true);
  });
});
