import { describe, expect, it } from "vitest";
import {
  imageIntentForUserRequest,
  requiredImageReplyMatchesUserScript,
} from "./image-action";

describe("Chat image action authority", () => {
  it.each([
    "给我一张自拍，但不要裸照，要穿睡袍",
    "不要全裸，穿内衣给我一张自拍",
    "send me a selfie, not nude, in a robe",
    "take a picture, but no nudity",
  ])("keeps an image request while preserving an explicit no-nudity constraint: %s", (userText) => {
    expect(imageIntentForUserRequest({ userText })).toMatchObject({
      kind: "generate",
      action: {
        name: "generate_image_async",
        requestedNudity: "none",
      },
    });
  });

  it.each([
    "给我一张你的全裸自拍",
    "给我裸照，不穿衣服",
    "send me a fully nude selfie",
    "take a picture without any clothes",
  ])("recognizes an affirmative full-nudity request: %s", (userText) => {
    expect(imageIntentForUserRequest({ userText })).toMatchObject({
      kind: "generate",
      action: { requestedNudity: "full" },
    });
  });

  it("rejects an unrelated-language image reply for a Han-script request", () => {
    expect(requiredImageReplyMatchesUserScript(
      "给我一张自拍",
      "Je peux te renvoyer la dernière photo.",
    )).toBe(false);
    expect(requiredImageReplyMatchesUserScript(
      "给我一张自拍",
      "给你，今晚的我。",
    )).toBe(true);
  });
});
