"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog } from "@/components/admin/ui/ConfirmDialog";
import Link from "next/link";
import type { CharacterMediaOperationsProjection } from "@idream/shared/admin";
import { useState } from "react";
import { StatusBadge } from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError } from "@/lib/admin-v2-api";

const mediaOperationLabels = {
  image: "Image",
  video: "Video",
  voice: "Voice",
} as const;

const mediaRecoveryLabels = {
  not_needed: "No recovery needed",
  retryable: "Retry available",
  operator_action: "Operator action required",
  not_recoverable: "Not retryable",
  unavailable: "Recovery unavailable",
} as const;

function mediaOperationDuration(durationMs: number) {
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/**
 * SPEC: 只有"运营真能去做点什么"的恢复态才让这张证据表默认展开。
 *
 * INTENT: 这张表此前恒定展开在角色页最顶上——标题下面第一屏就是三行 request ID、provider、
 * attempt 和耗时，角色本身被挤到折叠线以下。它是排障证据，不是角色的门面；顺利时"三个都完成了"
 * 一行就说完了。`unavailable` 表示这个模态压根没跑过（契约里 requestId===null 必须收敛到它），
 * 那是空状态不是故障，同样不值得抢占开屏。
 */
export function characterMediaOperationsNeedAttention(
  projection: CharacterMediaOperationsProjection,
) {
  return projection.operations.some((operation) =>
    ["retryable", "operator_action", "not_recoverable"].includes(
      operation.recoverability.state,
    ),
  );
}

export function shouldReleaseVoiceReclaimIdempotencyKey(cause: unknown) {
  if (!(cause instanceof AdminV2RequestError)) return false;
  const details =
    cause.details &&
    typeof cause.details === "object" &&
    !Array.isArray(cause.details)
      ? cause.details as Record<string, unknown>
      : {};
  return !(
    cause.status === 409 &&
    cause.code === "conflict" &&
    details.reason === "command_in_progress"
  );
}

export function CharacterMediaOperationsCard({
  projection,
  canReclaimVoice = false,
  reclaimingVoiceRequestId = null,
  onReclaimVoice,
}: {
  readonly projection: CharacterMediaOperationsProjection;
  readonly canReclaimVoice?: boolean;
  readonly reclaimingVoiceRequestId?: string | null;
  readonly onReclaimVoice?: (input: {
    readonly requestId: string;
    readonly confirmation: string;
    readonly reason: string;
  }) => Promise<void>;
}) {
  const { t } = useAdminI18n();
  const needsAttention = characterMediaOperationsNeedAttention(projection);
  const [pendingReclaim, setPendingReclaim] = useState<{
    readonly requestId: string;
    readonly confirmation: string;
    readonly attemptNo: number;
    readonly provider: string | null;
  } | null>(null);
  return (
    <>
    <details
      className="mt-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]"
      open={needsAttention}
    >
      <summary className="cursor-pointer px-4 py-3">
        <span className="text-sm font-semibold" id="character-media-operations-title">
          {t("Recent media operations")}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--ad-text-muted)]">
          {projection.operations.map((operation) => (
            <span className="inline-flex items-center gap-1.5" key={operation.modality}>
              {t(mediaOperationLabels[operation.modality])}
              {operation.status
                ? <StatusBadge value={operation.status} />
                : t("No runs")}
            </span>
          ))}
        </span>
      </summary>
      <div className="overflow-x-auto border-t border-[var(--ad-border)]">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="text-[var(--ad-text-muted)]">
            <tr className="border-b border-[var(--ad-border)]">
              <th className="px-4 py-2 font-semibold" scope="col">{t("Media")}</th>
              <th className="px-3 py-2 font-semibold" scope="col">{t("Latest run")}</th>
              <th className="px-3 py-2 font-semibold" scope="col">{t("Evidence")}</th>
              <th className="px-3 py-2 font-semibold" scope="col">{t("Recovery")}</th>
              <th className="px-4 py-2 text-right font-semibold" scope="col">{t("Open")}</th>
            </tr>
          </thead>
          <tbody>
            {projection.operations.map((operation) => (
              <tr
                className="border-b border-[var(--ad-border)] last:border-b-0"
                data-media-operation={operation.modality}
                key={operation.modality}
              >
                <th className="px-4 py-3 text-sm font-semibold" scope="row">
                  {t(mediaOperationLabels[operation.modality])}
                </th>
                <td className="px-3 py-3">
                  {operation.status ? <StatusBadge value={operation.status} /> : t("No runs")}
                  <span className="mt-1 block max-w-44 truncate font-mono text-[10px] text-[var(--ad-text-muted)]">
                    {operation.requestId ?? t("Unavailable")}
                  </span>
                </td>
                <td className="px-3 py-3 text-[var(--ad-text-muted)]">
                  <span className="block">
                    {operation.provider?.key ?? t("Provider unavailable")}
                    {operation.attempt ? ` · ${t("Attempt")} ${operation.attempt.number}` : ""}
                  </span>
                  <span className="mt-1 block">
                    {t("Time")} {operation.timing?.latencyMs === null || operation.timing?.latencyMs === undefined
                      ? t("Unavailable")
                      : mediaOperationDuration(operation.timing.latencyMs)}
                    {" · "}{operation.costDreamcoins === null
                      ? t("Cost unavailable")
                      : t("{cost} Dreamcoins", { cost: operation.costDreamcoins })}
                    {" · "}{operation.output
                      ? t(operation.output.availability === "available"
                          ? "Available"
                          : operation.output.availability === "deleted"
                            ? "Deleted"
                            : "Unavailable")
                      : t("No output")}
                  </span>
                </td>
                <td className="max-w-64 px-3 py-3">
                  <span className="font-semibold">
                    {t(mediaRecoveryLabels[operation.recoverability.state])}
                  </span>
                  {operation.recoverability.reason ? (
                    <span className="mt-1 block text-[var(--ad-text-muted)]">
                      {t(operation.recoverability.reason)}
                    </span>
                  ) : null}
                  {operation.modality === "voice" &&
                  operation.requestId &&
                  operation.recoverability.actionHref &&
                  operation.recoverability.actionConfirmation ? (
                    <button
                      className="mt-2 block font-semibold underline disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={
                        !canReclaimVoice ||
                        !onReclaimVoice ||
                        reclaimingVoiceRequestId === operation.requestId
                      }
                      onClick={() =>
                        setPendingReclaim({
                          requestId: operation.requestId!,
                          confirmation:
                            operation.recoverability.actionConfirmation!,
                          attemptNo: operation.attempt?.number ?? 1,
                          provider: operation.provider?.key ?? null,
                        })
                      }
                      type="button"
                    >
                      {t(
                        reclaimingVoiceRequestId === operation.requestId
                          ? "Reclaiming Voice request…"
                          : "Reclaim Voice request",
                      )}
                    </button>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link className="font-semibold underline" href={operation.studioHref}>
                    {t("Open Studio")}
                  </Link>
                  {operation.operationsHref ? (
                    <Link className="ml-3 font-semibold underline" href={operation.operationsHref}>
                      {t("Open operations")}
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[var(--ad-border)] px-4 py-2 text-xs text-[var(--ad-text-muted)]">
        {t("Run completion does not approve or publish an asset.")} {t("Review and Release remain separate decisions.")}
      </p>
    </details>
    {pendingReclaim && onReclaimVoice ? (
      <ConfirmDialog
        onClose={() => setPendingReclaim(null)}
        spec={{
          title: t("Reclaim expired Voice request"),
          summary: (
            <div className="space-y-2">
              <p>
                {t("Request")} <code>{pendingReclaim.requestId}</code>
                {" · "}{t("Attempt")} {pendingReclaim.attemptNo}
                {" · "}{pendingReclaim.provider ?? t("Provider unavailable")}
              </p>
              <p>
                {t(
                  "The reclaim reuses the pinned provider request and idempotency key, then rechecks the user's current Voice allowance and Dreamcoin balance.",
                )}
              </p>
            </div>
          ),
          destructive: {
            expectedName: pendingReclaim.confirmation,
            inputLabel: t("Type the projected Voice reclaim confirmation"),
          },
          reasonLabel: t("Operational reason (≥3)"),
          submitLabel: t("Reclaim Voice request"),
          onSubmit: (reason) =>
            onReclaimVoice({
              requestId: pendingReclaim.requestId,
              confirmation: pendingReclaim.confirmation,
              reason,
            }),
        }}
      />
    ) : null}
    </>
  );
}
