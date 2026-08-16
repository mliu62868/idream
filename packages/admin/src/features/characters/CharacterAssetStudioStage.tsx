"use client";

// SPEC: Character Asset Studio 的纯展示层 —— 只吃 props，不发请求、不持有写状态。
// INTENT: 从 CharacterAssetStudio.tsx 原样移出，纯机械搬运，没有任何行为改动。
import { ImageIcon, Loader2, Pin, X } from "lucide-react";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { cn } from "@/lib/utils";
import { useAdminI18n } from "@/components/admin/i18n";
import type { CharacterWorkspaceDetail, CreativeRunDetail } from "@idream/shared/admin";
import Link from "next/link";
import {
  candidateState,
  characterAssetReadinessSummary,
  isCharacterIdentityAuthorityReady,
  purposeConfig,
  resolveCharacterCandidateVisualState,
  type CharacterAssetPurpose,
} from "./character-asset-studio-authority";

export function AssetImage({ alt, className, src }: { alt: string; className: string; src: string | null | undefined }) {
  const { t } = useAdminI18n();
  if (!src) return (
    <div className={cn("grid place-items-center bg-black/[0.04] text-[var(--ad-text-muted)]", className)}>
      <ImageIcon aria-hidden="true" className="h-6 w-6" />
      <span className="sr-only">{t("No image asset is available")}</span>
    </div>
  );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- operator blob URLs are not compatible with Next image optimization
    <img alt={alt} className={className} src={src} />
  );
}

