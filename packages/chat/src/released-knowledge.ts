import {
  releasedKnowledgeDigest,
  type ReleasedKnowledgeSnapshot,
} from "@idream/shared";

interface ImmutableContentAuthority {
  readonly contentVersionId: string;
  readonly characterId: string;
}

interface ImmutableReleaseAuthority {
  readonly releaseId: string;
  readonly characterId: string;
  readonly characterContentVersionId: string;
  readonly status: string;
}

export interface ReleasedKnowledgeAuthority {
  readonly characterId: string;
  readonly contentVersion: ImmutableContentAuthority | null;
  readonly release: ImmutableReleaseAuthority | null;
}

const RELEASED_STATES = new Set(["published", "superseded"]);

/**
 * Validate the immutable Release pin and keep Gate M's knowledge directory empty.
 * The complete Character Soul is already delivered as the pinned system prompt;
 * copying parts of it into files creates two competing prompt authorities.
 */
export function buildReleasedKnowledgeSnapshot(
  input: ReleasedKnowledgeAuthority,
): ReleasedKnowledgeSnapshot {
  const contentVersionId =
    input.contentVersion?.contentVersionId ?? "legacy-unattributed";
  if (
    input.contentVersion &&
    input.contentVersion.characterId !== input.characterId
  ) {
    throw new Error(
      `content version ${contentVersionId} does not belong to character ${input.characterId}`,
    );
  }

  if (!input.release) {
    return snapshot(input.characterId, contentVersionId, null, []);
  }
  if (!RELEASED_STATES.has(input.release.status)) {
    throw new Error(
      `character release ${input.release.releaseId} is not released`,
    );
  }
  if (input.release.characterId !== input.characterId) {
    throw new Error(
      `character release ${input.release.releaseId} does not belong to character ${input.characterId}`,
    );
  }
  if (!input.contentVersion) {
    throw new Error(
      `character release ${input.release.releaseId} has no immutable content version`,
    );
  }
  if (
    input.release.characterContentVersionId !==
      input.contentVersion.contentVersionId
  ) {
    throw new Error(
      `character release ${input.release.releaseId} does not pin content version ${input.contentVersion.contentVersionId}`,
    );
  }

  return snapshot(
    input.characterId,
    contentVersionId,
    input.release.releaseId,
    [],
  );
}

function snapshot(
  characterId: string,
  characterContentVersionId: string,
  characterReleaseId: string | null,
  files: ReleasedKnowledgeSnapshot["files"],
): ReleasedKnowledgeSnapshot {
  const authority = {
    characterId,
    characterContentVersionId,
    characterReleaseId,
    files,
  };
  return { ...authority, digest: releasedKnowledgeDigest(authority) };
}
