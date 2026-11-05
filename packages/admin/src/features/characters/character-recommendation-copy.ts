import type { CharacterPerformanceRecommendation } from "@idream/shared/admin";

// SPEC: 建议只显示一句人话；表现页和角色监控共用。
export const CHARACTER_RECOMMENDATION_LABELS: Record<
  CharacterPerformanceRecommendation["recommendation"],
  string
> = {
  promote: "Promote",
  maintain: "Maintain",
  improve: "Improve",
  pause: "Consider pausing",
  retire: "Consider retiring",
  insufficient_data: "Insufficient data",
};

export const CHARACTER_RECOMMENDATION_SENTENCES: Record<
  CharacterPerformanceRecommendation["reasonCode"],
  string
> = {
  window_immature: "The window has not closed yet, so there is nothing to judge.",
  sample_insufficient: "Too little traffic to judge this window.",
  data_invalid: "This window's data is inconsistent and cannot support a decision.",
  no_peer_baseline: "Not enough comparable characters of the same style and gender.",
  platform_wide_decline: "Most characters fell in the same period. This may be a platform issue; check Incidents.",
  low_ctr_high_retention: "People who open it stay, but few open it. Check the images and placement.",
  high_starts_low_qce: "Many chats start but few become quality conversations. Check the opening and persona.",
  high_qce_low_d7: "Chats go well but people do not come back. Check continuity and memory.",
  low_qce: "Quality conversations are below similar characters. Check the opening and persona.",
  low_d7: "Fewer people come back than for similar characters. Check continuity and memory.",
  outperforming_peers: "Clearly ahead of similar characters. A good candidate for more exposure.",
  severely_underperforming: "Far below similar characters on quality and return. Your call whether to pause it.",
  persistently_underperforming: "Far below similar characters across a full 28 days. Your call whether to retire it.",
  in_line_with_peers: "In line with similar characters.",
};
