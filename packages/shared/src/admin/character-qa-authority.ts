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
export type CharacterQaAuthoritySnapshot = Readonly<
  Record<CharacterQaAuthorityKey, unknown>
>;
export type CharacterQaAuthorityRun = CharacterQaAuthoritySnapshot & {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string | Date;
};

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
