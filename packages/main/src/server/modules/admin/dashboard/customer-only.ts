import type { Prisma } from "@prisma/client";

const customerOwnerRelationWhere = {
  user: { is: { dataClass: "customer" } },
} as const;

export function customerUserWhere(
  where: Prisma.UserWhereInput,
): Prisma.UserWhereInput {
  return {
    AND: [{ dataClass: "customer" }, where],
  };
}

export function customerSubscriptionWhere(
  where: Prisma.SubscriptionWhereInput,
): Prisma.SubscriptionWhereInput {
  return {
    AND: [customerOwnerRelationWhere, where],
  };
}

export function customerGenerationJobWhere(
  where: Prisma.GenerationJobWhereInput,
): Prisma.GenerationJobWhereInput {
  return {
    AND: [customerOwnerRelationWhere, where],
  };
}

export function customerContentReportWhere(
  where: Prisma.ContentReportWhereInput,
): Prisma.ContentReportWhereInput {
  return {
    AND: [
      { reporter: { is: { dataClass: "customer" } } },
      where,
    ],
  };
}
