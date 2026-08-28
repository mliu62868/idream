import { describe, expect, it } from "vitest";
import { chatExecutionSnapshotSchema } from "./chat-turns";

const snapshot = {
  version: 1,
  turnId: "turn-1",
  sessionId: "session-1",
  userMessageId: "user-message-1",
  assistantMessageId: "assistant-message-1",
  attempt: 1,
  userId: "user-1",
  characterId: "character-1",
  characterContentVersionId: "content-1",
  characterReleaseId: "release-1",
  characterVisualProfileId: "visual-1",
  characterVisualProfileVersion: 2,
  memoryEnabled: true,
  contextRevision: 0,
  userContent: "Hello",
  recentTurns: [],
  sceneVersion: 0,
  scene: null,
} as const;

describe("Chat execution snapshot", () => {
  it("requires the immutable visual profile id and version to be pinned together", () => {
    expect(chatExecutionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(chatExecutionSnapshotSchema.safeParse({
      ...snapshot,
      characterVisualProfileVersion: null,
    }).success).toBe(false);
    expect(chatExecutionSnapshotSchema.safeParse({
      ...snapshot,
      characterVisualProfileId: null,
    }).success).toBe(false);
  });
});
