import {
  loadCharacterSoulSnapshot,
  releasedKnowledgeDigest,
  type ReleasedKnowledgeSnapshot,
} from "@idream/shared";

interface ImmutableContentAuthority {
  readonly contentVersionId: string;
  readonly characterId: string;
  readonly personaSnapshot: unknown;
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
 * Compile the only bytes that may enter Gate M's knowledge directory.
 * No release means an explicit empty snapshot; mutable Character and draft
 * project state are intentionally absent from this interface.
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

  const loaded = loadCharacterSoulSnapshot(input.contentVersion.personaSnapshot);
  if (!loaded.ok) {
    throw new Error(
      `character content ${contentVersionId} has no complete immutable Soul: ${loaded.diagnostics.map((item) => item.code).join(",")}`,
    );
  }
  const facts = loaded.snapshot.soul.canon.facts;
  const unknowns = loaded.snapshot.soul.canon.unknowns;
  const sections: string[] = [];
  if (facts.length > 0) {
    sections.push("# Canon facts", "", ...facts.map(markdownListItem));
  }
  if (unknowns.length > 0) {
    if (sections.length > 0) sections.push("");
    sections.push("# Canon unknowns", "", ...unknowns.map(markdownListItem));
  }
  const files: ReleasedKnowledgeSnapshot["files"] = sections.length > 0
    ? [{ path: "canon.md", content: `${sections.join("\n")}\n` }]
    : [];
  return snapshot(
    input.characterId,
    contentVersionId,
    input.release.releaseId,
    files,
  );
}

function markdownListItem(value: string): string {
  return `- ${value.replaceAll("\n", "\n  ")}`;
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
