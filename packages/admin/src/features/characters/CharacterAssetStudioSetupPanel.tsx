"use client";

// SPEC: Character Asset Studio 顶部的「首张身份肖像 / 图片生产准备」面板与路由失效提示 —— 只吃 props。
// INTENT: 从 CharacterAssetStudio.tsx 原样移出，纯机械搬运，没有任何行为改动。
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { RefreshCcw, WandSparkles } from "lucide-react";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";
import { ImagePackResetNotice, draftSelectedImageCount } from "./ImagePackResetNotice";
import type { CharacterAssetGenerationAction, CharacterAssetStudioBusy } from "./character-asset-studio-view";
import { ImageProductionReadinessCard } from "./CharacterAssetStudioStage";

export function CharacterAssetRouteStaleNotice({
  className,
  disabled,
  label,
  onRegenerate,
  staleCount,
}: {
  className: string;
  disabled: boolean;
  label: string;
  onRegenerate: () => void;
  staleCount: number;
}) {
  const { t } = useAdminI18n();
  return (
    <div className={className}>
      <span>
        {t(
          "The active image route changed. {count} selected assets remain in history but cannot be published.", { count: staleCount },
        )}
      </span>
      <WorkspaceButton
        disabled={disabled}
        onClick={onRegenerate}
      >
        {label}
      </WorkspaceButton>
    </div>
  );
}

export function CharacterAssetStudioSetupPanel({
  bootstrapMode,
  busy,
  canGenerate,
  canSelectDraft,
  data,
  generationAction,
  imageProductionRepairable,
  onContinueVisual,
  onGenerate,
  onPrepare,
  onRefresh,
  onRegenerate,
  productionBlocked,
  readinessDescriptionId,
  regenerateLabel,
  subjectName,
}: {
  bootstrapMode: boolean;
  busy: CharacterAssetStudioBusy;
  canGenerate: boolean;
  canSelectDraft: boolean;
  data: CharacterWorkspaceDetail;
  generationAction: CharacterAssetGenerationAction;
  imageProductionRepairable: boolean;
  onContinueVisual: () => void;
  onGenerate: () => void;
  onPrepare: () => void;
  onRefresh: () => void;
  onRegenerate: () => void;
  productionBlocked: boolean;
  readinessDescriptionId: string;
  regenerateLabel: string;
  subjectName: string;
}) {
  const { t } = useAdminI18n();
  const identityBootstrap = data.visual.identityBootstrap;
  const bootstrapProfile = identityBootstrap.profile;
  return (
    <section
      aria-labelledby="asset-pack-title"
      className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
    >
      <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">
            {t(
              bootstrapMode
                ? "First identity portrait"
                : productionBlocked
                  ? imageProductionRepairable
                    ? "Enable image production"
                    : "Image production setup"
                  : "Ready for ongoing image production",
            )}
          </p>
          <h3 className="mt-1 text-xl font-semibold" id="asset-pack-title">
            {t(
              bootstrapMode
                ? "Establish the face customers will recognize"
                : productionBlocked
                  ? imageProductionRepairable
                    ? "Use the current live portrait for future image generation"
                    : "Finish visual setup before creating more images"
                  : "{name}'s images",
              { name: subjectName },
            )}
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
            {t(
              bootstrapMode
                ? "Generate the first portrait without references, compare the results, then use one as identity version {version}."
                : productionBlocked
                  ? imageProductionRepairable
                    ? "Seal the existing live portrait as the reusable identity reference. Current live images and releases will not change."
                    : "Complete the current visual setup action once. Existing live images and releases will not change."
                  : "Generate images from the current identity, compare them, and choose which to use in the draft image set.",
              { version: identityBootstrap.nextIdentityVersion },
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <WorkspaceButton
            disabled={busy !== null}
            onClick={onRefresh}
          >
            <RefreshCcw className="h-4 w-4" /> {t("Refresh")}
          </WorkspaceButton>
          {bootstrapMode ? (
            <WorkspaceButton
              aria-describedby={
                generationAction.disabled
                  ? generationAction.descriptionId
                  : undefined
              }
              disabled={generationAction.disabled}
              onClick={onGenerate}
              tone="primary"
            >
              <WandSparkles className="h-4 w-4" /> {generationAction.text}
            </WorkspaceButton>
          ) : null}
        </div>
      </div>
      {generationAction.disabled ? (
        <p className="sr-only" id={generationAction.descriptionId}>
          {t(generationAction.description)}
        </p>
      ) : null}
      {bootstrapMode ? (
        <div
          className={cn(
            "mx-4 mb-4 rounded-lg p-3 text-sm sm:mx-5",
            bootstrapProfile
              ? "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]"
              : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
          )}
        >
          <p>
            {bootstrapProfile
              ? t(
                  identityBootstrap.state === "recoverable_empty_history"
                    ? "No reference image is needed. Your selected portrait becomes identity version {version}; earlier candidates remain in history."
                    : "No reference image is needed. Your selected portrait becomes the reference for later images.",
                  { version: identityBootstrap.nextIdentityVersion },
                )
              : t(
                  "No active text-to-image bootstrap profile is available. Generation remains blocked until one is published.",
                )}
          </p>
          {bootstrapProfile ? (
            <p className="mt-1 text-xs">
              {t(
                "The generation runtime is checked before any Run is created.",
              )}
            </p>
          ) : null}
        </div>
      ) : data.project.draftAssetRouteAuthority?.status === "stale" ? (
        <CharacterAssetRouteStaleNotice
          className="mx-4 mb-4 flex flex-col gap-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)] sm:mx-5 sm:flex-row sm:items-center sm:justify-between"
          disabled={!canGenerate || busy !== null}
          label={regenerateLabel}
          onRegenerate={onRegenerate}
          staleCount={data.project.draftAssetRouteAuthority.stalePurposes.length}
        />
      ) : productionBlocked ? (
        <div className="mx-4 mb-4 sm:mx-5">
          <ImageProductionReadinessCard
            blockers={data.visual.readiness.blockers}
            canRepair={
              data.visual.imageReadiness?.state === "repairable" &&
              canSelectDraft
            }
            descriptionId={readinessDescriptionId}
            onContinue={onContinueVisual}
            onRepair={onPrepare}
            repairing={busy === "prepare"}
          />
          {data.visual.imageReadiness?.state === "repairable" ? (
            <ImagePackResetNotice count={draftSelectedImageCount(data)} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
