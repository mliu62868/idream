"use client";

import { useCallback, useState } from "react";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { useAuthorityResource } from "@/lib/authority-resource";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { DataTable } from "@/components/admin/ui/DataTable";
import { useAdminFormat } from "@/components/admin/ui/format";

export function ChatEngagementPanel({
  userId,
  characterId,
}: { userId: string; characterId: string }) {
  const { t } = useAdminI18n();
  const { dateTime, text: value } = useAdminFormat();
  const [kind, setKind] = useState<"groups" | "proactive" | null>(null);
  const [cursor, setCursor] = useState("");
  const load = useCallback(() => {
    const query = new URLSearchParams({ kind: kind ?? "groups", limit: "25" });
    if (userId) query.set("userId", userId);
    if (characterId) query.set("characterId", characterId);
    if (cursor) query.set("cursor", cursor);
    return adminV2Operation("GET /api/v2/admin/chat/engagement", { query });
  }, [kind, userId, characterId, cursor]);
  const resource = useAuthorityResource({
    key: JSON.stringify([kind, userId, characterId, cursor]),
    enabled: kind !== null,
    load,
  });
  const { data, loading } = resource;

  function choose(next: "groups" | "proactive") {
    if (next === kind && !cursor) void resource.refresh();
    else {
      setKind(next);
      setCursor("");
    }
  }

  return <section className="space-y-3" aria-label={t("Group and proactive conversations")}>
    <h2 className="text-base font-semibold">{t("Group and proactive conversations")}</h2>
    <p className="text-sm text-[var(--ad-text-muted)]">
      {t("Inspect participants, schedules and the latest Turn without conversation text. User and Character filters apply.")}
    </p>
    <div className="flex flex-wrap gap-2" role="group" aria-label={t("Conversation operation view")}>
      {(["groups", "proactive"] as const).map((item) => <button
        key={item}
        type="button"
        className="min-h-9 rounded border border-[var(--ad-border)] px-3 text-sm aria-pressed:bg-[var(--ad-surface)]"
        aria-pressed={kind === item}
        onClick={() => choose(item)}
      >{t(item === "groups" ? "Group conversations" : "Proactive messages")}</button>)}
    </div>
    {kind && <>
      {kind === "proactive" && <p className="text-sm text-[var(--ad-text-muted)]">
        {t("Due means eligible for scheduler pickup. Allowance and release checks still run at admission. Pre-admission failures are logged by the worker; no Turn means no durable delivery evidence.")}
      </p>}
      {resource.error && <AuthorityRequestError
        cause={resource.cause}
        message={resource.error}
        onRetry={() => void resource.refresh()}
        snapshotAt={data ? resource.refreshedAt : null}
      />}
      <DataTable
        caption={t(kind === "groups" ? "Group conversations" : "Proactive messages")}
        headers={[t("Conversation / customer"), t("Participants"), t("Schedule / unread"), t("Latest Turn / admission")]}
        loading={loading}
        empty={t("No conversation operations match these filters")}
        rows={(data?.items ?? []).map((row) => ({
          id: row.id,
          cells: [
            <div key="identity" className="space-y-1 break-all">
              <div>{row.id}</div>
              <div>{value(row.status)}</div>
              <a className="underline" href={`/admin/customers/${encodeURIComponent(row.userId)}`}>{row.userId}</a>
            </div>,
            <div key="members" className="space-y-2">
              {row.sessions.map((session) => <div key={session.sessionId} className="break-all">
                <a className="underline" href={`/admin/characters/${encodeURIComponent(session.characterId)}`}>{session.characterId}</a>
                <div>{session.sessionId} · {value(session.status)}</div>
              </div>)}
            </div>,
            row.schedule ? <div key="schedule" className="space-y-1">
              <div>{t({
                disabled: "Proactive disabled",
                inactive: "Session inactive",
                missing_schedule: "Schedule missing",
                due: "Due for scheduler pickup",
                scheduled: "Scheduled",
              }[row.schedule.state])}</div>
              <div>{t("Interval hours")}: {row.schedule.intervalHours}</div>
              <div>{t("Next scheduled time")}: {dateTime(row.schedule.nextAt)}</div>
              <div>{t("Unread since")}: {dateTime(row.schedule.unreadAt)}</div>
            </div> : "—",
            row.latestTurn ? <div key="turn" className="space-y-1 break-all">
              <div>{row.latestTurn.id}</div>
              <div>{value(row.latestTurn.status)} · {t("Attempt")}: {row.latestTurn.attempt}</div>
              <div>{t("Admission attempts")}: {row.latestTurn.admissionAttempts}</div>
              <div>{t("Admitted at")}: {dateTime(row.latestTurn.admittedAt)}</div>
              {row.latestTurn.hasAdmissionError && <div role="status">
                {t("Admission error recorded. A next admission time is shown only while automatic admission is pending.")}
              </div>}
              <div>{t("Next admission time")}: {dateTime(row.latestTurn.admissionNextRunAt)}</div>
              <div>{t("Terminal at")}: {dateTime(row.latestTurn.terminalAt)}</div>
            </div> : t("No durable Turn yet"),
          ],
        }))}
      />
      <div className="flex gap-3">
        <button
          type="button"
          className="min-h-9 text-sm underline disabled:opacity-50"
          disabled={loading}
          onClick={() => {
            if (cursor) setCursor("");
            else void resource.refresh();
          }}
        >{t("Refresh from first page")}</button>
        <button
          type="button"
          className="min-h-9 text-sm underline disabled:opacity-50"
          disabled={loading || !data?.pageInfo.hasNextPage}
          onClick={() => setCursor(data?.pageInfo.endCursor ?? "")}
        >{t("Next page")}</button>
      </div>
    </>}
  </section>;
}
