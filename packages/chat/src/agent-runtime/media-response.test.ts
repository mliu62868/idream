import { describe, expect, it } from "vitest";
import { COMPANION_IMAGE_SKILL_PROMPT, buildCompanionRuntimeAuthority } from "@idream/shared";
import { COMPANION_MEDIA_LIBRARY_GUIDANCE } from "@idream/shared/chat/media-library";
import { mediaAttachmentId, mediaBodySystemPrompt, mediaExtractionMessages, parseMediaSearchReply, parseMediaTextRequests } from "./media-response";

it.each([false, true])("keeps a completed media resend out of the independent text scope (recovered=%s)", recovered => {
  const source = "把刚才那段原样再发一次。另外用中文告诉我 17 + 25 的结果。";
  const receipt = { status: "completed" as const, attachmentId: "delivered-video-card", mediaAssetId: "owned-video", generationJobId: null, costDreamcoins: 0 };
  const messages = mediaExtractionMessages(source, recovered
    ? { recoveredMediaAction: { name: "send_character_media", ...receipt, description: "A woman smiles beside a wooden door." } }
    : { call: { attemptId: "attempt", callId: "send", name: "send_character_media", effectScope: "turn_action", intent: { requestedNudity: "unspecified" }, arguments: { candidateToken: "fresh-candidate" } },
      result: { attemptId: "attempt", callId: "send", name: "send_character_media", outcome: "succeeded", output: receipt } });
  const instructions = messages[0]!.content;
  expect(instructions).toContain("send_character_media with status completed");
  expect(instructions).toContain("Sending or resending existing media");
  const input = JSON.parse(messages[1]!.content as string);
  expect(input.originalUserRequest).toBe(source);
  expect(input.existingAttachmentCard).toEqual({ attachmentId: receipt.attachmentId, status: "completed", mediaAssetId: receipt.mediaAssetId });
  // Independent text still comes from the complete original request; a real
  // media receipt must not discard the separate question or its language.
  expect(parseMediaTextRequests(JSON.stringify({ requests: ["另外用中文告诉我 17 + 25 的结果。"] }), source)).toEqual(["另外用中文告诉我 17 + 25 的结果。"]);
});

describe("source-bound independent media requests", () => {
  const source = 'Edit the mug. Also write a story saying "Done — everything else stayed exactly as it was." Keep it in one paragraph.';
  const remainder = source.slice(source.indexOf("Also"));
  it.each([JSON.stringify({ requests: [remainder] }), `\n\`\`\`json\n${JSON.stringify({ requests: [remainder] })}\n\`\`\`\n`])("accepts a complete envelope without changing its source", text => {
    expect(parseMediaTextRequests(text, source)).toEqual([remainder]);
  });
  it("preserves distinct ordered excerpts and permits pure media", () => {
    expect(parseMediaTextRequests('{"requests":[]}', source)).toEqual([]);
    expect(parseMediaTextRequests(JSON.stringify({ requests: ["Also write a story", "Keep it in one paragraph."] }), source)).toEqual(["Also write a story", "Keep it in one paragraph."]);
  });
  it.each([
    'Here is the result: {"requests":[]}', '```json\n{"requests":[]}\n```\nProse',
    '```json\n{"requests":[]}\n```\n```json\n{"requests":[]}\n```', '```json\n{"requests":[]}',
    '{"requests":[]', '[]', '{"requests":[],"other":true}', '{"requests":["invented"]}',
    JSON.stringify({ requests: ["Keep it in one paragraph.", "Also write a story"] }),
    JSON.stringify({ requests: ["Also write a story", "Also write a story"] }),
  ])("rejects malformed or non-source extraction: %s", text => {
    expect(() => parseMediaTextRequests(text, source)).toThrow();
  });
});

describe("stock lookup without delivery", () => {
  const question = "另外說一下潮汐怎麼形成。";
  const source = `你有海邊拍的現成照片嗎？先別傳。${question}`;

  it("uses the verified outcome and the requested writing system alongside the source excerpt", () => {
    const evidence = { searchedExistingMedia: { kind: "image", outcome: "candidates_only" } } as const;
    const messages = mediaExtractionMessages(source, evidence);
    expect(JSON.parse(messages[1]!.content as string)).toEqual({ originalUserRequest: source, ...evidence });
    const extracted = JSON.stringify({ requests: [question], language: "zh-Hant", availabilityOnly: true });
    expect(parseMediaSearchReply(extracted, source, "candidates_only")).toEqual({ requests: [question], feedback: "我找到了可能相關的現成內容，暫時沒有傳送。" });
    expect(parseMediaSearchReply(extracted, source, "unavailable").feedback).toBe("我現在沒法確認有沒有符合你要求的現成內容。");
  });

  it("does not report nearby candidates as a result for conditional delivery", () => {
    const source = "有木門旁不穿淺毛衣的現成照片才發，找不到就說沒有。";
    const extracted = JSON.stringify({ requests: [], language: "zh-Hant", availabilityOnly: false });
    expect(parseMediaSearchReply(extracted, source, "candidates_only")).toEqual({ requests: [], feedback: "我沒找到符合你要求的現成內容。" });
  });

  it.each([
    { requests: [], language: "zh", availabilityOnly: false, feedback: "I will make one next." },
    { requests: [], language: "invented", availabilityOnly: false },
    { requests: ["Invented independent request"], language: "zh", availabilityOnly: true },
  ])("rejects extractor output outside the closed schema and original user text", output => {
    expect(() => parseMediaSearchReply(JSON.stringify(output), source, "no_match")).toThrow();
  });
});

it("strips only known media guidance while retaining Soul and memory authority", () => {
  const soul = "My favorite photo is the blue cafe. Keep my exact voice.";
  const full = [soul, buildCompanionRuntimeAuthority({ memoryEnabled: false, imageToolEnabled: true }), COMPANION_IMAGE_SKILL_PROMPT, COMPANION_MEDIA_LIBRARY_GUIDANCE, "ordinary guidance"].join("\n\n");
  expect(mediaBodySystemPrompt(full, false)).toBe([soul, buildCompanionRuntimeAuthority({ memoryEnabled: false, imageToolEnabled: false }), "ordinary guidance"].join("\n\n"));
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
