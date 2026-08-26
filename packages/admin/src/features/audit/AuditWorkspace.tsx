"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import { Download, Loader2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { AdminCommandStatus } from "@idream/shared/admin";
import { apiGet } from "@/components/admin/api";
import { CopyableId } from "@/components/admin/ui/CopyableId";
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from "@/components/admin/ui/csv";
import { DataTable, type DataTableHeader, type DataTableRow } from "@/components/admin/ui/DataTable";
import { collapseAuditRuns } from "./collapse-runs";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { FilterBar, type FilterChip } from "@/components/admin/ui/FilterBar";
import { useAdminFormat, text } from "@/components/admin/ui/format";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { emptyPageInfo, Pagination, type PageInfo } from "@/components/admin/ui/Pagination";
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
  pageInfo?: PageInfo;
};

// SPEC: 导出走服务端的完整筛选结果，不是屏幕上这 25 行 —— 法务要的是整段证据。
// INVARIANT: 上限 20 页 × 100 行。够不够都要说清楚导出了多少行，不能悄悄截断。
const EXPORT_PAGE_SIZE = 100;
const EXPORT_MAX_PAGES = 20;

const AUDIT_CSV_COLUMNS: readonly CsvColumn<AuditRecord>[] = [
  { header: "event_id", value: (row) => text(row.id) },
  { header: "occurred_at", value: (row) => text(row.createdAt) },
  { header: "actor_id", value: (row) => text(row.actorId) || "system" },
  { header: "actor_role", value: (row) => text(row.actorRole) },
  { header: "action", value: (row) => text(row.action) },
  { header: "target_type", value: (row) => text(row.targetType) },
  { header: "target_id", value: (row) => text(row.targetId) },
  { header: "reason", value: (row) => (typeof row.reason === "string" ? row.reason : row.reason == null ? "" : JSON.stringify(row.reason)) },
];

const FILTER_LABELS: Record<AuditFilterKey, string> = {
  search: "Search",
  action: "Action",
  actorId: "Actor ID",
  targetType: "Target type",
};

export function AuditWorkspace() {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  // SPEC: 默认折叠 —— 首屏被一次批量操作吃掉是常态，不是例外。
  const [collapseRepeats, setCollapseRepeats] = useState(true);
  const [pageInfo, setPageInfo] = useState(emptyPageInfo);
  const [command, setCommand] = useState<AdminCommandStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  // 游标分页没有页码，只有「上一页用的是哪个游标」。这条轨迹就是 Pagination 的第 N 页。
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
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

  // SPEC: 导出当前筛选下的完整结果集（有上限），不是屏幕上这一页。
  async function exportCsv() {
    setExporting(true);
    setExportNote(null);
    try {
      const collected: AuditRecord[] = [];
      let cursor = "";
      let truncated = false;
      for (let page = 0; page < EXPORT_MAX_PAGES; page += 1) {
        const response = await apiGet<AuditListResponse>(
          auditListPath({ ...query, cursor, limit: EXPORT_PAGE_SIZE }),
        );
        collected.push(...response.items);
        const next = response.pageInfo ?? emptyPageInfo;
        if (!next.hasNextPage || !next.endCursor) break;
        cursor = next.endCursor;
        truncated = page === EXPORT_MAX_PAGES - 1;
      }
      downloadCsv(csvFilename("audit-log"), toCsv(AUDIT_CSV_COLUMNS, collected));
      setExportNote(truncated
        ? t("Exported the first {count} rows", { count: collected.length })
        : t("Exported {count} rows", { count: collected.length }));
    } catch (cause) {
      setExportNote(cause instanceof Error ? cause.message : t("Export failed"));
    } finally {
      setExporting(false);
    }
  }

  const filtered = isAuditQueryFiltered(query);
  const chips: FilterChip[] = changedAuditFilters(query).map((filter) => ({
    key: filter.key,
    label: t(FILTER_LABELS[filter.key]),
    value: filter.value,
    onClear: () => applyQuery({ ...query, ...filter.reset, cursor: "" }),
  }));

  const collapsed = collapseAuditRuns(records ?? []);
  const shown = collapseRepeats ? collapsed.visible : (records ?? []);
  const rows: DataTableRow[] = shown.map((row, index) => ({
    id: auditRowId(row, index),
    cells: [
      <CopyableId key="id" value={text(row.id)} />,
      <CopyableId key="actor" value={text(row.actorId) || "system"} />,
      text(row.actorRole) || "—",
      text(row.action) || "—",
      `${text(row.targetType) || "—"}:${text(row.targetId) || "—"}`,
      format.display(row.reason),
      dateCell(row.createdAt, format.dateTime),
    ],
  }));

  return (
    <section aria-labelledby="audit-workspace-title" className="space-y-5">
      <div id="audit-workspace-title">
        <PageHeader
          purpose={t("Trace consequential operator decisions to the actor, target, reason, request, and command evidence that produced them.")}
          title={t("Audit Log")}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-[var(--ad-text-muted)]" role="status">
          {refreshedAt ? <>{t("Refreshed")} <time dateTime={refreshedAt}>{format.time(refreshedAt)}</time></> : null}
          {exportNote ? <span className="ml-3">{exportNote}</span> : null}
          {/* 折叠了多少、以及怎么撤销，必须就写在这里 —— 悄悄少显示几行是审计日志最不能做的事。 */}
          {collapsed.hidden > 0 ? (
            <span className="ml-3">
              {collapseRepeats
                ? t("{count} repeats of the row above are hidden", { count: collapsed.hidden })
                : t("{count} rows repeat the row above", { count: collapsed.hidden })}
              <button
                className="ml-2 underline"
                // INVARIANT: 折起来的行必须同时退出勾选。DataTable 的「全选」只作用于可见行，
                //            于是"展开→勾一批→折叠"之后，「复制选中 ID」会复制到屏幕上根本
                //            看不见的行 —— 审计日志上，复制到自己没看过的 ID 是硬伤。
                onClick={() => {
                  setCollapseRepeats((value) => {
                    if (!value) {
                      const visible = new Set(collapsed.visible.map(auditRowId));
                      setSelectedRows((ids) => ids.filter((id) => visible.has(id)));
                    }
                    return !value;
                  });
                }}
                type="button"
              >
                {collapseRepeats ? t("Show every row") : t("Hide repeats")}
              </button>
            </span>
          ) : null}
        </p>
        <button
          className="inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm font-semibold disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
          disabled={exporting || loading}
          onClick={() => void exportCsv()}
          type="button"
        >
          {exporting ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Download aria-hidden className="h-4 w-4" />}
          {exporting ? t("Exporting…") : t("Export CSV")}
        </button>
      </div>

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
          rowCount={records?.length ?? 0}
        />
      ) : null}
    </section>
  );
}

