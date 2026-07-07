"use client";

// SPEC: 只读展示 generation backends（comfyui + sdcpp）目录 —— kind、endpoint/cliPath、
//       健康探测结果（ok + latencyMs，或 fail + detail）。
// INTENT: 零 props、自取数，样式镜像 TagsView.tsx。这是工程/运维排查视图，纯展示 + 手动
//         刷新，无写操作。
// INVARIANTS: 健康探测由后端每次请求时实时探测（无客户端缓存/轮询）；只有手动点击
//             Refresh 才会重新拉取。

import { useEffect, useState } from "react";
import { CircleCheck, CircleX, Loader2, RefreshCcw } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";

type BackendHealth = { ok: boolean; detail?: string; latencyMs?: number };

type BackendItem = {
  id: string;
  kind: string;
  endpoint?: string;
  cliPath?: string;
  health: BackendHealth;
};

export function BackendsView() {
  const { t } = useAdminI18n();
  const [backends, setBackends] = useState<BackendItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: BackendItem[] }>("/api/v1/admin/generation/backends");
      setBackends(data.items);
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
          {t("Backends")} ({backends.length})
        </h2>
        <button
          className="inline-flex h-9 items-center gap-2 border border-white/10 px-3 text-sm disabled:opacity-50"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          {t("Refresh")}
        </button>
      </div>
      {error ? <p className="text-xs text-red-300">{error}</p> : null}

      <div className="grid gap-4 md:grid-cols-2">
        {backends.map((backend) => (
          <BackendCard backend={backend} key={backend.id} />
        ))}
        {backends.length === 0 && !loading ? (
          <p className="text-xs text-[rgb(170,170,170)]">{t("No backends.")}</p>
        ) : null}
      </div>
    </div>
  );
}

function BackendCard({ backend }: { backend: BackendItem }) {
  const { t } = useAdminI18n();
  const { health } = backend;

  return (
    <section className="border border-white/10 bg-[rgb(18,18,18)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm font-semibold">{backend.id}</h3>
        <KindBadge kind={backend.kind} />
      </div>
      <dl className="mt-3 space-y-1.5 text-xs">
        {backend.endpoint ? (
          <div className="flex items-baseline gap-2">
            <dt className="shrink-0 text-[rgb(170,170,170)]">{t("Endpoint")}</dt>
            <dd className="truncate font-mono text-[rgb(230,230,230)]">{backend.endpoint}</dd>
          </div>
        ) : null}
        {backend.cliPath ? (
          <div className="flex items-baseline gap-2">
            <dt className="shrink-0 text-[rgb(170,170,170)]">{t("CLI Path")}</dt>
            <dd className="truncate font-mono text-[rgb(230,230,230)]">{backend.cliPath}</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-3 flex items-center gap-2">
        <HealthBadge health={health} />
        {typeof health.latencyMs === "number" ? (
          <span className="font-mono text-xs text-[rgb(170,170,170)]">{health.latencyMs}ms</span>
        ) : null}
      </div>
      {!health.ok && health.detail ? <p className="mt-2 text-xs text-red-300">{health.detail}</p> : null}
    </section>
  );
}

function HealthBadge({ health }: { health: BackendHealth }) {
  const { t } = useAdminI18n();

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium",
        health.ok ? "bg-emerald-400/10 text-emerald-300" : "bg-red-400/10 text-red-300",
      )}
    >
      {health.ok ? <CircleCheck className="h-3.5 w-3.5" /> : <CircleX className="h-3.5 w-3.5" />}
      {health.ok ? t("ok") : t("fail")}
    </span>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center rounded border border-white/10 px-2 py-0.5 text-xs font-medium text-[rgb(230,230,230)]">
      {kind}
    </span>
  );
}
