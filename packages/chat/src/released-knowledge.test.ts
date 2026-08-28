import { describe, expect, it } from "vitest";
import { buildReleasedKnowledgeSnapshot } from "./released-knowledge.js";

const authority = {
  characterId: "character-1",
  contentVersion: {
    contentVersionId: "ccv-1",
    characterId: "character-1",
  },
  release: {
    releaseId: "release-1",
    characterId: "character-1",
    characterContentVersionId: "ccv-1",
    status: "published",
  },
} as const;

describe("released knowledge authority", () => {
  it("keeps knowledge files empty because the pinned system prompt already contains the whole Soul", () => {
    expect(buildReleasedKnowledgeSnapshot(authority)).toEqual({
      characterId: "character-1",
      characterContentVersionId: "ccv-1",
      characterReleaseId: "release-1",
      digest: "98de209836814980660e80630bd93e2774a1745dabdb7c7bb124647deb13ca09",
      files: [],
    });
  });

  it.each(["draft", "approved", "withdrawn"])(
    "rejects %s release state instead of reading candidate knowledge",
    (status) => {
      expect(() => buildReleasedKnowledgeSnapshot({
        ...authority,
        release: { ...authority.release, status },
      })).toThrow(/not released/);
    },
  );

  it("rejects cross-character and cross-content release pins", () => {
    expect(() => buildReleasedKnowledgeSnapshot({
      ...authority,
      release: { ...authority.release, characterId: "character-2" },
    })).toThrow(/does not belong to character/);
    expect(() => buildReleasedKnowledgeSnapshot({
      ...authority,
      release: {
        ...authority.release,
        characterContentVersionId: "ccv-2",
      },
    })).toThrow(/does not pin content version/);
    expect(() => buildReleasedKnowledgeSnapshot({
      ...authority,
      contentVersion: { ...authority.contentVersion, characterId: "character-2" },
    })).toThrow(/content version.*does not belong/);
  });

  it("rejects an unattributed character instead of inventing legacy content authority", () => {
    expect(() => buildReleasedKnowledgeSnapshot({
      characterId: "character-1",
      contentVersion: null,
      release: null,
    } as never)).toThrow(/no immutable content version/);
  });
});
