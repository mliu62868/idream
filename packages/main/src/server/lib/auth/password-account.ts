import type { Prisma } from "@prisma/client";

// Main stores credential.accountId=email; Better Auth stores accountId=userId.
// The locked User is the shared identity authority. An ambiguous set is never
// eligible: choosing one would leave another password able to access the user.
export async function passwordAccountForUser(db: Pick<Prisma.TransactionClient, "account">, userId: string) {
  const accounts = await db.account.findMany({ where: { userId, providerId: "credential" }, take: 2 });
  return accounts.length === 1 ? accounts[0] : null;
}
