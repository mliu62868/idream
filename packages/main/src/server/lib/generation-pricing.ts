// SPEC: 生成计价单一实现（SSoT）：每个 mode 必须恰好有一个 active
//       PricingRule，cost = ceil(base * outputCount * multiplier)。
// INVARIANT: 缺失或重复 active 规则都必须 fail closed；绝不能猜规则或用历史常量扣款。
// NOTE: 报价握手用来钉住这条规则的 pricingFingerprint 不在这里 —— 它是生成报价
// 协议的一部分，与 routeFingerprint 一起住在
// modules/ourdream/generation-quote.ts。本文件只回答"多少钱"。
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

export type BillableGenerationMode = "image" | "video" | "voice";

export type GenerationPricingAuthority = {
  readonly id: string;
  readonly ruleKey: string;
  readonly version: number;
  readonly baseCost: number;
  readonly effectiveFrom: Date | null;
  readonly updatedAt: Date;
};

export async function resolveGenerationPricingAuthority(
  mode: BillableGenerationMode,
): Promise<GenerationPricingAuthority> {
  const now = new Date();
  const activeRules = await prisma.pricingRule.findMany({
    where: {
      mode,
      status: "active",
      OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
    },
    select: {
      id: true,
      ruleKey: true,
      version: true,
      baseCost: true,
      effectiveFrom: true,
      updatedAt: true,
    },
    take: 2,
  });
  if (activeRules.length !== 1) {
    throw Errors.conflict("Generation pricing is unavailable", {
      mode,
      reason: activeRules.length === 0 ? "missing_active_rule" : "ambiguous_active_rules",
    });
  }
  return activeRules[0];
}

export function generationCostFromAuthority(
  authority: GenerationPricingAuthority,
  outputCount: number,
  multiplier = 1,
): number {
  return Math.ceil(authority.baseCost * outputCount * multiplier);
}

export async function generationCostDreamcoins(
  mode: BillableGenerationMode,
  outputCount: number,
  multiplier = 1,
): Promise<number> {
  const authority = await resolveGenerationPricingAuthority(mode);
  return generationCostFromAuthority(authority, outputCount, multiplier);
}