// SPEC: width 说的是**文本盒**宽度，单元格左右还各有 0.75rem 内边距（compact），
//       所以真实列宽 ≈ width + 1.5rem。
// INTENT: 原来七列合计 82rem + 内边距 ≈ 1520px，比 1512 视口下的内容区（实测 1204px）宽 300 多，
//         「发生时间」被挤出可视区，而 macOS 的浮层滚动条不出现时连"还能横滚"都看不出来。
//         这里把预算压回 ~1184px：ID 三列只留够印它们真正印出来的那点内容，省下的给散文列。
/** 表格行 ID —— 勾选集合与折叠裁剪必须用同一个推法，否则裁的和勾的对不上。 */
function auditRowId(row: AuditRecord, index: number) {
  return text(row.id) || `audit-${index}`;
}

const AUDIT_HEADERS: DataTableHeader[] = [
  // CopyableId 只印 8 位 + 复制钮（实测 86px），再宽就是从「处理 / 目标 / 原因」里抢。
  { label: "Event", width: "5.5rem" },
  { label: "Actor", width: "5.5rem" },
  // 角色是枚举，中文最长三字；truncate 顺带保证它不会被压成竖排。
  { label: "Role", truncate: true, width: "3.5rem" },
  // 三列散文：钳在宽度内出省略号，完整值走 title 悬停与 CSV 导出，不许撑宽整张表。
  { label: "Action", truncate: true, width: "13rem" },
  { label: "Target", truncate: true, width: "12rem" },
  { label: "Reason", truncate: true, width: "12rem" },
  // 中文 dateStyle:medium + timeStyle:short 实测 ~142px；给足一行的量，dateCell 负责不折行。
  { label: "Occurred", width: "9.5rem" },
];

function CommandContext({ command }: { command: AdminCommandStatus }) {
  const format = useAdminFormat();
  return <DataTable caption="Command context" headers={["Command", "Type", "Target", "Execution", "Verification", "Reconciliation", "Updated"]} rows={[{ id: command.commandId, cells: [<CopyableId key="id" value={command.commandId} />, command.commandType, `${command.target.type}:${command.target.id}`, command.status, command.verificationState ?? "pending", command.needsReconciliation ? "required" : "not required", <time dateTime={command.updatedAt} key="updated">{format.dateTime(command.updatedAt)}</time>] }]} />;
}

function dateCell(value: unknown, dateTime: (value: unknown) => string) {
  const raw = text(value);
  // 时间戳换行会把行高撑成三行；这一列宁可参与横向滚动也不折行。
  return raw ? <time className="whitespace-nowrap" dateTime={raw}>{dateTime(raw)}</time> : "—";
}
