import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema } from "./common";
import { operationsCaseSchema } from "./cases";

export const customer360Schema = z
  .object({
    customer: z
      .object({
        id: adminIdSchema,
        email: z.string().email(),
        displayName: z.string().nullable(),
        status: z.string().min(1),
        createdAt: adminIsoDateTimeSchema,
      })
      .strict(),
    overview: z
      .object({
        balanceDreamcoins: z.number().int(),
        activeCaseCount: z.number().int().nonnegative(),
        failedGenerationCount30d: z.number().int().nonnegative(),
        lastActiveAt: adminIsoDateTimeSchema.nullable(),
      })
      .strict(),
    subscription: z
      .object({
        id: adminIdSchema,
        status: z.string().min(1),
        currentPeriodEnd: adminIsoDateTimeSchema.nullable(),
        cancelAtPeriodEnd: z.boolean(),
        plan: z.object({ id: adminIdSchema, name: z.string().min(1), billingPeriod: z.string().min(1) }).strict(),
      })
      .strict()
      .nullable(),
    relationships: z.array(z.object({
      characterId: adminIdSchema,
      characterName: z.string().min(1),
      sessionId: adminIdSchema,
      lastMessageAt: adminIsoDateTimeSchema.nullable(),
    }).strict()).readonly(),
    generations: z.array(z.object({
      id: adminIdSchema,
      mode: z.string().min(1),
      status: z.string().min(1),
      costDreamcoins: z.number().int(),
      createdAt: adminIsoDateTimeSchema,
    }).strict()).readonly(),
    ledger: z.array(z.object({
      id: adminIdSchema,
      delta: z.number().int(),
      balanceAfter: z.number().int(),
      reason: z.string().min(1),
      sourceId: z.string().nullable(),
      createdAt: adminIsoDateTimeSchema,
    }).strict()).readonly(),
    cases: z.array(operationsCaseSchema).readonly(),
    activity: z.array(z.object({
      id: adminIdSchema,
      action: z.string().min(1),
      targetType: z.string().min(1),
      targetId: adminIdSchema,
      createdAt: adminIsoDateTimeSchema,
    }).strict()).readonly(),
    asOf: adminIsoDateTimeSchema,
  })
  .strict();

export type Customer360 = z.infer<typeof customer360Schema>;
