import { describe, expect, it } from "vitest";
import { chatVideoSources, isExplicitChatVideoRequest } from "./chat-video";
import type { RuntimeChatMessage } from "./public-api-contracts";

describe("explicit Chat video actions", () => {
  it("opens a quote for explicit video creation", () => {
    for (const text of [
      "Generate a video.", "Make a video of this moment.", "Can you create a video?", "Animate this image slowly.",
      "请帮我生成一个视频", "请给我制作一个视频", "帮我做个动画",
    ]) expect(isExplicitChatVideoRequest(text), text).toBe(true);
  });

  it("keeps ordinary video requests, resends, discussion and negation in Chat", () => {
    for (const text of [
      "Please send me a short clip.", "Send me an existing prepared video.", "Could you show me that clip again?",
      "Show me a video of the coast.", "发送一段短视频", "发给我库存视频", "再发一次刚才的视频", "给我看一段动画",
      "I watched a video yesterday.", "Do not make a video.", "Don't send a clip.", "不要生成视频", "What is video generation?", "Send me a photo.",
    ]) expect(isExplicitChatVideoRequest(text), text).toBe(false);
  });

  it("offers only delivered images on completed pinned replies, preserving each group speaker's session", () => {
    const reply = { id: "reply", role: "assistant", status: "sent", content: "Here it is.", turnId: "turn", attempt: 2,
      attachments: [{ id: "attachment", kind: "generated_image", status: "completed", mediaAssetId: "image", mediaUrl: "/image.png" }],
    } satisfies RuntimeChatMessage;
    const groupReply = { ...reply, sessionId: "member-session", characterId: "member-character" };
    expect(chatVideoSources([groupReply], { sessionId: "group", characterId: null })).toEqual([{ sessionId: "member-session", characterId: "member-character", turnId: "turn", attempt: 2, mediaAssetId: "image", url: "/image.png" }]);
    expect(chatVideoSources([
      { ...reply, status: "generating" },
      { ...reply, attachments: [{ ...reply.attachments[0], status: "failed" }] },
      { ...reply, attachments: [{ ...reply.attachments[0], kind: "generated_video" }] },
    ], { sessionId: "session", characterId: "character" })).toEqual([]);
  });
});
