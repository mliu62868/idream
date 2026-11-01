import { describe, expect, it } from "vitest";
import { composeCompanionSystemPrompt } from "./companion-agent-prompt";
import { COMPANION_IMAGE_SKILL_PROMPT, COMPANION_IMAGE_SKILL_VERSION } from "./image-skill";
import { EDIT_LAST_IMAGE_TOOL, IMAGE_AGENT_TOOL_DEFINITIONS } from "./image-action";

describe("image receipt grounding contract", () => {
  it("distinguishes call success from image delivery in the actual composed prompt", () => {
    const prompt = composeCompanionSystemPrompt({ memoryEnabled: false, imageToolEnabled: true, soulPrompt: "Speak warmly.", characterName: "Sophie" });
    expect(prompt).toContain(COMPANION_IMAGE_SKILL_PROMPT);
    expect(prompt).toContain(`Image direction skill (${COMPANION_IMAGE_SKILL_VERSION})`);
    expect(prompt).toContain("The actual attachment card owns media status");
    expect(prompt).toContain("do not add a separate media acknowledgement or claim visual correctness");
    expect(prompt).toContain("awaiting_confirmation means no image was generated or charged");
    expect(prompt).toContain("the user must choose and confirm the area first");
    expect(prompt).toContain("accepted/queued means processing, completed means delivered");
    expect(prompt).toContain("Continue only independently requested text");
    expect(prompt).toContain("outcome=succeeded confirms the tool call, not the image");
  });

  it("keeps image descriptions within the request and the evidence returned", () => {
    expect(COMPANION_IMAGE_SKILL_PROMPT).toContain("the requested subjects and scene");
    expect(COMPANION_IMAGE_SKILL_PROMPT).toContain("Never claim visual correctness or unchanged pixels from a status receipt");
    expect(COMPANION_IMAGE_SKILL_PROMPT).toContain("attachment state owns completion");
    expect(COMPANION_IMAGE_SKILL_PROMPT).not.toContain("Mention no translation, tool, prompt, or process");
    const unavailable = composeCompanionSystemPrompt({ memoryEnabled: false, imageToolEnabled: false, soulPrompt: "Speak warmly." });
    expect(unavailable).not.toContain(COMPANION_IMAGE_SKILL_PROMPT);
  });

  it("requires local confirmation and keeps asynchronous delivery separate from visual proof", () => {
    const edit = IMAGE_AGENT_TOOL_DEFINITIONS.find(tool => tool.name === EDIT_LAST_IMAGE_TOOL)!;
    expect(edit.description).toContain("edit of the LAST delivered photo");
    expect(edit.description).toContain("Local edits return an area-confirmation card");
    expect(edit.description).toContain("no generation or charge occurs until the user confirms");
    expect(edit.description).toContain("Whole-image edits run asynchronously");
    expect(edit.description).toContain("completed confirms delivery, not visual correctness");
    expect(edit.parameters).toMatchObject({
      required: expect.arrayContaining(["editScope"]),
      properties: {
        editScope: {
          description: expect.stringContaining("Never use whole_image to bypass confirmation for a localized request"),
        },
      },
    });
    expect(COMPANION_IMAGE_SKILL_PROMPT).toContain("Character identity stays fixed");
  });
});
