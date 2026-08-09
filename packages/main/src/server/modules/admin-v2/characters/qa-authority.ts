import {
  latestCharacterQaAuthorityRun,
  type PersistedCharacterQaAuthoritySnapshot,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";

export async function findLatestCharacterQaAuthorityRun(
  tx: Prisma.TransactionClient,
  authority: PersistedCharacterQaAuthoritySnapshot,
) {
  const candidates = await tx.characterQaRun.findMany({
    where: {
      characterId: authority.characterId,
      projectId: authority.projectId,
      characterContentVersionId: authority.characterContentVersionId,
      projectVersion: authority.projectVersion,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return latestCharacterQaAuthorityRun(candidates, authority);
}
