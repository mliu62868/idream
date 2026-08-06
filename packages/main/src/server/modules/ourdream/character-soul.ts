import {
  compileCharacterSoul,
  loadCharacterSoulSnapshot,
  type CharacterSoulSnapshot,
  type SoulDiagnostic,
} from "@idream/shared";
import type { Prisma } from "@prisma/client";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

export class UserCharacterSoulCompileError extends Error {
  constructor(readonly diagnostics: SoulDiagnostic[]) {
    super("User Character Soul failed to compile");
  }
}

export interface UserCharacterSoulInput {
  name: string;
  age: number;
  gender: string;
  relationship: string | null;
  description: string;
  style: string;
  appearance: unknown;
  advancedDetails: unknown;
  immutablePersonaSnapshot?: unknown;
}

export function compileUserCharacterContent(input: UserCharacterSoulInput) {
  const immutable = input.immutablePersonaSnapshot === undefined
    ? null
    : loadCharacterSoulSnapshot(input.immutablePersonaSnapshot);
  const draft = immutable?.ok
    ? {
        soul: {
          ...immutable.snapshot.soul,
          identity: {
            ...immutable.snapshot.soul.identity,
            name: input.name,
            age: input.age,
            gender: input.gender,
            relationshipArchetype: input.relationship,
            characterPromise: input.description,
          },
        },
      }
    : {
        name: input.name,
        age: input.age,
        gender: input.gender,
        relationship: input.relationship,
        description: input.description,
        advancedDetails: input.advancedDetails,
      };
  const compiled = compileCharacterSoul(draft);
  if (!compiled.ok) throw new UserCharacterSoulCompileError(compiled.diagnostics);

  const details = record(input.advancedDetails);
  const openingSnapshot = {
    firstMessage: text(details.firstMessage) || null,
  };
  const appearanceSnapshot = {
    style: input.style,
    appearance: input.appearance ?? {},
  };
  const contentHash = canonicalSha256({
    soul: compiled.snapshot.soul,
    compilerVersion: compiled.snapshot.compiled.compilerVersion,
    openingSnapshot,
    appearanceSnapshot,
  });
  return {
    personaSnapshot: compiled.snapshot,
    openingSnapshot,
    appearanceSnapshot,
    contentHash,
    diagnostics: compiled.diagnostics,
    renderedSoulMarkdown: compiled.renderedMarkdown,
  };
}

/**
 * SPEC: A user Character edit either reuses the exact historical content hash
 * (explicit rollback) or appends one immutable version. It never overwrites an
 * existing CharacterContentVersion.
 */
export async function materializeUserCharacterContentVersion(input: {
  tx: Prisma.TransactionClient;
  characterId: string;
  sourceId: string | null;
  createdById: string | null;
  content: ReturnType<typeof compileUserCharacterContent>;
}): Promise<{ id: string; version: number; snapshot: CharacterSoulSnapshot }> {
  const existing = await input.tx.characterContentVersion.findUnique({
    where: {
      characterId_contentHash: {
        characterId: input.characterId,
        contentHash: input.content.contentHash,
      },
    },
  });
  if (existing) {
    return {
      id: existing.id,
      version: existing.version,
      snapshot: input.content.personaSnapshot,
    };
  }
  const latest = await input.tx.characterContentVersion.findFirst({
    where: { characterId: input.characterId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const created = await input.tx.characterContentVersion.create({
    data: {
      characterId: input.characterId,
      version: (latest?.version ?? 0) + 1,
      contentHash: input.content.contentHash,
      personaSnapshot: toInputJson(input.content.personaSnapshot),
      openingSnapshot: toInputJson(input.content.openingSnapshot),
      appearanceSnapshot: toInputJson(input.content.appearanceSnapshot),
      sourceType: "user",
      sourceId: input.sourceId,
      createdById: input.createdById,
    },
  });
  return {
    id: created.id,
    version: created.version,
    snapshot: input.content.personaSnapshot,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
