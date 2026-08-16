import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema } from "./common";

/**
 * SPEC: 合规运营契约 —— DSAR 导出 / 账号擦除 / 年龄验证复核。
 * INTENT: 导出的每一段都逐字段声明，是因为「导出里不许出现明文 prompt/chat」这条不变量
 *         此前只写在服务端的 `select` 里。`.strict()` 把它变成运行时可验证的：多带一列
 *         就是契约违约，而不是一次静默的多导。
 */

export const complianceExportUserSchema = z
  .object({
    id: adminIdSchema,
    email: z.string(),
    displayName: z.string().nullable(),
    name: z.string().nullable(),
    role: z.string().min(1),
    status: z.string().min(1),
    createdAt: adminIsoDateTimeSchema,
    deletedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

export const complianceExportSubscriptionSchema = z
  .object({
    id: adminIdSchema,
    status: z.string().min(1),
    currentPeriodEnd: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
    planId: adminIdSchema,
  })
  .strict();

export const complianceExportLedgerEntrySchema = z
  .object({
    id: adminIdSchema,
    delta: z.number().int(),
    reason: z.string().min(1),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const complianceExportGenerationJobSchema = z
  .object({
    id: adminIdSchema,
    mode: z.string().min(1),
    status: z.string().min(1),
    costDreamcoins: z.number().int(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const complianceExportCharacterSchema = z
  .object({
    id: adminIdSchema,
    name: z.string(),
    visibility: z.string().min(1),
    status: z.string().min(1),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const complianceExportReportSchema = z
  .object({
    id: adminIdSchema,
    targetType: z.string().min(1),
    category: z.string().min(1),
    status: z.string().min(1),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const complianceAgeVerificationSchema = z
  .object({
    id: adminIdSchema,
    userId: adminIdSchema,
    provider: z.string().min(1),
    status: z.string().min(1),
    jurisdiction: z.string().nullable(),
    verifiedAt: adminIsoDateTimeSchema.nullable(),
    expiresAt: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

const complianceExportAgeVerificationSchema = z
  .object({
    id: adminIdSchema,
    provider: z.string().min(1),
    status: z.string().min(1),
    verifiedAt: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const complianceUserExportResponseSchema = z
  .object({
    export: z
      .object({
        user: complianceExportUserSchema,
        subscriptions: z.array(complianceExportSubscriptionSchema),
        ledger: z.array(complianceExportLedgerEntrySchema),
        jobs: z.array(complianceExportGenerationJobSchema),
        characters: z.array(complianceExportCharacterSchema),
        reports: z.array(complianceExportReportSchema),
        ageVerifications: z.array(complianceExportAgeVerificationSchema),
      })
      .strict(),
  })
  .strict();

export const complianceEraseRequestSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const complianceEraseResponseSchema = z
  .object({
    erased: z.literal(true),
    idempotent: z.boolean(),
    deletion: z
      .object({
        id: adminIdSchema,
        status: z.string().min(1),
        gracePeriodMs: z.number().int(),
        requestedAt: adminIsoDateTimeSchema,
        graceEndsAt: adminIsoDateTimeSchema,
      })
      .strict(),
  })
  .strict();

export const complianceAgeVerificationQuerySchema = z
  .object({
    status: z.string().trim().min(1).max(40).optional(),
    userId: adminIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const complianceAgeVerificationListResponseSchema = z
  .object({ items: z.array(complianceAgeVerificationSchema) })
  .strict();

// INVARIANT: 只裁决成年验证争议，`status` 因此没有第三个取值 —— 未成年硬底线不在这条路径上。
export const complianceAgeVerificationOverrideRequestSchema = z
  .object({
    status: z.enum(["verified", "failed"]),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const complianceAgeVerificationOverrideResponseSchema = z
  .object({
    ageVerification: z
      .object({
        id: adminIdSchema,
        status: z.string().min(1),
        verifiedAt: adminIsoDateTimeSchema.nullable(),
      })
      .strict(),
  })
  .strict();
