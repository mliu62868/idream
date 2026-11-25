import { describe, expect, it } from "vitest";
import {
  canSkipMediaExtractionForPureMedia,
  extractMediaRoutingHint,
  mediaAttachmentId,
  mediaExtractionMessages,
  parseMediaSearchReply,
  parseMediaTextRequests,
  shouldBufferMediaLeadText,
} from "./media-response";

it.each([false, true])("keeps a completed media resend out of the independent text scope (recovered=%s)", recovered => {
  const source = "把刚才那段原样再发一次。另外用中文告诉我 17 + 25 的结果。";
  const receipt = { status: "completed" as const, attachmentId: "delivered-video-card", mediaAssetId: "owned-video", generationJobId: null, costDreamcoins: 0 };
  const messages = mediaExtractionMessages(source, recovered
    ? { recoveredMediaAction: { name: "resend_session_media", ...receipt, description: "A woman smiles beside a wooden door." } }
    : { call: { attemptId: "attempt", callId: "send", name: "resend_session_media", effectScope: "turn_action", intent: { requestedNudity: "unspecified" }, arguments: { previousMediaAssetId: receipt.mediaAssetId } },
      result: { attemptId: "attempt", callId: "send", name: "resend_session_media", outcome: "succeeded", output: receipt } });
  const instructions = messages[0]!.content;
  expect(instructions).toContain("A completed receipt confirms delivery");
  expect(instructions).toContain("Sending or resending existing media");
  const input = JSON.parse(messages[1]!.content as string);
  expect(input.originalUserRequest).toBe(source);
  expect(input.existingAttachmentCard).toEqual({ attachmentId: receipt.attachmentId, status: "completed", mediaAssetId: receipt.mediaAssetId });
  // Independent text still comes from the complete original request; a real
  // media receipt must not discard the separate question or its language.
  expect(parseMediaTextRequests("> 另外用中文告诉我 17 + 25 的结果。", source)).toEqual({ content: "另外用中文告诉我 17 + 25 的结果。", excerptCount: 1 });
});

describe("source-bound independent media requests", () => {
  const source = 'Edit the mug. Also write a story saying "Done — everything else stayed exactly as it was." Keep it in one paragraph.';
  it("preserves distinct ordered excerpts and permits pure media", () => {
    expect(parseMediaTextRequests("NONE", source)).toEqual({ content: "", excerptCount: 0 });
    expect(parseMediaTextRequests("> Also write a story\n\n> Keep it in one paragraph.", source)).toEqual({ content: "Also write a story\n\nKeep it in one paragraph.", excerptCount: 2 });
    expect(parseMediaTextRequests("> NONE", "Edit the mug and print NONE")).toEqual({ content: "NONE", excerptCount: 1 });
  });
  it.each(["\n", "\r\n"])("preserves quoted blank lines, indentation and literal quote markers (%j)", newline => {
    const excerpt = ["Also copy this layout:", "", "> quoted content", "  indented content  "].join(newline);
    const original = `Edit the mug. ${excerpt}`;
    const output = ["> Also copy this layout:", ">", "> > quoted content", ">   indented content  "].join(newline);
    expect(parseMediaTextRequests(`${newline}${output}${newline}`, original)).toEqual({ content: excerpt, excerptCount: 1 });
  });
  it.each([["\r\n", "\n"], ["\n", "\r\n"]])("recovers the original line endings when the provider changes them (%j to %j)", (sourceNewline, wireNewline) => {
    const lines = ["Keep this layout: [title].", "", "> Indent \\here."];
    const excerpt = lines.join(sourceNewline);
    const output = lines.map(line => `> ${line}`).join(wireNewline);
    expect(parseMediaTextRequests(output, `Find the original photo. ${excerpt}`)).toEqual({ content: excerpt, excerptCount: 1 });
  });
  it("rejects a carriage return added to the excerpt outside the line ending", () => {
    expect(() => parseMediaTextRequests("> First\r\r\n> Next", "First\r\nNext")).toThrow();
  });
  it.each([
    "", 'Here is the result:\n> Also write a story', '> Also write a story\nProse',
    'NONE\n\n> Also write a story', '```text\n> Also write a story\n```',
    '{"requests":[]}', '> ', '> invented',
    '> Keep it in one paragraph.\n\n> Also write a story',
    '> Also write a story\n\n> Also write a story',
  ])("rejects malformed or non-source extraction: %s", text => {
    expect(() => parseMediaTextRequests(text, source)).toThrow();
  });
});

describe("stock lookup without delivery", () => {
  const question = "另外說一下潮汐怎麼形成。";
  const source = `你有海邊拍的現成照片嗎？先別傳。${question}`;

  it("uses the verified outcome and the requested writing system alongside the source excerpt", () => {
    const evidence = { searchedExistingMedia: { kind: "image", outcome: "available" } } as const;
    const messages = mediaExtractionMessages(source, evidence);
    expect(JSON.parse(messages[1]!.content as string)).toEqual({ originalUserRequest: source, ...evidence });
    const extracted = `zh-Hant\n> ${question}`;
    expect(parseMediaSearchReply(extracted, source, "available")).toEqual({ requests: { content: question, excerptCount: 1 }, feedback: "我找到了可能相關的現成內容，暫時沒有傳送。" });
    expect(parseMediaSearchReply(extracted, source, "unavailable").feedback).toBe("我現在沒法確認有沒有符合你要求的現成內容。");
  });

  it("reports the Main no-match receipt for an existing-only request", () => {
    const source = "有木門旁不穿淺毛衣的現成照片才發，找不到就說沒有。";
    const extracted = "zh-Hant\nNONE";
    expect(parseMediaSearchReply(extracted, source, "no_match")).toEqual({ requests: { content: "", excerptCount: 0 }, feedback: "我沒找到符合你要求的現成內容。" });
  });

  it("retains both excerpts when a model spaces the unquoted separator", () => {
    const original = "先解釋潮汐。只傳港口的現成照片。再寫一句晚安。";
    expect(parseMediaSearchReply("zh-Hant\n> 先解釋潮汐。\n \t\n> 再寫一句晚安。", original, "no_match")).toEqual({
      requests: { content: "先解釋潮汐。\n\n再寫一句晚安。", excerptCount: 2 }, feedback: "我沒找到符合你要求的現成內容。",
    });
  });

  it.each([
    "zh\nNONE\nI will make one next.",
    "invented\nNONE",
    "zh",
    "zh\n> Invented independent request",
  ])("rejects invalid language, extra prose or text outside the original request", output => {
    expect(() => parseMediaSearchReply(output, source, "no_match")).toThrow();
  });
});

