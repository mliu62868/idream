import { describe, expect, it } from "vitest";
import type { RuntimeChatSession as ChatSession } from "@/lib/public-api-contracts";
import {
  chatSessionIsReadOnly,
  chatSessionMetadataReducer,
  INITIAL_CHAT_SESSION_METADATA,
} from "./chat-session-metadata";

const session = (extra: Partial<ChatSession> = {}): ChatSession => ({
  id: "session-1", ownerScope: "user:viewer-a", title: "Rainy cafe", characterId: "mira",
  messages: [], character: { name: "Mira", image: "/mira.webp", canUpdateIdentity: true }, ...extra,
});

describe("chat session metadata", () => {
  it("applies a session read as one snapshot", () => {
    const next = chatSessionMetadataReducer(INITIAL_CHAT_SESSION_METADATA, { type: "session", session: session({ memoryEnabled: false, proactiveEnabled: true, status: "archived" }) });
    expect(next).toMatchObject({
      title: "Rainy cafe", characterId: "mira", characterImage: "/mira.webp", canUpdateIdentity: true,
      memoryEnabled: false, proactiveEnabled: true, archived: true, continuation: "available",
    });
    expect(chatSessionIsReadOnly(next)).toBe(true);
  });

  it("keeps the known character and memory flag when a read omits them", () => {
    const known = chatSessionMetadataReducer(INITIAL_CHAT_SESSION_METADATA, { type: "session", session: session({ memoryEnabled: false }) });
    const next = chatSessionMetadataReducer(known, { type: "session", session: session({ characterId: undefined, memoryEnabled: undefined, title: null, character: { name: "" } }) });
    expect(next).toMatchObject({ characterId: "mira", memoryEnabled: false, title: "Unavailable character", characterImage: null });
  });

  it("returns the same state for no-op local confirmations", () => {
    const state = INITIAL_CHAT_SESSION_METADATA;
    expect(chatSessionMetadataReducer(state, { type: "memory", enabled: true })).toBe(state);
    expect(chatSessionMetadataReducer(state, { type: "continuation", continuation: "character_unavailable" }).continuation).toBe("character_unavailable");
    expect(chatSessionMetadataReducer({ ...state, archived: true }, { type: "reset" })).toBe(INITIAL_CHAT_SESSION_METADATA);
  });
});
