"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import type { AdminCommandStatus } from "@idream/shared/admin";
import { apiGet } from "@/components/admin/api";
import { CopyableId } from "@/components/admin/ui/CopyableId";
import { DataTable, type DataTableHeader, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { FilterBar, type FilterChip } from "@/components/admin/ui/FilterBar";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { Pagination } from "@/components/admin/ui/Pagination";
import { useUrlFilters } from "@/components/admin/ui/useUrlFilters";
import { createLatestRequestGate } from "@/lib/latest-request";
import { canonicalListEmptyTitle } from "@/features/compatibility-lists/empty-state";
import {
  auditCommandPath,
  auditLimitOptions,
  auditListPath,
  auditQueryFromSearch,
  auditWorkspaceUrl,
  changedAuditFilters,
  defaultAuditQuery,
  isAuditQueryFiltered,
  type AuditFilterKey,
  type AuditQuery,
} from "./query";

type AuditRecord = Record<string, unknown>;
type AuditListResponse = {
  items: AuditRecord[];
  pageInfo?: AuditPageInfo;
};

type AuditPageInfo = { endCursor: string | null; hasNextPage: boolean };
const emptyPageInfo: AuditPageInfo = { endCursor: null, hasNextPage: false };

const FILTER_LABELS: Record<AuditFilterKey, string> = {
  search: "Search",
  action: "Action",
  actorId: "Actor ID",
  targetType: "Target type",
};

export function AuditWorkspace() {
  const { t } = useAdminI18n();
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  const [pageInfo, setPageInfo] = useState(emptyPageInfo);
  const [command, setCommand] = useState<AdminCommandStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  // 游标分页没有页码，只有「上一页用的是哪个游标」。这条轨迹就是 Pagination 的第 N 页。
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const requestGate = useRef(createLatestRequestGate());

  const load = useCallback(async (next: AuditQuery) => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const [audit, commandContext] = await Promise.all([
        apiGet<AuditListResponse>(auditListPath(next)),
        next.commandId
          ? apiGet<AdminCommandStatus>(auditCommandPath(next.commandId))
          : Promise.resolve(null),
      ]);
      if (!request.isCurrent()) return;
      setRecords(audit.items);
      setPageInfo(audit.pageInfo ?? emptyPageInfo);
      setCommand(commandContext);
      setRefreshedAt(new Date().toISOString());
    } catch (loadError) {
      if (request.isCurrent()) {
        setError(loadError instanceof Error ? loadError.message : "Audit authority request failed");
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, []);

  const filters = useUrlFilters<AuditQuery>({
    initial: defaultAuditQuery,
    parse: (params) => auditQueryFromSearch(`?${params.toString()}`),
    toUrl: (next, location) => auditWorkspaceUrl(location.pathname, location.search, {
      auditSearch: next.search || null,
      auditAction: next.action || null,
      auditActor: next.actorId || null,
      auditTargetType: next.targetType || null,
      auditCursor: next.cursor || null,
      auditLimit: next.limit === defaultAuditQuery.limit ? null : String(next.limit),
    }),
    load: (next) => { void load(next); },
  });
  const { apply, draft, query, reload, setDraft } = filters;

  // SPEC: 任何改变结果集的动作都回到第一页并清空勾选 —— 选中的行翻页后已经不在屏幕上了。
  function applyQuery(next: AuditQuery, trail: string[] = []) {
    setCursorTrail(trail);
    setSelectedRows([]);
    apply(next);
  }

  const filtered = isAuditQueryFiltered(query);
  const chips: FilterChip[] = changedAuditFilters(query).map((filter) => ({
    key: filter.key,
    label: t(FILTER_LABELS[filter.key]),
    value: filter.value,
    onClear: () => applyQuery({ ...query, ...filter.reset, cursor: "" }),
  }));

  const rows: DataTableRow[] = (records ?? []).map((row, index) => ({
    id: text(row.id) || `audit-${index}`,
    cells: [
      <CopyableId key="id" value={text(row.id)} />,
      <CopyableId key="actor" value={text(row.actorId) || "system"} />,
      text(row.actorRole) || "—",
      text(row.action) || "—",
      `${text(row.targetType) || "—"}:${text(row.targetId) || "—"}`,
      display(row.reason),
      dateCell(row.createdAt),
    ],
  }));

  return (
    <section aria-labelledby="audit-workspace-title" className="space-y-5">
      <div id="audit-workspace-title">
        <PageHeader
          purpose="Trace consequential operator decisions to the actor, target, reason, request, and command evidence that produced them."
          title={t("Audit Log")}
        />
      </div>
      <p className="text-xs text-[var(--ad-text-muted)]" role="status">

        {refreshedAt ? <>{t("Refreshed")} <time dateTime={refreshedAt}>{new Date(refreshedAt).toLocaleTimeString()}</time></> : null}
      </p>

      <FilterBar
        busy={loading}
        chips={chips}
        collapsible
        inputs={[
          { name: t("Exact action"), value: draft.action, onChange: (action) => setDraft({ action }), placeholder: t("character.release.publish") },
          { name: t("Actor ID"), value: draft.actorId, onChange: (actorId) => setDraft({ actorId }), placeholder: t("operator ID") },
          { name: t("Target type"), value: draft.targetType, onChange: (targetType) => setDraft({ targetType }), placeholder: t("character_release") },
        ]}
        onApply={() => applyQuery({ ...draft, cursor: "" })}
        onReset={() => applyQuery({ ...defaultAuditQuery, commandId: query.commandId })}
        onSearch={(search) => setDraft({ search })}
        search={draft.search}
        searchPlaceholder={t("action, target, reason, or request")}
      />

      {command ? <CommandContext command={command} /> : null}

      <DataTable
        caption="Audit authority events"
        density="compact"
        empty={
          <EmptyState
            hint={filtered
              ? "The complete server-side query returned no records. Clear filters to inspect the authority."
              : "Auditable operator actions will appear after the first consequential command is recorded."}
            kind={filtered ? "filtered" : "empty"}
            onClearFilters={filtered ? () => applyQuery({ ...defaultAuditQuery, commandId: query.commandId }) : undefined}
            title={canonicalListEmptyTitle("audit", filtered)}
          />
        }
        error={error}
        headers={AUDIT_HEADERS}
        loading={loading}
        minimumWidthClassName="min-w-[1200px]"
        onRetry={reload}
        rows={rows}
        selection={{
          selected: selectedRows,
          onChange: setSelectedRows,
          actions: (
            <button
              className="min-h-8 rounded-md border border-white/40 px-3 text-xs font-semibold"
              onClick={() => { void navigator.clipboard?.writeText(selectedRows.join("\n")); }}
              type="button"
            >
              {t("Copy selected IDs")}
            </button>
          ),
        }}
        skeletonRows={query.limit}
        stickyHeader
      />

      {records ? (
        <Pagination
          hasNext={Boolean(pageInfo.hasNextPage && pageInfo.endCursor)}
          hasPrevious={cursorTrail.length > 0}
          loading={loading}
          onNext={() => {
            if (!pageInfo.endCursor) return;
            applyQuery({ ...query, cursor: pageInfo.endCursor }, [...cursorTrail, query.cursor]);
          }}
          onPageSizeChange={(limit) => applyQuery({ ...query, limit, cursor: "" })}
          onPrevious={() => applyQuery({ ...query, cursor: cursorTrail.at(-1) ?? "" }, cursorTrail.slice(0, -1))}
          page={cursorTrail.length + 1}
          pageSize={query.limit}
          pageSizeOptions={auditLimitOptions}
          rowCount={rows.length}
        />
      ) : null}
    </section>
  );
}

const AUDIT_HEADERS: DataTableHeader[] = [
  { label: "Event", width: "9rem" },
  { label: "Actor", width: "9rem" },
  { label: "Role", width: "7rem" },
  { label: "Action", truncate: true, width: "14rem" },
  { label: "Target", truncate: true, width: "14rem" },
  { label: "Reason", truncate: true, width: "18rem" },
  { label: "Occurred", width: "11rem" },
];

function CommandContext({ command }: { command: AdminCommandStatus }) {
  return <DataTable caption="Command context" headers={["Command", "Type", "Target", "Execution", "Verification", "Reconciliation", "Updated"]} rows={[{ id: command.commandId, cells: [<CopyableId key="id" value={command.commandId} />, command.commandType, `${command.target.type}:${command.target.id}`, command.status, command.verificationState ?? "pending", command.needsReconciliation ? "required" : "not required", <time dateTime={command.updatedAt} key="updated">{formatDate(command.updatedAt)}</time>] }]} />;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function display(value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return <code className="block max-w-72 truncate text-xs" title={JSON.stringify(value)}>{JSON.stringify(value)}</code>;
}

function dateCell(value: unknown) {
  const dateTime = text(value);
  // 时间戳换行会把行高撑成三行；这一列宁可参与横向滚动也不折行。
  return dateTime ? <time className="whitespace-nowrap" dateTime={dateTime}>{formatDate(dateTime)}</time> : "—";
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
