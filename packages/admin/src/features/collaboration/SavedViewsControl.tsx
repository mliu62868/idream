"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import {
  savedViewUpdateResponseSchema,
  type CollaborationTargetType,
  type SavedViewQueryState,
} from "@idream/shared/admin";
import { Bookmark, RefreshCcw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { useFailureToast, useToast } from "@/components/admin/ui/Toast";
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
  const { toast } = useToast();
  const failureToast = useFailureToast();
  const [views, setViews] = useState<SavedViewRecord[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // SPEC: 只有「视图列表读不出来」留在控件里（它带重试）；保存 / 覆盖的成败一律走 toast。
  const [loadError, setLoadError] = useState<unknown>(null);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);

  const clearSelection = useCallback(() => {
    onSelectedChange(null);
    setLabel("");
    if (typeof window !== "undefined") {
      setWorkspaceUrl(withoutSavedViewParam(window.location.search));
    }
  }, [onSelectedChange]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await adminV2Request(`/api/v2/admin/saved-views?scope=${scope}`, { schema: savedViewListSchema });
      setViews([...response.items]);
      const selected = response.items.find((view) => view.id === selectedId);
      if (selected) setLabel(selected.label);
      else if (selectedId) clearSelection();
    } catch (cause) {
      setLoadError(cause);
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
      toast({ tone: "success", title: t("Applied saved view {label}.", { label: view.label }) });
    } else clearSelection();
  };

  const saveNew = async () => {
    if (!label.trim()) return;
    setBusy(true);
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
      toast({ tone: "success", title: t("Saved view {label} created.", { label: response.view.label }) });
    } catch (cause) {
      failureToast(cause);
    } finally {
      setBusy(false);
    }
  };

  const updateSelected = async (current: SavedViewRecord) => {
    if (!label.trim()) return;
    setBusy(true);
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
      toast({ tone: "success", title: t("Saved view {label} updated.", { label: response.view.label }) });
    } catch (cause) {
      // SPEC: 别人抢先改过就先把服务端的新版本拉回来，再把错误抛回确认框。
      // INTENT: 覆盖是在 ConfirmDialog 里发起的，异常抛回去它就地显示、不关框 ——
      //         运营敲好的标签留着，重试只差再点一次。自己吞掉的话框会关，
      //         错误落在框后面，看起来像是成功了。
      if (cause instanceof AdminV2RequestError && cause.status === 409) await load();
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  // SPEC: 覆盖已保存视图前必须确认 —— 这是共享记录，别人下次打开看到的就是你写进去的查询。
  // INTENT: 后端只存当前 queryState，没有版本历史，覆盖确实不可恢复；按 ConfirmSpec 的约定，
  //         reversible:false 就得配确认串，不能只靠点一下。敲的是当前存着的那个名字
  //         （弹窗 placeholder 里写着），跟同一个 scope 里的删除流程用同一套口径。
  // 后端 PATCH 契约没有 reason 字段，所以 requireReason=false —— 不让运营填一个会被丢弃的原因。
  const confirmUpdate = (current: SavedViewRecord) => {
    setConfirmSpec({
      title: t("Overwrite the shared Saved View"),
      consequence: {
        effect: t("Everyone using {label} sees this query the next time they open it. The stored v{version} query is replaced and cannot be recovered.", { label: current.label, version: current.version }),
        reversible: false,
      },
      destructive: { expectedName: current.label, inputLabel: t("Saved view name") },
      requireReason: false,
      submitLabel: t("Overwrite"),
      onSubmit: () => updateSelected(current),
    });
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
          <div className="flex flex-wrap gap-2"><WorkspaceButton disabled={busy || label.trim().length === 0} onClick={() => void saveNew()}><Save className="h-4 w-4" />{t("Save new")}</WorkspaceButton>{selected ? <WorkspaceButton aria-label={t("Overwrite shared view {label} (v{version})", { label: selected.label, version: selected.version })} disabled={busy || label.trim().length === 0} onClick={() => confirmUpdate(selected)}>{t("Overwrite v")}{selected.version}</WorkspaceButton> : null}<WorkspaceButton disabled={loading || busy} onClick={() => void load()}><RefreshCcw className="h-4 w-4" />{t("Reload")}</WorkspaceButton></div>
        </div>
        {loadError ? (
          <div className="mt-2">
            <AuthorityRequestError cause={loadError} message="Saved Views could not be loaded" onRetry={() => void load()} />
          </div>
        ) : null}
      </div>
      {confirmSpec ? <ConfirmDialog onClose={() => setConfirmSpec(null)} spec={confirmSpec} /> : null}
    </details>
  );
}
