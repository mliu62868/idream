import {
  compileCharacterSoul,
  loadCharacterSoulSnapshot,
  type CharacterSoulSnapshot,
  type SoulDiagnostic,
} from "@idream/shared";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { characterContentHash } from "@/server/modules/admin-v2/shared/character-content-identity";
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
  immutableContentSnapshot?: {
    personaSnapshot: unknown;
    openingSnapshot: unknown;
    appearanceSnapshot: unknown;
  };
}

export function compileUserCharacterContent(input: UserCharacterSoulInput) {
  const immutable = input.immutableContentSnapshot === undefined
    ? null
    : loadCharacterSoulSnapshot(input.immutableContentSnapshot.personaSnapshot);
  if (immutable && !immutable.ok) {
    // INVARIANT: once a Character has an immutable content pointer, edits may
    // never reconstruct missing authority from mutable compatibility columns.
    throw new UserCharacterSoulCompileError(immutable.diagnostics);
  }
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
  const openingSnapshot = input.immutableContentSnapshot?.openingSnapshot ?? {
    firstMessage: text(details.firstMessage) || null,
  };
  const appearanceSnapshot = input.immutableContentSnapshot?.appearanceSnapshot ?? {
    style: input.style,
    appearance: input.appearance ?? {},
  };
  const contentHash = characterContentHash({
    personaSnapshot: compiled.snapshot,
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

// SPEC: 编译失败即 400，并把 Soul 诊断原样回给用户。
// INTENT: 建角色 / 改角色 / 复制角色三条路径都要把 UserCharacterSoulCompileError 翻成
// 同一个 400 —— 翻译只做一次，否则三份错误形状迟早不一样。
export function compileUserSoulOrBadRequest(input: UserCharacterSoulInput) {
  try {
    return compileUserCharacterContent(input);
  } catch (error) {
    if (error instanceof UserCharacterSoulCompileError) {
      throw Errors.badRequest("Complete the Character Soul before saving", {
        diagnostics: error.diagnostics,
      });
    }
    throw error;
  }
}

export async function loadCurrentCharacterContentSnapshot(
  tx: Prisma.TransactionClient,
  characterId: string,
  currentContentVersionId: string | null,
): Promise<{
  personaSnapshot: unknown;
  openingSnapshot: unknown;
  appearanceSnapshot: unknown;
} | undefined> {
  let contentVersionId = currentContentVersionId;
  if (!contentVersionId) {
    const serving = await tx.characterServing.findUnique({
      where: { characterId },
      select: {
        currentRelease: {
          select: { characterContentVersionId: true },
        },
      },
    });
    contentVersionId = serving?.currentRelease?.characterContentVersionId ?? null;
  }
  if (!contentVersionId) return undefined;
  const content = await tx.characterContentVersion.findFirst({
    where: { id: contentVersionId, characterId },
    select: {
      personaSnapshot: true,
      openingSnapshot: true,
      appearanceSnapshot: true,
    },
  });
  if (!content) {
    throw Errors.conflict("The Character's immutable content version is unavailable");
  }
  return content;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
