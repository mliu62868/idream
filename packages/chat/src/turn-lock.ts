import type { Prisma } from "../generated/client/client.js";

type TurnTransaction = Prisma.TransactionClient;

export async function advisoryLock(
  tx: TurnTransaction,
  key: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT 1::int AS locked
    FROM pg_advisory_xact_lock(hashtext(${`idream-chat:${key}`}))
  `;
}

export async function lockUser(
  tx: TurnTransaction,
  userId: string,
): Promise<void> {
  await advisoryLock(tx, `user:${userId}`);
}

export async function lockUserShared(
  tx: TurnTransaction,
  userId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT 1::int AS locked
    FROM pg_advisory_xact_lock_shared(hashtext(${`idream-chat:user:${userId}`}))
  `;
}

export async function lockTurn(
  tx: TurnTransaction,
  userId: string,
  sessionId: string,
): Promise<void> {
  // Stable lock order prevents deadlocks when different sessions for one user race.
  await lockUser(tx, userId);
  await advisoryLock(tx, `turn:${sessionId}`);
}
