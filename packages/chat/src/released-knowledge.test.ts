import { describe, expect, it } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import { buildReleasedKnowledgeSnapshot } from "./released-knowledge.js";

function personaSnapshot(input?: {
  facts?: string[];
  unknowns?: string[];
}) {
  const compiled = compileCharacterSoul({
    name: "Mira",
    age: 29,
    gender: "female",
    relationship: "trusted companion",
    description: "A precise observatory keeper.",
    personality: "Grounded and curious.",
    canon: {
      facts: input?.facts ?? ["The observatory windows are blue."],
      unknowns: input?.unknowns ?? ["What lies beyond the northern ridge."],
    },
  });
  if (!compiled.ok) throw new Error("invalid Soul fixture");
  return compiled.snapshot;
}

const authority = {
  characterId: "character-1",
  contentVersion: {
    contentVersionId: "ccv-1",
    characterId: "character-1",
    personaSnapshot: personaSnapshot(),
  },
  release: {
    releaseId: "release-1",
    characterId: "character-1",
    characterContentVersionId: "ccv-1",
    status: "published",
  },
} as const;

describe("released knowledge authority", () => {
  it("compiles only immutable released canon into deterministic knowledge bytes", () => {
    expect(buildReleasedKnowledgeSnapshot(authority)).toEqual({
      characterId: "character-1",
      characterContentVersionId: "ccv-1",
      characterReleaseId: "release-1",
      digest: "d37a13320ba031adbd638566d9c935640c7e21275eff1b852a1b992d337af98f",
      files: [{
        path: "canon.md",
        content: [
          "# Canon facts",
          "",
          "- The observatory windows are blue.",
          "",
          "# Canon unknowns",
          "",
          "- What lies beyond the northern ridge.",
          "",
        ].join("\n"),
      }],
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

  it("emits a pinned empty snapshot when released canon has no content", () => {
    expect(buildReleasedKnowledgeSnapshot({
      ...authority,
      contentVersion: {
        ...authority.contentVersion,
        personaSnapshot: personaSnapshot({ facts: [], unknowns: [] }),
      },
    })).toEqual({
      characterId: "character-1",
      characterContentVersionId: "ccv-1",
      characterReleaseId: "release-1",
      digest: "98de209836814980660e80630bd93e2774a1745dabdb7c7bb124647deb13ca09",
      files: [],
    });
  });

  it("emits an empty digest without consulting immutable content when no release is pinned", () => {
    expect(buildReleasedKnowledgeSnapshot({
      characterId: "character-1",
      contentVersion: null,
      release: null,
    })).toEqual({
      characterId: "character-1",
      characterContentVersionId: "legacy-unattributed",
      characterReleaseId: null,
      digest: "105eeb3b7da80af178083cdcd5a37d702e64d0d2daa2ca51f531e11992de875f",
      files: [],
    });
  });
});
