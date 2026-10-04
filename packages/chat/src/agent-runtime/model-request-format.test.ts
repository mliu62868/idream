import { describe, expect, it } from "vitest";
import { dropOldestReplayExchange, formatModelRequestInput } from "./model-request-format";

const messages = [
  { id: "user-1", sourceKind: "replay" as const, role: "user" as const, content: "I chose basil and have not planted it." },
  { id: "assistant-1", sourceKind: "replay" as const, role: "assistant" as const, content: "I will plant it after we finish talking." },
  { id: "current", sourceKind: "current_user" as const, role: "user" as const, content: "What have I actually done?" },
];

describe("model request source boundary", () => {
  it("drops the oldest pinned exchange while retaining runtime context and the current tool round trip", () => {
    const input = [
      { id: "system", role: "system" },
      { id: "old-user", role: "user" },
      { id: "old-briar", role: "assistant" },
      { id: "old-cedar", role: "assistant" },
      { id: "next-user", role: "user" },
      { id: "next-assistant", role: "assistant" },
      { id: "state:current", role: "user" },
      { id: "recall:current", role: "user" },
      { id: "current", role: "user" },
      { id: "current-tool-call", role: "assistant" },
      { id: "current-tool-result", role: "tool" },
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

  it.each([false, true])("preserves stable group speaker identity in the actual provider request (image=%s)", (requiredTool) => {
    const speaker = { characterId: "briar", sessionId: "briar-session", name: "Briar" };
    const input = [messages[0], { ...messages[1], speaker }, messages[2]];
    const request = formatModelRequestInput({ requiredTool, messages: input });
    if (requiredTool) {
      const content = (request.messages.at(-1) as { content: string }).content;
      expect(content).toContain(JSON.stringify(speaker));
      expect(content.indexOf("I chose basil")).toBeLessThan(content.indexOf("I will plant"));
      expect(content).not.toContain('"source":"user","speaker"');
    } else {
      // Ordinary turns are native chat turns; another Character's line keeps its name.
      expect(request.messages).toEqual([
        { role: "user", content: "I chose basil and have not planted it." },
        { role: "assistant", content: "Briar: I will plant it after we finish talking." },
        { role: "user", content: "What have I actually done?" },
      ]);
    }
  });

  it.each([false, true])("does not promote plugin context or recall to user authority (image=%s)", (requiredTool) => {
    const request = formatModelRequestInput({ requiredTool, messages: [
      messages[0]!,
      { id: "state:current", sourceKind: "plugin", role: "user", content: "Current Scene: the conservatory." },
      { id: "recall:current", sourceKind: "plugin", role: "user", content: "An earlier conversation mentioned mint." },
      messages[2]!,
    ] });
    const content = (request.messages.at(-1) as { content: string }).content;
    if (requiredTool) {
      expect(content).not.toContain('"source":"user","content":"Current Scene:');
      expect(content).not.toContain('"source":"user","content":"An earlier');
      expect(content).toContain('"source":"scene_state"');
      expect(content).toContain('"source":"retrieved_memory"');
      const latest = content.split("LATEST USER RECORD (authoritative for user facts when it conflicts with earlier records):\n")[1]?.split("\n")[0];
      expect(latest).toContain("I chose basil");
      expect(latest).not.toContain("mint");
    } else {
      // Context never becomes a standalone user turn: it is folded into the
      // current message, ahead of the user's own words.
      expect(request.messages.map((message) => (message as { role: string }).role)).toEqual(["user", "user"]);
      expect(content).toBe("Current Scene: the conservatory.\n\nAn earlier conversation mentioned mint.\n\nWhat have I actually done?");
    }
  });

  it("sends ordinary history as native chat turns with the current request last", () => {
    const request = formatModelRequestInput({ messages, requiredTool: false });
    expect(request.messages).toEqual([
      { role: "user", content: "I chose basil and have not planted it." },
      { role: "assistant", content: "I will plant it after we finish talking." },
      { role: "user", content: "What have I actually done?" },
    ]);
    expect(JSON.stringify(request)).not.toContain("Conversation records");
  });

  it("keeps Character dialogue visible but outside image-fact authority", () => {
    const request = formatModelRequestInput({
      messages: [
        { id: "user-1", sourceKind: "replay" as const, role: "user" as const, content: "It is night; the notebook is left of the cup." },
        { id: "assistant-1", sourceKind: "replay" as const, role: "assistant" as const, content: "The dusk light warms the cafe." },
        { id: "current", sourceKind: "current_user" as const, role: "user" as const, content: "Generate a fully clothed photo." },
      ],
      requiredTool: true,
      tools: [{ name: "generate_image_async", description: "Generate", parameters: { type: "object" } }],
    });
    const current = request.messages.at(-1) as { content: string };
    expect(current.content).toContain("LATEST USER RECORD");
    expect(current.content).toContain("completed Character actions are continuity, not user actions");
    expect(current.content).toContain("The dusk light warms the cafe.");
    expect(current.content).toContain("It is night; the notebook is left of the cup.");
  });

  it("preserves source identities and cross-speaker event order for an image action", () => {
    const request = formatModelRequestInput({ requiredTool: true, messages: [
      { id: "user-arrangement", sourceKind: "replay", role: "user", content: "I put the cup on the table." },
      { id: "character-action", sourceKind: "replay", role: "assistant", content: "I place a candle beside the cup." },
      { id: "user-update", sourceKind: "replay", role: "user", content: "I move the cup onto the shelf." },
      { id: "character-update", sourceKind: "replay", role: "assistant", content: "I light the candle on the table." },
      { id: "current", sourceKind: "current_user", role: "user", content: "Take a picture of this arrangement." },
    ] });
    const content = (request.messages.at(-1) as { content: string }).content;
    expect(content.indexOf("I place a candle")).toBeLessThan(content.indexOf("I move the cup"));
    expect(content.indexOf("I move the cup")).toBeLessThan(content.indexOf("I light the candle"));
    for (const id of ["user-arrangement", "character-action", "user-update", "character-update"]) {
      expect(content).toContain(JSON.stringify(id));
    }
  });
});
