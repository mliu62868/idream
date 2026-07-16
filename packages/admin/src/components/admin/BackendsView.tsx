"use client";

// SPEC: 只读展示 generation backends（comfyui + sdcpp + drawthings）目录 —— kind、endpoint/cliPath、
//       健康探测结果（ok + latencyMs，或 fail + detail）。用 ReadonlyOpsView 表格渲染，
//       与 jobs/dead-letter 运维页一致；不健康行用 FailureReason 出人话，endpoint/cliPath
//       折进 EngineeringDetails，不裸露成表格列。
// INTENT: 零 props、自取数，纯展示 + 手动刷新，无写操作。
// INVARIANTS: 健康探测由后端每次请求时实时探测（无客户端缓存/轮询）；只有手动点击
//             Refresh 才会重新拉取。

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, Loader2, RefreshCcw } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import { FailureReason } from "@/components/admin/generation/FailureReason";
import { ReadonlyOpsView, type OpsColumn } from "@/components/admin/generation/ReadonlyOpsView";
import { useAdminI18n } from "@/components/admin/i18n";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
} from "@/lib/authority-state";
import { createLatestRequestGate } from "@/lib/latest-request";
import { cn } from "@/lib/utils";

type BackendHealth = { ok: boolean; detail?: string; latencyMs?: number };

type BackendItem = {
  id: string;
  kind: string;
  endpoint?: string;
  cliPath?: string;
  modelsDir?: string;
  health: BackendHealth;
};

// Rows handed to ReadonlyOpsView are always this component's own `backends` state (cast at the
// call site below, since Record<string, unknown>[] has no structural relation to BackendItem[]).
// Narrow back to BackendItem here for typed access inside cell renders.
function asBackend(row: Record<string, unknown>): BackendItem {
  return row as unknown as BackendItem;
}

export function BackendsView() {
  const { t } = useAdminI18n();
  const [authority, setAuthority] = useState(() => createAuthorityState<BackendItem[]>());
  const requestGate = useRef(createLatestRequestGate());

  const load = useCallback(async () => {
    const queryKey = "/api/v1/admin/generation/backends";
    const request = requestGate.current.begin();
    setAuthority((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<{ items: BackendItem[] }>("/api/v1/admin/generation/backends");
      if (!request.isCurrent()) return;
      setAuthority(authorityRequestSucceeded(queryKey, data.items));
    } catch (err) {
      if (!request.isCurrent()) return;
      setAuthority((current) => authorityRequestFailed(
        current,
        queryKey,
        err instanceof Error ? err.message : "Load failed",
      ));
    }
  }, []);

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

  const backends = authority.data ?? [];

  const columns: OpsColumn[] = [
    {
      key: "id",
      label: "Backend",
      render: (row) => {
        const backend = asBackend(row);
        const hasConfig = Boolean(backend.endpoint || backend.cliPath || backend.modelsDir);
        return (
          <div className="space-y-1.5">
            <span className="font-mono text-sm font-semibold">{backend.id}</span>
            {hasConfig ? (
              <EngineeringDetails summary={t("Connection details")}>
                <div className="space-y-1">
                  {backend.endpoint ? (
                    <div>
                      {t("Endpoint")}: {backend.endpoint}
                    </div>
                  ) : null}
                  {backend.cliPath ? (
                    <div>
                      {t("CLI Path")}: {backend.cliPath}
                    </div>
                  ) : null}
                  {backend.modelsDir ? (
                    <div>
                      {t("Models directory")}: {backend.modelsDir}
                    </div>
                  ) : null}
                </div>
              </EngineeringDetails>
            ) : null}
          </div>
        );
      },
    },
    { key: "kind", label: "Kind" },
    {
      key: "health",
      label: "Health",
      render: (row) => {
        const backend = asBackend(row);
        return (
          <div className="flex items-center gap-2">
            <HealthBadge health={backend.health} />
            {typeof backend.health.latencyMs === "number" ? (
              <span className="font-mono text-xs text-[var(--ad-text-muted)]">{backend.health.latencyMs}ms</span>
            ) : null}
          </div>
        );
      },
    },
    {
      key: "failure",
      label: "Failure reason",
      render: (row) => {
        const backend = asBackend(row);
        return !backend.health.ok ? (
          <FailureReason code="backend_unreachable" detail={backend.health.detail} />
        ) : (
          <span className="text-[var(--ad-text-muted)]">—</span>
        );
      },
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
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
      {authority.error ? <AuthorityRequestError message={authority.error} onRetry={() => void load()} /> : null}

      {authority.loading && authority.data === null ? (
        <p className="text-sm text-[var(--ad-text-muted)]" role="status">{t("Loading…")}</p>
      ) : null}

      {authority.data ? <ReadonlyOpsView
        columns={columns}
        empty={t("No backends.")}
        rows={backends as unknown as Record<string, unknown>[]}
        title="Backends"
      /> : null}
    </div>
  );
}

function HealthBadge({ health }: { health: BackendHealth }) {
  const { t } = useAdminI18n();

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium",
        health.ok ? "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]" : "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
      )}
    >
      {health.ok ? <CircleCheck className="h-3.5 w-3.5" /> : <CircleX className="h-3.5 w-3.5" />}
      {health.ok ? t("ok") : t("fail")}
    </span>
  );
}