it("requires real acknowledged attachment identity", () => {
  const identity = { attemptId: "attempt", callId: "call", name: "edit_last_image" as const };
  expect(mediaAttachmentId({ ...identity, outcome: "succeeded", output: { status: "accepted", attachmentId: "real" } })).toBe("real");
  expect(mediaAttachmentId({ ...identity, outcome: "succeeded", output: { status: "awaiting_confirmation", attachmentId: "pending", generationJobId: null, mediaAssetId: null, costDreamcoins: 0 } })).toBe("pending");
  expect(mediaAttachmentId({ ...identity, outcome: "succeeded", output: { status: "awaiting_confirmation", attachmentId: " " } })).toBeUndefined();
  expect(mediaAttachmentId({ ...identity, outcome: "succeeded", output: { status: "requesting", attachmentId: "real" } })).toBeUndefined();
  expect(mediaAttachmentId({ ...identity, outcome: "failed", attachmentId: "real", error: { code: "failed", message: "failed", retryable: false } })).toBe("real");
  expect(mediaAttachmentId({ ...identity, outcome: "failed", error: { code: "http", message: "http", retryable: false } })).toBeUndefined();
});

describe("intent-aware media lead buffering and pure-media fast path", () => {
  it("streams ordinary text chat immediately while buffering media-intent or paid turns", () => {
    expect(shouldBufferMediaLeadText({ hasMediaTools: false, currentUserText: "Send me a photo" })).toBe(false);
    expect(shouldBufferMediaLeadText({ hasMediaTools: true, imageActionMode: "chat", currentUserText: "今天好累，陪我聊聊天吧" })).toBe(false);
    expect(shouldBufferMediaLeadText({ hasMediaTools: true, imageActionMode: "chat", currentUserText: "Tell me about your favorite book." })).toBe(false);
    expect(shouldBufferMediaLeadText({ hasMediaTools: true, imageActionMode: "paid", currentUserText: "Tell me about your favorite book." })).toBe(true);
    expect(shouldBufferMediaLeadText({ hasMediaTools: true, imageActionMode: "chat", currentUserText: "发一张自拍给我看" })).toBe(true);
    expect(shouldBufferMediaLeadText({ hasMediaTools: true, imageActionMode: "chat", currentUserText: "Edit the green mug to red." })).toBe(true);
    expect(shouldBufferMediaLeadText({
      hasMediaTools: true, imageActionMode: "chat", currentUserText: "好呀发吧", previousAssistantText: "要不要我给你发一张海边照片？",
    })).toBe(true);
    expect(shouldBufferMediaLeadText({
      hasMediaTools: true, imageActionMode: "chat", currentUserText: "好呀", previousAssistantText: "我们今晚去吃拉面吧？",
    })).toBe(false);
  });

  it("strips independentTextRequest before forwarding tool args to Main", () => {
    expect(extractMediaRoutingHint({ kind: "image", direction: "selfie", subject: "companion", independentTextRequest: false })).toEqual({
      independentTextRequest: false,
      toolArgs: { kind: "image", direction: "selfie", subject: "companion" },
    });
    expect(extractMediaRoutingHint({ previousMediaAssetId: "asset-1" })).toEqual({
      toolArgs: { previousMediaAssetId: "asset-1" },
    });
  });

  it("skips secondary extraction only when model declares false and the single-intent guard agrees", () => {
    expect(canSkipMediaExtractionForPureMedia("发一张海边自拍给我。", false)).toBe(true);
    expect(canSkipMediaExtractionForPureMedia("Send me a selfie by the window", false)).toBe(true);
    expect(canSkipMediaExtractionForPureMedia("发一张海边自拍给我。", undefined)).toBe(false);
    expect(canSkipMediaExtractionForPureMedia("发一张海边自拍给我。", true)).toBe(false);
    expect(canSkipMediaExtractionForPureMedia("发一张自拍，顺便告诉我明天天气", false)).toBe(false);
    expect(canSkipMediaExtractionForPureMedia("发一张自拍，夸夸我今天的表现", false)).toBe(false);
    expect(canSkipMediaExtractionForPureMedia("Send a photo, tell me a joke", false)).toBe(false);
    expect(canSkipMediaExtractionForPureMedia("Send a photo. Also explain tides.", false)).toBe(false);
    expect(canSkipMediaExtractionForPureMedia("Can you send a photo?", false)).toBe(false);
    expect(canSkipMediaExtractionForPureMedia("发一张自拍\n另外讲个故事", false)).toBe(false);
  });
});
