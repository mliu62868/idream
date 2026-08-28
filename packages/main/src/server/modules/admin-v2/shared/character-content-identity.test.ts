import {
  loadCharacterSoulSnapshot,
  type CharacterSoulSnapshot,
} from "@idream/shared";
import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "./canonical-json";
import {
  characterContentHash,
  legacyCutoverContentIdentity,
  officialEditorialContentIdentity,
  officialEditorialSoulContentIdentity,
} from "./character-content-identity";

// SPEC: these digests were produced by the five inline call sites that existed
// before this module, against the fixtures below. They are the identity of rows
// that are already in the database. A failure here means content identity moved:
// existing versions would split in two and rollback would stop resolving. Do not
// re-record the expected values — migrate the data instead.

const personaSnapshot = {
  schemaVersion: 1,
  soul: {
    identity: {
      name: "Aria",
      age: 24,
      gender: "female",
      characterPromise: "warm and steady",
    },
    voice: { tone: "soft", vocabulary: ["dear", "hey"] },
  },
  compiled: {
    compilerVersion: "character-soul-1",
    systemPrompt: "COMPILED PROMPT BYTES",
    fingerprint: "0123456789abcdef",
    estimatedTokens: 42,
  },
  // Only `soul` and `compiled.compilerVersion` take part in the hash, so a
  // partial snapshot is the honest fixture for this formula.
} as unknown as CharacterSoulSnapshot;

const openingSnapshot = { firstMessage: "hey, you came back" };
const appearanceSnapshot = { style: "anime", appearance: { hair: "black" } };

const legacyCharacter = {
  name: "Aria",
  age: 24,
  description: "warm and steady companion",
  systemPrompt: "legacy system prompt",
  style: "anime",
  gender: "female",
  appearance: { hair: "black", eyes: "amber" },
  advancedDetails: {
    personality: "warm",
    firstMessage: "hey, you came back",
    visualBrief: "soft rim light",
  },
};

describe("character content identity", () => {
  it("pins the compiled-Soul content hash", () => {
    expect(
      characterContentHash({ personaSnapshot, openingSnapshot, appearanceSnapshot }),
    ).toBe("c6a6c824b18bd463f37b020e299d933a26660a039874639bf8dfd065b0485a7c");
  });

  it("ignores compiled prompt bytes, so runtime artifacts are not authoring authority", () => {
    const recompiled = {
      ...personaSnapshot,
      compiled: {
        ...personaSnapshot.compiled,
        systemPrompt: "DIFFERENT PROMPT BYTES",
        fingerprint: "ffffffffffffffff",
        estimatedTokens: 999,
      },
    };
    expect(
      characterContentHash({
        personaSnapshot: recompiled,
        openingSnapshot,
        appearanceSnapshot,
      }),
    ).toBe(
      characterContentHash({ personaSnapshot, openingSnapshot, appearanceSnapshot }),
    );
  });

  it("gives a compiler upgrade a new content identity", () => {
    const upgraded = {
      ...personaSnapshot,
      compiled: { ...personaSnapshot.compiled, compilerVersion: "character-soul-2" },
    };
    expect(
      characterContentHash({
        personaSnapshot: upgraded,
        openingSnapshot,
        appearanceSnapshot,
      }),
    ).not.toBe(
      characterContentHash({ personaSnapshot, openingSnapshot, appearanceSnapshot }),
    );
  });

  it("pins the legacy cutover content hash", () => {
    expect(legacyCutoverContentIdentity(legacyCharacter).contentHash).toBe(
      "d0b1df27aeb14a49f3d89baf30de419d97754ee1b2dcd2a120892f3a6c9e578d",
    );
  });

  it("pins the official editorial import content hash", () => {
    expect(officialEditorialContentIdentity(legacyCharacter).contentHash).toBe(
      "66bec2bd09a433f05f959c8d309585964f18a119e389d22112ad3a2f2d30f7fc",
    );
  });

  it("builds a complete immutable Soul for new official editorial releases", () => {
    const identity = officialEditorialSoulContentIdentity(legacyCharacter);
    const loaded = loadCharacterSoulSnapshot(identity.snapshot.persona);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.snapshot.soul).toMatchObject({
      name: "Aria",
      age: 24,
      gender: "female",
      characterPromise: "warm and steady companion",
    });
    expect(loaded.snapshot.soul.detailsMarkdown).toContain("## Personality");
    expect(identity.snapshot.opening).toEqual({
      firstMessage: "hey, you came back",
    });
    expect(identity.contentHash).toBe(characterContentHash({
      personaSnapshot: identity.snapshot.persona,
      openingSnapshot: identity.snapshot.opening,
      appearanceSnapshot: identity.snapshot.appearance,
    }));
  });

  it("does not append retired flat persona fields to authored editorial details", () => {
    const identity = officialEditorialSoulContentIdentity({
      ...legacyCharacter,
      advancedDetails: {
        ...legacyCharacter.advancedDetails,
        detailsMarkdown: "CURRENT EDITORIAL SOUL",
        backstory: "RETIRED BACKSTORY",
      },
    });
    const loaded = loadCharacterSoulSnapshot(identity.snapshot.persona);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.snapshot.soul.detailsMarkdown).toBe("CURRENT EDITORIAL SOUL");
    expect(loaded.snapshot.soul.detailsMarkdown).not.toContain("RETIRED BACKSTORY");
  });

  it("pins both legacy shapes when advancedDetails carries nothing", () => {
    const bare = {
      ...legacyCharacter,
      systemPrompt: null,
      advancedDetails: null,
    };
    expect(legacyCutoverContentIdentity(bare).contentHash).toBe(
      "bca00e7bad60628149451af04294ff4d570a6bd209a00f6e144848ad42fb9004",
    );
    expect(officialEditorialContentIdentity(bare).contentHash).toBe(
      "e2abaf66cd160508cb52b884249df32ec1e3ef810fef5061b6fb82b228e4b952",
    );
  });

  it("keeps the two legacy shapes distinct for the same Character", () => {
    // They read different fields off the same row, so they must never be folded
    // into one function "because they look alike".
    expect(legacyCutoverContentIdentity(legacyCharacter).contentHash).not.toBe(
      officialEditorialContentIdentity(legacyCharacter).contentHash,
    );
  });

  it("reads a non-string opening as absent only in the editorial shape", () => {
    const numericOpening = {
      ...legacyCharacter,
      advancedDetails: { ...legacyCharacter.advancedDetails, firstMessage: 7 },
    };
    expect(
      officialEditorialContentIdentity(numericOpening).snapshot.opening.firstMessage,
    ).toBeNull();
    expect(
      legacyCutoverContentIdentity(numericOpening).snapshot.opening.firstMessage,
    ).toBe(7);
  });

  it("hashes exactly the snapshot it hands back for persistence", () => {
    // The columns a caller writes and the hash it keys them by come from one
    // call, so they cannot drift into describing different content.
    for (const identity of [
      legacyCutoverContentIdentity(legacyCharacter),
      officialEditorialContentIdentity(legacyCharacter),
    ]) {
      expect(canonicalSha256(identity.snapshot)).toBe(identity.contentHash);
    }
  });
});
