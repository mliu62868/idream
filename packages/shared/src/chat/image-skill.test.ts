import { describe, expect, it } from "vitest";
import { composeCompanionSystemPrompt } from "./companion-agent-prompt";
import { COMPANION_IMAGE_SKILL_PROMPT, COMPANION_IMAGE_SKILL_VERSION } from "./image-skill";

describe("image receipt grounding contract", () => {
  it("distinguishes call success from image delivery in the actual composed prompt", () => {
    const prompt = composeCompanionSystemPrompt({ memoryEnabled: false, imageToolEnabled: true, soulPrompt: "Speak warmly.", characterName: "Sophie" });
    expect(prompt).toContain(COMPANION_IMAGE_SKILL_PROMPT);
    expect(prompt).toContain(`Image direction skill (${COMPANION_IMAGE_SKILL_VERSION})`);
    expect(prompt).toContain("acknowledge output.status");
    expect(prompt).toContain("following the user's requested response format");
    expect(prompt).toContain("For accepted, the photo is being made and will arrive later");
    expect(prompt).toContain("For completed, acknowledge delivery");
    expect(prompt).toContain("outcome=succeeded describes the call, not photo completion");
  });

  it("keeps image descriptions within the request and the evidence returned", () => {
    expect(COMPANION_IMAGE_SKILL_PROMPT).toContain("subjects and scene the user requested");
    expect(COMPANION_IMAGE_SKILL_PROMPT).toContain("A tool receipt gives status, not a view of the photo");
    expect(COMPANION_IMAGE_SKILL_PROMPT).toContain("attachment state owns completion");
    expect(COMPANION_IMAGE_SKILL_PROMPT).not.toContain("Mention no translation, tool, prompt, or process");
    const unavailable = composeCompanionSystemPrompt({ memoryEnabled: false, imageToolEnabled: false, soulPrompt: "Speak warmly." });
    expect(unavailable).not.toContain(COMPANION_IMAGE_SKILL_PROMPT);
  });
});
