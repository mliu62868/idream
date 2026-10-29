import { describe, expect, it } from "vitest";
import { composeCompanionSystemPrompt } from "./companion-agent-prompt";
import { COMPANION_IMAGE_SKILL_PROMPT, COMPANION_IMAGE_SKILL_VERSION } from "./image-skill";
import { EDIT_LAST_IMAGE_TOOL, IMAGE_AGENT_TOOL_DEFINITIONS } from "./image-action";

describe("image receipt grounding contract", () => {
  it("distinguishes call success from image delivery in the actual composed prompt", () => {
    const prompt = composeCompanionSystemPrompt({ memoryEnabled: false, imageToolEnabled: true, soulPrompt: "Speak warmly.", characterName: "Sophie" });
    expect(prompt).toContain(COMPANION_IMAGE_SKILL_PROMPT);
    expect(prompt).toContain(`Image direction skill (${COMPANION_IMAGE_SKILL_VERSION})`);
    expect(prompt).toContain("acknowledge output.status");
    expect(prompt).toContain("the user's requested format");
    expect(prompt).toContain("accepted or queued means still processing");
    expect(prompt).toContain("use present/future tense throughout, never claim completion");
    expect(prompt).toContain("completed confirms delivery only");
    expect(prompt).toContain("outcome=succeeded confirms the call, not completion");
  });

  it("keeps image descriptions within the request and the evidence returned", () => {
    expect(COMPANION_IMAGE_SKILL_PROMPT).toContain("the requested subjects and scene");
    expect(COMPANION_IMAGE_SKILL_PROMPT).toContain("Never claim visual correctness or unchanged pixels from a status receipt");
    expect(COMPANION_IMAGE_SKILL_PROMPT).toContain("attachment state owns completion");
    expect(COMPANION_IMAGE_SKILL_PROMPT).not.toContain("Mention no translation, tool, prompt, or process");
    const unavailable = composeCompanionSystemPrompt({ memoryEnabled: false, imageToolEnabled: false, soulPrompt: "Speak warmly." });
    expect(unavailable).not.toContain(COMPANION_IMAGE_SKILL_PROMPT);
  });

  it("advertises editing as an asynchronous request with no visual proof in its receipt", () => {
    const edit = IMAGE_AGENT_TOOL_DEFINITIONS.find(tool => tool.name === EDIT_LAST_IMAGE_TOOL)!;
    expect(edit.description).toContain("asynchronous edit of the LAST delivered photo");
    expect(edit.description).toContain("accepted/queued means still processing");
    expect(edit.description).toContain("completed confirms delivery only, not visual correctness");
    expect(edit.description).toContain("not unrelated scenes; preserve identity");
  });
});
