"use client";

// SPEC: Character Asset Studio 的候选主舞台（批次 / 对比 / 现有图库 / 空态）—— 只吃 props。
// INTENT: 从 CharacterAssetStudio.tsx 原样移出，纯机械搬运，没有任何行为改动。
import type { CharacterWorkspaceDetail, CreativeRunDetail } from "@idream/shared/admin";
import { ShieldAlert, Sparkles } from "lucide-react";
import { StatusBadge, WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";
import {
  characterSourceVariationAvailabilityMessage,
  characterSourceVariationBlockerMessage,
  purposeConfig,
  type CharacterAssetPurpose,
  type CharacterSourceVariationBlocker,
} from "./character-asset-studio-authority";
import type { CharacterAssetExistingImage } from "./character-asset-studio-view";
import { AssetImage, CandidateBatchGrid, CandidateComparisonStage } from "./CharacterAssetStudioStage";

type CandidateItem = CreativeRunDetail["items"][number];

export function CharacterAssetCandidatePanel({
  activePurpose,
  activeRunDetail,
  bootstrapMode,
  comparisonItem,
  comparisonItemId,
  existingImages,
  mutationContextLocked,
  onActivate,
  onCloseComparison,
  onCompare,
  onContinueVisual,
  onSelectExistingImage,
  productionBlocked,
  qualifiedRoute,
  selectedExistingImage,
  selectedItem,
  selectedPackAssetId,
  subjectName,
  unconfirmedOperations,
  variationRouteBlocker,
  variationRouteReady,
}: {
  activePurpose: CharacterAssetPurpose;
  activeRunDetail: CreativeRunDetail | null;
  bootstrapMode: boolean;
  comparisonItem: CandidateItem | null;
  comparisonItemId: string | null;
  existingImages: readonly CharacterAssetExistingImage[];
  mutationContextLocked: boolean;
  onActivate: (index: number) => void;
  onCloseComparison: () => void;
  onCompare: (itemId: string) => void;
  onContinueVisual: () => void;
  onSelectExistingImage: (imageId: string) => void;
  productionBlocked: boolean;
  qualifiedRoute: CharacterWorkspaceDetail["visual"]["routeQualifications"][number] | null;
  selectedExistingImage: CharacterAssetExistingImage | null;
  selectedItem: CandidateItem | null;
  selectedPackAssetId: string | undefined;
  subjectName: string;
  unconfirmedOperations: readonly CharacterWorkspaceDetail["mediaOperations"]["operations"][number][];
  variationRouteBlocker: CharacterSourceVariationBlocker;
  variationRouteReady: boolean;
}) {
  const { t } = useAdminI18n();
  const activeConfig = purposeConfig[activePurpose];
  return (
    <section aria-labelledby="candidate-title" className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3 pb-3">
        <div>
          <h3 className="font-semibold" id="candidate-title">
            {productionBlocked
              ? t("Candidate history is paused")
              : activeRunDetail?.items.length
                ? t("{count} recent images", {
                    count: activeRunDetail.items.length,
                  })
                : existingImages.length
                  ? t("{count} images", { count: existingImages.length })
                  : t("Ready for a first run")}
          </h3>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
            {t(activeConfig.label)}
          </p>
        </div>
        {activeRunDetail ? (
          <div className="flex flex-wrap gap-2">
            {activeRunDetail.items.some((item) => !item.asset && unconfirmedOperations.some((operation) => operation.requestId === item.lineage?.requestId))
              ? <span className="rounded bg-[var(--ad-yellow-bg)] px-2 py-1 text-xs">{t("Generation result awaiting confirmation")}</span>
              : <StatusBadge value={activeRunDetail.executionOutcome} />}
          </div>
        ) : null}
      </div>

      {!bootstrapMode &&
      qualifiedRoute &&
      selectedItem &&
      !variationRouteReady ? (
        <div className="mt-3 flex flex-col gap-2 rounded-lg bg-[var(--ad-blue-bg)] p-3 text-xs leading-5 text-[var(--ad-blue-text)] sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">{t("More like this unavailable")}</p>
            <p className="mt-1">
              {t(
                characterSourceVariationBlockerMessage(variationRouteBlocker),
              )}
            </p>
            <p className="mt-1">
              {t(characterSourceVariationAvailabilityMessage())}
            </p>
          </div>
          <WorkspaceButton onClick={onContinueVisual}>
            {t("Review generation route")}
          </WorkspaceButton>
        </div>
      ) : null}

      <div className="mt-1">
        {productionBlocked ? (
          <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-[var(--ad-border)] bg-black/[0.02] px-6 py-8 text-center text-[var(--ad-text-muted)]">
            <div>
              <ShieldAlert className="mx-auto h-6 w-6" />
              <p className="mt-3 text-sm font-semibold">
                {t("Image production is waiting for visual setup")}
              </p>
              <p className="mt-1 max-w-md text-xs leading-5">
                {t(
                  "Complete the readiness steps above; candidate generation will appear here when the character is ready.",
                )}
              </p>
            </div>
          </div>
        ) : selectedItem?.asset && comparisonItem?.asset ? (
          <CandidateComparisonStage
            activeItem={selectedItem}
            activePurpose={activePurpose}
            comparisonItem={comparisonItem}
            onClose={onCloseComparison}
            onUseComparison={() => {
              const comparisonIndex =
                activeRunDetail?.items.findIndex(
                  (item) => item.id === comparisonItem.id,
                ) ?? -1;
              if (comparisonIndex >= 0) onActivate(comparisonIndex);
            }}
            subjectName={subjectName}
          />
        ) : activeRunDetail?.items.length ? (
          <CandidateBatchGrid
            activeItemId={selectedItem?.id ?? null}
            activePurpose={activePurpose}
            comparisonItemId={comparisonItemId}
            disabled={mutationContextLocked}
            items={activeRunDetail.items}
            onActivate={onActivate}
            onCompare={onCompare}
            runCreatedAt={activeRunDetail.createdAt}
            runId={activeRunDetail.id}
            selectedPackAssetId={selectedPackAssetId}
            subjectName={subjectName}
            unconfirmedOperations={unconfirmedOperations}
          />
        ) : selectedExistingImage ? (
          <div aria-label={t("Character image library")}>
            <div
              className="overflow-hidden rounded-lg bg-black/[0.04]"
              style={{ height: "min(500px, 60vh)" }}
            >
              <AssetImage
                alt={t("{name} image {number}", {
                  name: subjectName,
                  number: existingImages.indexOf(selectedExistingImage) + 1,
                })}
                className="h-full w-full object-contain"
                src={selectedExistingImage.url}
              />
            </div>
            <div
              className="mt-3 flex gap-2 overflow-x-auto pb-1"
              role="list"
            >
              {existingImages.map((image, index) => (
                <div
                  className="w-24 shrink-0"
                  key={image.id}
                  role="listitem"
                >
                  <button
                    aria-label={t("Open image {number}", {
                      number: index + 1,
                    })}
                    aria-pressed={image.id === selectedExistingImage.id}
                    className={cn(
                      "w-full overflow-hidden rounded-md border bg-black/[0.04] p-0.5 transition focus-visible:outline focus-visible:outline-2",
                      image.id === selectedExistingImage.id
                        ? "border-[var(--ad-ink)] ring-1 ring-[var(--ad-ink)]"
                        : "border-[var(--ad-border)] hover:border-[var(--ad-text-muted)]",
                    )}
                    onClick={() => onSelectExistingImage(image.id)}
                    type="button"
                  >
                    <AssetImage
                      alt={t("{name} thumbnail {number}", {
                        name: subjectName,
                        number: index + 1,
                      })}
                      className="aspect-square w-full rounded-[4px] object-cover"
                      src={image.thumbnailUrl}
                    />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-[var(--ad-border)] bg-black/[0.02] px-6 text-center text-[var(--ad-text-muted)]">
            <div>
              <Sparkles className="mx-auto h-7 w-7" />
              <p className="mt-3 text-sm">
                {t("Generate an image, then choose whether to use it.")}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
