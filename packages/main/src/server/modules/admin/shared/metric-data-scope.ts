import type { Prisma } from "@prisma/client";

const operationalDataClasses = ["customer", "internal"];
const operationalEventDataClasses = [
  "customer",
  "internal",
  "operational",
];

export const CUSTOMER_METRIC_DATA_SCOPE = {
  kind: "customer",
  includedDataClasses: ["customer"],
  excludedDataClasses: ["internal", "operational", "fixture", "audit"],
} as const;

export const OPERATIONAL_METRIC_DATA_SCOPE = {
  kind: "operational",
  includedDataClasses: ["customer", "internal", "operational"],
  excludedDataClasses: ["fixture", "audit"],
} as const;

const customerOwnerRelationWhere = {
  user: { is: { dataClass: "customer" } },
} as const;

const operationalOwnerRelationWhere = {
  user: {
    is: { dataClass: { in: [...operationalDataClasses] } },
  },
} satisfies Prisma.GenerationJobWhereInput;

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

export function operationalGenerationJobWhere(
  where: Prisma.GenerationJobWhereInput,
): Prisma.GenerationJobWhereInput {
  return {
    AND: [operationalOwnerRelationWhere, where],
  };
}

export function customerDreamcoinLedgerWhere(
  where: Prisma.DreamcoinLedgerWhereInput,
): Prisma.DreamcoinLedgerWhereInput {
  return {
    AND: [customerOwnerRelationWhere, where],
  };
}

export function customerReferralWhere(
  where: Prisma.ReferralWhereInput,
): Prisma.ReferralWhereInput {
  return {
    AND: [
      { inviter: { is: { dataClass: "customer" } } },
      where,
    ],
  };
}

export function customerAnalyticsEventWhere(
  where: Prisma.AnalyticsEventWhereInput,
): Prisma.AnalyticsEventWhereInput {
  return {
    AND: [{ dataClass: "customer" }, where],
  };
}

export function operationalAnalyticsEventWhere(
  where: Prisma.AnalyticsEventWhereInput,
): Prisma.AnalyticsEventWhereInput {
  return {
    AND: [
      { dataClass: { in: [...operationalEventDataClasses] } },
      where,
    ],
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

export function operationalMediaAssetPlacementWhere(
  where: Prisma.MediaAssetPlacementWhereInput,
): Prisma.MediaAssetPlacementWhereInput {
  return {
    AND: [
      {
        createdBy: {
          is: { dataClass: { in: [...operationalDataClasses] } },
        },
      },
      {
        mediaAsset: {
          is: {
            owner: {
              is: { dataClass: { in: [...operationalDataClasses] } },
            },
          },
        },
      },
      where,
    ],
  };
}
