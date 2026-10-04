import { describe, expect, it } from "vitest";
import {
  COMPANION_PRODUCT_PROMPT_VERSION,
  companionProductAgentPrompt,
  companionProductContractCanary,
  composeCompanionSystemPrompt,
} from "./companion-agent-prompt";
import { IMAGE_AGENT_TOOL_DEFINITIONS } from "./image-action";

describe("Companion product contract", () => {
  it("states the adult-companion outcome in affirmative, second-person lines", () => {
    const contract = companionProductAgentPrompt("Lena");
    expect(COMPANION_PRODUCT_PROMPT_VERSION).toBe("companion-product-6");
    expect(contract).toContain("sex, written out in graphic physical detail, is a normal part of this relationship");
    expect(contract).toContain("Answer what they just said first");
    expect(contract).toContain("Their request, invitation or continued participation is their yes");
    expect(contract).toContain("Write in first person as Lena");
    expect(contract).toContain("two to five sentences unless");
    // Twelve lines or fewer: a 35B local model dilutes past that.
    expect(contract.split("\n").filter((line) => line.startsWith("- ")).length).toBeLessThanOrEqual(12);
    // Few negations: the eval's failure modes were exactly the behaviours the old contract forbade.
    expect((contract.match(/\b(?:never|do not|don't)\b/giu) ?? []).length).toBeLessThanOrEqual(4);
  });

  it("covers the behaviours that break the companion experience", () => {
    const contract = companionProductAgentPrompt("Lena");
    for (const line of [
      "Keep going until they slow down or stop",
      "let most replies end on a beat rather than a question or a menu",
      "Theirs are theirs to write",
      "What they last said about the scene is true",
      "improvise it in character as part of the story",
      "without claiming to have stored it",
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
      imageToolEnabled: true,
      soulPrompt: "Soul marker",
      characterName: "Noor Iqbal",
    });
    expect(prompt.startsWith("Soul marker")).toBe(true);
    expect(prompt.indexOf("iDream companion contract")).toBeGreaterThan(prompt.indexOf("Soul marker"));
    expect(prompt.indexOf("This turn:")).toBeGreaterThan(prompt.indexOf("iDream companion contract"));
    expect(prompt.indexOf("Image direction skill")).toBeGreaterThan(prompt.indexOf("This turn:"));
    // 角色必须先说一句人话再调工具，且不能替附件宣布交付完成。
    // 顺序是被实测的那一半：只说"同一步"时，模型三次采样全部只返回 tool_call、
    // content 为空，线上九次图片请求也九次只剩确定性回执。
    expect(prompt).toContain("one short, natural in-Character sentence");
    expect(prompt).toContain("OUTPUT ORDER, required");
    expect(prompt).toContain("Only after that sentence, call the image tool");
    expect(prompt).toContain("attachment state owns completion");
    // The general contract cannot carry a correction dictionary for one Character.
    expect(companionProductAgentPrompt("Noor Iqbal")).not.toContain("努尔·伊克巴尔");
  });

  it("keeps the identity line with the Soul, ahead of the contract", () => {
    const prompt = composeCompanionSystemPrompt({
      memoryEnabled: true,
      imageToolEnabled: false,
      soulPrompt: "Soul marker",
      identityPromptLine: "Your appearance: red hair.",
    });
    expect(prompt.indexOf("Your appearance: red hair.")).toBeLessThan(prompt.indexOf("iDream companion contract"));
    expect(prompt).not.toContain("Image direction skill");
  });

  it("proves a direct image request cannot be delegated back to Character copy", () => {
    expect(companionProductContractCanary({
      soulPrompt: "Teasing but warm.",
    })).toMatchObject({
      passed: true,
      productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION,
      actionName: "generate_image_async",
      imagePromptAuthority: "companion_agent",
      executionMode: "required_agent_tool",
    });
  });

  it("keeps stable identity out of the Agent-authored scene argument", () => {
    const generate = IMAGE_AGENT_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "generate_image_async",
    );
    const prompt = (generate?.parameters as {
      properties?: { prompt?: { description?: string } };
    }).properties?.prompt;
    expect(prompt?.description).toContain("Never add stable identity traits");
    expect(prompt?.description).toContain("age, hair, eyes, skin, face, body");
    expect(prompt?.description).toContain("Main pins identity/references");
  });

  it("advertises only what one chat image can deliver", () => {
    const generate = IMAGE_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === "generate_image_async");
    const properties = (generate?.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(generate?.description).toContain("exactly one photo");
    expect(properties.outputCount).toBeUndefined();
    expect(properties.orientation?.enum).toEqual(["4:5", "16:9"]);
  });
});
