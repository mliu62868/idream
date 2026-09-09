import { describe, expect, it } from "vitest";
import { formatModelRequestInput } from "./model-request-format";

const messages = [
  { id: "user-1", sourceKind: "replay" as const, role: "user" as const, content: "I chose basil and have not planted it." },
  { id: "assistant-1", sourceKind: "replay" as const, role: "assistant" as const, content: "I will plant it after we finish talking." },
  { id: "current", sourceKind: "current_user" as const, role: "user" as const, content: "What have I actually done?" },
];

describe("model request source boundary", () => {
  it.each([false, true])("does not promote plugin context or recall to user authority (image=%s)", (requiredTool) => {
    const request = formatModelRequestInput({ requiredTool, messages: [
      messages[0]!,
      { id: "state:current", sourceKind: "plugin", role: "user", content: "Current Scene: the conservatory." },
      { id: "recall:current", sourceKind: "plugin", role: "user", content: "An earlier conversation mentioned mint." },
      messages[2]!,
    ] });
    const content = (request.messages.at(-1) as { content: string }).content;
    expect(content).not.toContain('"source":"user","content":"Current Scene:');
    expect(content).not.toContain('"source":"user","content":"An earlier');
    expect(content).toContain('"source":"scene_state"');
    expect(content).toContain('"source":"retrieved_memory"');
    if (requiredTool) {
      const latest = content.split("LATEST USER RECORD (authoritative for user facts when it conflicts with earlier records):\n")[1]?.split("\n")[0];
      expect(latest).toContain("I chose basil");
      expect(latest).not.toContain("mint");
    }
  });

  it("quotes ordinary history and leaves the current request authoritative", () => {
    const request = formatModelRequestInput({ messages, requiredTool: false });
    const current = request.messages.at(-1) as { role: string; content: string };
    expect(request.messages).toHaveLength(1);
    expect(current.role).toBe("user");
    expect(current.content).toContain('"source":"user"');
    expect(current.content).toContain('"source":"character"');
    expect(current.content.indexOf("Latest user request (authoritative):")).toBeLessThan(
      current.content.indexOf("What have I actually done?"),
    );
    expect(current.content).toContain("Negated user facts remain negated");
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
});
