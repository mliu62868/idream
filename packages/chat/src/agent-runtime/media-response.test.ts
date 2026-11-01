import { describe, expect, it } from "vitest";
import { COMPANION_IMAGE_SKILL_PROMPT, buildCompanionRuntimeAuthority } from "@idream/shared";
import { COMPANION_MEDIA_LIBRARY_GUIDANCE } from "@idream/shared/chat/media-library";
import { mediaAttachmentId, mediaBodySystemPrompt, parseMediaTextRequests } from "./media-response";

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
