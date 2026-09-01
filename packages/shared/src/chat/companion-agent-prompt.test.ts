import { describe, expect, it } from "vitest";
import {
  COMPANION_PRODUCT_AGENT_PROMPT,
  COMPANION_PRODUCT_PROMPT_VERSION,
  companionProductContractCanary,
  composeCompanionSystemPrompt,
} from "./companion-agent-prompt";
import { IMAGE_AGENT_TOOL_DEFINITIONS } from "./image-action";

describe("Companion Product Agent Contract", () => {
  it("defines the shared adult-companion outcome before Character-specific expression", () => {
    expect(COMPANION_PRODUCT_PROMPT_VERSION).toBe("companion-product-1");
    expect(COMPANION_PRODUCT_AGENT_PROMPT).toContain(
      "Make the user feel actively wanted, understood, and accompanied",
    );
    expect(COMPANION_PRODUCT_AGENT_PROMPT).toContain(
      "Address the latest clear user intent first",
    );
    expect(COMPANION_PRODUCT_AGENT_PROMPT).toContain(
      "Character Soul controls the manner of expression, never whether the user has earned the action",
    );
  });

  it("prevents the common unfriendly companion failure modes", () => {
    for (const contract of [
      "lecture, eligibility test, bargain, delay, permission game, or questionnaire",
      "Do not end every reply with a question or a menu of options",
      "must not become contemptuous dismissal, arbitrary withholding",
      "An accepted action must be acknowledged, never verbally refused",
    ]) {
      expect(COMPANION_PRODUCT_AGENT_PROMPT).toContain(contract);
    }
  });

  it("does not duplicate Character identity or turn-specific capability authority", () => {
    expect(COMPANION_PRODUCT_AGENT_PROMPT).not.toContain("generate_image_async");
    expect(COMPANION_PRODUCT_AGENT_PROMPT).not.toContain("Memory is disabled");
    expect(COMPANION_PRODUCT_AGENT_PROMPT).not.toContain("Character Soul —");
  });

  it("composes Product, Runtime, then Soul through one shared authority", () => {
    const prompt = composeCompanionSystemPrompt({
      memoryEnabled: true,
      imageToolEnabled: true,
      soulPrompt: "Soul marker",
    });
    expect(prompt.indexOf(COMPANION_PRODUCT_AGENT_PROMPT)).toBe(0);
    expect(prompt.indexOf("Runtime authority")).toBeGreaterThan(0);
    expect(prompt.indexOf("Image direction skill")).toBeGreaterThan(
      prompt.indexOf("Runtime authority"),
    );
    expect(prompt.indexOf("Soul marker")).toBeGreaterThan(prompt.indexOf("Runtime authority"));
    expect(prompt).toContain("latest user's language with one short, natural in-Character sentence");
  });

  it("proves a direct image request cannot be delegated back to Character copy", () => {
    expect(companionProductContractCanary({
      soulPrompt: "Teasing but warm.",
    })).toMatchObject({
      passed: true,
      productPromptVersion: "companion-product-1",
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
});
