import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma, chatProjectorPrisma } from "./db.js";
import {
  projectChatFileMutations,
  recordChatFileMutation,
} from "./file-mutations.js";
import { lockUser } from "./turn-lock.js";

type RelationshipPair = {
  userId: string;
  characterId: string;
};

export async function repairRelationshipSignals(
  prisma: ChatPrismaClient = chatPrisma,
  projectorPrisma: ChatPrismaClient = chatProjectorPrisma,
): Promise<{ users: number; relationships: number; projectedMutations: number }> {
  const pairs = await prisma.$queryRaw<RelationshipPair[]>`
    SELECT DISTINCT
      user_id AS "userId",
      character_id AS "characterId"
    FROM chat.chat_sessions
    WHERE deleted_at IS NULL
      AND status <> 'deleted'
    ORDER BY user_id, character_id
  `;
  const charactersByUser = new Map<string, string[]>();
  for (const pair of pairs) {
    const characterIds = charactersByUser.get(pair.userId) ?? [];
    characterIds.push(pair.characterId);
    charactersByUser.set(pair.userId, characterIds);
  }

  let projectedMutations = 0;
  for (const [userId, characterIds] of charactersByUser) {
    projectedMutations += await projectChatFileMutations(
      userId,
      projectorPrisma,
    );
    await prisma.$transaction(
      async (tx) => {
        await lockUser(tx, userId);
        for (const characterId of characterIds) {
          await recordChatFileMutation(tx, userId, {
            kind: "relationship_rebuild",
            characterId,
          });
        }
      },
      { timeout: 30_000 },
    );
    projectedMutations += await projectChatFileMutations(
      userId,
      projectorPrisma,
    );
  }

  return {
    users: charactersByUser.size,
    relationships: pairs.length,
    projectedMutations,
  };
}

async function main() {
  try {
    const result = await repairRelationshipSignals();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await Promise.all([
      chatPrisma.$disconnect(),
      chatProjectorPrisma.$disconnect(),
    ]);
  }
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === entrypoint) {
  await main();
}
