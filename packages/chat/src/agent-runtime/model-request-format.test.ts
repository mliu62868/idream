import { describe, expect, it } from "vitest";
import { dropOldestReplayExchange, formatModelRequestInput } from "./model-request-format";

const messages = [
  { id: "user-1", sourceKind: "replay" as const, role: "user" as const, content: "I chose basil and have not planted it." },
  { id: "assistant-1", sourceKind: "replay" as const, role: "assistant" as const, content: "I will plant it after we finish talking." },
  { id: "current", sourceKind: "current_user" as const, role: "user" as const, content: "What have I actually done?" },
] as const;
const imageTools = [{ name: "generate_image_async", description: "Generate", parameters: { type: "object" } }];

describe("model request source boundary", () => {
  it("drops complete pinned exchanges while retaining runtime context and the current tool round trip", () => {
    const input = [
      { id: "system", role: "system" },
      { id: "old-user", role: "user" }, { id: "old-briar", role: "assistant" }, { id: "old-cedar", role: "assistant" },
      { id: "next-user", role: "user" }, { id: "next-assistant", role: "assistant" },
      { id: "state:current", role: "user" }, { id: "recall:current", role: "user" }, { id: "current", role: "user" },
      { id: "current-tool-call", role: "assistant" }, { id: "current-tool-result", role: "tool" },
    ];
    const replayIds = new Set(["old-user", "old-briar", "old-cedar", "next-user", "next-assistant"]);
    const retained = dropOldestReplayExchange(input, replayIds)!;
    expect(retained.map(message => message.id)).toEqual([
      "system", "next-user", "next-assistant", "state:current", "recall:current", "current", "current-tool-call", "current-tool-result",
    ]);
    expect(input).toHaveLength(11);
    const fixed = dropOldestReplayExchange(retained, replayIds)!;
    expect(fixed.map(message => message.id)).toEqual([
      "system", "state:current", "recall:current", "current", "current-tool-call", "current-tool-result",
    ]);
    expect(dropOldestReplayExchange(fixed, replayIds)).toBeNull();
  });

  it.each([false, true])("keeps native speaker roles and the current request last (images available=%s)", images => {
    const request = formatModelRequestInput({ messages: [
      messages[0], { ...messages[1], speaker: { characterId: "briar", sessionId: "briar-session", name: "Briar" } }, messages[2],
    ], tools: images ? imageTools : [] });
    expect(request.messages).toEqual([
      { role: "user", content: "I chose basil and have not planted it." },
      { role: "assistant", content: "Briar: I will plant it after we finish talking." },
      { role: "user", content: "What have I actually done?" },
    ]);
    expect(JSON.stringify(request)).not.toContain("Conversation records");
  });

  it.each([false, true])("folds context into the current turn without promoting it to a new request (images available=%s)", images => {
    const request = formatModelRequestInput({ tools: images ? imageTools : [], messages: [
      messages[0],
      { id: "state:current", sourceKind: "plugin", role: "user", content: "Current Scene: the conservatory." },
      { id: "recall:current", sourceKind: "plugin", role: "user", content: "An earlier conversation mentioned mint." },
      messages[2],
    ] });
    expect(request.messages).toEqual([
      { role: "user", content: messages[0].content },
      { role: "user", content: "Current Scene: the conservatory.\n\nAn earlier conversation mentioned mint.\n\nWhat have I actually done?" },
    ]);
  });

  it("preserves the actual tool result for the next Agent step", () => {
    const tool_calls = [{ id: "image-1", type: "function" as const, function: { name: "generate_image_async", arguments: "{}" } }];
    const request = formatModelRequestInput({ tools: imageTools, messages: [
      ...messages.slice(0, -1),
      { id: "state", sourceKind: "plugin", role: "user", content: "Current Scene: the library." },
      messages.at(-1)!,
      { id: "call", sourceKind: "plugin", role: "assistant", content: "Give me a moment.", tool_calls },
      { id: "result", sourceKind: "plugin", role: "tool", tool_call_id: "image-1", content: "The image request was accepted." },
    ] });
    expect(request.messages.slice(-2)).toEqual([
      { role: "assistant", content: "Give me a moment.", tool_calls },
      { role: "tool", tool_call_id: "image-1", content: "The image request was accepted." },
    ]);
    expect(request.messages[2]).toEqual({ role: "user", content: "Current Scene: the library.\n\nWhat have I actually done?" });
  });
});
