import {
  generationCostFromAuthority,
  resolveGenerationPricingAuthority,
  type GenerationPricingAuthority,
} from "@/server/lib/generation-pricing";
import { resolveProductionProfile } from "./run-create-authority";

// SPEC: Creative Run 的计价规则只有这一处。每个 Run item 是一条 outputCount=1 的独立
//       Generation Job，单价 = ceil(base × 规则倍率 × profile 倍率)，合计 = 单价 × item 数。
// INTENT: 运营提交前看到的预估与 Run 被接纳时写进 batch.estimatedCostDreamcoins /
//         generationJob.costDreamcoins 的数字必须同源；接纳和预估都调用这里，不另写估算。
// NOTE: 先对单张取整再乘张数——这正是接纳时逐 item 记账的方式，不能改成对合计一次取整。
export function creativeRunCostQuote(input: {
  readonly authority: GenerationPricingAuthority;
  readonly profileCostMultiplier: number | null | undefined;
  readonly itemCount: number;
}) {
  const perItemCostDreamcoins = generationCostFromAuthority(
    input.authority,
    1,
    input.profileCostMultiplier ?? 1,
  );
  return {
    perItemCostDreamcoins,
    totalCostDreamcoins: perItemCostDreamcoins * input.itemCount,
  };
}

/** Creative Run 创建表单的成本预估：与创建走同一套 profile 准入判断与同一条计价规则。 */
export async function estimateCreativeRunCost(input: {
  readonly profileId: string;
  readonly count: number;
}) {
  const profile = await resolveProductionProfile(input.profileId);
  const authority = await resolveGenerationPricingAuthority("image");
  return creativeRunCostQuote({
    authority,
    profileCostMultiplier: profile.costMultiplier,
    itemCount: input.count,
  });
}
