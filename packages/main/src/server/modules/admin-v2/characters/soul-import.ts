import { compileCharacterSoul, type CharacterSoulSnapshot } from "@idream/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";
import { lockCharacterGenerationAuthority } from "./generation-authority-lock";

export const REPOSITORY_SOUL_DOCUMENT_VERSION = 1 as const;

export interface RepositorySoulDocument {
  documentVersion: 1;
  characterId: string;
  expectedCurrentContentHash: string;
  reason: string;
  soul: CharacterSoulSnapshot["soul"];
  opening: { firstMessage: string };
}

export interface PreparedRepositorySoulImport {
  document: RepositorySoulDocument;
  personaSnapshot: CharacterSoulSnapshot;
  openingSnapshot: { firstMessage: string };
  appearanceSnapshot: Prisma.JsonValue;
  contentHash: string;
  renderedSoulMarkdown: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * SPEC: Repository documents carry authored facts only. The shared compiler is
 * the sole place that can turn them into immutable runtime bytes.
 * INVARIANT: Official imports reject warnings as well as errors, so a bulk
 * command can never fill missing character facts with a generic template.
 */
export function prepareRepositorySoulImport(
  value: unknown,
  appearanceSnapshot: Prisma.JsonValue,
): PreparedRepositorySoulImport {
  const root = record(value);
  if (!root) throw new Error("repository Soul document must be an object");
  if (root.documentVersion !== REPOSITORY_SOUL_DOCUMENT_VERSION) {
    throw new Error(`documentVersion must be ${REPOSITORY_SOUL_DOCUMENT_VERSION}`);
  }
  const opening = record(root.opening);
  const document: RepositorySoulDocument = {
    documentVersion: REPOSITORY_SOUL_DOCUMENT_VERSION,
    characterId: requiredText(root.characterId, "characterId"),
    expectedCurrentContentHash: requiredText(
      root.expectedCurrentContentHash,
      "expectedCurrentContentHash",
    ),
    reason: requiredText(root.reason, "reason"),
    soul: root.soul as CharacterSoulSnapshot["soul"],
    opening: {
      firstMessage: requiredText(opening?.firstMessage, "opening.firstMessage"),
    },
  };
  const compiled = compileCharacterSoul({ soul: document.soul });
  if (!compiled.ok) {
    throw new Error(
      `Character Soul compilation failed: ${compiled.diagnostics.map((item) => `${item.path.join(".")}: ${item.message}`).join("; ")}`,
    );
  }
  if (compiled.diagnostics.length > 0) {
    throw new Error(
      `Official Character Soul is incomplete: ${compiled.diagnostics.map((item) => `${item.path.join(".")}: ${item.message}`).join("; ")}`,
    );
  }
  const openingSnapshot = { firstMessage: document.opening.firstMessage };
  return {
    document,
    personaSnapshot: compiled.snapshot,
    openingSnapshot,
    appearanceSnapshot,
    contentHash: canonicalSha256({
      soul: compiled.snapshot.soul,
      compilerVersion: compiled.snapshot.compiled.compilerVersion,
      openingSnapshot,
      appearanceSnapshot,
    }),
    renderedSoulMarkdown: compiled.renderedMarkdown,
  };
}

export interface RepositorySoulImportResult {
  mode: "dry-run" | "applied" | "unchanged";
  characterId: string;
  projectId: string;
  previousContentVersionId: string;
  previousContentHash: string;
  contentVersionId: string;
  contentVersion: number;
  revisionId: string | null;
  revision: number | null;
  contentHash: string;
  fingerprint: string;
  compilerVersion: string;
  nextAction: string;
}

/**
 * Materializes Content Version + Revision only. Release proposal, QA approval,
 * and Publish remain explicit Admin operations with their existing authority.
 */
export async function importRepositorySoul(input: {
  db: PrismaClient;
  document: unknown;
  apply: boolean;
  actorId?: string;
  actorRole?: string;
  requestId?: string;
  sourceId: string;
}): Promise<RepositorySoulImportResult> {
  if (input.apply && (!input.actorId || !input.requestId)) {
    throw new Error("--apply requires --actor-id and --request-id");
  }
  const characterId = requiredText(record(input.document)?.characterId, "characterId");
  const state = await input.db.character.findUnique({
    where: { id: characterId },
    select: { id: true, source: true },
  });
  if (!state || state.source !== "official") {
    throw new Error(`official Character ${characterId} was not found`);
  }
  const [project, latestContent] = await Promise.all([
    input.db.characterProject.findFirst({ where: { characterId }, orderBy: { createdAt: "desc" } }),
    input.db.characterContentVersion.findFirst({ where: { characterId }, orderBy: { version: "desc" } }),
  ]);
  if (!project || !latestContent) {
    throw new Error(`Character ${characterId} must already have a Project and Content Version`);
  }
  const prepared = prepareRepositorySoulImport(input.document, latestContent.appearanceSnapshot);
  if (prepared.document.expectedCurrentContentHash !== latestContent.contentHash) {
    throw new Error(
      `expectedCurrentContentHash mismatch: expected ${prepared.document.expectedCurrentContentHash}, current ${latestContent.contentHash}`,
    );
  }
  const base = {
    characterId,
    projectId: project.id,
    previousContentVersionId: latestContent.id,
    previousContentHash: latestContent.contentHash,
    contentHash: prepared.contentHash,
    fingerprint: prepared.personaSnapshot.compiled.fingerprint,
    compilerVersion: prepared.personaSnapshot.compiled.compilerVersion,
    nextAction: "Run behavior QA and live canary, propose a Release, then explicitly Publish in Admin.",
  };
  if (prepared.contentHash === latestContent.contentHash) {
    return {
      ...base,
      mode: "unchanged",
      contentVersionId: latestContent.id,
      contentVersion: latestContent.version,
      revisionId: null,
      revision: null,
    };
  }
  const latestRevision = await input.db.characterRevision.findFirst({
    where: { projectId: project.id },
    orderBy: { revision: "desc" },
  });
  if (!input.apply) {
    return {
      ...base,
      mode: "dry-run",
      contentVersionId: "pending",
      contentVersion: latestContent.version + 1,
      revisionId: null,
      revision: (latestRevision?.revision ?? 0) + 1,
    };
  }

  return input.db.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, characterId);
    const lockedContent = await tx.characterContentVersion.findFirst({
      where: { characterId },
      orderBy: { version: "desc" },
    });
    const lockedRevision = await tx.characterRevision.findFirst({
      where: { projectId: project.id },
      orderBy: { revision: "desc" },
    });
    if (!lockedContent || lockedContent.contentHash !== latestContent.contentHash) {
      throw new Error("Character Content Version changed after preflight; rerun the import");
    }
    const content = await tx.characterContentVersion.create({
      data: {
        characterId,
        version: lockedContent.version + 1,
        contentHash: prepared.contentHash,
        personaSnapshot: toInputJson(prepared.personaSnapshot),
        openingSnapshot: toInputJson(prepared.openingSnapshot),
        appearanceSnapshot: toInputJson(prepared.appearanceSnapshot),
        sourceType: "repository_character_soul_import",
        sourceId: input.sourceId,
        createdById: input.actorId,
      },
    });
    const revision = await tx.characterRevision.create({
      data: {
        projectId: project.id,
        revision: (lockedRevision?.revision ?? 0) + 1,
        characterContentVersionId: content.id,
        projectSnapshot: toInputJson({
          source: "repository_character_soul_import",
          sourceId: input.sourceId,
          contentHash: content.contentHash,
          soulFingerprint: prepared.personaSnapshot.compiled.fingerprint,
        }),
        createdById: input.actorId,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actorId!,
        actorRole: input.actorRole ?? "admin",
        action: "character.soul.repository_imported",
        targetType: "character_project",
        targetId: project.id,
        reason: prepared.document.reason,
        before: toInputJson({ contentVersionId: lockedContent.id, contentHash: lockedContent.contentHash }),
        after: toInputJson({
          contentVersionId: content.id,
          revisionId: revision.id,
          contentHash: content.contentHash,
          fingerprint: prepared.personaSnapshot.compiled.fingerprint,
          sourceId: input.sourceId,
        }),
        requestId: input.requestId,
      },
    });
    await tx.adminCollaborationActivity.create({
      data: {
        targetType: "character_project",
        targetId: project.id,
        kind: "draft_saved",
        actorId: input.actorId!,
        body: "Imported reviewed repository Character Soul",
        metadata: toInputJson({ contentVersionId: content.id, revisionId: revision.id }),
        idempotencyKey: `character_soul_repository_import:${input.requestId}`,
      },
    });
    return {
      ...base,
      mode: "applied",
      contentVersionId: content.id,
      contentVersion: content.version,
      revisionId: revision.id,
      revision: revision.revision,
    };
  });
}
