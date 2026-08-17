"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog } from "@/components/admin/ui/ConfirmDialog";
import { DataTable } from "@/components/admin/ui/DataTable";
import { useAdminFormat } from "@/components/admin/ui/format";
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
  const format = useAdminFormat();
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
              {/* 裸文本节点不是 flex item，gap 对它无效——「Image」和「No runs」会粘成
                  「ImageNo runs」。两侧都套 span 才吃得到间距。 */}
              <span>{t(mediaOperationLabels[operation.modality])}</span>
              {operation.status
                ? <StatusBadge value={operation.status} />
                : <span>{t("No runs")}</span>}
            </span>
          ))}
        </span>
      </summary>
      <div className="border-t border-[var(--ad-border)] p-3">
        <DataTable
          caption="Recent media operations"
          headers={[
            { label: "Media", width: "8rem" },
            { label: "Latest run" },
            { label: "Evidence" },
            { label: "Recovery", width: "16rem" },
            { label: "Open", align: "right" },
          ]}
          minimumWidthClassName="min-w-[760px]"
          rows={projection.operations.map((operation) => ({
            id: operation.modality,
            cells: [
              <span className="text-sm font-semibold" key="media">
                {t(mediaOperationLabels[operation.modality])}
              </span>,
              <div key="run">
                {operation.status ? <StatusBadge value={operation.status} /> : t("No runs")}
                <span className="mt-1 block max-w-44 truncate font-mono text-[10px] text-[var(--ad-text-muted)]">
                  {operation.requestId ?? t("Unavailable")}
                </span>
              </div>,
              <div className="text-xs text-[var(--ad-text-muted)]" key="evidence">
                <span className="block">
                  {operation.provider?.key ?? t("Provider unavailable")}
                  {operation.attempt ? ` · ${t("Attempt")} ${operation.attempt.number}` : ""}
                </span>
                <span className="mt-1 block">
                  {t("Time")} {operation.timing?.latencyMs === null || operation.timing?.latencyMs === undefined
                    ? t("Unavailable")
                    : format.duration(operation.timing.latencyMs)}
                  {" · "}{operation.costDreamcoins === null
                    ? t("Cost unavailable")
                    : format.dreamcoins(operation.costDreamcoins)}
                  {" · "}{operation.output
                    ? t(operation.output.availability === "available"
                        ? "Available"
                        : operation.output.availability === "deleted"
                          ? "Deleted"
                          : "Unavailable")
                    : t("No output")}
                </span>
              </div>,
              <div className="text-xs" key="recovery">
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
                {/* SPEC: "Retry available" 必须带着一条真能重跑的去处。
                    INTENT: 只有 voice 能就地重领——契约的 superRefine 明确禁止非 voice
                    投递 actionHref。图片/视频的重跑在运维的作业队列里，所以这里给的是
                    那条路，而不是一个点不动的按钮。 */}
                {operation.modality !== "voice" &&
                operation.recoverability.state === "retryable" &&
                operation.operationsHref ? (
                  <Link
                    className="mt-2 block font-semibold underline"
                    href={operation.operationsHref}
                  >
                    {t("Requeue in operations")}
                  </Link>
                ) : null}
              </div>,
              <span className="whitespace-nowrap text-xs" key="open">
                <Link className="font-semibold underline" href={operation.studioHref}>
                  {t("Open Studio")}
                </Link>
                {operation.operationsHref ? (
                  <Link className="ml-3 font-semibold underline" href={operation.operationsHref}>
                    {t("Open operations")}
                  </Link>
                ) : null}
              </span>,
            ],
          }))}
        />
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
