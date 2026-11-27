"use client";

// SPEC: Character Asset Studio 底部的首张肖像简报编辑器与「最近 Run / 技术血缘」折叠区 —— 只吃 props。
// INTENT: 从 CharacterAssetStudio.tsx 原样移出，纯机械搬运，没有任何行为改动。
import type { CharacterWorkspaceDetail, CreativeRun, CreativeRunDetail } from "@idream/shared/admin";
import type { Dispatch, MouseEvent, SetStateAction } from "react";
import { WorkspaceButton, textAreaClass } from "@/features/operations/WorkspaceUi";
import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";
import { isCharacterAssetPurpose, purposeConfig, type CharacterAssetPurpose } from "./character-asset-studio-authority";

type PurposeText = Record<CharacterAssetPurpose, string>;

export function BootstrapBriefEditor({
  activePurpose,
  briefs,
  mutationContextLocked,
  setBriefs,
}: {
  activePurpose: CharacterAssetPurpose;
  briefs: PurposeText;
  mutationContextLocked: boolean;
  setBriefs: Dispatch<SetStateAction<PurposeText>>;
}) {
  const { t } = useAdminI18n();
  const activeConfig = purposeConfig[activePurpose];
  return (
    <details className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        {t("Adjust the creative brief")}
      </summary>
      <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">
        {t(
          "Keep intent human-readable. Identity, references, workflow, and route stay automatic.",
        )}
      </p>
      <textarea
        aria-label={`${t(activeConfig.label)} ${t("creative brief")}`}
        className={`${textAreaClass} mt-3`}
        disabled={mutationContextLocked}
        onChange={(event) =>
          setBriefs((current) => ({
            ...current,
            [activePurpose]: event.target.value,
          }))
        }
        value={briefs[activePurpose]}
      />
    </details>
  );
}

export function CharacterAssetRunHistory({
  activePurpose,
  bootstrapMode,
  bootstrapProfile,
  historyCursor,
  loadingHistory,
  mutationContextLocked,
  onLoadMore,
  pinnedRunIds,
  qualifiedRoute,
  runs,
  selectHistoryRun,
  selectedItem,
  selectedRunId,
}: {
  activePurpose: CharacterAssetPurpose;
  bootstrapMode: boolean;
  bootstrapProfile: CharacterWorkspaceDetail["visual"]["identityBootstrap"]["profile"];
  historyCursor: string | null;
  loadingHistory: boolean;
  mutationContextLocked: boolean;
  onLoadMore: (cursor: string) => void;
  pinnedRunIds: ReadonlySet<string>;
  qualifiedRoute: CharacterWorkspaceDetail["visual"]["routeQualifications"][number] | null;
  runs: readonly CreativeRun[];
  selectHistoryRun: (event: MouseEvent<HTMLButtonElement>) => void;
  selectedItem: CreativeRunDetail["items"][number] | null;
  selectedRunId: string | null;
}) {
  const { locale, t } = useAdminI18n();
  return (
    <details className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        {t("Recent runs and technical lineage")}
      </summary>
      <div className="mt-3 space-y-2">
        {runs.some((run) => run.purpose === activePurpose) ? (
          runs.filter((run) => run.purpose === activePurpose).map((run) => (
            <button
              className={cn(
                "w-full rounded-lg border p-3 text-left text-xs",
                selectedRunId === run.id
                  ? "border-[var(--ad-ink)] bg-black/[0.03]"
                  : "border-[var(--ad-border)]",
              )}
              disabled={mutationContextLocked}
              key={run.id}
              onClick={selectHistoryRun}
              type="button"
              value={run.id}
            >
              <span className="flex items-center justify-between gap-3">
                <strong>
                  {isCharacterAssetPurpose(run.purpose)
                    ? t(purposeConfig[run.purpose].label)
                    : t(run.purpose)}
                  {pinnedRunIds.has(run.id)
                    ? ` · ${t("Selected in draft")}`
                    : ""}
                </strong>
                <span>
                  {new Date(run.updatedAt).toLocaleString(
                    adminDateLocale(locale),
                  )}
                </span>
              </span>
              <span className="mt-1 block break-all text-[var(--ad-text-muted)]">
                {run.id} · {run.counts.generated}/{run.counts.total}{" "}
                {t("generated")} · {run.counts.approved} {t("approved")}
              </span>
            </button>
          ))
        ) : (
          <p className="text-xs text-[var(--ad-text-muted)]">
            {t("No production history for this character.")}
          </p>
        )}
      </div>
        {historyCursor ? <WorkspaceButton disabled={loadingHistory || mutationContextLocked} onClick={() => onLoadMore(historyCursor)}>{t("Load more")}</WorkspaceButton> : null}
      {bootstrapProfile || qualifiedRoute ? (
        <p className="mt-4 break-all border-t border-[var(--ad-border)] pt-4 text-xs text-[var(--ad-text-muted)]">
          {t("Current image route")}: {bootstrapMode
            ? `${bootstrapProfile?.label ?? ""} · ${bootstrapProfile?.orientation ?? ""}`
            : qualifiedRoute?.generationProfileKey}
        </p>
      ) : null}
      {selectedItem ? (
        <dl className="mt-4 grid gap-2 border-t border-[var(--ad-border)] pt-4 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-[var(--ad-text-muted)]">
              {t("Generation profile")}
            </dt>
            <dd className="mt-1 break-all">
              {selectedItem.lineage.generationProfileKey ?? t("Pending")}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--ad-text-muted)]">{t("Workflow")}</dt>
            <dd className="mt-1 break-all">
              {selectedItem.lineage.workflowKey ?? t("Pending")}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--ad-text-muted)]">{t("Request")}</dt>
            <dd className="mt-1 break-all">
              {selectedItem.lineage.requestId ?? t("Pending")}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--ad-text-muted)]">
              {t("Provider request / Comfy prompt")}
            </dt>
            <dd className="mt-1 break-all">
              {selectedItem.lineage.providerRequestId ?? t("Pending")}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--ad-text-muted)]">{t("Asset")}</dt>
            <dd className="mt-1 break-all">
              {selectedItem.asset?.id ?? t("Pending")}
            </dd>
          </div>
        </dl>
      ) : null}
    </details>
  );
}
