import { describe, expect, it, vi } from "vitest";
import type { CharacterMediaLibraryEntry } from "@prisma/client";
import { passesPaidCuratedGateA, routeCuratedMediaReadOnly } from "./media-fulfillment-router";

function entry(overrides?: Partial<CharacterMediaLibraryEntry>): CharacterMediaLibraryEntry {
  return {
    id: "cml_1",
    characterId: "char_1",
    sourceAssetId: "asset_1",
    visualProfileId: "vp_1",
    visualProfileVersion: 1,
    kind: "image",
    status: "published",
    description: "Luna wearing a red dress at the beach at sunset.",
    facts: ["red dress", "beach", "sunset"],
    absentFacts: ["glasses", "hat"],
    nudity: "none",
    attireLevel: "fully_clothed",
    nudityVerifiedById: "admin_1",
    distributionScope: "chat_library",
    nearDuplicateClusterId: null,
    photoSetId: null,
    durationSeconds: null,
    hasAudio: null,
    audioType: null,
    paidDeliveryCount: 0,
    width: 1024,
    height: 1280,
    contentType: "image/jpeg",
    storageKey: "character-chat-library/char_1/cml_1/media",
    thumbnailKey: null,
    contentHash: "a".repeat(64),
    descriptionSource: "operator",
    descriptorModel: null,
    embedding: [1, 0],
    embeddingModel: "fixture",
    embeddingDimensions: 2,
    embeddingHash: "b".repeat(64),
    revision: 1,
    sourceSnapshot: {},
    createdById: "admin_1",
    updatedById: "admin_1",
    createdAt: new Date("2026-11-20T00:00:00Z"),
    updatedAt: new Date("2026-11-20T00:00:00Z"),
    publishedAt: new Date("2026-11-20T00:00:00Z"),
    ...overrides,
  };
}

