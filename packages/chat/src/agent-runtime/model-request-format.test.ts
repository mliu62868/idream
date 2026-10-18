import { describe, expect, it } from "vitest";
import { dropOldestReplayExchange, formatModelRequestInput } from "./model-request-format";

const messages = [
  { id: "user-1", sourceKind: "replay" as const, role: "user" as const, content: "I chose basil and have not planted it." },
  { id: "assistant-1", sourceKind: "replay" as const, role: "assistant" as const, content: "I will plant it after we finish talking." },
  { id: "current", sourceKind: "current_user" as const, role: "user" as const, content: "What have I actually done?" },
] as const;
const imageTools = [{ name: "generate_image_async", description: "Generate", parameters: { type: "object" } }];

describe("model request source boundary", () => {
  it("distinguishes the responding character by identity even when group members share a name", () => {
    const request = formatModelRequestInput({ respondingCharacterId: "self", messages: [
      { id: "other", sourceKind: "replay", role: "assistant", content: "My earlier words.", speaker: { characterId: "other", sessionId: "other-session", name: "Sam" } },
      { id: "self", sourceKind: "replay", role: "assistant", content: "My own reply.", speaker: { characterId: "self", sessionId: "self-session", name: "Sam" } },
      messages.at(-1)!,
    ] });
    expect(request.messages).toEqual([
      { role: "user", content: "Sam: My earlier words." },
      { role: "assistant", content: "My own reply." },
      { role: "user", content: messages.at(-1)!.content },
    ]);
  });

  it("separates answered recalled questions from the current request without changing either passage", () => {
    const note = "[user @ earlier] Where is my notebook? [assistant @ earlier] Beside the window.";
    const current = "I just placed a paper crane on the piano. Where is the crane now?";
    const request = formatModelRequestInput({ respondingCharacterId: "responding", messages: [
      ...messages.slice(0, 2),
      { id: "recall", sourceKind: "plugin", role: "user", content: note },
      { id: "now", sourceKind: "current_user", role: "user", content: current },
    ] });
    expect(request.messages.slice(0, 2)).toEqual([
      { role: "user", content: messages[0].content },
      { role: "assistant", content: messages[1].content },
    ]);
    expect(request.messages.at(-2)).toEqual({ role: "user", content: `Context for this reply (earlier messages are already answered):\n<context>\n${note}\n</context>` });
    expect(request.messages.at(-1)).toEqual({ role: "user", content: current });
  });

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

  it.each([false, true])("keeps each speaker distinct and the current request last (images available=%s)", images => {
    const request = formatModelRequestInput({ respondingCharacterId: "responding", messages: [
      messages[0], { ...messages[1], speaker: { characterId: "briar", sessionId: "briar-session", name: "Briar" } }, messages[2],
    ], tools: images ? imageTools : [] });
    expect(request.messages).toEqual([
      { role: "user", content: "Earlier user message, already answered:\nI chose basil and have not planted it." },
      { role: "user", content: "Briar: I will plant it after we finish talking." },
      { role: "user", content: "What have I actually done?" },
    ]);
    expect(JSON.stringify(request)).not.toContain("Conversation records");
  });

  it.each([false, true])("keeps bounded background separate from the unchanged current message (images available=%s)", images => {
    const request = formatModelRequestInput({ respondingCharacterId: "responding", tools: images ? imageTools : [], messages: [
      messages[0],
      { id: "state:current", sourceKind: "plugin", role: "user", content: "Current Scene: the conservatory." },
      { id: "recall:current", sourceKind: "plugin", role: "user", content: "An earlier conversation mentioned mint." },
      messages[2],
    ] });
    expect(request.messages).toEqual([
      { role: "user", content: messages[0].content },
      { role: "user", content: "Context for this reply (earlier messages are already answered):\n<context>\nCurrent Scene: the conservatory.\n\nAn earlier conversation mentioned mint.\n</context>" },
      { role: "user", content: messages[2].content },
    ]);
  });

  it("preserves the actual tool result for the next Agent step", () => {
    const tool_calls = [{ id: "image-1", type: "function" as const, function: { name: "generate_image_async", arguments: "{}" } }];
    const request = formatModelRequestInput({ respondingCharacterId: "responding", tools: imageTools, messages: [
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
    expect(request.messages[2]).toEqual({ role: "user", content: "Context for this reply (earlier messages are already answered):\n<context>\nCurrent Scene: the library.\n</context>" });
    expect(request.messages[3]).toEqual({ role: "user", content: messages[2].content });
  });
});

it("marks a replay request as answered when another Character's reply has an incoming role", () => {
  const previousUser = "The room is now the library. What would you do first?";
  const currentUser = "My notebook is on the desk. Confirm that location.";
  const request = formatModelRequestInput({ respondingCharacterId: "diana", messages: [
    { id: "u1", sourceKind: "replay", role: "user", content: previousUser },
    { id: "a1", sourceKind: "replay", role: "assistant", content: "I would sit by the window.",
      speaker: { characterId: "bailey", name: "Bailey", sessionId: "bailey-session" } },
    { id: "current", sourceKind: "current_user", role: "user", content: currentUser },
  ] });
  expect(request.messages).toEqual([
    { role: "user", content: `Earlier user message, already answered:\n${previousUser}` },
    { role: "user", content: "Bailey: I would sit by the window." },
    { role: "user", content: currentUser },
  ]);
});

it("only marks the open incoming tail after the responding Character's last answer", () => {
  const other = { characterId: "other", name: "Sam", sessionId: "other-session" };
  const self = { characterId: "self", name: "Jo", sessionId: "self-session" };
  const request = formatModelRequestInput({ respondingCharacterId: "self", messages: [
    { id: "old-question", sourceKind: "replay", role: "user", content: "What about the old plan?" },
    { id: "old-other", sourceKind: "replay", role: "assistant", content: "We discussed it.", speaker: other },
    { id: "self-answer", sourceKind: "replay", role: "assistant", content: "That plan is settled.", speaker: self },
    { id: "tail-question", sourceKind: "replay", role: "user", content: "Where would you sit?" },
    { id: "tail-other", sourceKind: "replay", role: "assistant", content: "By the window.", speaker: other },
    { id: "current", sourceKind: "current_user", role: "user", content: "Tell me the new code." },
  ] });
  expect(request.messages[0]).toEqual({ role: "user", content: "What about the old plan?" });
  expect(request.messages[3]).toEqual({ role: "user", content: "Earlier user message, already answered:\nWhere would you sit?" });
  expect(request.messages.at(-1)).toEqual({ role: "user", content: "Tell me the new code." });
});