export function ImageProductionReadinessCard({
  blockers,
  canRepair,
  descriptionId,
  onContinue,
  onRepair,
  repairing,
}: {
  blockers: CharacterWorkspaceDetail["visual"]["readiness"]["blockers"];
  canRepair: boolean;
  descriptionId: string;
  onContinue: () => void;
  onRepair: () => void;
  repairing: boolean;
}) {
  const { t } = useAdminI18n();
  const summary = characterAssetReadinessSummary(
    blockers.map((blocker) => blocker.code),
  );
  return (
    <section
      className="mt-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
      aria-labelledby={`${descriptionId}-title`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 className="text-sm font-semibold" id={`${descriptionId}-title`}>
            {t(canRepair
              ? "Enable image production with the current portrait"
              : summary.title)}
          </h4>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]" id={descriptionId}>
            {t(canRepair
              ? "The current live portrait will become the sealed identity reference for future images. Existing live images and releases will not change."
              : summary.steps[0] ?? "Complete the current visual setup before generating an image.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canRepair ? (
            <WorkspaceButton
              aria-describedby={descriptionId}
              disabled={repairing}
              onClick={onRepair}
              tone="primary"
            >
              {repairing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}

              {t("Use existing portrait")}
            </WorkspaceButton>
          ) : (
            <WorkspaceButton
              aria-describedby={descriptionId}
              onClick={onContinue}
            >

              {t("Open visual setup")}
            </WorkspaceButton>
          )}
        </div>
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-semibold text-[var(--ad-text-muted)]">

          {t("Technical diagnostics")}
        </summary>
        <ul className="mt-2 space-y-1">
          {blockers.map((blocker) => (
            <li key={blocker.code}>
              {blocker.code}: {t(blocker.message)}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

export function IdentityRail({
  data,
  onRepair,
}: {
  data: CharacterWorkspaceDetail;
  onRepair: () => void;
}) {
  const { t } = useAdminI18n();
  const identity = data.visual.activeIdentity;
  const identityBootstrap = data.visual.identityBootstrap;
  const bootstrapMode = identityBootstrap.allowed;
  const bootstrapProfile = identityBootstrap.profile;
  const identityEstablished = isCharacterIdentityAuthorityReady({
    hasIdentity: identity !== null,
    blockerCodes: data.visual.readiness.blockers.map((blocker) => blocker.code),
  });
  const referenceAssets = data.visual.activeReferenceSet?.references.length
    ? data.visual.activeReferenceSet.references
    : [...data.visual.anchors, ...data.visual.references];
  const availableReferenceCount = referenceAssets.filter((asset) => asset.available).length;
  const qualifiedRoute = data.visual.routeQualifications.find(
    (route) => route.result === "qualified" && !route.stale,
  );

  return (
    <aside
      aria-labelledby="identity-lock-title"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--ad-border)] pb-3 text-xs text-[var(--ad-text-muted)]"
    >
      <h3 className="sr-only" id="identity-lock-title">{t("Visual identity authority")}</h3>
      <span>{t("Visual identity")} <strong className="font-semibold text-[var(--ad-ink)]">{identity ? `v${identity.version}` : t("Pending")}</strong></span>
      <span aria-hidden="true">·</span>
      <span>{t("References")} <strong className="font-semibold text-[var(--ad-ink)]">{identityEstablished ? availableReferenceCount : t("Pending")}</strong></span>
      <span aria-hidden="true">·</span>
      <span className="max-w-56 truncate"><strong className="font-semibold text-[var(--ad-ink)]">{bootstrapMode ? bootstrapProfile?.label ?? t("Unavailable") : qualifiedRoute?.generationProfileKey ?? t("Unavailable")}</strong></span>
      {!identityEstablished && identity ? (
        <button className="font-semibold text-[var(--ad-ink)] underline" onClick={onRepair} type="button">{t("Repair visual authority")}</button>
      ) : null}
    </aside>
  );
}

export function CandidateBatchGrid({
  activeItemId,
  activePurpose,
  comparisonItemId,
  disabled,
  items,
  onActivate,
  onCompare,
  runId,
  selectedPackAssetId,
  subjectName,
}: {
  activeItemId: string | null;
  activePurpose: CharacterAssetPurpose;
  comparisonItemId: string | null;
  disabled: boolean;
  items: CreativeRunDetail["items"];
  onActivate: (index: number) => void;
  onCompare: (itemId: string) => void;
  runId: string | null;
  selectedPackAssetId: string | null | undefined;
  subjectName: string;
}) {
  const { t } = useAdminI18n();
  const activeItem = items.find((item) => item.id === activeItemId) ?? items[0] ?? null;
  const activeIndex = activeItem
    ? items.findIndex((item) => item.id === activeItem.id)
    : -1;
  const activeIsDraft = Boolean(
    activeItem?.asset?.id && activeItem.asset.id === selectedPackAssetId,
  );
  return (
    <div aria-label={t("Generated candidates")}>
      <div className="overflow-hidden rounded-lg bg-black/[0.04]" style={{ height: "min(500px, 60vh)" }}>
        <AssetImage
          alt={activeItem
            ? t("{name} {purpose} candidate {number}", {
                name: subjectName,
                purpose: t(purposeConfig[activePurpose].label),
                number: activeItem.ordinal + 1,
              })
            : t("No image asset is available")}
          className="h-full w-full object-contain"
          src={activeItem?.asset?.url ?? activeItem?.asset?.thumbnailUrl}
        />
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="list">
        {items.map((item, index) => {
          const active = item.id === activeItem?.id;
          const comparison = item.id === comparisonItemId;
          const draft = Boolean(item.asset?.id && item.asset.id === selectedPackAssetId);
          const visualState = resolveCharacterCandidateVisualState({
            active,
            comparison,
            draft,
            decision: item.review?.decision ?? null,
            failed: item.executionState === "failed",
          });
          return (
            <article
              className="group relative w-24 shrink-0"
              data-candidate-state={visualState}
              key={item.id}
              role="listitem"
            >
              <button
                aria-label={t("View candidate {number}", { number: item.ordinal + 1 })}
                aria-pressed={active}
                className={cn(
                  "block w-full overflow-hidden rounded-md border bg-black/[0.04] p-0.5 transition focus-visible:outline focus-visible:outline-2",
                  active
                    ? "border-[var(--ad-ink)] ring-1 ring-[var(--ad-ink)]"
                    : comparison
                      ? "border-[var(--ad-blue-text)]"
                      : draft
                        ? "border-[var(--ad-green-text)]"
                        : visualState === "failed"
                          ? "border-[var(--ad-red-text)]"
                          : "border-[var(--ad-border)] hover:border-[var(--ad-text-muted)]",
                  item.review?.decision === "rejected" && "opacity-60",
                )}
                disabled={disabled}
                onClick={() => onActivate(index)}
                type="button"
              >
                <AssetImage
                  alt={t("{name} {purpose} candidate {number}", {
                    name: subjectName,
                    purpose: t(purposeConfig[activePurpose].label),
                    number: item.ordinal + 1,
                  })}
                  className="aspect-square w-full rounded-[4px] object-cover"
                  src={item.asset?.thumbnailUrl ?? item.asset?.url}
                />
              </button>
              {!active && item.asset ? (
                <button
                  aria-label={comparison
                    ? t("Remove candidate {number} from comparison", { number: item.ordinal + 1 })
                    : t("Compare candidate {number} with current candidate", { number: item.ordinal + 1 })}
                  aria-pressed={comparison}
                  className="absolute right-1 top-1 grid h-8 w-8 place-items-center rounded-md border border-white/70 bg-white/95 opacity-0 transition group-hover:opacity-100 focus:opacity-100 focus-visible:outline focus-visible:outline-2"
                  disabled={disabled}
                  onClick={() => onCompare(item.id)}
                  type="button"
                >
                  {comparison ? <X aria-hidden="true" className="h-3.5 w-3.5" /> : <Pin aria-hidden="true" className="h-3.5 w-3.5" />}
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
      {activeItem ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--ad-border)] pt-3 text-xs">
          <p>
            <strong>{t("Candidate {number}", { number: activeItem.ordinal + 1 })}</strong>
            <span className="ml-2 text-[var(--ad-text-muted)]">{t(candidateState(activeItem))}</span>
          </p>
          <p className="text-[var(--ad-text-muted)]">
            {activeIsDraft ? t("Selected in draft") : t(purposeConfig[activePurpose].label)}
            {activeIndex >= 0 ? ` · ${activeIndex + 1}/${items.length}` : ""}
          </p>
        </div>
      ) : null}
      {/* SPEC: 失败候选必须说清原因，并给出一条能真正重跑的去处。
          INTENT: 之前失败只映射成 "Generation failed" 五个字，契约里的 failure.errorCode /
          operatorGuidance 全仓只有视觉实验台读；重试入口在 characters/ 下一个都没有。
          重试本身是一台带幂等键与本地落盘的持久命令机（CreativeRunWorkspace），不在这里
          复制第二份 —— 直接把运营送到那台机器上。 */}
      {activeItem?.executionState === "failed" ? (
        <div
          className="mt-3 rounded-lg bg-[var(--ad-red-bg)] p-3 text-xs text-[var(--ad-red-text)]"
          role="alert"
        >
          <p className="font-semibold">
            {activeItem.failure?.operatorGuidance ?? t("Generation failed")}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {activeItem.failure ? (
              <code className="font-mono text-[11px]">
                {activeItem.failure.errorCode}
              </code>
            ) : null}
            {runId ? (
              <Link
                className="font-semibold underline"
                href={`/admin/creative/runs/${encodeURIComponent(runId)}`}
              >
                {t("Open run to retry")}
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function CandidateComparisonStage({
  activeItem,
  activePurpose,
  comparisonItem,
  onClose,
  onUseComparison,
  subjectName,
}: {
  activeItem: CreativeRunDetail["items"][number];
  activePurpose: CharacterAssetPurpose;
  comparisonItem: CreativeRunDetail["items"][number];
  onClose: () => void;
  onUseComparison: () => void;
  subjectName: string;
}) {
  const { t } = useAdminI18n();
  const imageClass = cn(
    "w-full bg-black/[0.04] object-cover",
    activePurpose === "character_hero"
      ? "aspect-video"
      : "aspect-[4/5]",
  );
  return (
    <section aria-labelledby="candidate-comparison-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ad-blue-text)]">
            {t("Two-candidate comparison")}
          </p>
          <h4 className="mt-1 font-semibold" id="candidate-comparison-title">
            {t("Compare the current decision without changing authority")}
          </h4>
        </div>
        <WorkspaceButton className="min-h-9" onClick={onClose}>
          <X aria-hidden="true" className="h-4 w-4" />
          {t("Back to generated image")}
        </WorkspaceButton>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <figure className="overflow-hidden rounded-lg border border-[var(--ad-ink)] bg-[var(--ad-surface)]">
          <AssetImage
            alt={t("{name} current candidate {number}", {
              name: subjectName,
              number: activeItem.ordinal + 1,
            })}
            className={imageClass}
            src={activeItem.asset?.url ?? activeItem.asset?.thumbnailUrl}
          />
          <figcaption className="flex items-center justify-between gap-2 px-3 py-3 text-sm">
            <span>
              <strong>{t("Current candidate")}</strong>
              <span className="ml-2 text-[var(--ad-text-muted)]">
                {String(activeItem.ordinal + 1).padStart(2, "0")}
              </span>
            </span>
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--ad-ink)]" />
          </figcaption>
        </figure>
        <figure className="overflow-hidden rounded-lg border border-[var(--ad-blue-text)] bg-[var(--ad-surface)]">
          <AssetImage
            alt={t("{name} comparison candidate {number}", {
              name: subjectName,
              number: comparisonItem.ordinal + 1,
            })}
            className={imageClass}
            src={comparisonItem.asset?.url ?? comparisonItem.asset?.thumbnailUrl}
          />
          <figcaption className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="text-sm">
              <strong>{t("Comparison candidate")}</strong>
              <span className="ml-2 text-[var(--ad-text-muted)]">
                {String(comparisonItem.ordinal + 1).padStart(2, "0")}
              </span>
            </span>
            <WorkspaceButton className="min-h-9" onClick={onUseComparison}>
              {t("Make current")}
            </WorkspaceButton>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
