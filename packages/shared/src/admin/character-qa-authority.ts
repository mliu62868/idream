export const characterQaAuthorityKeys = [
  "characterId",
  "projectId",
  "characterContentVersionId",
  "projectVersion",
  "visualProfileId",
  "visualProfileVersion",
  "visualProfileHash",
  "referenceSetRevisionId",
  "referenceSetRevision",
  "referenceSetHash",
  "draftAssetPackHash",
] as const;

export type CharacterQaAuthorityKey = typeof characterQaAuthorityKeys[number];

/**
 * SPEC: the exact authority a QA run was produced against. Every key is one
 * axis a run can go stale along, so all eleven are compared, never a subset.
 *
 * INTENT: typed per key rather than `Record<Key, unknown>`. The weak form let a
 * producer put anything in a slot — a Date where a hash belongs, a `version`
 * object where a number belongs — and `===` would simply report a mismatch, so
 * the release just silently stayed blocked with no failing test anywhere.
 * `null` is meaningful and stays expressible: it says "this axis is absent", and
 * absent never matches a persisted run's non-null column.
 */
export type CharacterQaAuthoritySnapshot = {
  /** null only where the caller could not resolve a Character, e.g. an orphaned Release. */
  readonly characterId: string | null;
  readonly projectId: string;
  /** null while a draft has no content version yet. */
  readonly characterContentVersionId: string | null;
  readonly projectVersion: number;
  readonly visualProfileId: string | null;
  readonly visualProfileVersion: number | null;
  readonly visualProfileHash: string | null;
  readonly referenceSetRevisionId: string | null;
  readonly referenceSetRevision: number | null;
  readonly referenceSetHash: string | null;
  readonly draftAssetPackHash: string | null;
};

/**
 * A snapshot whose identity keys are all resolved, so it can address persisted
 * rows. Query helpers require this; comparison helpers do not.
 */
export type PersistedCharacterQaAuthoritySnapshot = CharacterQaAuthoritySnapshot & {
  readonly characterId: string;
  readonly characterContentVersionId: string;
};

export type CharacterQaAuthorityRun = CharacterQaAuthoritySnapshot & {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string | Date;
};

// INVARIANT: the `actual` side stays `unknown`-valued on purpose. It is read
// back from persisted JSON provenance, so claiming it already has the right
// types is the assumption this comparison exists to check.
export function characterQaAuthorityMatches(
  actual: Partial<Record<CharacterQaAuthorityKey, unknown>> | null | undefined,
  expected: CharacterQaAuthoritySnapshot,
) {
  return Boolean(
    actual &&
    characterQaAuthorityKeys.every((key) => actual[key] === expected[key]),
  );
}

export function characterQaProvenanceMatchesRun(
  provenance: Partial<Record<CharacterQaAuthorityKey | "evidenceHash", unknown>> | null | undefined,
  run: CharacterQaAuthoritySnapshot & { readonly evidenceHash: unknown },
) {
  return Boolean(
    provenance &&
    provenance.evidenceHash === run.evidenceHash &&
    characterQaAuthorityMatches(provenance, run),
  );
}

function characterQaRunCreatedAt(run: Pick<CharacterQaAuthorityRun, "createdAt">) {
  return run.createdAt instanceof Date
    ? run.createdAt.getTime()
    : Date.parse(run.createdAt);
}

/**
 * Returns the single QA authority for a snapshot.
 *
 * A failed run remains authoritative. Callers must inspect `status` instead of
 * filtering to passed runs first, otherwise an older pass can silently become
 * authoritative again after a newer failure.
 */
export function latestCharacterQaAuthorityRun<
  T extends CharacterQaAuthorityRun,
>(
  runs: readonly T[],
  authority: CharacterQaAuthoritySnapshot,
): T | null {
  let latest: T | null = null;
  for (const run of runs) {
    if (!characterQaAuthorityMatches(run, authority)) continue;
    if (!latest) {
      latest = run;
      continue;
    }
    const runCreatedAt = characterQaRunCreatedAt(run);
    const latestCreatedAt = characterQaRunCreatedAt(latest);
    if (
      runCreatedAt > latestCreatedAt ||
      (runCreatedAt === latestCreatedAt && run.id > latest.id)
    ) {
      latest = run;
    }
  }
  return latest;
}
