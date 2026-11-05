import type { CharacterPortfolioItem } from "@idream/shared/admin";
import type { CharacterWorkspaceTab } from "./character-deep-link";

export type CharacterAttentionReason = NonNullable<
  CharacterPortfolioItem["attentionReason"]
>;

// SPEC: 「这个角色为什么要人处理」只在这里判一次。列表 attention、卡片和 Today 都读它，
//       判定用的 SQL 事实在 today/work-severity.ts，不另建状态。
export function characterAttentionReason(input: {
  readonly monitorActionRequired: boolean;
  readonly noTraffic: boolean;
}): CharacterAttentionReason | null {
  if (input.monitorActionRequired) return "release_monitor_action";
  return input.noTraffic ? "no_traffic_after_window" : null;
}

const ATTENTION_COPY: Record<
  CharacterAttentionReason,
  {
    readonly summary: string;
    readonly recommendedAction: string;
    readonly tab: CharacterWorkspaceTab;
  }
> = {
  release_monitor_action: {
    summary: "published monitor requires action",
    recommendedAction: "Investigate monitor evidence and keep or rollback",
    tab: "monitor",
  },
  no_traffic_after_window: {
    summary: "no exposure, funnel, or chat traffic after 7 days live",
    recommendedAction: "Check placement targeting and event delivery",
    tab: "monitor",
  },
};

export function characterAttentionCopy(reason: CharacterAttentionReason | null) {
  return reason ? ATTENTION_COPY[reason] : null;
}