describe("Paid curated media Gate A & lockless routing", () => {
  it("enforces strict wardrobe, distributionScope, closed-world mustExclude, mustHave, and video constraints", () => {
    const beachPhoto = entry();
    expect(passesPaidCuratedGateA(beachPhoto, {
      kind: "image", requestedNudity: "none", mustHave: ["red dress", "beach"], mustExclude: ["glasses"],
    })).toBe(true);
    expect(passesPaidCuratedGateA(beachPhoto, {
      kind: "image", requestedNudity: "none", mustHave: ["red dress"], mustExclude: [], orientation: "landscape",
    })).toBe(false);

    // Closed-world strict exclusion: "sunglasses" not confirmed in absentFacts -> reject!
    expect(passesPaidCuratedGateA(beachPhoto, {
      kind: "image", requestedNudity: "none", mustHave: ["red dress"], mustExclude: ["sunglasses"],
    })).toBe(false);

    // Pack-exclusive assets never leak into chat library fulfillment.
    expect(passesPaidCuratedGateA(entry({ distributionScope: "pack_exclusive" }), {
      kind: "image", requestedNudity: "none", mustHave: [], mustExclude: [],
    })).toBe(false);

    // Partial nudity must match exactly when explicitly requested.
    expect(passesPaidCuratedGateA(entry({ nudity: "partial" }), {
      kind: "image", requestedNudity: "partial", mustHave: [], mustExclude: [],
    })).toBe(true);
    expect(passesPaidCuratedGateA(entry({ nudity: "none" }), {
      kind: "image", requestedNudity: "partial", mustHave: [], mustExclude: [],
    })).toBe(false);

    // Video duration & audio checks.
    const vid = entry({ kind: "video", durationSeconds: 5, hasAudio: true });
    expect(passesPaidCuratedGateA(vid, {
      kind: "video", requestedNudity: "none", mustHave: [], mustExclude: [],
      minDurationSeconds: 4, maxDurationSeconds: 6, hasAudio: true,
    })).toBe(true);
    expect(passesPaidCuratedGateA(vid, {
      kind: "video", requestedNudity: "none", mustHave: [], mustExclude: [],
      hasAudio: false,
    })).toBe(false);
  });

  it("bypasses library immediately for force_new, scene subjects, and non-official characters", async () => {
    const searchImpl = vi.fn();
    const base = {
      userId: "user_1",
      characterId: "char_1",
      characterSource: "official",
      visualProfileId: "vp_1",
      visualProfileVersion: 1,
      searchImpl,
    };

    expect(await routeCuratedMediaReadOnly({
      ...base,
      args: { kind: "image", direction: "red dress", subject: "companion", requestedNudity: "none", mustHave: [], mustExclude: [], mode: "force_new" },
    })).toEqual({ route: "live_gen", reason: "force_new_requested" });

    expect(await routeCuratedMediaReadOnly({
      ...base,
      args: { kind: "image", direction: "empty beach", subject: "scene", requestedNudity: "unspecified", mustHave: [], mustExclude: [], mode: "auto" },
    })).toEqual({ route: "live_gen", reason: "scene_subject" });

    expect(await routeCuratedMediaReadOnly({
      ...base,
      characterSource: "user",
      args: { kind: "image", direction: "red dress", subject: "companion", requestedNudity: "none", mustHave: [], mustExclude: [], mode: "auto" },
    })).toEqual({ route: "live_gen", reason: "non_official_character" });

    expect(await routeCuratedMediaReadOnly({
      ...base,
      characterSource: "user",
      args: { kind: "video", direction: "waving", subject: "companion", requestedNudity: "none", mustHave: [], mustExclude: [], mode: "auto" },
    })).toEqual({ route: "no_delivery", reason: "non_official_character" });

    expect(searchImpl).not.toHaveBeenCalled();
  });

  it("selects verified high-score official library hit and gracefully falls back on low score or timeout", async () => {
    const candidate = entry();
    const hit = await routeCuratedMediaReadOnly({
      userId: "user_1",
      characterId: "char_1",
      characterSource: "official",
      visualProfileId: "vp_1",
      visualProfileVersion: 1,
      args: { kind: "image", direction: "red dress at the beach", subject: "companion", requestedNudity: "none", mustHave: ["red dress"], mustExclude: ["glasses"], mode: "auto" },
      searchImpl: vi.fn().mockResolvedValue([{ entry: candidate, score: 0.46, scoreSource: "rerank", alreadySent: false }]),
    });
    expect(hit).toEqual({ route: "delayed_library", entry: candidate, score: 0.46 });

    // Low score -> early fallback to live_gen (never forces bad paid photo).
    const lowScore = await routeCuratedMediaReadOnly({
      userId: "user_1",
      characterId: "char_1",
      characterSource: "official",
      visualProfileId: "vp_1",
      visualProfileVersion: 1,
      args: { kind: "image", direction: "red dress", subject: "companion", requestedNudity: "none", mustHave: [], mustExclude: [], mode: "auto" },
      searchImpl: vi.fn().mockResolvedValue([{ entry: candidate, score: 0.5, scoreSource: "dense", alreadySent: false }]),
    });
    expect(lowScore).toEqual({ route: "live_gen", reason: "no_verified_match" });

    // Search timeout/error -> safe fallback (live_gen for image, no_delivery for video).
    const failedImg = await routeCuratedMediaReadOnly({
      userId: "user_1",
      characterId: "char_1",
      characterSource: "official",
      visualProfileId: "vp_1",
      visualProfileVersion: 1,
      args: { kind: "image", direction: "red dress", subject: "companion", requestedNudity: "none", mustHave: [], mustExclude: [], mode: "auto" },
      searchImpl: vi.fn().mockRejectedValue(new Error("embedding timeout")),
    });
    expect(failedImg).toEqual({ route: "live_gen", reason: "lookup_unavailable_or_timeout" });

    const failedVid = await routeCuratedMediaReadOnly({
      userId: "user_1",
      characterId: "char_1",
      characterSource: "official",
      visualProfileId: "vp_1",
      visualProfileVersion: 1,
      args: { kind: "video", direction: "waving", subject: "companion", requestedNudity: "none", mustHave: [], mustExclude: [], mode: "auto" },
      searchImpl: vi.fn().mockRejectedValue(new Error("embedding timeout")),
    });
    expect(failedVid).toEqual({ route: "no_delivery", reason: "lookup_unavailable_or_timeout" });
  });
});
