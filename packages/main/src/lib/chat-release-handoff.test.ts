import { describe, expect, it } from "vitest";
import { chatReleaseChangedCharacterId } from "./chat-release-handoff";

describe("chatReleaseChangedCharacterId", () => {
  it("reads the reason from both the Chat façade and the Main envelope", () => {
    const details = { reason: "character_release_changed", characterId: "character-1" };
    expect(chatReleaseChangedCharacterId({ error: "gone", details })).toBe("character-1");
    expect(chatReleaseChangedCharacterId({ ok: false, error: { code: "gone", details } })).toBe("character-1");
  });

  it("ignores every other gone chat", () => {
    expect(chatReleaseChangedCharacterId({ error: "gone", message: "Chat session is archived" })).toBeNull();
    expect(chatReleaseChangedCharacterId({ error: "gone", details: { reason: "other", characterId: "character-1" } })).toBeNull();
    expect(chatReleaseChangedCharacterId({ error: "gone", details: { reason: "character_release_changed" } })).toBeNull();
    expect(chatReleaseChangedCharacterId(null)).toBeNull();
  });
});
