// SPEC: 生成计价单一实现（SSoT）：取 mode 的最新 active PricingRule
//       （effectiveFrom desc, version desc），cost = ceil(base * outputCount * multiplier)。
// INVARIANTS: 无 active 规则时用内置兜底（image=5 / video=100），与用户侧历史行为一致。
// EXAMPLE: 规则 baseCost=7 时 generationCostDreamcoins("image", 2, 1) → 14
import { prisma } from "@/server/lib/db";

const FALLBACK_BASE_COST: Record<"image" | "video", number> = { image: 5, video: 100 };

export async function generationCostDreamcoins(
  mode: "image" | "video",
  outputCount: number,
  multiplier = 1,
): Promise<number> {
  const pricing = await prisma.pricingRule.findFirst({
    where: { mode, status: "active" },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
  });
  const base = pricing?.baseCost ?? FALLBACK_BASE_COST[mode];
  return Math.ceil(base * outputCount * multiplier);
}
