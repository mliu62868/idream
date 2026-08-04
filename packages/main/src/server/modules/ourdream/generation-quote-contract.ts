import { z } from "zod";

// INVARIANT: 六字段全部参与 quote -> submit 比对；缺一项都不能授权生成。
export const generationQuoteAuthoritySchema = z
  .object({
    profileId: z.string().trim().min(1).max(180),
    profileVersion: z.number().int().positive(),
    routeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    pricingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    outputCount: z.number().int().min(1).max(8),
    costDreamcoins: z.number().int().nonnegative(),
  })
  .strict();

export type GenerationQuoteAuthority = z.infer<
  typeof generationQuoteAuthoritySchema
>;
