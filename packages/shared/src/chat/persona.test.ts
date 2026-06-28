import { describe, expect, it } from "vitest";
import {
  buildCharacterSystemPrompt,
  companionRole,
  looksLikeMockChatResponse,
} from "./persona";

describe("chat persona helpers", () => {
  it("does not treat creator handles as companion roles", () => {
    expect(companionRole("@creator")).toBe("AI companion");

    const prompt = buildCharacterSystemPrompt({
      name: "Melissa Burke",
      age: 38,
      description: "She's been your best friend's mom your whole life.",
      relationship: "@some1cool",
      style: "realistic",
      gender: "female",
    });

    expect(prompt).toContain("Companion role: AI companion");
    expect(prompt).not.toContain("@some1cool");
    expect(prompt).toContain("Speak in first person as Melissa Burke");
  });

  it("detects mock/template chat responses", () => {
    expect(looksLikeMockChatResponse("Mock Launch Probe reply: hello")).toBe(true);
    expect(looksLikeMockChatResponse("Mock probe response: hello")).toBe(true);
    expect(looksLikeMockChatResponse("Received. All systems operational.")).toBe(false);
  });
});
