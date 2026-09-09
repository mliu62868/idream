import { describe, expect, it } from "vitest";
import {
  imageIntentForUserRequest,
  requiredImageReplyMatchesUserScript,
} from "./image-action";

describe("Chat image action authority", () => {
  it.each([
    "Edit the picture you just sent: change only the notebook from blue to green. Preserve the same face, hairstyle, clothes, pose, background and camera framing. Make the edited picture now.",
    "Edit the picture you just sent: change only the notebook from green to red. Preserve the same face, hairstyle, clothes, pose, background and camera framing. Do not change anything else. Make the edited picture now.",
    "Please modify the photo you sent me: make the notebook green.",
    "Change the image you just generated to use a green notebook.",
  ])("authorizes editing an explicitly referenced delivered image: %s", (userText) => {
    expect(imageIntentForUserRequest({ userText, hasRecentImageContext: true })).toMatchObject({
      kind: "edit", reason: "explicit_last_image_edit", action: { name: "edit_last_image" },
    });
  });

  it.each([".", "!", "?", ";", "。", "！", "？", "；"])("keeps preservation negation within its own clause (%s)", separator => {
    expect(imageIntentForUserRequest({
      userText: `Edit this image: make the notebook red. Do not change anything else${separator} Make the edited picture now.`,
      hasRecentImageContext: true,
    })).toMatchObject({ kind: "edit", action: { name: "edit_last_image" } });
    expect(imageIntentForUserRequest({
      userText: `把这张图片里的本子改红。别改其他${separator}生成修改后的图片。`,
      hasRecentImageContext: true,
    })).toMatchObject({ kind: "edit", action: { name: "edit_last_image" } });
  });

  it("keeps a separate new-image request after an unrelated negative instruction", () => {
    expect(imageIntentForUserRequest({ userText: "Do not change the topic. Make a picture of the rainy window." }))
      .toMatchObject({ kind: "generate", action: { name: "generate_image_async" } });
  });

  it.each([
    'Please explain "edit the picture you just sent".',
    "Do not edit the picture you just sent.",
    "How would you edit the photo you sent me?",
    "I like the picture you just sent.",
    "Edit this image: make the notebook red. Actually, do not edit this picture.",
    "Do not generate any images. Let's only discuss how you would edit this picture.",
    "Make a picture; no need to send any photo.",
    "Don't want any pictures. Let's talk.",
    "把这张图片里的本子改红。别生成图片。",
    "不要再给我发图片；只讨论这张图片。",
    "不想看图片。聊聊窗外的雨吧。",
    "How would you edit this image? Do not change anything else. Explain the picture in words.",
  ])("does not authorize editing from discussion or negation: %s", (userText) => {
    expect(imageIntentForUserRequest({ userText, hasRecentImageContext: true }).kind).toBe("none");
  });

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
