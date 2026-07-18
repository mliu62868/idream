import {
  latestCharacterQaAuthorityRun,
  type CharacterQaAuthoritySnapshot,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";

type PersistedCharacterQaAuthoritySnapshot = CharacterQaAuthoritySnapshot & {
  readonly characterId: string;
  readonly projectId: string;
  readonly characterContentVersionId: string;
  readonly projectVersion: number;
};

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
