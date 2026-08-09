import { loadCharacterSoulSnapshot, requiredChatCanaryProfiles } from "@idream/shared";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { jsonRecord as record } from "../shared/prisma-json";

type SoulContentVersion = {
  id: string;
  version: number;
  personaSnapshot: Prisma.JsonValue;
};

export function characterSoulWorkspaceProjection(
  versions: readonly SoulContentVersion[],
  servingVersion: SoulContentVersion | null,
) {
  const current = versions[0];
  if (!current) throw Errors.notFound("Character Soul content version not found");
  const loaded = loadCharacterSoulSnapshot(current.personaSnapshot);
  // SPEC: operator diffs answer "what will change in Serving?", not merely
  // "what changed since the last draft?".
  const previousRow = servingVersion;
  const previousLoaded = previousRow
    ? loadCharacterSoulSnapshot(previousRow.personaSnapshot)
    : null;
  const raw = record(current.personaSnapshot);
  return {
    valid: loaded.ok,
    current: {
      contentVersionId: current.id,
      version: current.version,
      schemaVersion:
        typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0,
      compilerVersion: loaded.ok
        ? loaded.snapshot.compiled.compilerVersion
        : null,
      fingerprint: loaded.ok ? loaded.snapshot.compiled.fingerprint : null,
      estimatedTokens: loaded.ok
        ? loaded.snapshot.compiled.estimatedTokens
        : null,
      soul: loaded.ok
        ? loaded.snapshot.soul as unknown as Record<string, unknown>
        : null,
      markdown: loaded.ok ? loaded.renderedMarkdown : null,
      systemPrompt: loaded.ok
        ? loaded.snapshot.compiled.systemPrompt
        : null,
      diagnostics: loaded.diagnostics,
    },
    previous: previousRow
      ? {
          contentVersionId: previousRow.id,
          version: previousRow.version,
          fingerprint: previousLoaded?.ok
            ? previousLoaded.snapshot.compiled.fingerprint
            : null,
        }
      : null,
    changedFields:
      loaded.ok && previousLoaded?.ok
        ? changedSoulFields(
            previousLoaded.snapshot.soul as unknown as Record<string, unknown>,
            loaded.snapshot.soul as unknown as Record<string, unknown>,
          )
        : [],
    requiredCanaryProfiles: requiredChatCanaryProfiles(process.env).map(
      ({ tier, profile }) => ({
        tier,
        provider: profile.provider,
        model: profile.model,
      }),
    ),
  };
}

function changedSoulFields(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  prefix = "soul",
): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...keys].sort().flatMap((key) => {
    const before = previous[key];
    const after = current[key];
    const path = `${prefix}.${key}`;
    if (isPlainRecord(before) && isPlainRecord(after)) {
      return changedSoulFields(before, after, path);
    }
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [path];
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
