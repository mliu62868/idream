import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema } from "./common";

/**
 * SPEC: 财务滥用信号总览（多账号设备簇 / 推荐农场 / 人工调整异常）。
 * INTENT: 这是一个只读的信号面板，处置动作留在各自的来源域，所以契约里没有任何命令。
 *         `dataScope` 与 `window` 一起发出去，读的人才知道这些数字是在什么范围、什么时间窗上算的。
 */

export const riskAbuseQuerySchema = z
  .object({
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
  })
  .strict();

export const riskAbuseOverviewSchema = z
  .object({
    dataScope: z
      .object({
        kind: z.literal("customer"),
        includedDataClasses: z.array(z.string()),
        excludedDataClasses: z.array(z.string()),
      })
      .strict(),
    window: z
      .object({ from: adminIsoDateTimeSchema, to: adminIsoDateTimeSchema })
      .strict(),
    deviceClusters: z.array(
      z
        .object({
          anonymousId: z.string().min(1),
          accountCount: z.number().int(),
          userIds: z.array(adminIdSchema),
        })
        .strict(),
    ),
    referralAbuse: z.array(
      z
        .object({ inviterId: adminIdSchema, referralCount: z.number().int() })
        .strict(),
    ),
    adjustAnomalies: z.array(
      z
        .object({
          userId: adminIdSchema,
          totalDelta: z.number().int(),
          count: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();
