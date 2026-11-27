"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { formatDreamcoins } from "@/components/admin/ui/format";

type ImageGenerationEstimates = CharacterWorkspaceDetail["visual"]["imageGenerationEstimates"];

export type CharacterImageCostEstimate = {
  readonly perItemCostDreamcoins: number;
  readonly imageCount: number;
  readonly totalCostDreamcoins: number;
};

// SPEC: 每张图是一条独立的单图 Run，Main 用同一条规则逐条记账：合计 = 单价 × 张数。
// INTENT: 单价只来自 Main 投影的 imageGenerationEstimates；对应 profile 没有单价就返回 null，
//         界面不显示，绝不在前端推算或兜底一个数字。
export function characterImageCostEstimate(input: {
  readonly estimates: ImageGenerationEstimates;
  readonly profileKey: string | null | undefined;
  readonly imageCount: number;
}): CharacterImageCostEstimate | null {
  if (!input.profileKey || input.imageCount < 1) return null;
  const estimate = input.estimates?.find(
    (candidate) => candidate.profileKey === input.profileKey,
  );
  if (!estimate) return null;
  return {
    perItemCostDreamcoins: estimate.perItemCostDreamcoins,
    imageCount: input.imageCount,
    totalCostDreamcoins: estimate.perItemCostDreamcoins * input.imageCount,
  };
}

/**
 * 提交前的费用预估。`manual` 是手动生成（一次 1/2/4 张）；`missing` 是「生成缺失图片」，
 * 已有图片、候选或进行中 Run 的展示位会被 Main 跳过且不计费，所以只给上限。
 */
export function CharacterImageCostEstimateNote(props: {
  readonly estimates: ImageGenerationEstimates;
  readonly profileKey: string | null | undefined;
  readonly imageCount: number;
  readonly variant: "manual" | "missing";
  readonly className?: string;
}) {
  const { locale, t } = useAdminI18n();
  const estimate = characterImageCostEstimate(props);
  if (!estimate) return null;
  const perItem = formatDreamcoins(estimate.perItemCostDreamcoins, locale);
  const total = formatDreamcoins(estimate.totalCostDreamcoins, locale);
  const text = props.variant === "missing"
    ? t("Estimated cost: up to {total} ({perItem} × {count} images). Placements that are skipped are not charged.", {
        total,
        perItem,
        count: estimate.imageCount,
      })
    : estimate.imageCount === 1
      ? t("Estimated cost: {cost}", { cost: total })
      : t("Estimated cost: {perItem} × {count} images = {total}", {
          perItem,
          count: estimate.imageCount,
          total,
        });
  return (
    <p
      aria-label={t("Generation estimate")}
      className={props.className ?? "text-xs leading-5 text-[var(--ad-text-muted)]"}
      data-testid={`character-image-cost-estimate-${props.variant}`}
    >
      {text}
    </p>
  );
}
