// SPEC: 生成计价单一实现（SSoT）：每个 mode 必须恰好有一个 active
//       PricingRule，cost = ceil(base * outputCount * multiplier)。
// INVARIANT: 缺失或重复 active 规则都必须 fail closed；绝不能猜规则或用历史常量扣款。
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

export type BillableGenerationMode = "image" | "video" | "voice";

export async function generationCostDreamcoins(
  mode: BillableGenerationMode,
  outputCount: number,
  multiplier = 1,
): Promise<number> {
  const now = new Date();
  const activeRules = await prisma.pricingRule.findMany({
    where: {
      mode,
      status: "active",
      OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
    },
    select: { baseCost: true },
    take: 2,
  });
  if (activeRules.length !== 1) {
    throw Errors.conflict("Generation pricing is unavailable", {
      mode,
      reason: activeRules.length === 0 ? "missing_active_rule" : "ambiguous_active_rules",
    });
  }
  return Math.ceil(activeRules[0].baseCost * outputCount * multiplier);
}
