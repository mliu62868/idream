import type { CharacterSoulSnapshot } from "@idream/shared";
import { canonicalSha256 } from "./canonical-json";

// SPEC: `CharacterContentVersion.contentHash` is the identity of one immutable
// content version. `@@unique([characterId, contentHash])` makes it do two jobs at
// once: an edit that lands on an existing hash reuses that version instead of
// appending one (explicit rollback), and callers compare it to detect that
// content moved under them before they write.
//
// INVARIANT: these formulas are frozen. Every row already in the database was
// keyed by the exact bytes below — changing a formula splits one logical version
// into two, and makes a rollback unable to find the version it means to return
// to. Changing one is a data migration with a rehash pass, not a refactor.
// `character-content-identity.test.ts` pins each formula to a literal digest so
// that an "innocent" edit fails in CI instead of in the unique index.
//
// INTENT: three shapes live here on purpose rather than being folded into one.
// They hash different field sets read off different sources, so unifying them
// would rewrite the identity of every row the retired shape produced.

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * The current authoring identity: every path that produces content by running
 * the shared Soul compiler — user Character edits, Admin drafts and Soul
 * versions, reviewed repository imports.
 *
 * INTENT: hashes the canonical Soul plus the compiler identity, never the
 * compiled prompt bytes. Those bytes are deterministic output; including them
 * would make a runtime artifact a second authoring authority. A compiler upgrade
 * still yields a new version, because `compilerVersion` is part of the payload.
 */
export function characterContentHash(input: {
  readonly personaSnapshot: CharacterSoulSnapshot;
  readonly openingSnapshot: unknown;
  readonly appearanceSnapshot: unknown;
}): string {
  return canonicalSha256({
    soul: input.personaSnapshot.soul,
    compilerVersion: input.personaSnapshot.compiled.compilerVersion,
    openingSnapshot: input.openingSnapshot,
    appearanceSnapshot: input.appearanceSnapshot,
  });
}

export interface LegacyCharacterContentFields {
  readonly name: string;
  readonly age: number;
  readonly description: string;
  readonly systemPrompt: string | null;
  readonly style: string;
  readonly gender: string;
  readonly appearance: unknown;
  readonly advancedDetails: unknown;
}

/**
 * Identity for rows minted by the legacy cutover backfill, which had no compiled
 * Soul to hash and could only read the flat mutable Character columns.
 *
 * INTENT: kept separate from {@link officialEditorialContentIdentity} even though
 * both hash flat columns. This one carries `personality` and `visualBrief` and no
 * `relationship`, and takes `firstMessage` unconditionally — the editorial shape
 * does the opposite on all three counts. Merging them would re-key every
 * `legacy_cutover_snapshot` row and make the backfill non-idempotent on rerun.
 */
export function legacyCutoverContentIdentity(
  character: LegacyCharacterContentFields,
) {
  const advanced = record(character.advancedDetails);
  const snapshot = {
    persona: {
      name: character.name,
      age: character.age,
      description: character.description,
      systemPrompt: character.systemPrompt,
      personality: advanced.personality ?? null,
    },
    opening: { firstMessage: advanced.firstMessage ?? null },
    appearance: {
      style: character.style,
      gender: character.gender,
      structured: character.appearance,
      visualBrief: advanced.visualBrief ?? null,
    },
  };
  return { snapshot, contentHash: canonicalSha256(snapshot) };
}

/**
 * Identity for public-catalog editorial imports, whose authored facts arrive as
 * flat Character columns rather than as a Soul document.
 *
 * INTENT: `firstMessage` is type-checked to a string here, unlike the cutover
 * shape, because this hash gates a replay decision on a live public Release —
 * a non-string opening must read as absent rather than as arbitrary JSON.
 */
export function officialEditorialContentIdentity(
  character: LegacyCharacterContentFields & { readonly relationship: string | null },
) {
  const advanced = record(character.advancedDetails);
  const snapshot = {
    persona: {
      name: character.name,
      age: character.age,
      description: character.description,
      systemPrompt: character.systemPrompt,
      relationship: character.relationship,
    },
    opening: {
      firstMessage:
        typeof advanced.firstMessage === "string" ? advanced.firstMessage : null,
    },
    appearance: {
      style: character.style,
      gender: character.gender,
      structured: character.appearance,
    },
  };
  return { snapshot, contentHash: canonicalSha256(snapshot) };
}
