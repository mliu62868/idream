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

// SPEC: 账号擦除是一条跨两个服务、四个阶段、带宽限期的不可逆承诺。
// INTENT: 运营按下 Erase 到擦除真正发生之间隔着一整个宽限期，按按钮的人早就走了；
//         擦除完成时也没有任何审计行（完成路径不写审计，请求那行的 targetId 还会被改写成
//         不可逆的 subject ref）。在这张表出现之前，后台看不到任何一条擦除请求的下落。
// INVARIANT: 这里不发明「积压多久算久」的阈值，只摊开权威自己的事实——宽限期到期时间、
//            Chat 投递行的 attempts、Blob 回执进度、finalize 写回的 lastError。
export const COMPLIANCE_ACCOUNT_DELETION_WAITING_ON = [
  "grace_period",
  "chat_erasure",
  "blob_deletion",
  "main_purge",
  "nothing",
] as const;

export const complianceAccountDeletionSchema = z
  .object({
    id: adminIdSchema,
    // 完成后 userId 被置空：那正是「主库已清干净」的证据，不是缺字段。
    userId: adminIdSchema.nullable(),
    status: z.string().min(1),
    waitingOn: z.enum(COMPLIANCE_ACCOUNT_DELETION_WAITING_ON),
    // INVARIANT: 只断言「承诺的日子已经过了，事情还没做完」这一个结构事实。
    pastDue: z.boolean(),
    requestedAt: adminIsoDateTimeSchema,
    graceEndsAt: adminIsoDateTimeSchema,
    chatCompletedAt: adminIsoDateTimeSchema.nullable(),
    blobExpectedCount: z.number().int(),
    blobDeletedCount: z.number().int(),
    completedAt: adminIsoDateTimeSchema.nullable(),
    updatedAt: adminIsoDateTimeSchema,
    blockedReason: z.string().nullable(),
    chatRequestDelivery: z
      .object({
        status: z.string().min(1),
        attempts: z.number().int(),
        nextRunAt: adminIsoDateTimeSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const complianceAccountDeletionQuerySchema = z
  .object({
    scope: z.enum(["open", "all"]).default("open"),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const complianceAccountDeletionListResponseSchema = z
  .object({
    items: z.array(complianceAccountDeletionSchema),
    // 分页会截断 items，这个数不会——它是「有多少条已经过期还没做完」的唯一可信来源。
    pastDueCount: z.number().int(),
  })
  .strict();
