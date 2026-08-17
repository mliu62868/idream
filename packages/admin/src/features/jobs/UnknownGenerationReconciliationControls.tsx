"use client";

import { AlertTriangle, CheckCircle2, Clock3, RefreshCcw } from "lucide-react";
import { useState } from "react";
import {
  unknownGenerationReconciliationCommandSchema,
  unknownGenerationReconciliationResultSchema,
  type GenerationJobDetailResponse,
  type UnknownGenerationReconciliationCommand,
  type UnknownGenerationReconciliationResult,
} from "@idream/shared/admin";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { useAdminI18n } from "@/components/admin/i18n";
import { useAdminFormat } from "@/components/admin/ui/format";
import { AdminV2RequestError, adminV2Request } from "@/lib/admin-v2-api";
import {
  claimDurableMutationIntent,
  clearDurableMutationIntent,
  readActiveDurableMutationIntent,
  updateDurableMutationIntent,
  type DurableMutationIntent,
} from "@/lib/durable-mutation-intent";

const REVIEW_DELAY_MS = 24 * 60 * 60 * 1_000;

export function unknownGenerationEvidenceRefs(
  detail: GenerationJobDetailResponse,
) {
  const latest = detail.attempts.at(-1);
  const refs = detail.transportExecutions
    .filter((transport) => transport.attemptId === latest?.id)
    .flatMap((transport) => [
    transport.providerRequestId
      ? `provider-request:${transport.providerRequestId}`
      : null,
    transport.terminalRecordRef
      ? `terminal-record:${transport.terminalRecordRef}`
      : null,
    ]).filter((value): value is string => Boolean(value));
  if (detail.unknownTerminalEvidence?.terminalRecordRef) {
    refs.push(
      `terminal-record:${detail.unknownTerminalEvidence.terminalRecordRef}`,
    );
  }
  if (refs.length === 0 && latest) refs.push(`attempt-event:${latest.id}:unknown`);
  return [...new Set(refs)].slice(0, 20);
}

