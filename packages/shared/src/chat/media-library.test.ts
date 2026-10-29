import { describe, expect, it } from "vitest";
import {
  parseCharacterMediaToolCall, searchCharacterMediaArgsSchema, searchCharacterMediaResultSchema,
  sendCharacterMediaArgsSchema, sendCharacterMediaResultSchema,
  CHARACTER_MEDIA_TOOL_DEFINITIONS, SEARCH_CHARACTER_MEDIA_TOOL,
} from "./media-library";

const candidate = {
  candidateToken: "signed-candidate", kind: "video", description: "Mira walks beside the sea in a blue dress.",
  facts: ["blue dress", "seaside"], absentFacts: ["hat"], durationSeconds: 8.5,
  hasAudio: false, alreadySent: false, score: 0.78,
};
const receipt = {
  accepted: true, duplicate: false, status: "completed", attachmentId: "attachment-1",
  mediaAssetId: "asset-1", generationJobId: null, costDreamcoins: 0, source: "library",
  description: candidate.description,
};

describe("Character media lookup and delivery contracts", () => {
  it("preserves every explicit search condition without turning it into generation", () => {
    const args = { kind: "video", query: "Mira at the sea, blue dress, no hat, silent, 6-10 seconds",
      requestedNudity: "none",
      unseenOnly: true, minDurationSeconds: 6, maxDurationSeconds: 10, hasAudio: false };
    expect(parseCharacterMediaToolCall("search_character_media", args)?.arguments).toEqual(args);
    for (const invalid of [
      { ...args, minDurationSeconds: 11 }, { ...args, hasAudio: "false" },
      { ...args, kind: "image" },
      { ...args, query: " " }, { ...args, generateOnMiss: true },
    ]) expect(searchCharacterMediaArgsSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps negation in the complete query without model-authored exact fact filters", () => {
    const args = { kind: "image", query: "Blue cardigan and green mug, without a hat", requestedNudity: "none" };
    expect(searchCharacterMediaArgsSchema.parse(args)).toEqual(args);
    for (const fields of [
      { requiredFacts: ["blue cardigan", "green mug", "no hat"] },
      { excludedFacts: ["hat"] },
    ]) expect(searchCharacterMediaArgsSchema.safeParse({ ...args, ...fields }).success).toBe(false);
    const search = CHARACTER_MEDIA_TOOL_DEFINITIONS.find(tool => tool.name === SEARCH_CHARACTER_MEDIA_TOOL)!;
    expect(search.parameters.properties).not.toHaveProperty("requiredFacts");
    expect(search.parameters.properties).not.toHaveProperty("excludedFacts");
    expect(search.parameters.additionalProperties).toBe(false);
    expect((search.parameters.properties as Record<string, { description?: string }>).query?.description).toContain("negation");
  });

  it("requires exactly one opaque send source and never accepts a new prompt", () => {
    expect(sendCharacterMediaArgsSchema.parse({ candidateToken: "signed-candidate" })).toEqual({ candidateToken: "signed-candidate" });
    expect(sendCharacterMediaArgsSchema.parse({ previousMediaAssetId: "asset-1" })).toEqual({ previousMediaAssetId: "asset-1" });
    for (const invalid of [{}, { candidateToken: "" }, { previousMediaAssetId: " " },
      { candidateToken: "candidate", previousMediaAssetId: "asset" },
      { candidateToken: "candidate", prompt: "change the outfit" }, { mediaAssetId: "asset" },
    ]) expect(sendCharacterMediaArgsSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps lookup observations separate from attachment and payment receipts", () => {
    expect(searchCharacterMediaResultSchema.parse({ accepted: true, status: "matches", matches: [candidate] }).matches).toEqual([candidate]);
    expect(searchCharacterMediaResultSchema.parse({ accepted: true, status: "no_match", matches: [] })).not.toHaveProperty("attachmentId");
    for (const invalid of [
      { accepted: true, status: "completed", matches: [candidate] },
      { accepted: true, status: "no_match", matches: [candidate] },
      { accepted: true, status: "matches", matches: [] },
      { accepted: true, status: "matches", matches: [{ ...candidate, score: Infinity }] },
      { accepted: true, status: "no_match", matches: [], attachmentId: "invented" },
    ]) expect(searchCharacterMediaResultSchema.safeParse(invalid).success).toBe(false);
    const fullFacts = Array.from({ length: 48 }, (_, index) => `${index}:${"a".repeat(156)}`);
    expect(searchCharacterMediaResultSchema.safeParse({ accepted: true, status: "matches", matches: [{ ...candidate, facts: fullFacts }] }).success).toBe(true);
  });

  it("accepts only completed free deliveries with no Generation job", () => {
    expect(sendCharacterMediaResultSchema.parse(receipt)).toEqual(receipt);
    expect(sendCharacterMediaResultSchema.parse({ ...receipt, duplicate: true, source: "previous_media", description: null }).duplicate).toBe(true);
    for (const invalid of [
      { ...receipt, accepted: false }, { ...receipt, status: "accepted" },
      { ...receipt, costDreamcoins: 5 }, { ...receipt, generationJobId: "job-1" },
      { ...receipt, attachmentId: null }, { ...receipt, mediaAssetId: null },
      { ...receipt, source: "generated" }, { ...receipt, duplicate: undefined },
    ]) expect(sendCharacterMediaResultSchema.safeParse(invalid).success).toBe(false);
  });
});
