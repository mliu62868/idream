import { randomUUID } from "node:crypto";
import {
  characterQaRunCreateRequestSchema,
  characterQaRunSchema,
  type CharacterQaRun,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";

export async function createCharacterQaRun(
  request: Request,
  characterId: string,
  rawInput: unknown,
  options?: {
    readonly tx?: Prisma.TransactionClient;
    readonly actor?: { readonly id: string; readonly role: string };
    readonly requestId?: string;
  },
): Promise<CharacterQaRun> {
  const actor = options?.actor ?? await actorWithPermission(request, "character.release.review", { characterId });
  const input = characterQaRunCreateRequestSchema.parse(rawInput);
  const execute = async (tx: Prisma.TransactionClient) => {
    const project = await tx.characterProject.findFirst({ where: { characterId } });
    if (!project) throw Errors.notFound("Character Project not found");
    if (project.version !== input.entityVersion) {
      throw Errors.conflict("Character Project changed before QA evidence was recorded", {
        expectedVersion: input.entityVersion,
        currentVersion: project.version,
      });
    }
    const revision = await tx.characterRevision.findFirst({
      where: { projectId: project.id },
      orderBy: { revision: "desc" },
    });
    if (!revision) throw Errors.conflict("Character QA requires an immutable Character Revision");
    const id = `character-qa:${randomUUID()}`;
    const status = input.checks.every((check) => check.result === "passed") ? "passed" : "failed";
    const checks = input.checks.map((check) => ({ ...check, ownerId: actor.id }));
    const evidenceHash = canonicalSha256({
      id,
      characterId,
      projectId: project.id,
      characterContentVersionId: revision.characterContentVersionId,
      projectVersion: project.version,
      ownerId: actor.id,
      status,
      checks,
    });
    const qaRun = await tx.characterQaRun.create({
      data: {
        id,
        characterId,
        projectId: project.id,
        characterContentVersionId: revision.characterContentVersionId,
        projectVersion: project.version,
        ownerId: actor.id,
        status,
        checks: toInputJson(checks),
        evidenceHash,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "character.qa.recorded",
        targetType: "character_qa_run",
        targetId: qaRun.id,
        reason: input.reason,
        after: toInputJson({
          characterId,
          projectId: project.id,
          characterContentVersionId: revision.characterContentVersionId,
          status,
          evidenceHash,
        }),
        requestId: options?.requestId ?? request.headers.get("x-request-id"),
      },
    });
    await tx.adminCollaborationActivity.create({
      data: {
        targetType: "character_project",
        targetId: project.id,
        kind: "evidence_attached",
        actorId: actor.id,
        body: `Recorded immutable Character QA Run: ${status}`,
        metadata: toInputJson({ qaRunId: qaRun.id, status, evidenceHash }),
        idempotencyKey: `character_qa_recorded:${qaRun.id}`,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "character.qa.recorded.v2",
        aggregateType: "character_qa_run",
        aggregateId: qaRun.id,
        payload: toInputJson({
          qaRunId: qaRun.id,
          characterId,
          projectId: project.id,
          characterContentVersionId: revision.characterContentVersionId,
          status,
          evidenceHash,
        }),
      },
    });
    return characterQaRunSchema.parse({
      ...qaRun,
      checks,
      createdAt: qaRun.createdAt.toISOString(),
    });
  };
  return options?.tx ? execute(options.tx) : prisma.$transaction(execute);
}
