"use client";

// SPEC: 只读展示 workflow 描述符目录（Generation Ops）—— workflowKey/modelId/backendKind/
//       version/capabilities + 槽位数；点击行展开显示 inputs 槽表（key/type/target/default）。
// INTENT: 零 props、自取数，样式镜像 TagsView.tsx。这是工程排查视图——运营的"选图填槽"
//         操作发生在 Profile 编辑（Task 7），此处只读，不做任何写操作/reason/confirmation。
// INVARIANTS: 同一时间只展开一行（expandedKey 单值，非 Set）；inputs 直接渲染 API 返回的
//             槽位数组，不做二次状态管理。

import { useEffect, useState } from "react";
import { ChevronRight, Loader2, RefreshCcw } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";

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
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: WorkflowRow[] }>("/api/v1/admin/generation/workflows");
      setWorkflows(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {t("Workflows")} ({workflows.length})
        </h2>
        <button
          className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          {t("Refresh")}
        </button>
      </div>
      {error ? <p className="text-xs text-[var(--ad-red-text)]">{error}</p> : null}

      <section className="rounded-lg overflow-hidden border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--ad-border)] text-xs text-[var(--ad-text-muted)]">
            <tr>
              <th className="px-3 py-2 font-medium" />
              <th className="px-3 py-2 font-medium">{t("workflowKey")}</th>
              <th className="px-3 py-2 font-medium">{t("modelId")}</th>
              <th className="px-3 py-2 font-medium">{t("backendKind")}</th>
              <th className="px-3 py-2 font-medium">{t("version")}</th>
              <th className="px-3 py-2 font-medium">{t("capabilities")}</th>
              <th className="px-3 py-2 font-medium">{t("slots")}</th>
            </tr>
          </thead>
          <tbody>
            {workflows.map((workflow) => (
              <WorkflowRowItem
                expanded={expandedKey === workflow.workflowKey}
                key={workflow.workflowKey}
                onToggle={() =>
                  setExpandedKey((current) =>
                    current === workflow.workflowKey ? null : workflow.workflowKey,
                  )
                }
                workflow={workflow}
              />
            ))}
            {workflows.length === 0 && !loading ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-[var(--ad-text-muted)]" colSpan={7}>
                  {t("No workflows.")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function WorkflowRowItem({
  workflow,
  expanded,
  onToggle,
}: {
  workflow: WorkflowRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        aria-expanded={expanded}
        className="cursor-pointer border-b border-[var(--ad-border)] hover:bg-black/[0.04]"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        tabIndex={0}
      >
        <td className="px-3 py-2">
          <ChevronRight
            className={cn(
              "h-4 w-4 text-[var(--ad-text-muted)] transition-transform",
              expanded && "rotate-90",
            )}
          />
        </td>
        <td className="px-3 py-2 font-mono text-xs">{workflow.workflowKey}</td>
        <td className="px-3 py-2 font-mono text-xs text-[var(--ad-text-muted)]">{workflow.modelId}</td>
        <td className="px-3 py-2">
          <KindBadge kind={workflow.backendKind} />
        </td>
        <td className="px-3 py-2">{workflow.version}</td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1">
            {workflow.capabilities.map((capability) => (
              <span
                className="inline-flex items-center rounded border border-[var(--ad-border)] bg-black/[0.03] px-2 py-0.5 text-[11px] text-[var(--ad-text-muted)]"
                key={capability}
              >
                {capability}
              </span>
            ))}
          </div>
        </td>
        <td className="px-3 py-2">{workflow.inputs.length}</td>
      </tr>
      {expanded ? (
        <tr className="border-b border-[var(--ad-border)] bg-black/[0.03]">
          <td className="px-3 py-3" colSpan={7}>
            <SlotTable slots={workflow.inputs} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function SlotTable({ slots }: { slots: WorkflowSlot[] }) {
  const { t } = useAdminI18n();

  if (slots.length === 0) {
    return <p className="text-xs text-[var(--ad-text-muted)]">{t("No slots.")}</p>;
  }

  return (
    <table className="w-full text-left text-xs">
      <thead className="text-[var(--ad-text-muted)]">
        <tr>
          <th className="px-2 py-1 font-medium">{t("key")}</th>
          <th className="px-2 py-1 font-medium">{t("type")}</th>
          <th className="px-2 py-1 font-medium">{t("target")}</th>
          <th className="px-2 py-1 font-medium">{t("default")}</th>
        </tr>
      </thead>
      <tbody>
        {slots.map((slot) => (
          <tr className="border-t border-[var(--ad-border)]" key={slot.key}>
            <td className="px-2 py-1 font-mono">{slot.key}</td>
            <td className="px-2 py-1">{slot.type}</td>
            <td className="px-2 py-1 font-mono text-[var(--ad-text-muted)]">{formatSlotTarget(slot.target)}</td>
            <td className="px-2 py-1">{slot.default ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
