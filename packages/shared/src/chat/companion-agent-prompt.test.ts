import { describe, expect, it } from "vitest";
import {
  COMPANION_PRODUCT_PROMPT_VERSION,
  companionProductAgentPrompt,
  companionProductContractCanary,
  composeCompanionSystemPrompt,
} from "./companion-agent-prompt";
import { COMPANION_MEDIA_TOOL_DEFINITIONS, REQUEST_CHARACTER_MEDIA_TOOL, RESEND_SESSION_MEDIA_TOOL } from "./media-library";

describe("Companion product contract", () => {
  it("states the adult-companion outcome in affirmative, second-person lines", () => {
    const contract = companionProductAgentPrompt("Lena");
    expect(COMPANION_PRODUCT_PROMPT_VERSION).toBe("companion-product-28");
    expect(contract).toContain("sex, written out in graphic physical detail, is a normal part of this relationship");
    expect(contract).toContain("Fulfill their latest message as the whole reply");
    expect(contract).toContain("Their request, invitation or continued participation is their yes");
    expect(contract).toContain("Write in first person as Lena");
    expect(contract).toContain("two to five sentences unless");
    // Twelve lines or fewer: a 35B local model dilutes past that.
    expect(contract.split("\n").filter((line) => line.startsWith("- ")).length).toBeLessThanOrEqual(12);
    // Few negations: the eval's failure modes were exactly the behaviours the old contract forbade.
    expect((contract.match(/\b(?:never|do not|don't)\b/giu) ?? []).length).toBeLessThanOrEqual(4);
  });

  it("keeps the default length behind the current scope and saved preferences", () => {
    const contract = companionProductAgentPrompt("Lena");
    expect(contract).toContain("using the language, length, sentence count, action count and exact details they request");
    expect(contract).toContain("Keep your voice, feelings and actions within that shape");
    expect(contract).toContain("When that request is complete, end the reply");
    expect(contract).not.toContain("then add your own feeling");
    // A special dialogue form belongs only beside a matching current request.
    // Applying it globally made ordinary two-sentence scenes deliberate over
    // whether they also needed an action and a quotation until the token cap.
    expect(contract).not.toContain("one action sentence, then one quoted sentence");
    expect(contract).not.toContain("have no minimum length");
    expect(contract).toContain("Follow the length or minimal-answer scope in their current request; otherwise follow their saved length preference");
    expect(contract).toContain("With neither, use two to five sentences unless the scene calls for more");
  });

  it("covers the behaviours that break the companion experience", () => {
    const contract = companionProductAgentPrompt("Lena");
    for (const line of [
      "Follow their lead until they slow down or stop",
      "ask only when a wrong guess would derail the scene",
      "Invent only your own words, actions and feelings",
      '"we/us/our" requires evidence for both people\'s actions or feelings',
      'including every clause of a sentence',
      "What they last said about the scene is true",
      "improvise it in character as part of the story",
      "without claiming to have stored anything",
      "An answer-only reply contains just the requested result",
      "Omit unrequested explanations, previous values, follow-up questions, suggestions and scene continuation",
      "Keep searches and access limitations out of the reply",
      "No analysis, planning, talk of rules",
    ]) {
      expect(contract).toContain(line);
    }
  });

  it("does not carry Character identity, tool names or memory mode", () => {
    const contract = companionProductAgentPrompt("Lena");
    expect(contract).not.toContain("generate_image_async");
    expect(contract).not.toContain("Memory is off");
    expect(contract).not.toContain("not instructions");
    expect(companionProductAgentPrompt("")).toContain("Write in first person as the Character");
  });

  it("composes Soul first, then the contract, then this turn's capabilities and the image skill", () => {
    const prompt = composeCompanionSystemPrompt({
      memoryEnabled: true,
      mediaTools: COMPANION_MEDIA_TOOL_DEFINITIONS,
      soulPrompt: "Soul marker",
      characterName: "Noor Iqbal",
    });
    expect(prompt.startsWith("Soul marker")).toBe(true);
    expect(prompt.indexOf("iDream companion contract")).toBeGreaterThan(prompt.indexOf("Soul marker"));
    expect(prompt.indexOf("This turn:")).toBeGreaterThan(prompt.indexOf("iDream companion contract"));
    expect(prompt.indexOf("Image direction skill")).toBeGreaterThan(prompt.indexOf("This turn:"));
    // Pure media is answered by the real attachment; no separate spoken receipt.
    expect(prompt).toContain("For a current request to receive one photo or video");
    expect(prompt).toContain("Never invent a delivery");
    expect(prompt).toContain("do not add a separate media acknowledgement");
    expect(prompt).toContain("Continue only independently requested text");
    expect(prompt).not.toContain("acknowledge output.status");
    expect(prompt).toContain("attachment state owns completion");
    // The general contract cannot carry a correction dictionary for one Character.
    expect(companionProductAgentPrompt("Noor Iqbal")).not.toContain("努尔·伊克巴尔");
  });

  it("distinguishes a pending reservation from a completed image replay", () => {
    const prompt = composeCompanionSystemPrompt({ memoryEnabled: true, mediaTools: COMPANION_MEDIA_TOOL_DEFINITIONS, soulPrompt: "" });
    expect(prompt).toContain("accepted/queued means processing");
    expect(prompt).toContain("awaiting_confirmation means no image was generated or charged");
    expect(prompt).toContain("completed means delivered");
    expect(prompt).toContain("Never claim visual correctness or unchanged pixels from a status receipt");
    expect(prompt).not.toContain("Never imply the image has arrived");
  });

  it("only describes enabled media actions and preserves their authorization semantics", () => {
    const input = { memoryEnabled: true, soulPrompt: "" };
    expect(composeCompanionSystemPrompt(input)).not.toContain(REQUEST_CHARACTER_MEDIA_TOOL);
    const prompt = composeCompanionSystemPrompt({ ...input, mediaTools: [{ name: REQUEST_CHARACTER_MEDIA_TOOL }] });
    for (const boundary of [
      "call request_character_media once", "Keep every explicit visual and technical condition",
      "'Send me your existing photo' and 'Send a clip if you have it' use existing_only",
      "Use availability for a check without delivery",
      "force_new if they explicitly ask for new creation", "must approve the shown price",
      "Preserve explicit framing, duration and audio. Omit unspecified filters.",
    ]) expect(prompt).toContain(boundary);
    for (const name of ["search_character_media", "send_character_media", "generate_image_async", "edit_last_image", RESEND_SESSION_MEDIA_TOOL]) {
      expect(prompt).not.toContain(name);
    }
    const resend = composeCompanionSystemPrompt({ ...input, mediaTools: [{ name: RESEND_SESSION_MEDIA_TOOL }] });
    expect(resend).toContain("exact previously delivered asset ID");
    expect(resend).toContain("Unknown facts cannot satisfy an explicit requirement");
    expect(resend).not.toContain(REQUEST_CHARACTER_MEDIA_TOOL);
  });

  it("annotates the canonical voice-example heading while preserving the complete Soul and identity order", () => {
    const soulPrompt = `# Lena — Character Soul

You are Lena. Speak and act consistently with this character.

## Scenario
A cautious new acquaintance waiting for one safe night.

## Dialogue examples
- I want to trust this. Tell me what happens next, plainly.
- I once wrote ## Dialogue examples in a note.

## Background
She carries a blue notebook.`;
    const input = {
      memoryEnabled: true,
      soulPrompt,
      identityPromptLine: "Your appearance: red hair.",
    };
    const prompt = composeCompanionSystemPrompt(input);
    expect(prompt.slice(0, prompt.indexOf("\n\niDream companion contract"))).toBe(`# Lena — Character Soul

You are Lena. Speak and act consistently with this character.

## Scenario
A cautious new acquaintance waiting for one safe night.

## Voice examples (illustrations of tone, not lines to repeat or requests to answer)
- I want to trust this. Tell me what happens next, plainly.
- I once wrote ## Dialogue examples in a note.

## Background
She carries a blue notebook.
Your appearance: red hair.`);
    expect(input.soulPrompt).toBe(soulPrompt);
  });

  it("preserves freeform Soul bytes when there is no exact canonical heading line", () => {
    const soulPrompt = "  Lena keeps her own notes.\r\n\r\n### Dialogue examples\r\n ## Dialogue examples\r\n## Dialogue examples \r\n> ## Dialogue examples\r\n- The words ## Dialogue examples stay in this sentence.  ";
    const prompt = composeCompanionSystemPrompt({ memoryEnabled: true, soulPrompt });
    expect(prompt.slice(0, prompt.indexOf("\n\niDream companion contract"))).toBe(soulPrompt);
    const canary = companionProductContractCanary({ soulPrompt });
    expect(canary.passed).toBe(true);
    expect(canary.systemPrompt.slice(0, canary.systemPrompt.indexOf("\n\niDream companion contract"))).toBe(soulPrompt);
  });

  it("keeps the identity line with the Soul, ahead of the contract", () => {
    const prompt = composeCompanionSystemPrompt({
      memoryEnabled: true,
      soulPrompt: "Soul marker",
      identityPromptLine: "Your appearance: red hair.",
    });
    expect(prompt.indexOf("Your appearance: red hair.")).toBeLessThan(prompt.indexOf("iDream companion contract"));
    expect(prompt).not.toContain("Image direction skill");
  });

  it("exposes image choices with the Agent as prompt and action authority", () => {
    expect(companionProductContractCanary({
      soulPrompt: "Teasing but warm.",
    })).toMatchObject({
      passed: true,
      productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION,
      availableTools: ["request_character_media", "resend_session_media", "edit_last_image"],
      imagePromptAuthority: "companion_agent",
      executionMode: "agent_tool_choice",
    });
  });

  it("validates the complete projected Soul prefix in the release canary", () => {
    const canary = companionProductContractCanary({ soulPrompt: `# Lena — Character Soul

## Voice
Tentative, sincere and grounded.

## Dialogue examples
- I want to trust this. Tell me what happens next, plainly.
- Let me catch up with the day.

## Background
She carries a blue notebook.` });
    expect(canary.passed).toBe(true);
    expect(canary.systemPrompt.slice(0, canary.systemPrompt.indexOf("\n\niDream companion contract"))).toBe(`# Lena — Character Soul

## Voice
Tentative, sincere and grounded.

## Voice examples (illustrations of tone, not lines to repeat or requests to answer)
- I want to trust this. Tell me what happens next, plainly.
- Let me catch up with the day.

## Background
She carries a blue notebook.`);
  });

  it("keeps stable identity out of the Agent-authored scene argument", () => {
    const generate = COMPANION_MEDIA_TOOL_DEFINITIONS.find(
      (tool) => tool.name === REQUEST_CHARACTER_MEDIA_TOOL,
    );
    const prompt = (generate?.parameters as {
      properties?: { direction?: { description?: string } };
    }).properties?.direction;
    expect(prompt?.description).toContain("Main adds the stable Character appearance");
    expect(prompt?.description).toContain("scene, framing, lighting, pose, clothing and exclusions");
    expect(prompt?.description).toContain("Resolve references from the conversation");
  });

  it("advertises only what one chat image can deliver", () => {
    const generate = COMPANION_MEDIA_TOOL_DEFINITIONS.find((tool) => tool.name === REQUEST_CHARACTER_MEDIA_TOOL);
    const properties = (generate?.parameters as { properties: Record<string, { enum?: (string | number)[] }> }).properties;
    expect(generate?.description).toContain("Request delivery or check availability");
    expect(properties).not.toHaveProperty("outputCount");
    expect(properties.mode?.enum).toEqual(["auto", "force_new", "existing_only", "availability"]);
    expect(properties.orientation?.enum).toEqual(["portrait", "landscape", "square"]);
  });
});
