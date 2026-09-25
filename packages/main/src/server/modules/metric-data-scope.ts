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

const operationalUserDataClassWhere = {
  dataClass: { in: [...OPERATIONAL_USER_DATA_CLASSES] },
} satisfies Prisma.UserWhereInput;

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

export function operationalUserWhere(
  where: Prisma.UserWhereInput,
): Prisma.UserWhereInput {
  return {
    AND: [operationalUserDataClassWhere, where],
  };
}

export function operationalContentReportWhere(
  where: Prisma.ContentReportWhereInput,
): Prisma.ContentReportWhereInput {
  return {
    AND: [
      {
        OR: [
          { reporterId: null },
          {
            reporter: {
              is: {
                dataClass: { in: [...OPERATIONAL_USER_DATA_CLASSES] },
              },
            },
          },
        ],
      },
      where,
    ],
  };
}

export function operationalMediaAssetWhere(
  where: Prisma.MediaAssetWhereInput,
): Prisma.MediaAssetWhereInput {
  return {
    AND: [
      {
        owner: {
          is: { dataClass: { in: [...OPERATIONAL_USER_DATA_CLASSES] } },
        },
      },
      where,
    ],
  };
}

export function operationalAppealWhere(
  where: Prisma.AppealWhereInput,
): Prisma.AppealWhereInput {
  return {
    AND: [
      {
        user: {
          is: { dataClass: { in: [...OPERATIONAL_USER_DATA_CLASSES] } },
        },
      },
      where,
    ],
  };
}

export function operationalSupportRequestWhere(
  where: Prisma.SupportRequestWhereInput,
): Prisma.SupportRequestWhereInput {
  return {
    AND: [
      {
        user: {
          is: { dataClass: { in: [...OPERATIONAL_USER_DATA_CLASSES] } },
        },
      },
      where,
    ],
  };
}

export function operationalCharacterWhere(
  where: Prisma.CharacterWhereInput,
): Prisma.CharacterWhereInput {
  return {
    AND: [
      {
        OR: [
          { source: "official" },
          {
            source: "user",
            creator: {
              is: {
                dataClass: { in: [...OPERATIONAL_USER_DATA_CLASSES] },
              },
            },
          },
        ],
      },
      where,
    ],
  };
}

export function operationalContentProductionBatchWhere(
  where: Prisma.ContentProductionBatchWhereInput,
): Prisma.ContentProductionBatchWhereInput {
  return {
    AND: [
      {
        createdBy: {
          is: { dataClass: { in: [...OPERATIONAL_USER_DATA_CLASSES] } },
        },
      },
      where,
    ],
  };
}

export function operationalCharacterSubmissionWhere(
  where: Prisma.CharacterSubmissionWhereInput,
): Prisma.CharacterSubmissionWhereInput {
  return {
    AND: [
      {
        character: {
          is: operationalCharacterWhere({ deletedAt: null }),
        },
      },
      where,
    ],
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

// INTENT: AdminCase has no user relation — for these target types targetId is the subject
//         user's id. Cases whose subject is a fixture/audit account leave the operational
//         queues (Today, Cases list) the same way the Support queue drops their tickets.
//         Cases without a resolvable subject user (content, characters) stay in.
export const USER_SUBJECT_CASE_TARGET_TYPES = ["user", "user_profile"];

export async function operationalAdminCaseWhere(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
): Promise<Prisma.AdminCaseWhereInput> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT subject.id
    FROM "admin_cases" admin_case
    JOIN "users" subject ON subject.id = admin_case."targetId"
    WHERE admin_case."targetType" IN (${Prisma.join(USER_SUBJECT_CASE_TARGET_TYPES)})
      AND subject."dataClass" NOT IN (${OPERATIONAL_USER_DATA_CLASS_SQL})
  `);
  if (rows.length === 0) return {};
  return {
    NOT: {
      targetType: { in: USER_SUBJECT_CASE_TARGET_TYPES },
      targetId: { in: rows.map((row) => row.id) },
    },
  };
}
