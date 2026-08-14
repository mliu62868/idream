"use client";

import {
  INCIDENT_CORRELATION_ATTEMPT_MISSING_DISCARD_CONFIRMATION,
  INCIDENT_CORRELATION_REPLAY_CONFIRMATION,
  type IncidentCorrelationOutboxEvent,
  type IncidentCorrelationOutboxEventListResponse,
} from "@idream/shared/admin";
import { AlertTriangle, Loader2, RefreshCcw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { createLatestRequestGate } from "@/lib/latest-request";

export function incidentCorrelationReplayPayload(
  events: readonly IncidentCorrelationOutboxEvent[],
  reason: string,
) {
  return {
    events: events.map((event) => ({
      id: event.id,
      expectedAttempts: event.attempts,
      expectedUpdatedAt: event.updatedAt,
      expectedPayloadHash: event.payloadHash,
    })),
    reason: {
      code: "operator_replay",
      summary: reason.trim(),
    },
    confirmation: INCIDENT_CORRELATION_REPLAY_CONFIRMATION,
  };
}

export function incidentCorrelationAttemptMissingDiscardPayload(
  event: IncidentCorrelationOutboxEvent,
  reason: string,
) {
  if (!event.attemptId) {
    throw new Error("Attempt-missing disposition requires an attempt id");
  }
  return {
    id: event.id,
    expectedAttempts: event.attempts,
    expectedUpdatedAt: event.updatedAt,
    expectedPayloadHash: event.payloadHash,
    expectedAttemptId: event.attemptId,
    reason: {
      code: "source_authority_missing",
      summary: reason.trim(),
    },
    confirmation: INCIDENT_CORRELATION_ATTEMPT_MISSING_DISCARD_CONFIRMATION,
  };
}

export function summarizeIncidentCorrelationReplay(
  results: ReadonlyArray<{ readonly outcome: string }>,
) {
  const counts = new Map<string, number>();
  for (const { outcome } of results) {
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([outcome, count]) => `${outcome}: ${count}`)
    .join(" · ");
}

export function IncidentCorrelationOutbox({
  canDiscardAttemptMissing = false,
  canRead,
  canReplay,
}: {
  readonly canDiscardAttemptMissing?: boolean;
  readonly canRead: boolean;
  readonly canReplay: boolean;
}) {
  const { t } = useAdminI18n();
  const [data, setData] =
    useState<IncidentCorrelationOutboxEventListResponse | null>(null);
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const gate = useRef(createLatestRequestGate());

  const load = useCallback(async (cursor = "") => {
    if (!canRead) return;
    const request = gate.current.begin();
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ status: "failed", limit: "50" });
    if (cursor) query.set("cursor", cursor);
    try {
      const response = await adminV2Operation(
        "GET /api/v2/admin/incidents/correlation-outbox",
        { query },
      );
      if (!request.isCurrent()) return;
      setData(response);
      setSelected(new Set());
    } catch (cause) {
      if (!request.isCurrent()) return;
      setError(cause instanceof Error ? cause.message : "Incident correlation outbox request failed");
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    const requestGate = gate.current;
    const timer = window.setTimeout(() => void load(), 0);
    const refresh = () => void load();
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      window.clearTimeout(timer);
      requestGate.invalidate();
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    };
  }, [load]);

  const rows = data?.items ?? [];
  const eligibleRows: IncidentCorrelationOutboxEvent[] = [];
  const selectedRows: IncidentCorrelationOutboxEvent[] = [];
  for (const row of rows) {
    if (row.replayEligibility !== "eligible") continue;
    eligibleRows.push(row);
    if (selected.has(row.id)) selectedRows.push(row);
  }
  const allSelected = eligibleRows.length > 0 && selectedRows.length === eligibleRows.length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requestReplay() {
    if (!canReplay || selectedRows.length === 0) return;
    const exactRevision = [...selectedRows];
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: t("Replay incident correlation failed events ({count})", {
        count: exactRevision.length,
      }),
      summary: t(
        "The worker will retry the unchanged correlation payloads; this browser request does not correlate an Incident.",
      ),
      destructive: {
        expectedName: INCIDENT_CORRELATION_REPLAY_CONFIRMATION,
        inputLabel: t("Replay confirmation"),
      },
      reasonLabel: t("Replay reason (≥3)"),
      submitLabel: t("Queue replay"),
      onSubmit: async (reason) => {
        const result = await adminV2Operation(
          "POST /api/v2/admin/incidents/correlation-outbox/commands/replay",
          {
            body: incidentCorrelationReplayPayload(exactRevision, reason),
            idempotencyKey,
          },
        );
        setNotice(t("Incident correlation replay result · {summary}.", {
          summary: summarizeIncidentCorrelationReplay(result.results),
        }));
        await load();
      },
    });
  }

  function requestAttemptMissingDisposition(
    row: IncidentCorrelationOutboxEvent,
  ) {
    if (
      !canDiscardAttemptMissing ||
      row.replayEligibility !== "attempt_missing" ||
      !row.attemptId
    ) return;
    const exactRevision = row;
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: t("Record source authority missing"),
      summary: t(
        "This preserves the failed carrier and records that its GenerationAttempt source authority is still absent; no user effect is applied.",
      ),
      destructive: {
        expectedName:
          INCIDENT_CORRELATION_ATTEMPT_MISSING_DISCARD_CONFIRMATION,
        inputLabel: t("Disposition confirmation"),
      },
      reasonLabel: t("Disposition reason (≥3)"),
      submitLabel: t("Record terminal disposition"),
      onSubmit: async (reason) => {
        const result = await adminV2Operation(
          "POST /api/v2/admin/incidents/correlation-outbox/commands/discard-attempt-missing",
          {
            body: incidentCorrelationAttemptMissingDiscardPayload(
              exactRevision,
              reason,
            ),
            idempotencyKey,
          },
        );
        setNotice(t(
          "Incident correlation attempt-missing disposition · {outcome}.",
          { outcome: result.outcome },
        ));
        await load();
      },
    });
  }

  return (
    <section
      aria-labelledby="incident-correlation-outbox-title"
      className="space-y-3 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold" id="incident-correlation-outbox-title">
            {t("Incident correlation failed delivery")}
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--ad-text-muted)]">
            {t("Inspect terminally failed generation-to-Incident carriers and return only exact eligible revisions to the worker queue.")}
          </p>
        </div>
        <div className="text-right text-xs font-semibold text-[var(--ad-text-muted)]">
          {!canRead ? (
            <p>{t("Unavailable · ops.queue.read is not granted")}</p>
          ) : !canReplay ? (
            <p>{t("Replay unavailable · ops.deadletter.write is not granted")}</p>
          ) : null}
        </div>
      </div>

      {notice ? (
        <p className="rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">
          {t("Incident correlation failed delivery refresh failed:")} {error}
          <button className="ml-3 min-h-8 rounded border border-current px-2 font-semibold" onClick={() => void load()} type="button">
            {t("Retry")}
          </button>
        </p>
      ) : null}

      {!canRead ? null : loading && !data ? (
        <p className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("Loading incident correlation failed delivery")}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          hint={t("Every incident correlation carrier is pending, delivered, or explicitly quarantined.")}
          title={t("No failed incident correlation deliveries")}
        />
      ) : (
        <>
          {canReplay ? (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
                <input
                  aria-label={t("Select all replay-eligible incident correlation events")}
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(eligibleRows.map(({ id }) => id)))}
                  type="checkbox"
                />
                {t("Select replay-eligible")}
              </label>
              <button
                className="inline-flex min-h-10 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-[var(--ad-surface)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={selectedRows.length === 0}
                onClick={requestReplay}
                type="button"
              >
                <RotateCcw className="h-4 w-4" />
                {t("Replay selected")}
              </button>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-lg border border-[var(--ad-border)]">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="bg-[var(--ad-surface-subtle)] text-xs text-[var(--ad-text-muted)]">
                <tr>
                  <th className="px-3 py-2">{t("Select")}</th>
                  <th className="px-3 py-2">{t("Event")}</th>
                  <th className="px-3 py-2">{t("Attempt")}</th>
                  <th className="px-3 py-2">{t("Replay authority")}</th>
                  <th className="px-3 py-2">{t("Last error")}</th>
                  <th className="px-3 py-2">{t("Revision")}</th>
                  <th className="px-3 py-2">{t("Terminal disposition")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const eligible = row.replayEligibility === "eligible";
                  return (
                    <tr className="border-t border-[var(--ad-border)] align-top" key={row.id}>
                      <td className="px-3 py-3">
                        {canReplay ? (
                          <input
                            aria-label={t("Select failed incident correlation event {id}", { id: row.id })}
                            checked={selected.has(row.id)}
                            disabled={!eligible}
                            onChange={() => toggle(row.id)}
                            type="checkbox"
                          />
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <p className="font-mono text-xs">{row.id}</p>
                        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{row.aggregateType}:{row.aggregateId}</p>
                      </td>
                      <td className="px-3 py-3">
                        <p className="font-mono text-xs">{row.attemptId ?? "—"}</p>
                        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{row.attemptStatus ?? "—"}</p>
                      </td>
                      <td className="px-3 py-3">
                        <span className={eligible ? "text-[var(--ad-green-text)]" : "text-[var(--ad-yellow-text)]"}>
                          {!eligible ? <AlertTriangle className="mr-1 inline h-3.5 w-3.5" /> : null}
                          {t(row.replayEligibility.replaceAll("_", " "))}
                        </span>
                      </td>
                      <td className="max-w-xs px-3 py-3 text-xs">
                        <p className="font-mono">{row.lastErrorCode ?? "—"}</p>
                        <p className="mt-1 line-clamp-2 text-[var(--ad-text-muted)]">{row.lastErrorMessage ?? "—"}</p>
                      </td>
                      <td className="px-3 py-3 text-xs text-[var(--ad-text-muted)]">
                        <p>{t("Attempts")}: {row.attempts}</p>
                        <p className="mt-1 font-mono" title={row.payloadHash}>{row.payloadHash.slice(0, 12)}</p>
                        <time className="mt-1 block" dateTime={row.updatedAt}>{new Date(row.updatedAt).toLocaleString()}</time>
                      </td>
                      <td className="px-3 py-3">
                        {canDiscardAttemptMissing &&
                        row.replayEligibility === "attempt_missing" &&
                        row.attemptId ? (
                          <button
                            className="min-h-9 rounded-md border border-[var(--ad-border)] px-3 text-xs font-semibold"
                            onClick={() => requestAttemptMissingDisposition(row)}
                            type="button"
                          >
                            {t("Record source authority missing")}
                          </button>
                        ) : (
                          <span className="text-xs text-[var(--ad-text-muted)]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {data?.pageInfo.hasNextPage && data.pageInfo.endCursor ? (
            <button
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold"
              disabled={loading}
              onClick={() => void load(data.pageInfo.endCursor ?? "")}
              type="button"
            >
              <RefreshCcw className="h-4 w-4" />
              {t("Next failed delivery page")}
            </button>
          ) : null}
        </>
      )}

      {confirmation ? <ConfirmDialog onClose={() => setConfirmation(null)} spec={confirmation} /> : null}
    </section>
  );
}
