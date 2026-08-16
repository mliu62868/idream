"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import {
  savedViewUpdateResponseSchema,
  type CollaborationTargetType,
  type SavedViewQueryState,
} from "@idream/shared/admin";
import { Bookmark, RefreshCcw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError, adminV2Request, setWorkspaceUrl } from "@/lib/admin-v2-api";
import {
  applySavedView,
  savedViewListSchema,
  savedViewMutationSchema,
  type SavedViewRecord,
  withoutSavedViewParam,
} from "./saved-views";

export function SavedViewsControl({
  scope,
  currentState,
  selectedId,
  onApply,
  onSelectedChange,
}: {
  scope: Extract<CollaborationTargetType, "case" | "incident">;
  currentState: SavedViewQueryState;
  selectedId: string | null;
  onApply: (view: SavedViewRecord) => void;
  onSelectedChange: (id: string | null) => void;
}) {
  const { t } = useAdminI18n();
  const [views, setViews] = useState<SavedViewRecord[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const clearSelection = useCallback(() => {
    onSelectedChange(null);
    setLabel("");
    setNotice(null);
    if (typeof window !== "undefined") {
      setWorkspaceUrl(withoutSavedViewParam(window.location.search));
    }
  }, [onSelectedChange]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await adminV2Request(`/api/v2/admin/saved-views?scope=${scope}`, { schema: savedViewListSchema });
      setViews([...response.items]);
      const selected = response.items.find((view) => view.id === selectedId);
      if (selected) setLabel(selected.label);
      else if (selectedId) clearSelection();
    } catch (cause) {
      setError(message(cause, "Saved Views could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [clearSelection, scope, selectedId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const select = (id: string) => {
    const view = views.find((item) => item.id === id);
    if (view) {
      applySavedView(view, onSelectedChange, onApply);
      setLabel(view.label);
      setNotice(`Applied ${view.label}.`);
      setError(null);
    } else clearSelection();
  };

  const saveNew = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminV2Request(`/api/v2/admin/saved-views`, {
        method: "POST",
        idempotencyKey: crypto.randomUUID(),
        body: { scope, label: label.trim(), queryState: currentState },
        schema: savedViewMutationSchema,
      });
      await load();
      applySavedView(response.view, onSelectedChange, onApply);
      setLabel(response.view.label);
      setNotice(`Saved ${response.view.label}.`);
    } catch (cause) {
      setError(message(cause, "Current view could not be saved"));
    } finally {
      setBusy(false);
    }
  };

  const updateSelected = async () => {
    const current = views.find((view) => view.id === selectedId);
    if (!current || !label.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminV2Request(`/api/v2/admin/saved-views/${encodeURIComponent(current.id)}`, {
        method: "PATCH",
        // INTENT: manifest 声明这个操作要 if-match，此前客户端不发、服务端也不读，
        // 只有 body 里的 expectedVersion 在挡陈旧写入 —— 集成测试却是发头的，所以
        // CI 全绿而浏览器里没人发现。先补齐客户端，服务端的 transport 断言才能打开。
        ifMatch: current.version,
        body: { expectedVersion: current.version, label: label.trim(), queryState: currentState },
        schema: savedViewUpdateResponseSchema,
      });
      setViews((items) => items.map((item) => item.id === response.view.id ? response.view : item));
      applySavedView(response.view, onSelectedChange, onApply);
      setNotice(`Updated ${response.view.label}.`);
    } catch (cause) {
      if (cause instanceof AdminV2RequestError && cause.status === 409) {
        await load();
        setError("Saved View changed on the server. Your local query was not written; reload before retrying.");
      } else {
        setError(message(cause, "Saved View could not be updated"));
      }
    } finally {
      setBusy(false);
    }
  };

  const selected = views.find((view) => view.id === selectedId) ?? null;
  // SPEC: 有存好的视图才默认展开。
  // INTENT: 这块面板过去恒定展开，于是队列页第一屏被一张写着「No saved views yet」的空卡
  //         顶掉——在 1512×808 上，Cases 打开时一条工单都看不见。它是每周用一次的工具，
  //         不该跟每天要读的队列抢首屏。
  return (
    <details className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]" open={views.length > 0}>
      <summary aria-labelledby={`${scope}-saved-views-title`} className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-semibold">
        <Bookmark className="h-4 w-4" />
        <span id={`${scope}-saved-views-title`}>{t("Saved Views")}</span>
        <span className="text-xs font-normal text-[var(--ad-text-muted)]">
          {loading ? t("Loading views…") : views.length === 0 ? t("No saved views yet") : `${views.length}`}
        </span>
      </summary>
      <div className="border-t border-[var(--ad-border)] p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Select a server view")}<select className={fieldClass} disabled={loading} onChange={(event) => select(event.target.value)} value={selectedId ?? ""}><option value="">{loading ? t("Loading views…") : views.length === 0 ? t("No saved views yet") : t("Choose a saved view")}</option>{views.map((view) => <option key={view.id} value={view.id}>{view.label} · v{view.version}</option>)}</select></label>
          <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("View label")}<input className={fieldClass} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder={t("e.g. Critical incidents I own")} value={label} /></label>
          <div className="flex flex-wrap gap-2"><WorkspaceButton disabled={busy || label.trim().length === 0} onClick={() => void saveNew()}><Save className="h-4 w-4" />{t("Save new")}</WorkspaceButton>{selected ? <WorkspaceButton disabled={busy || label.trim().length === 0} onClick={() => void updateSelected()}>{t("Update v")}{selected.version}</WorkspaceButton> : null}<WorkspaceButton disabled={loading || busy} onClick={() => void load()}><RefreshCcw className="h-4 w-4" />{t("Reload")}</WorkspaceButton></div>
        </div>
        <div aria-atomic="true" aria-live="polite" className="mt-2 min-h-5 text-xs">{error ? <p className="text-[var(--ad-red-text)]" role="alert">{error}</p> : notice ? <p className="text-[var(--ad-green-text)]" role="status">{notice}</p> : null}</div>
      </div>
    </details>
  );
}

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
