import { describe, expect, it } from "vitest";
import { imageReplyMatchesUserScript, parseImageAgentToolCall } from "./image-action";

describe("Agent-authored image arguments", () => {
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
