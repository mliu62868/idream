import type { Prisma } from "@prisma/client";

export const characterDraftAssetPurposes = [
  "character_cover",
  "character_hero",
  "character_chat",
] as const;

export type CharacterDraftAssetPurpose =
  (typeof characterDraftAssetPurposes)[number];

export type DraftAssetRouteEntry = {
  readonly assetId: string;
  readonly runId: string | null;
  readonly itemId: string | null;
  readonly reviewDecisionId: string | null;
  readonly generationJobId: string | null;
  readonly bootstrapIdentity: boolean;
  readonly generationRouteFingerprint: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function draftAssetRouteEntries(
  value: Prisma.JsonValue,
): Partial<Record<CharacterDraftAssetPurpose, DraftAssetRouteEntry>> {
  const source = record(value);
  return Object.fromEntries(
    characterDraftAssetPurposes.flatMap((purpose) => {
      const raw = source[purpose];
      if (typeof raw === "string") {
        return [
          [
            purpose,
            {
              assetId: raw,
              runId: null,
              itemId: null,
              reviewDecisionId: null,
              generationJobId: null,
              bootstrapIdentity: false,
              generationRouteFingerprint: null,
            },
          ],
        ];
      }
      const entry = record(raw);
      if (typeof entry.assetId !== "string") return [];
      return [
        [
          purpose,
          {
            assetId: entry.assetId,
            runId: typeof entry.runId === "string" ? entry.runId : null,
            itemId: typeof entry.itemId === "string" ? entry.itemId : null,
            reviewDecisionId:
              typeof entry.reviewDecisionId === "string"
                ? entry.reviewDecisionId
                : null,
            generationJobId:
              typeof entry.generationJobId === "string"
                ? entry.generationJobId
                : null,
            bootstrapIdentity: entry.bootstrapIdentity === true,
            generationRouteFingerprint:
              typeof entry.generationRouteFingerprint === "string"
                ? entry.generationRouteFingerprint
                : null,
          },
        ],
      ];
    }),
  );
}

// 只要 assetId 的读法：运营台的 project.draftAssetPack 与「有没有草稿图工作」都只关心
// 每个用途选了哪张图，不关心它是怎么来的。
export function characterAssetPack(
  value: Prisma.JsonValue,
): Partial<Record<CharacterDraftAssetPurpose, string>> {
  const source = record(value);
  return Object.fromEntries(
    characterDraftAssetPurposes.flatMap((purpose) => {
      const entry = source[purpose];
      if (typeof entry === "string") return [[purpose, entry]];
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const assetId = (entry as Record<string, unknown>).assetId;
      return typeof assetId === "string" ? [[purpose, assetId]] : [];
    }),
  );
}

/**
 * SPEC: 运营位选择与图片的生产路线解耦；完整性只看三个用途是否都有素材。
 * INTENT: 路线仍决定“还能不能继续生成”，但不让一次模型或工作流升级使已选运营图失效。
 */
export function evaluateDraftAssetRouteAuthority(
  value: Prisma.JsonValue,
  currentRouteFingerprint: string | null,
) {
  const entries = draftAssetRouteEntries(value);
  const selectedPurposes = characterDraftAssetPurposes.filter(
    (purpose) => entries[purpose],
  );
  const missingPurposes = characterDraftAssetPurposes.filter(
    (purpose) => !entries[purpose],
  );
  const stalePurposes: CharacterDraftAssetPurpose[] = [];
  const routeCurrentByPurpose = Object.fromEntries(
    selectedPurposes.map((purpose) => [purpose, true]),
  ) as Partial<Record<CharacterDraftAssetPurpose, boolean>>;

  return {
    status:
      selectedPurposes.length === 0 ? ("empty" as const) : ("current" as const),
    currentRouteFingerprint,
    stalePurposes,
    missingPurposes,
    recoveryPurpose: stalePurposes[0] ?? null,
    routeCurrentByPurpose,
    // Bootstrap describes how the image established identity. Its exact
    // identity pins are checked at Release, independently of the selected slot.
    releaseReady: missingPurposes.length === 0,
    releaseBlockers: [
      ...(missingPurposes.length > 0 ? ["draft_asset_pack_incomplete"] : []),
    ],
  };
}
