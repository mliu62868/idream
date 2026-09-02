import { describe, expect, it } from "vitest";
import {
  imageIntentForUserRequest,
  requiredImageReplyMatchesUserScript,
} from "./image-action";

describe("Chat image action authority", () => {
  it("takes the confirmed scene and boundary only from the precise proposal", () => {
    expect(imageIntentForUserRequest({
      previousAssistantText: "Earlier we talked about nude photography. Would you like a photo by the window?",
      userText: "Yes.",
    })).toMatchObject({ kind: "generate", confirmedOffer: "Would you like a photo by the window?", action: { requestedNudity: "unspecified" } });
  });
  it.each([
    "If you could take a photo, what would it look like?",
    "How do you make a photo look vintage?",
    "假设让你生成一张照片，你会选什么场景？",
    "What reflection would you photograph from our window?",
    "Imagine you could send a photo of the view; what would it show?",
    'Please explain the phrase "send me a photo" in French.',
    'Can you translate "send me a selfie" into Chinese?',
  ])("keeps hypothetical photography questions text-only: %s", (userText) => {
    expect(imageIntentForUserRequest({ userText })).toMatchObject({ kind: "none" });
  });

  it.each([
    ["Would you like me to send you a photo?", "Yes, please."],
    ["Want to see a selfie by the window?", "Sure!"],
    ["Shall I take a portrait for you?", "Go ahead."],
    ["要不要我发张自拍给你？", "好，发吧。"],
    ["想看我在窗边的照片吗？", "可以。"],
  ])("authorizes a clear confirmation of the immediately preceding image offer: %s", (previousAssistantText, userText) => {
    expect(imageIntentForUserRequest({ userText, previousAssistantText })).toMatchObject({
      kind: "generate", reason: "confirmed_image_offer",
    });
  });

  it.each([
    ["Would you like me to send you a photo?", "No, let's just talk."],
    ["Would you like me to send you a photo?", "What reflection would you photograph from our window?"],
    ["Would you like me to send you a photo?", "Yes, but don't send it."],
    ["Do you enjoy photography?", "Yes, please."],
    ["Shall we discuss the photo?", "Yes."],
    ["Want a photo? Do you also enjoy coffee?", "Yes."],
    ["I framed us by the glass — your reflection layered over the rainy street, my hair still damp from outside. Want me to send it to you?", "Yes."],
    ["要不要我发张自拍给你？", "不，聊聊雨吧。"],
    ["你喜欢摄影吗？", "好。"],
    ["要不要聊聊照片？", "可以。"],
    [undefined, "Yes, please."],
  ])("does not infer consent from discussion, negation, or a missing offer: %s", (previousAssistantText, userText) => {
    expect(imageIntentForUserRequest({ userText: userText!, previousAssistantText })).toMatchObject({ kind: "none" });
  });

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
