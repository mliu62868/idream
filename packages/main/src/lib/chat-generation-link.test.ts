import { describe, expect, it } from "vitest";
import { chatGenerationHref } from "./chat-generation-link";

describe("Chat generation navigation", () => {
  const message = { id: "reply-new", turnId: "turn-old", attempt: 2, role: "assistant", status: "sent", content: "A moment" };
  it("pins the selected message and image, including a historical Turn", () => {
    const href = chatGenerationHref({ characterId: "character-1", sessionId: "session-1", message, mediaAssetId: "image-old" });
    const url = new URL(href!, "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({ characterId: "character-1", chatSessionId: "session-1", chatTurnId: "turn-old", chatAttempt: "2", chatMediaAssetId: "image-old" });
  });
  it("never silently opens a generic generator for an unbound image or pending reply", () => {
    expect(chatGenerationHref({ characterId: "character-1", sessionId: "session-1", mediaAssetId: "image-old" })).toBeNull();
    expect(chatGenerationHref({ characterId: "character-1", sessionId: "session-1", message: { ...message, status: "pending" } })).toBeNull();
  });
  it("allows a new chat without a completed moment to open the character generator", () => {
    expect(chatGenerationHref({ characterId: "character-1", sessionId: "session-1" })).toBe("/generate?characterId=character-1");
  });
});
