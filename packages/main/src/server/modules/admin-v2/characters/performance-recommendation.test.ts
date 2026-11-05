import { describe, expect, it } from "vitest";
import {
  characterPeerBaselines,
  characterPerformanceRecommendation,
  characterPlatformDecliners,
  peerKey,
  type CharacterPeerFunnelRow,
} from "./performance-recommendation";

const baseline = { peerCount: 6, detailCtr: 0.4, chatStartRate: 0.5, qceRate: 0.5, sameCharacterD7: 0.3 };
const mature = {
  window: "28d" as const,
  maturity: "mature" as const,
  qualityState: "directional" as const,
  detailCtr: 0.4,
  chatStartRate: 0.5,
  qceRate: 0.5,
  sameCharacterD7: 0.3,
};
function recommend(
  summary: Partial<typeof mature> | null,
  overrides: Partial<Parameters<typeof characterPerformanceRecommendation>[0]> = {},
) {
  return characterPerformanceRecommendation({
    window: "28d",
    summary: summary === null ? null : ({ ...mature, ...summary } as typeof mature),
    baseline,
    servingState: "live",
    declinedWithPlatform: false,
    ...overrides,
  });
}

describe("character performance recommendation", () => {
  // SPEC: insufficient_data 不自动淘汰角色。再差的数字只要未成熟或样本不足，也只说数据不足。
  it("only says insufficient_data until the evidence is mature", () => {
    const awful = { qceRate: 0, sameCharacterD7: 0, detailCtr: 0 };
    for (const [summary, reasonCode] of [
      [null, "window_immature"],
      [{ ...awful, maturity: "immature" }, "window_immature"],
      [{ ...awful, maturity: "insufficient_data" }, "sample_insufficient"],
      [{ ...awful, qualityState: "no_data" }, "sample_insufficient"],
      [{ ...awful, qualityState: "invalid" }, "data_invalid"],
    ] as const) {
      expect(recommend(summary as never)).toMatchObject({ recommendation: "insufficient_data", reasonCode });
    }
    expect(recommend(awful, { baseline: null })).toMatchObject({
      recommendation: "insufficient_data",
      reasonCode: "no_peer_baseline",
    });
  });

  it("maps the §8.4 diagnostics to the tab that can act on them", () => {
    expect(recommend({ detailCtr: 0.2, qceRate: 0.7 })).toMatchObject({
      recommendation: "improve",
      reasonCode: "low_ctr_high_retention",
      targetTab: "assets",
    });
    expect(recommend({ chatStartRate: 0.8, qceRate: 0.3 })).toMatchObject({
      recommendation: "improve",
      reasonCode: "high_starts_low_qce",
      targetTab: "soul",
    });
    expect(recommend({ qceRate: 0.7, sameCharacterD7: 0.2 })).toMatchObject({
      recommendation: "improve",
      reasonCode: "high_qce_low_d7",
      targetTab: "soul",
    });
    expect(recommend({ qceRate: 0.7, sameCharacterD7: 0.4 })).toMatchObject({
      recommendation: "promote",
      reasonCode: "outperforming_peers",
    });
    expect(recommend({})).toMatchObject({ recommendation: "maintain", reasonCode: "in_line_with_peers" });
  });

  it("escalates only on severe evidence and proposes retire only on a full 28d window", () => {
    const severe = { qceRate: 0.1, sameCharacterD7: 0.05 };
    expect(recommend(severe)).toMatchObject({ recommendation: "pause", reasonCode: "severely_underperforming" });
    expect(recommend(severe, { servingState: "paused" }).recommendation).toBe("maintain");
    expect(recommend({ ...severe, detailCtr: 0.1 })).toMatchObject({ recommendation: "retire" });
    expect(
      recommend({ ...severe, detailCtr: 0.1, window: "7d" as never }, { window: "7d" }).recommendation,
    ).toBe("pause");
  });

  it("does not compare a missing D7 as a low D7", () => {
    expect(recommend({ sameCharacterD7: null as never })).toMatchObject({ recommendation: "maintain" });
    expect(recommend({ qceRate: 0.7, sameCharacterD7: null as never }).recommendation).toBe("maintain");
  });

  it("points a platform-wide decline at incidents instead of blaming the Character", () => {
    expect(recommend({ qceRate: 0.1 }, { declinedWithPlatform: true })).toEqual({
      window: "28d",
      recommendation: "maintain",
      reasonCode: "platform_wide_decline",
      targetTab: null,
      baseline,
    });
  });
});

function row(id: string, overrides: Partial<CharacterPeerFunnelRow> = {}): CharacterPeerFunnelRow {
  return {
    characterId: id,
    style: "realistic",
    gender: "female",
    matured: true,
    impressions: 200,
    detailViews: 100,
    chatStarts: 50,
    qce: 25,
    d7Pairs: 10,
    d7Returns: 3,
    priorChatStarts: 50,
    priorQce: 25,
    ...overrides,
  };
}

describe("peer baseline", () => {
  it("uses the median of qualified peers in the same style and gender", () => {
    const rows = [0.2, 0.3, 0.4, 0.5, 0.9].map((rate, index) =>
      row(`c${index}`, { qce: rate * 50 }),
    );
    const baselines = characterPeerBaselines([
      ...rows,
      row("other-style", { style: "anime", qce: 50 }),
      row("too-small", { chatStarts: 5, qce: 5 }),
      row("too-new", { matured: false, qce: 50 }),
    ]);
    const result = baselines.get(peerKey(rows[0]));
    expect(result?.peerCount).toBe(5);
    expect(result?.qceRate).toBeCloseTo(0.4);
    // 同类不足不比较，而不是拿一两个角色当基线。
    expect(baselines.get("anime|female")).toBeUndefined();
  });

  it("leaves a rate without denominator out of the median", () => {
    const rows = ["a", "b", "c", "d", "e"].map((id) => row(id, { d7Pairs: 0, d7Returns: 0 }));
    expect(characterPeerBaselines(rows).get("realistic|female")?.sameCharacterD7).toBeNull();
  });
});

describe("platform decline", () => {
  it("flags decliners only when most comparable Characters fell together", () => {
    const fell = ["a", "b", "c", "d"].map((id) => row(id, { qce: 10 }));
    expect([...characterPlatformDecliners([...fell, row("steady")])].sort()).toEqual(["a", "b", "c", "d"]);
    expect(characterPlatformDecliners([fell[0], fell[1], row("x"), row("y"), row("z")]).size).toBe(0);
    // 可比角色太少不下结论。
    expect(characterPlatformDecliners(fell).size).toBe(0);
  });
});
