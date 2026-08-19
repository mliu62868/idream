"use client";

// SPEC: 只读展示 workflow 描述符目录（Generation Ops）—— workflowKey/modelId/backendKind/
//       version/capabilities + 槽位；槽位（key/type/target/default）折进 EngineeringDetails。
// INTENT: 零 props、自取数。这是工程排查视图——运营的"选图填槽"操作发生在 Profile 编辑
//         （Task 7），此处只读，不做任何写操作/reason/confirmation。
// WHY(不再整行展开): 原来是 <tr tabIndex={0} onClick> 自带一个 colSpan 详情行。<tr> 上没有任何
//   ARIA 能表达"整行可展开"，读屏念到那个 Tab 停靠点时什么都不说；而 DataTable 也接不下
//   colSpan 详情行。槽位改用 EngineeringDetails（原生 <details>，语义现成），展开态归浏览器管，
//   expandedKey 这一份状态连同它的单选不变式一起删掉。
// WHY(槽位不再是表): 槽位挤在一个表格单元格里，四列会被压成没法读的窄条。改成每槽一行
//   `key · type → target`（EngineeringDetails 本来就是等宽字体），比一张挤扁的表好读。

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCcw } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { useAdminI18n } from "@/components/admin/i18n";
import { requestErrorMessage } from "@/components/admin/section-kit";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
} from "@/lib/authority-state";
import { createLatestRequestGate } from "@/lib/latest-request";

type WorkflowSlotTarget = { nodeId: string; field: string } | { argFlag: string };

type WorkflowSlot = {
  key: string;
  type: "text" | "int" | "float" | "image";
  target: WorkflowSlotTarget;
  default?: string | number;
};

type WorkflowRow = {
  workflowKey: string;
  modelId: string;
  backendKind: string;
  version: number;
  capabilities: string[];
  inputs: WorkflowSlot[];
};

export function WorkflowsView() {
  const { t } = useAdminI18n();
  const [authority, setAuthority] = useState(() => createAuthorityState<WorkflowRow[]>());
  const requestGate = useRef(createLatestRequestGate());

  const load = useCallback(async () => {
    const queryKey = "/api/v2/admin/generation/workflows";
    const request = requestGate.current.begin();
    setAuthority((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<{ items: WorkflowRow[] }>("/api/v2/admin/generation/workflows");
      if (!request.isCurrent()) return;
      setAuthority(authorityRequestSucceeded(queryKey, data.items));
    } catch (err) {
      if (!request.isCurrent()) return;
      setAuthority((current) => authorityRequestFailed(
        current,
        queryKey,
        requestErrorMessage(err, t),
        err,
      ));
    }
  }, [t]);

  useEffect(() => {
    const gate = requestGate.current;
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
    };
  }, [load]);

  const workflows = authority.data ?? [];
  const rows: DataTableRow[] = workflows.map((workflow) => ({
    id: workflow.workflowKey,
    cells: [
      <span className="font-mono text-xs" key="key">{workflow.workflowKey}</span>,
      <span className="font-mono text-xs text-[var(--ad-text-muted)]" key="model">{workflow.modelId}</span>,
      <KindBadge key="backend" kind={workflow.backendKind} />,
      workflow.version,
      <div className="flex flex-wrap gap-1" key="capabilities">
        {workflow.capabilities.map((capability) => (
          <span
            className="inline-flex items-center rounded border border-[var(--ad-border)] bg-black/[0.03] px-2 py-0.5 text-[11px] text-[var(--ad-text-muted)]"
            key={capability}
          >
            {capability}
          </span>
        ))}
      </div>,
      <SlotList key="slots" slots={workflow.inputs} />,
    ],
  }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {t("Workflows")}{authority.data ? ` (${workflows.length})` : ""}
        </h2>
        <button
          className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
          disabled={authority.loading}
          onClick={() => void load()}
          type="button"
        >
          {authority.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          {t("Refresh")}
        </button>
      </div>
      {authority.error ? <AuthorityRequestError cause={authority.cause} message={authority.error} onRetry={() => void load()} snapshotAt={authority.data ? authority.refreshedAt : null} /> : null}

      {authority.error && authority.data === null ? null : (
        <DataTable
          caption="Generation workflows"
          empty={<EmptyState hint={t("Workflow descriptors are published by the generation backends.")} title={t("No workflows.")} />}
          headers={[
            { label: t("Workflow"), width: "16rem" },
            { label: t("Model"), width: "14rem" },
            t("Backend"),
            { label: t("Version"), align: "right" },
            t("Capabilities"),
            { label: t("Slots"), width: "20rem" },
          ]}
          loading={authority.loading}
          rows={rows}
        />
      )}
    </div>
  );
}

// SPEC: 槽位默认折起来 —— 目录页要能一眼扫完 workflowKey / model / backend，槽位是排查时才展开的细节。
function SlotList({ slots }: { slots: WorkflowSlot[] }) {
  const { t } = useAdminI18n();

  if (slots.length === 0) {
    return <span className="text-xs text-[var(--ad-text-muted)]">{t("No slots.")}</span>;
  }

  return (
    <EngineeringDetails summary={t("{count} input slots", { count: slots.length })}>
      <ul className="space-y-1">
        {slots.map((slot) => (
          <li key={slot.key}>
            {slot.key} · {slot.type} → {formatSlotTarget(slot.target)}
            {slot.default === undefined ? null : ` (${t("Default")}: ${slot.default})`}
          </li>
        ))}
      </ul>
    </EngineeringDetails>
  );
}

function formatSlotTarget(target: WorkflowSlotTarget): string {
  if ("nodeId" in target) return `${target.nodeId}.${target.field}`;
  return target.argFlag;
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center rounded border border-[var(--ad-border)] px-2 py-0.5 text-xs font-medium text-[var(--ad-text)]">
      {kind}
    </span>
  );
}
