import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CharacterOperationsSummary, CharacterPortfolioItem } from "@idream/shared/admin";
import { translateAdmin } from "@/components/admin/i18n";
import { CHARACTER_RECOMMENDATION_LABELS, CHARACTER_RECOMMENDATION_SENTENCES } from "./character-recommendation-copy";
import { characterOperationsSummaryRows } from "./CharacterOperationsSummaryPanel";
import { CharacterPerformanceBoard, characterPerformanceBoardQuery, characterPerformanceRow } from "./CharacterPerformanceBoard";
import { BULK_ACTION_LABELS } from "./character-bulk-operations";

describe("Character performance board", () => {
  // SPEC: 表现页曾按更新时间列出所有 portfolio，连归档草稿都在。
  it("asks only for live and paused Characters, on one window, sorted by a funnel metric", () => {
    const params = new URLSearchParams(
      characterPerformanceBoardQuery({ window: "7d", sort: "qce_rate_desc", scope: "operating", search: " mira " }),
    );
    expect(Object.fromEntries(params)).toEqual({
      limit: "25",
      includePerformance: "true",
      aggregateOnly: "true",
      performanceWindow: "7d",
      sort: "qce_rate_desc",
      operating: "true",
      search: "mira",
    });
    const paused = new URLSearchParams(
      characterPerformanceBoardQuery({ window: "28d", sort: "impressions_asc", scope: "paused", search: "" }),
    );
    expect(paused.get("servingState")).toBe("paused");
    expect(paused.has("operating")).toBe(false);
  });

  it("fails closed on no_data and invalid windows and links a platform decline to incidents", () => {
    const base = {
      characterId: "a",
      changeMarkers: [{ window: "28d", comparable: true }, { window: "7d", comparable: false }],
      recommendation: { targetTab: "soul" },
      performance: [
        { window: "28d", placementId: null, qualityState: "directional" },
        { window: "7d", placementId: null, qualityState: "no_data" },
      ],
    } as unknown as CharacterPortfolioItem;
    expect(characterPerformanceRow(base, "28d")).toMatchObject({ usable: true, href: "/admin/characters/a?tab=soul" });
    expect(characterPerformanceRow(base, "28d").comparison).not.toBeNull();
    expect(characterPerformanceRow(base, "7d")).toMatchObject({ usable: false, comparison: null });
    expect(
      characterPerformanceRow({ ...base, recommendation: { targetTab: null } } as unknown as CharacterPortfolioItem, "28d").href,
    ).toBe("/admin/ops/incidents");
  });

  it("does not offer anything before the first page loads, and denies without the read grant", () => {
    const loading = renderToStaticMarkup(<CharacterPerformanceBoard canOpenProject canRead />);
    expect(loading).toContain("Loading release-attributed portfolio");
    expect(loading).toContain('aria-pressed="true"');
    expect(renderToStaticMarkup(<CharacterPerformanceBoard canOpenProject canRead={false} />)).toContain("character.performance.read");
  });
});

describe("Operating efficiency", () => {
  const empty: CharacterOperationsSummary = {
    window: "7d",
    windowStart: "2026-08-13T00:00:00.000Z",
    windowEnd: "2026-08-20T00:00:00.000Z",
    firstUsableImage: { medianHours: null, sampleSize: 0 },
    createToFirstPublish: { medianHours: null, sampleSize: 0 },
    imageAdoption: { adopted: 0, generated: 0, rate: null },
    adoptedImageCost: { microsPerAdoptedImage: null, currency: "USD", coverage: "none" },
    publishFailures: { count: 0, coverage: "committed_commands_only" },
    operationCount: 0,
  };
  const value = (rows: ReturnType<typeof characterOperationsSummaryRows>, label: string) =>
    rows.find((row) => row.label === label);

  it("says none yet instead of inventing a zero", () => {
    const rows = characterOperationsSummaryRows(empty);
    for (const label of ["Time to first usable image", "Creation to first publish", "Image adoption", "Real cost per adopted image"]) {
      expect(value(rows, label)?.value).toBe("None yet");
    }
  });

  it("is honest that publish failures only cover committed commands", () => {
    expect(value(characterOperationsSummaryRows(empty), "Publish failures")?.note).toBe("Committed publish failures only");
    expect(translateAdmin("zh", "Committed publish failures only")).toBe("仅统计已提交的发布失败");
  });

  it("formats measured values", () => {
    const rows = characterOperationsSummaryRows({
      ...empty,
      firstUsableImage: { medianHours: 3.25, sampleSize: 4 },
      createToFirstPublish: { medianHours: 72, sampleSize: 2 },
      imageAdoption: { adopted: 1, generated: 4, rate: 0.25 },
      adoptedImageCost: { microsPerAdoptedImage: 40_000, currency: "USD", coverage: "complete" },
    });
    expect(value(rows, "Time to first usable image")?.value).toBe("3.3 h");
    expect(value(rows, "Creation to first publish")?.value).toBe("3.0 d");
    expect(value(rows, "Image adoption")?.value).toBe("25.0%");
    expect(value(rows, "Real cost per adopted image")?.value).toBe("$0.04");
  });
});

describe("Operator copy", () => {
  it("translates every recommendation, reason, bulk action and blocker", () => {
    for (const key of [
      ...Object.values(CHARACTER_RECOMMENDATION_LABELS),
      ...Object.values(CHARACTER_RECOMMENDATION_SENTENCES),
      ...Object.values(BULK_ACTION_LABELS),
      "No visual identity yet.",
      "Only unpublished drafts can be archived here.",
      "Command failed.",
      "The earlier request is still unconfirmed. Retry to check it; this cannot create a duplicate.",
      "Insufficient data",
    ]) {
      expect(translateAdmin("zh", key), key).not.toBe(key);
    }
  });

  // 后端下发的 Journey 阻塞文案也要有中文。
  it("translates the Journey blockers the overview now renders", () => {
    for (const key of [
      "A reusable visual identity has not been established.",
      "A sealed active Reference Set is required.",
      "The active command outcome must be reconciled before another mutation.",
      "The draft has no opening message.",
      "The draft persona must be saved in the current format before publishing.",
      "No qualified image route can consume this Character's Reference Set. This is a platform configuration issue; platform operations can fix it under Profiles & Rollout.",
      "The latest image Run has an unknown outcome and may already have cost money. Check that Run before generating again.",
      "The latest image Run failed without producing an image. Generate it again.",
    ]) {
      expect(translateAdmin("zh", key), key).not.toBe(key);
    }
  });
});
