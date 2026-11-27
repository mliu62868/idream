"use client";

// SPEC: Character Asset Studio 的占位状态与提示条 —— 只吃 props，不发请求、不持有写状态。
// INTENT: 从 CharacterAssetStudio.tsx 原样移出，纯机械搬运，没有任何行为改动。
import type { CharacterImageSourceAsset, CharacterWorkspaceDetail } from "@idream/shared/admin";
import { Loader2, RefreshCcw, ShieldAlert, WandSparkles } from "lucide-react";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { useAdminI18n } from "@/components/admin/i18n";
import type { DurableMutationIntent } from "@/lib/durable-mutation-intent";
import { CharacterImageCostEstimateNote } from "./CharacterImageCostEstimate";
import { purposeConfig, type CharacterAssetPurpose } from "./character-asset-studio-authority";
import type { CharacterAssetStudioBusy } from "./character-asset-studio-view";
import { AssetImage } from "./CharacterAssetStudioStage";

export function CharacterAssetStudioNoPermission() {
  const { t } = useAdminI18n();
  return (
    <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8">
      <ShieldAlert className="h-6 w-6" />
      <h3 className="mt-4 font-semibold">
        {t("No asset workspace permission")}
      </h3>
      <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
        {t("creative.run.read is required to see character production.")}
      </p>
    </section>
  );
}

export function CharacterAssetStudioLoading() {
  const { t } = useAdminI18n();
  return (
    <section
      aria-busy="true"
      className="grid min-h-80 place-items-center rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
      role="status"
    >
      <span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />{" "}
        {t("Loading character assets")}
      </span>
    </section>
  );
}

export function CharacterAssetStudioAlerts({
  error,
  statusMessage,
}: {
  error: string | null;
  statusMessage: string | null;
}) {
  const { t } = useAdminI18n();
  return (
    <>
      {error ? (
        <p
          className="rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          {t(error)}
        </p>
      ) : null}
      {statusMessage ? (
        <p
          className="rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]"
          role="status"
        >
          {t(statusMessage)}
        </p>
      ) : null}
    </>
  );
}

export function LibraryCandidateStrip({
  candidates,
  disabled,
  onSelect,
}: {
  candidates: readonly { purpose: CharacterAssetPurpose; asset: CharacterImageSourceAsset }[];
  disabled: boolean;
  onSelect: (purpose: CharacterAssetPurpose, asset: CharacterImageSourceAsset) => void;
}) {
  const { t } = useAdminI18n();
  return (
    <section aria-label={t("Available image candidates")} className="flex flex-wrap gap-3">
      {candidates.map(({ purpose, asset }) => (
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-2" key={purpose}>
          <AssetImage alt={t(purposeConfig[purpose].label)} className="h-14 w-14 rounded object-cover" src={asset.thumbnailUrl ?? asset.url} />
          <WorkspaceButton
            disabled={disabled}
            onClick={() => onSelect(purpose, asset)}
          >
            {t("Use candidate for {slot}", { slot: t(purposeConfig[purpose].label) })}
          </WorkspaceButton>
        </div>
      ))}
    </section>
  );
}

export function GenerateMissingImagesBar({
  busy,
  estimates,
  onGenerate,
  profileKey,
  purposes,
}: {
  busy: CharacterAssetStudioBusy;
  estimates: CharacterWorkspaceDetail["visual"]["imageGenerationEstimates"];
  onGenerate: () => void;
  profileKey: string;
  purposes: readonly CharacterAssetPurpose[];
}) {
  const { t } = useAdminI18n();
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      data-testid="generate-missing-images"
    >
      <span>
        {t("Still needs: {purposes}. Default briefs are ready, and you can adjust them below.", {
          purposes: purposes.map((purpose) => t(purposeConfig[purpose].label)).join(" · "),
        })}
      </span>
      <div className="flex flex-col items-stretch gap-1 sm:items-end">
        <WorkspaceButton disabled={busy !== null} onClick={onGenerate} tone="primary">
          {busy === "generate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
          {t("Generate missing images")}
        </WorkspaceButton>
        <CharacterImageCostEstimateNote
          estimates={estimates}
          imageCount={purposes.length}
          profileKey={profileKey}
          variant="missing"
        />
      </div>
    </div>
  );
}

export function RunReceiptNotice({ runId }: { runId: string }) {
  const { t } = useAdminI18n();
  return (
    <p
      className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm"
      role="status"
    >
      {t("Created Run receipt:")}{" "}
      <span className="font-medium">
        {runId}
      </span>
      {t(
        ". Verify its projection before starting another generation intent.",
      )}
    </p>
  );
}

export function SelectionIntentNotice({
  disabled,
  needsReconciliation,
  onResume,
  status,
}: {
  disabled: boolean;
  needsReconciliation: boolean;
  onResume: () => void;
  status: DurableMutationIntent["status"];
}) {
  const { t } = useAdminI18n();
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      role="status"
    >
      <span>
        {needsReconciliation
          ? t(
              "This saved selection is aged or no longer matches the active contract. Reconcile its server receipt before another selection.",
            )
          : status ===
              "committed_projection_pending"
            ? t(
                "Selection receipt is committed; verify it against current Character authority.",
              )
            : t(
                "Asset selection is ready to resume with the same request key.",
              )}
      </span>
      <WorkspaceButton
        disabled={disabled}
        onClick={onResume}
      >
        {needsReconciliation
          ? t("Reconcile selection")
          : status ===
              "committed_projection_pending"
            ? t("Verify selection")
            : t("Resume selection")}
      </WorkspaceButton>
    </div>
  );
}

export function RefreshWarningNotice({
  disabled,
  onRefresh,
  warning,
}: {
  disabled: boolean;
  onRefresh: () => void;
  warning: string;
}) {
  const { t } = useAdminI18n();
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]"
      role="status"
    >
      <span>{t(warning)}</span>
      <WorkspaceButton disabled={disabled} onClick={onRefresh}>
        <RefreshCcw className="h-4 w-4" /> {t("Refresh")}
      </WorkspaceButton>
    </div>
  );
}
