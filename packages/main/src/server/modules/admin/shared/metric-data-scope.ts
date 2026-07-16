import { Prisma } from "@prisma/client";

export const OPERATIONAL_USER_DATA_CLASSES = [
  "customer",
  "internal",
] as const;
export const OPERATIONAL_EVENT_DATA_CLASSES = [
  "customer",
  "internal",
  "operational",
] as const;
export const OPERATIONAL_USER_DATA_CLASS_SQL = Prisma.join([
  ...OPERATIONAL_USER_DATA_CLASSES,
]);
export const OPERATIONAL_EVENT_DATA_CLASS_SQL = Prisma.join([
  ...OPERATIONAL_EVENT_DATA_CLASSES,
]);

export const CUSTOMER_METRIC_DATA_SCOPE = {
  kind: "customer",
  includedDataClasses: ["customer"],
  excludedDataClasses: ["internal", "operational", "fixture", "audit"],
} as const;

export const OPERATIONAL_METRIC_DATA_SCOPE = {
  kind: "operational",
  includedDataClasses: OPERATIONAL_EVENT_DATA_CLASSES,
  excludedDataClasses: ["fixture", "audit"],
} as const;

export const OPERATIONAL_USER_DATA_SCOPE = {
  kind: "operational",
  includedDataClasses: OPERATIONAL_USER_DATA_CLASSES,
  excludedDataClasses: ["fixture", "audit"],
} as const;

const customerOwnerRelationWhere = {
  user: { is: { dataClass: "customer" } },
} as const;

const operationalOwnerRelationWhere = {
  user: {
    is: { dataClass: { in: [...OPERATIONAL_USER_DATA_CLASSES] } },
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
      { dataClass: { in: [...OPERATIONAL_EVENT_DATA_CLASSES] } },
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
          is: { dataClass: { in: [...OPERATIONAL_USER_DATA_CLASSES] } },
        },
      },
      {
        mediaAsset: {
          is: {
            owner: {
              is: { dataClass: { in: [...OPERATIONAL_USER_DATA_CLASSES] } },
            },
          },
        },
      },
      where,
    ],
  };
}
