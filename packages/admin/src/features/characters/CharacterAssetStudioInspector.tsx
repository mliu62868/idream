"use client";

// SPEC: Character Asset Studio 右侧检查器（新图编排 / 当前候选）与当前候选决策条 —— 只吃 props。
// INTENT: 从 CharacterAssetStudio.tsx 原样移出，纯机械搬运，没有任何行为改动。
import type { CharacterWorkspaceDetail, CreativeRunDetail } from "@idream/shared/admin";
import { Check, Loader2, Sparkles, WandSparkles, X } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { WorkspaceButton, textAreaClass } from "@/features/operations/WorkspaceUi";
import { useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";
import { CharacterImageCostEstimateNote } from "./CharacterImageCostEstimate";
import { candidateState, purposeConfig, type CharacterAssetPurpose } from "./character-asset-studio-authority";
import type { CharacterAssetGenerationAction, CharacterAssetStudioBusy } from "./character-asset-studio-view";

type CandidateItem = CreativeRunDetail["items"][number];
type PurposeText = Record<CharacterAssetPurpose, string>;

export function CharacterAssetInspector({
  activePurpose,
  batchCount,
  bootstrapMode,
  briefs,
  busy,
  canSelectDraft,
  estimates,
  generationAction,
  mutationContextLocked,
  negativePrompts,
  onGenerate,
  orientation,
  productionBlocked,
  profileKey,
  recurringProductionReady,
  selectedItem,
  setBatchCount,
  setBriefs,
  setNegativePrompts,
  setWorkspaceMode,
  workspaceMode,
}: {
  activePurpose: CharacterAssetPurpose;
  batchCount: 1 | 2 | 4;
  bootstrapMode: boolean;
  briefs: PurposeText;
  busy: CharacterAssetStudioBusy;
  canSelectDraft: boolean;
  estimates: CharacterWorkspaceDetail["visual"]["imageGenerationEstimates"];
  generationAction: CharacterAssetGenerationAction;
  mutationContextLocked: boolean;
  negativePrompts: PurposeText;
  onGenerate: () => void;
  orientation: string | null | undefined;
  productionBlocked: boolean;
  profileKey: string | undefined;
  recurringProductionReady: boolean;
  selectedItem: CandidateItem | null;
  setBatchCount: (count: 1 | 2 | 4) => void;
  setBriefs: Dispatch<SetStateAction<PurposeText>>;
  setNegativePrompts: Dispatch<SetStateAction<PurposeText>>;
  setWorkspaceMode: (mode: "library" | "review") => void;
  workspaceMode: "library" | "review";
}) {
  const { t } = useAdminI18n();
  const activeConfig = purposeConfig[activePurpose];
  if (recurringProductionReady && workspaceMode === "library") return (
    <aside
      className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 xl:sticky xl:top-24"
      aria-labelledby="new-image-title"
    >
      <div
          className="flex border-b border-[var(--ad-border)] [&>[role=tab]]:scroll-mt-24"
          role="tablist"
          aria-label={t("Image inspector mode")}
        >
          <button
            aria-selected={false}
            className="min-h-11 border-b-2 border-transparent px-3 text-sm text-[var(--ad-text-muted)] disabled:opacity-40"
            disabled={!selectedItem?.asset}
            onClick={() => setWorkspaceMode("review")}
            role="tab"
            type="button"
          >
            {t("Inspect")}
          </button>
          <button
            aria-selected="true"
            className="min-h-11 border-b-2 border-[var(--ad-ink)] px-3 text-sm font-semibold"
            role="tab"
            type="button"
          >
            {t("New image")}
          </button>
        </div>
      <h3 className="sr-only" id="new-image-title">
        {t("New image")}
      </h3>
      <label className="mt-5 block text-xs font-semibold text-[var(--ad-text-muted)]">
        {t("What should be different this time?")}
        <textarea
          aria-label={`${t(activeConfig.label)} ${t("creative brief")}`}
          className={`${textAreaClass} mt-1 min-h-36`}
          disabled={mutationContextLocked}
          onChange={(event) =>
            setBriefs((current) => ({
              ...current,
              [activePurpose]: event.target.value,
            }))
          }
          value={briefs[activePurpose]}
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ad-text-muted)]">
        <span>{t("Aspect ratio")}: {orientation ?? t("Default")}</span>
        <div aria-label={t("Images per request")} className="inline-flex items-center gap-1" role="group">
          <span className="mr-1 font-semibold">{t("Images per request")}</span>
          {([1, 2, 4] as const).map((option) => (
            <button
              aria-pressed={batchCount === option}
              className={cn(
                "min-h-7 min-w-7 rounded border px-2 font-semibold",
                batchCount === option
                  ? "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-[var(--ad-surface)]"
                  : "border-[var(--ad-border)] text-[var(--ad-ink)] hover:bg-black/[0.03]",
              )}
              disabled={mutationContextLocked}
              key={option}
              onClick={() => setBatchCount(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <details className="mt-4 border-t border-[var(--ad-border)] pt-3 text-xs">
        <summary className="cursor-pointer font-semibold">
          {t("Settings")}
        </summary>
        <label className="mt-3 block font-semibold text-[var(--ad-text-muted)]">
          {t("Negative prompt")}
          <textarea
            aria-label={t("Negative prompt")}
            className={`${textAreaClass} mt-1 min-h-24`}
            disabled={mutationContextLocked}
            onChange={(event) =>
              setNegativePrompts((current) => ({
                ...current,
                [activePurpose]: event.target.value,
              }))
            }
            value={negativePrompts[activePurpose]}
          />
        </label>
        <p className="mt-2 leading-5 text-[var(--ad-text-muted)]">
          {t(
            "Identity and quality safeguards are automatic. Add only exclusions specific to this image.",
          )}
        </p>
      </details>
      <CharacterImageCostEstimateNote
        className="mt-4 text-xs leading-5 text-[var(--ad-text-muted)]"
        estimates={estimates}
        imageCount={bootstrapMode ? 1 : batchCount}
        profileKey={profileKey}
        variant="manual"
      />
      <WorkspaceButton
        aria-describedby={
          generationAction.disabled
            ? generationAction.descriptionId
            : undefined
        }
        className="mt-5 w-full justify-center"
        disabled={generationAction.disabled}
        onClick={onGenerate}
        tone="primary"
      >
        <WandSparkles className="h-4 w-4" /> {generationAction.text}
      </WorkspaceButton>
      {selectedItem?.asset ? (
        <button
          className="mt-3 min-h-10 w-full text-center text-xs font-semibold text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]"
          onClick={() => setWorkspaceMode("review")}
          type="button"
        >
          {t("Cancel")}
        </button>
      ) : null}
    </aside>
  );
  if (!productionBlocked && selectedItem?.asset) return (
    <aside
      className="space-y-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 xl:sticky xl:top-24"
      aria-label={t("Current candidate decision inspector")}
    >
      {recurringProductionReady ? (
        <div
          className="flex border-b border-[var(--ad-border)] [&>[role=tab]]:scroll-mt-24"
          role="tablist"
          aria-label={t("Image inspector mode")}
        >
          <button
            aria-selected="true"
            className="min-h-11 border-b-2 border-[var(--ad-ink)] px-3 text-sm font-semibold"
            role="tab"
            type="button"
          >
            {t("Inspect")}
          </button>
          <button
            aria-selected={false}
            className="min-h-11 border-b-2 border-transparent px-3 text-sm text-[var(--ad-text-muted)]"
            onClick={() => setWorkspaceMode("library")}
            role="tab"
            type="button"
          >
            {t("New image")}
          </button>
        </div>
      ) : null}
      <p className="text-sm leading-6 text-[var(--ad-text-muted)]">
        {t("Choose the image that fits this Character. Selection updates the draft; publishing updates the live Character.")}
      </p>
      {!canSelectDraft && busy === null ? <p className="text-sm">{t("Character editing permission is required to select an image.")}</p> : null}
    </aside>
  );
  return null;
}

export function CharacterAssetDecisionBar({
  bootstrapMode,
  busy,
  canGenerate,
  canUseDecisionAction,
  comparisonItem,
  decisionActionLabel,
  isApprovedItem,
  mutationContextLocked,
  onApprove,
  onCloseComparison,
  onGenerateVariation,
  refreshWarning,
  selectedItem,
  unconfirmedOperations,
  variationRouteReady,
}: {
  bootstrapMode: boolean;
  busy: CharacterAssetStudioBusy;
  canGenerate: boolean;
  canUseDecisionAction: boolean;
  comparisonItem: CandidateItem | null;
  decisionActionLabel: string;
  isApprovedItem: boolean;
  mutationContextLocked: boolean;
  onApprove: () => void;
  onCloseComparison: () => void;
  onGenerateVariation: (assetId: string) => void;
  refreshWarning: string | null;
  selectedItem: CandidateItem;
  unconfirmedOperations: readonly CharacterWorkspaceDetail["mediaOperations"]["operations"][number][];
  variationRouteReady: boolean;
}) {
  const { t } = useAdminI18n();
  return (
    <section
      aria-label={t("Current candidate actions")}
      className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ad-text-muted)]">
          {t("Current decision")}
        </p>
        <p className="mt-1 truncate text-sm font-semibold">
          {selectedItem
            ? t("Candidate {number} · {state}", {
                number: selectedItem.ordinal + 1,
                state: t(candidateState(selectedItem, unconfirmedOperations.some((operation) => operation.requestId === selectedItem.lineage?.requestId))),
              })
            : t("No active candidate")}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {comparisonItem ? (
          <WorkspaceButton onClick={onCloseComparison}>
            <X className="h-4 w-4" />
            <span className="sm:hidden">{t("Image")}</span>
            <span className="hidden sm:inline">
              {t("Back to generated image")}
            </span>
          </WorkspaceButton>
        ) : null}
        <WorkspaceButton
          disabled={
            mutationContextLocked ||
            bootstrapMode ||
            !variationRouteReady ||
            !canGenerate ||
            busy !== null ||
            !selectedItem?.asset ||
            !isApprovedItem
          }
          onClick={() =>
            selectedItem?.asset
              ? onGenerateVariation(selectedItem.asset.id)
              : undefined
          }
        >
          <Sparkles className="h-4 w-4" />
          <span className="sm:hidden">{t("Similar")}</span>
          <span className="hidden sm:inline">{t("More like this")}</span>
        </WorkspaceButton>
        {selectedItem?.asset ? (
          <WorkspaceButton disabled={mutationContextLocked || !canUseDecisionAction || busy !== null || Boolean(refreshWarning)}
            onClick={onApprove} tone="primary">
            {busy === "select" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {t(decisionActionLabel)}
          </WorkspaceButton>
        ) : null}
      </div>
    </section>
  );
}
