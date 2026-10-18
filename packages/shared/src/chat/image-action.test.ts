import { describe, expect, it } from "vitest";
import { IMAGE_AGENT_TOOL_DEFINITIONS, imageReplyMatchesUserScript, parseImageAgentToolCall } from "./image-action";

describe("Agent-authored image arguments", () => {
  it.each(IMAGE_AGENT_TOOL_DEFINITIONS)("leaves the spoken reply out of $name model arguments", tool => {
    expect(tool.parameters.properties).not.toHaveProperty("caption");
  });

  it.each([
    { name: "generate_image_async", arguments: { prompt: "A portrait beside the rainy bedroom window", subject: "companion" } },
    { name: "edit_last_image", arguments: { instruction: "Change the coat to red" } },
  ])("preserves a historical $name caption for call replay", call => {
    const caption = "Here is the historical photo caption.";
    expect(parseImageAgentToolCall(call.name, { ...call.arguments, caption })?.arguments).toHaveProperty("caption", caption);
  });

  it.each(["none", "full", "unspecified"] as const)("preserves %s wardrobe intent without interpreting user text", requestedNudity => {
    expect(parseImageAgentToolCall("generate_image_async", {
      prompt: "A portrait beside the rainy bedroom window", subject: "companion", requestedNudity,
    })).toMatchObject({ arguments: { requestedNudity, orientation: "4:5", outputCount: 1 } });
    expect(parseImageAgentToolCall("edit_last_image", {
      instruction: "Change the coat to red", requestedNudity,
    })).toMatchObject({ arguments: { requestedNudity } });
  });

  it("refuses invalid wardrobe values and new images without a subject", () => {
    expect(parseImageAgentToolCall("generate_image_async", { prompt: "A rainy window portrait" })).toBeNull();
    expect(parseImageAgentToolCall("edit_last_image", { instruction: "Change the coat to red", requestedNudity: "unknown" })).toBeNull();
  });

  it("rejects an unrelated writing system in an image reply", () => {
    expect(imageReplyMatchesUserScript("给我一张自拍", "Je peux te renvoyer la dernière photo.")).toBe(false);
    expect(imageReplyMatchesUserScript("给我一张自拍", "等我一下，今晚的我给你看。")).toBe(true);
  });
});
