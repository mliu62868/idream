import type { Prisma } from "@prisma/client";
import type { CharacterScope } from "@/server/admin/effective-permissions";
import { prisma } from "@/server/lib/db";

/**
 * SPEC: a Creative Run belongs to a Character only when it targets one.
 * INTENT: the single answer to "which Character does this Run sit under" for every
 *         character-scope check (detail, commands, collaboration, recovery). A Run with any
 *         other target type belongs to no Character and is reachable only by a global grant.
 */
export function creativeRunCharacterId(run: {
  readonly targetType: string | null;
  readonly targetId: string | null;
}): string | null {
  return run.targetType === "character" && run.targetId ? run.targetId : null;
}

/**
 * SPEC: the authority resource for a Run id, resolved before the permission check.
 * INVARIANT: an unknown Run or a Run outside every Character returns no `characterId`, so a
 *            scoped grant is refused by the authority seam and a global grant continues to the
 *            handler's own 404.
 */
export async function creativeRunAuthorityResource(
  runId: string,
): Promise<{ readonly characterId?: string }> {
  const run = await prisma.contentProductionBatch.findUnique({
    where: { id: runId },
    select: { targetType: true, targetId: true },
  });
  const characterId = run ? creativeRunCharacterId(run) : null;
  return characterId ? { characterId } : {};
}

/** SPEC: narrows a Run query to the Characters a scoped grant reaches; null scope narrows nothing. */
export function creativeRunScopeWhere(
  scope: CharacterScope,
): Prisma.ContentProductionBatchWhereInput | null {
  if (scope === null) return null;
  return { targetType: "character", targetId: { in: [...scope] } };
}
