import { describe, expect, it } from "vitest";
import { requiredImageCaptionAuthority } from "@idream/shared/chat/image-action";
import {
  AGENT_TOOL_REGISTRY,
  EDIT_LAST_IMAGE_TOOL,
  findAgentTool,
  GENERATE_IMAGE_ASYNC_TOOL,
  imageIntentForUserRequest,
  imageToolCaption,
  requiredImageToolCallForUserRequest,
  registryChatTools,
} from "./agent-tools.js";

describe("DSH image tool registry", () => {
  it("exposes only the Chat-owned image bridge schemas", () => {
    expect(AGENT_TOOL_REGISTRY.map((tool) => tool.name)).toEqual([
      GENERATE_IMAGE_ASYNC_TOOL,
      EDIT_LAST_IMAGE_TOOL,
    ]);
    expect(registryChatTools()).toEqual([
      expect.objectContaining({
        name: GENERATE_IMAGE_ASYNC_TOOL,
        parameters: expect.objectContaining({ required: ["prompt"] }),
      }),
      expect.objectContaining({
        name: EDIT_LAST_IMAGE_TOOL,
        parameters: expect.objectContaining({ required: ["instruction"] }),
      }),
    ]);
  });

  it("validates generated-image calls without a second planner", () => {
    expect(findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)?.parseCall({
      prompt: "A detailed portrait beside a sunlit window",
    })).toEqual({
      name: GENERATE_IMAGE_ASYNC_TOOL,
      arguments: {
        prompt: "A detailed portrait beside a sunlit window",
        orientation: "4:5",
        outputCount: 1,
      },
    });
    expect(findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)?.parseCall({ prompt: "short" }))
      .toBeNull();
  });

  it("validates edit calls and rejects unknown tools", () => {
    expect(findAgentTool(EDIT_LAST_IMAGE_TOOL)?.parseCall({
      instruction: "Change the background to snow",
    })).toEqual({
      name: EDIT_LAST_IMAGE_TOOL,
      arguments: { instruction: "Change the background to snow" },
    });
    expect(findAgentTool(EDIT_LAST_IMAGE_TOOL)?.parseCall({ instruction: "x" }))
      .toBeNull();
    expect(findAgentTool("unknown_tool")).toBeUndefined();
  });

  it("uses a deterministic caption fallback", () => {
    expect(imageToolCaption({
      name: EDIT_LAST_IMAGE_TOOL,
      arguments: { instruction: "Change the background to snow" },
    }, "Mina")).toBe("Mina will make that image for you now.");
  });

  it("keeps delivery truth out of the character caption", () => {
    expect(requiredImageCaptionAuthority("Fine. One photo—don't make me regret it."))
      .toEqual({ valid: true });
    expect(requiredImageCaptionAuthority("先好好说话，再考虑给不给你。"))
      .toEqual({ valid: false, reason: "negotiation" });
    expect(requiredImageCaptionAuthority("*snaps a selfie* There you go."))
      .toEqual({ valid: false, reason: "invented_completion" });
  });

  it.each([
      "给我一个你的裸照",
      "我要你的裸照",
      "给我一张你的照片",
      "给我一张你在屋顶花园里的 4:5 随手照",
      "发张你的自拍",
      "发个自拍",
      "拍给我看看",
      "你发一张自拍吧",
      "别光聊天，给张照片",
      "Show me a selfie by the window",
      "send a selfie",
      "send your photo",
  ])("turns an explicit new-image request into a required Chat tool call: %s", (userText) => {
    expect(requiredImageToolCallForUserRequest({
      userText,
      characterName: "Raya Reyes",
    })).toEqual({
      name: GENERATE_IMAGE_ASYNC_TOOL,
      arguments: {
        prompt: `Create an in-character photo of Raya Reyes. User request: ${userText}`,
        orientation: "4:5",
        outputCount: 1,
      },
    });
  });

  it("turns an explicit last-image change into the edit tool", () => {
    expect(requiredImageToolCallForUserRequest({
      userText: "把上一张照片换成红裙子",
      characterName: "Raya Reyes",
    })).toEqual({
      name: EDIT_LAST_IMAGE_TOOL,
      arguments: { instruction: "把上一张照片换成红裙子" },
    });
  });

  it.each([
    "让我看看你现在穿什么",
    "能看看你现在的样子吗",
    "穿睡衣给我看看",
    "来点福利",
    "send me something spicy",
  ])("treats a high-confidence show-me paraphrase as a required image: %s", (userText) => {
    expect(imageIntentForUserRequest({ userText, characterName: "Raya Reyes" }))
      .toMatchObject({ kind: "generate" });
  });

  it.each([
    "换个姿势",
    "改一下背景",
    "try a different outfit",
  ])("treats a contextual visual change as an edit intent: %s", (userText) => {
    expect(imageIntentForUserRequest({
      userText,
      characterName: "Raya Reyes",
      hasRecentImageContext: true,
    }))
      .toMatchObject({ kind: "edit", reason: "contextual_image_edit" });
  });

  it.each([
    "换个姿势",
    "改一下背景",
    "try a different outfit",
  ])("does not invent an edit without a recent image: %s", (userText) => {
    expect(imageIntentForUserRequest({
      userText,
      characterName: "Raya Reyes",
      hasRecentImageContext: false,
    })).toEqual({ kind: "none", reason: "discussion_or_ambiguous" });
  });

  it.each([
    "不要发照片",
    "你喜欢拍照吗？",
    "我们聊聊你上一张照片",
    "Can you generate images?",
    "你觉得什么姿势更好看？",
    "不要给我看你现在穿什么",
    "do not send your photo",
  ])("does not force a tool for negation or image discussion: %s", (userText) => {
    expect(requiredImageToolCallForUserRequest({
      userText,
      characterName: "Raya Reyes",
    })).toBeNull();
  });
});
