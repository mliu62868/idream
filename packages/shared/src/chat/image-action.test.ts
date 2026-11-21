import { describe, expect, it } from "vitest";
import { EDIT_LAST_IMAGE_TOOL_DEFINITION, editLastImageArgsSchema, imageReplyMatchesUserScript } from "./image-action";

describe("image action contract", () => {
  it("keeps the spoken reply outside the edit definition", () => {
    expect(EDIT_LAST_IMAGE_TOOL_DEFINITION.parameters.properties).not.toHaveProperty("caption");
    expect(editLastImageArgsSchema.parse({ instruction: "Change the coat to red", caption: "While it develops." })).toHaveProperty("caption");
    expect(editLastImageArgsSchema.safeParse({ instruction: "Change the coat to red", requestedNudity: "unknown" }).success).toBe(false);
  });

  it("rejects an unrelated writing system in an image reply", () => {
    expect(imageReplyMatchesUserScript("给我一张自拍", "Je peux te renvoyer la dernière photo.")).toBe(false);
    expect(imageReplyMatchesUserScript("给我一张自拍", "等我一下，今晚的我给你看。")).toBe(true);
  });
});
