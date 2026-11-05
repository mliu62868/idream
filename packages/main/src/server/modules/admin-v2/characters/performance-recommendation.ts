import type {
  CharacterPerformanceRecommendation,
  CharacterPerformanceSummary,
} from "@idream/shared/admin";
import { MIN_CHAT_STARTS, MIN_IMPRESSIONS } from "./performance";

// SPEC: BackendFeatureSpec §8.4 的 Promote/Maintain/Improve/Pause/Retire 建议与诊断。
// INVARIANT: 纯函数，只产出建议。未成熟或样本不足只输出 insufficient_data，绝不自动执行。

const MIN_PEERS = 5;
// 相对同类中位数 ±20% 之内都算「正常波动」；低于一半才谈得上暂停或退役。
const LOW_RATIO = 0.8;
const HIGH_RATIO = 1.2;
const SEVERE_RATIO = 0.5;
const PLATFORM_DECLINE_SHARE = 0.6;

type Baseline = NonNullable<CharacterPerformanceRecommendation["baseline"]>;
type Metrics = Pick<
  CharacterPerformanceSummary,
  | "maturity"
  | "qualityState"
  | "detailCtr"
  | "chatStartRate"
  | "qceRate"
  | "sameCharacterD7"
  | "window"
>;

type Compare = "low" | "severe" | "normal" | "high" | "unknown";
function compare(value: number | null, baseline: number | null): Compare {
  if (value === null || baseline === null || baseline === 0) return "unknown";
  if (value < baseline * SEVERE_RATIO) return "severe";
  if (value < baseline * LOW_RATIO) return "low";
  return value > baseline * HIGH_RATIO ? "high" : "normal";
}
const isLow = (value: Compare) => value === "low" || value === "severe";

export function characterPerformanceRecommendation(input: {
  readonly window: CharacterPerformanceSummary["window"];
  readonly summary: Metrics | null;
  readonly baseline: Baseline | null;
  readonly servingState: string;
  readonly declinedWithPlatform: boolean;
}): CharacterPerformanceRecommendation {
  const { window, summary, baseline } = input;
  const result = (
    recommendation: CharacterPerformanceRecommendation["recommendation"],
    reasonCode: CharacterPerformanceRecommendation["reasonCode"],
    targetTab: CharacterPerformanceRecommendation["targetTab"],
  ): CharacterPerformanceRecommendation => ({
    window,
    recommendation,
    reasonCode,
    targetTab,
    baseline,
  });
  if (!summary || summary.maturity === "immature") {
    return result("insufficient_data", "window_immature", "monitor");
  }
  if (summary.qualityState === "invalid") {
    return result("insufficient_data", "data_invalid", "monitor");
  }
  if (summary.qualityState === "no_data" || summary.maturity !== "mature") {
    return result("insufficient_data", "sample_insufficient", "monitor");
  }
  if (!baseline) return result("insufficient_data", "no_peer_baseline", "monitor");
  // 全平台同期普遍下跌时，单角色的诊断没有意义，先看平台。
  if (input.declinedWithPlatform) {
    return result("maintain", "platform_wide_decline", null);
  }
  const ctr = compare(summary.detailCtr, baseline.detailCtr);
  const starts = compare(summary.chatStartRate, baseline.chatStartRate);
  const qce = compare(summary.qceRate, baseline.qceRate);
  const d7 = compare(summary.sameCharacterD7, baseline.sameCharacterD7);
  const retentionHigh = qce === "high" || d7 === "high";
  if (qce === "severe" && d7 === "severe") {
    // 退役不可撤销，只在满 28 天的证据上才提，且只是建议。
    return window === "28d" && ctr === "severe"
      ? result("retire", "persistently_underperforming", "release")
      : input.servingState === "paused"
        ? result("maintain", "severely_underperforming", "release")
        : result("pause", "severely_underperforming", "release");
  }
  if (isLow(ctr) && retentionHigh) {
    return result("improve", "low_ctr_high_retention", "assets");
  }
  if (starts === "high" && isLow(qce)) {
    return result("improve", "high_starts_low_qce", "soul");
  }
  if (qce === "high" && isLow(d7)) {
    return result("improve", "high_qce_low_d7", "soul");
  }
  if (isLow(qce)) return result("improve", "low_qce", "soul");
  if (isLow(d7)) return result("improve", "low_d7", "soul");
  if (qce === "high" && (d7 === "high" || d7 === "normal")) {
    return result("promote", "outperforming_peers", "monitor");
  }
  return result("maintain", "in_line_with_peers", "monitor");
}

export interface CharacterPeerFunnelRow {
  readonly characterId: string;
  readonly style: string;
  readonly gender: string;
  readonly matured: boolean;
  readonly impressions: number;
  readonly detailViews: number;
  readonly chatStarts: number;
  readonly qce: number;
  readonly d7Pairs: number;
  readonly d7Returns: number;
  readonly priorChatStarts: number;
  readonly priorQce: number;
}

function median(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const rate = (numerator: number, denominator: number) =>
  denominator > 0 ? numerator / denominator : null;
const present = (values: ReadonlyArray<number | null>) =>
  values.filter((value): value is number => value !== null);

// SPEC: 同类 = 同 style+gender 的合格角色（窗口走完且达到最小样本）；不足 MIN_PEERS 个不比较。
export function characterPeerBaselines(rows: readonly CharacterPeerFunnelRow[]) {
  const groups = new Map<string, CharacterPeerFunnelRow[]>();
  for (const row of rows) {
    if (!row.matured || row.impressions < MIN_IMPRESSIONS || row.chatStarts < MIN_CHAT_STARTS) continue;
    const key = peerKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return new Map(
    [...groups].flatMap(([key, peers]): Array<readonly [string, Baseline]> =>
      peers.length < MIN_PEERS
        ? []
        : [[key, {
            peerCount: peers.length,
            detailCtr: median(present(peers.map((peer) => rate(peer.detailViews, peer.impressions)))),
            chatStartRate: median(present(peers.map((peer) => rate(peer.chatStarts, peer.detailViews)))),
            qceRate: median(present(peers.map((peer) => rate(peer.qce, peer.chatStarts)))),
            sameCharacterD7: median(present(peers.map((peer) => rate(peer.d7Returns, peer.d7Pairs)))),
          }] as const],
    ),
  );
}

export function peerKey(row: Pick<CharacterPeerFunnelRow, "style" | "gender">) {
  return `${row.style}|${row.gender}`;
}

// SPEC: 跨角色同期失败：两个窗口都有足量开聊的角色里，多数 QCE 率相对上一窗口掉了 20% 以上。
// 只作提示，链接到事故页，不自动建 Incident。
export function characterPlatformDecliners(rows: readonly CharacterPeerFunnelRow[]) {
  const comparable = rows.filter(
    (row) => row.chatStarts >= MIN_CHAT_STARTS && row.priorChatStarts >= MIN_CHAT_STARTS,
  );
  const decliners = comparable.filter(
    (row) => row.qce / row.chatStarts < (row.priorQce / row.priorChatStarts) * LOW_RATIO,
  );
  return comparable.length >= MIN_PEERS &&
    decliners.length / comparable.length >= PLATFORM_DECLINE_SHARE
    ? new Set(decliners.map((row) => row.characterId))
    : new Set<string>();
}