export function UnknownGenerationReconciliationControls({
  detail,
  onReconciled,
}: {
  readonly detail: GenerationJobDetailResponse;
  readonly onReconciled: (
    result: UnknownGenerationReconciliationResult,
  ) => Promise<void> | void;
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const request = detail.request;
  const latestAttempt = detail.attempts.at(-1) ?? null;
  const latestDecision = detail.unknownReconciliations.at(-1) ?? null;
  const hasTerminalDecision =
    latestDecision?.resolution === "confirm_failed" ||
    latestDecision?.resolution === "adopt_succeeded";
  const scope = `generation-unknown-reconciliation:${request.id}`;
  const [intent, setIntent] = useState<DurableMutationIntent | null>(() =>
    readActiveDurableMutationIntent({ scope })
  );
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (
    !latestAttempt ||
    latestAttempt.status !== "unknown" ||
    request.requestOutcome !== "needs_reconciliation" ||
    hasTerminalDecision
  ) return null;

  const evidenceRefs = unknownGenerationEvidenceRefs(detail);
  const terminalEvidence = detail.unknownTerminalEvidence;
  const recoveredSuccessCannotResolveAsFailure =
    terminalEvidence?.outcome === "succeeded";

  async function commitIntent(current: DurableMutationIntent) {
    const saved = unknownGenerationReconciliationCommandSchema.parse(
      current.requestSnapshot,
    );
    setBusy(true);
    setError(null);
    setMessage(null);
    let active = current;
    try {
      const result = await adminV2Request(
        `/api/v2/admin/jobs/${encodeURIComponent(request.id)}/commands/reconcile-unknown`,
        {
          method: "POST",
          idempotencyKey: active.idempotencyKey,
          schema: unknownGenerationReconciliationResultSchema,
          body: saved,
        },
      );
      active = updateDurableMutationIntent(active, {
        status: "committed_projection_pending",
        committedTargetId: result.commandId,
      });
      setIntent(active);
      await onReconciled(result);
      clearDurableMutationIntent(active);
      setIntent(null);
      setMessage(result.resolution === "confirm_failed"
        ? t("Provider failure confirmed; {count} Dreamcoins refunded.", {
            count: result.refundAmount,
          })
        : result.resolution === "adopt_succeeded"
          ? t("Recovered success adopted; {count} output(s) delivered.", {
              count: result.deliveredCount,
            })
          : t("Unknown outcome retained; next review {time}.", {
              time: format.dateTime(result.nextReviewAt),
            }));
      return result;
    } catch (cause) {
      if (isDefinitiveMutationRejection(cause)) {
        clearDurableMutationIntent(active);
        setIntent(null);
        setError(cause.message);
      } else if (active.status === "committed_projection_pending") {
        setError(
          t("The reconciliation committed, but the authoritative Jobs projection still needs refresh. Resume the saved command to verify it."),
        );
      } else {
        active = updateDurableMutationIntent(active, { status: "outcome_unknown" });
        setIntent(active);
        setError(
          t("The reconciliation outcome is unknown. Resume the exact saved command; no new resolution will be submitted."),
        );
      }
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  async function submit(command: UnknownGenerationReconciliationCommand) {
    const signature = JSON.stringify({
      requestId: request.id,
      entityVersion: command.entityVersion,
      resolution: command.resolution,
    });
    const claim = await claimDurableMutationIntent({
      scope,
      signature,
      requestSnapshot: command,
    });
    if (claim.intent.signature !== signature) {
      setIntent(claim.intent);
      throw new Error(
        t("Another unknown-outcome decision is already saved in this browser. Resume it before choosing a different resolution."),
      );
    }
    setIntent(claim.intent);
    await commitIntent(claim.intent);
  }

  function openRemainUnknown() {
    setConfirmSpec({
      title: t("Keep provider outcome unknown"),
      summary: (
        <span>
          {t("Records an audited review and keeps settlement open. The next review is scheduled for 24 hours from submission; the unknown Attempt remains immutable.")}
        </span>
      ),
      submitLabel: t("Schedule next review"),
      onSubmit: (reason) => submit(unknownGenerationReconciliationCommandSchema.parse({
        resolution: "remain_unknown",
        entityVersion: request.version,
        reason,
        providerEvidenceRefs: evidenceRefs,
        nextReviewAt: new Date(Date.now() + REVIEW_DELAY_MS).toISOString(),
        confirmation: `${request.id}:remain_unknown`,
      })),
    });
  }

  function openConfirmFailed() {
    setConfirmSpec({
      title: t("Confirm provider failure"),
      summary: (
        <span>
          {t("Settles the Request as failed and refunds the remaining captured Dreamcoins. The unknown Attempt evidence is retained unchanged.")}
        </span>
      ),
      destructive: { expectedName: `${request.id}:confirm_failed` },
      submitLabel: t("Confirm failure and refund"),
      onSubmit: (reason) => submit(unknownGenerationReconciliationCommandSchema.parse({
        resolution: "confirm_failed",
        entityVersion: request.version,
        reason,
        providerEvidenceRefs: evidenceRefs,
        confirmation: `${request.id}:confirm_failed`,
      })),
    });
  }

  function openAdoptSucceeded() {
    setConfirmSpec({
      title: t("Adopt recovered provider success"),
      summary: (
        <span>
          {t("Delivers only the assets bound to the validated late terminal record. The unknown Attempt remains immutable while the Request, settlement, and downstream projections complete transactionally.")}
        </span>
      ),
      destructive: { expectedName: `${request.id}:adopt_succeeded` },
      submitLabel: t("Adopt success and deliver"),
      onSubmit: (reason) => submit(unknownGenerationReconciliationCommandSchema.parse({
        resolution: "adopt_succeeded",
        entityVersion: request.version,
        reason,
        providerEvidenceRefs: evidenceRefs,
        confirmation: `${request.id}:adopt_succeeded`,
      })),
    });
  }

  return (
    <section className="rounded-lg border border-amber-400/40 bg-amber-50/60 p-4" data-testid="unknown-generation-reconciliation">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-amber-950">
            {t("Unknown provider outcome requires an operator decision")}
          </h3>
          <p className="mt-1 text-xs text-amber-900/80">
            {t("Attempt {attemptNo} stays unknown. Evidence captured: {count} reference(s).", {
              attemptNo: latestAttempt.attemptNo,
              count: evidenceRefs.length,
            })}
          </p>
          {latestDecision?.resolution === "remain_unknown" ? (
            <p
              className={`mt-2 text-xs font-semibold ${latestDecision.reviewStatus === "due" ? "text-red-700" : "text-amber-800"}`}
              data-testid="unknown-review-status"
            >
              {latestDecision.reviewStatus === "due"
                ? t("Scheduled provider review is due now.")
                : t("Next provider review is scheduled for {time}.", {
                    time: latestDecision.nextReviewAt
                      ? format.dateTime(latestDecision.nextReviewAt)
                      : "—",
                  })}
            </p>
          ) : null}
          {terminalEvidence ? (
            <p className="mt-2 text-xs text-amber-900/80">
              {t("Recovered terminal evidence: {outcome}, {count} artifact(s).", {
                outcome: terminalEvidence.outcome,
                count: terminalEvidence.artifactCount,
              })}
            </p>
          ) : null}
          {terminalEvidence?.adoptionBlockReason === "request_already_refunded" ? (
            <p
              className="mt-2 text-xs font-semibold text-red-700"
              data-testid="unknown-recovered-success-readonly"
            >
              {t("Recovered success is verified, but this Request was already refunded. Adoption and failure confirmation are unavailable; only an audited future review may be recorded.")}
            </p>
          ) : null}
          {intent ? (
            <div className="mt-3 rounded-md border border-amber-500/30 bg-white/70 p-3">
              <p className="text-xs text-amber-950">
                {t("A durable reconciliation command is saved with status {status}.", {
                  status: intent.status,
                })}
              </p>
              <button
                className="mt-2 inline-flex min-h-9 items-center gap-2 rounded-md border border-amber-700/30 px-3 text-xs font-semibold disabled:opacity-50"
                disabled={busy}
                onClick={() => void commitIntent(intent).catch(() => undefined)}
                type="button"
              >
                <RefreshCcw className="h-4 w-4" /> {t("Resume exact saved command")}
              </button>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {terminalEvidence?.adoptable ? (
                <button
                  className="inline-flex min-h-9 items-center gap-2 rounded-md bg-emerald-800 px-3 text-xs font-semibold text-white disabled:opacity-50"
                  disabled={busy}
                  onClick={openAdoptSucceeded}
                  type="button"
                >
                  <CheckCircle2 className="h-4 w-4" /> {t("Adopt recovered success")}
                </button>
              ) : null}
              <button
                className="inline-flex min-h-9 items-center gap-2 rounded-md border border-amber-700/30 px-3 text-xs font-semibold disabled:opacity-50"
                disabled={busy}
                onClick={openRemainUnknown}
                type="button"
              >
                <Clock3 className="h-4 w-4" /> {t("Remain unknown and review later")}
              </button>
              {!terminalEvidence?.adoptable &&
              !recoveredSuccessCannotResolveAsFailure ? (
                <button
                  className="inline-flex min-h-9 items-center gap-2 rounded-md bg-amber-950 px-3 text-xs font-semibold text-white disabled:opacity-50"
                  disabled={busy}
                  onClick={openConfirmFailed}
                  type="button"
                >
                  <CheckCircle2 className="h-4 w-4" /> {t("Confirm failed and refund")}
                </button>
              ) : null}
            </div>
          )}
          {message ? <p className="mt-3 text-xs text-emerald-700" role="status">{message}</p> : null}
          {error ? <p className="mt-3 text-xs text-red-700" role="alert">{error}</p> : null}
        </div>
      </div>
      {confirmSpec ? (
        <ConfirmDialog onClose={() => setConfirmSpec(null)} spec={confirmSpec} />
      ) : null}
    </section>
  );
}

function isDefinitiveMutationRejection(
  cause: unknown,
): cause is AdminV2RequestError {
  return cause instanceof AdminV2RequestError &&
    [400, 401, 403, 404, 409, 422].includes(cause.status);
}
