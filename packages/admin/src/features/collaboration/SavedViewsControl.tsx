"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import {
  type CollaborationTargetType,
  type SavedViewQueryState,
} from "@idream/shared/admin";
import { Bookmark, RefreshCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { useFailureToast, useToast } from "@/components/admin/ui/Toast";
import { WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError, adminV2Request, setWorkspaceUrl } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import {
  applySavedView,
  savedViewListSchema,
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
  const [confirmRevision, setConfirmRevision] = useState(0);
  const loadRequestId = useRef(0);
  const labelEdited = useRef(false);
  const labelRevision = useRef(0);
  const stateKey = JSON.stringify(currentState);
  const context = useRef({ scope, selectedId, stateKey, onApply });
  // INVARIANT: 父工作区的应用回调还绑定当前工单；旧写回执不能恢复已离开的详情。
  const contextIsCurrent = (draftRevision?: number) => context.current.scope === scope && context.current.selectedId === selectedId && context.current.stateKey === stateKey && context.current.onApply === onApply && (draftRevision === undefined || labelRevision.current === draftRevision);

  const clearSelection = useCallback(() => {
    labelEdited.current = false;
    onSelectedChange(null);
    setLabel("");
    if (typeof window !== "undefined") {
      setWorkspaceUrl(withoutSavedViewParam(window.location.search));
    }
  }, [onSelectedChange]);

  const load = useCallback(async (preserveLabel = false) => {
    if (context.current.scope !== scope || context.current.selectedId !== selectedId) return;
    const requestId = ++loadRequestId.current;
    const isCurrent = () => requestId === loadRequestId.current && context.current.scope === scope && context.current.selectedId === selectedId;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await adminV2Request(`/api/v2/admin/saved-views?scope=${scope}`, { schema: savedViewListSchema });
      if (!isCurrent()) return;
      setViews([...response.items]);
      const selected = response.items.find((view) => view.id === selectedId);
      if (selected) { if (!preserveLabel && !labelEdited.current) setLabel(selected.label); }
      else if (selectedId) clearSelection();
      return response.items;
    } catch (cause) {
      if (isCurrent()) setLoadError(cause);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [clearSelection, scope, selectedId]);

  useEffect(() => {
    if (context.current.scope !== scope || context.current.selectedId !== selectedId) labelEdited.current = false;
    if (context.current.scope !== scope || context.current.selectedId !== selectedId || context.current.stateKey !== stateKey || context.current.onApply !== onApply) setConfirmSpec(null);
    context.current = { scope, selectedId, stateKey, onApply };
  }, [scope, selectedId, stateKey, onApply]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      loadRequestId.current += 1;
    };
  }, [load, scope, selectedId]);

  const select = (id: string) => {
    const view = views.find((item) => item.id === id);
    if (view) {
      labelEdited.current = false;
      applySavedView(view, onSelectedChange, onApply);
      setLabel(view.label);
      toast({ tone: "success", title: t("Applied saved view {label}.", { label: view.label }) });
    } else clearSelection();
  };

  const saveNew = async () => {
    if (!label.trim()) return;
    const draftRevision = labelRevision.current;
    setBusy(true);
    try {
      const response = await adminV2Operation("POST /api/v2/admin/saved-views", {
        body: { scope, label: label.trim(), queryState: currentState },
      });
      toast({ tone: "success", title: t("Saved view {label} created.", { label: response.view.label }) });
      if (!contextIsCurrent(draftRevision)) return;
      await load(true);
      if (!contextIsCurrent(draftRevision)) return;
      applySavedView(response.view, onSelectedChange, onApply);
      labelEdited.current = false;
      setLabel(response.view.label);
    } catch (cause) {
      failureToast(cause);
    } finally {
      setBusy(false);
    }
  };

  const updateSelected = async (current: SavedViewRecord, draftLabel: string, draftState: SavedViewQueryState) => {
    if (!draftLabel.trim()) return;
    const draftRevision = labelRevision.current;
    setBusy(true);
    try {
      // INTENT: manifest 声明这个操作要 if-match，此前客户端不发、服务端也不读，
      // 只有 body 里的 expectedVersion 在挡陈旧写入 —— 集成测试却是发头的，所以
      // CI 全绿而浏览器里没人发现。走 operation id 之后 if-match 是编译期必填。
      const response = await adminV2Operation("PATCH /api/v2/admin/saved-views/:id", {
        path: { id: current.id },
        ifMatch: current.version,
        body: { expectedVersion: current.version, label: draftLabel.trim(), queryState: draftState },
      });
      toast({ tone: "success", title: t("Saved view {label} updated.", { label: response.view.label }) });
      if (!contextIsCurrent(draftRevision)) return;
      setViews((items) => items.map((item) => item.id === response.view.id ? response.view : item));
      applySavedView(response.view, onSelectedChange, onApply);
      labelEdited.current = false;
      setLabel(response.view.label);
    } catch (cause) {
      // INVARIANT: 冲突后仍需明确确认读回的版本；草稿不能被服务端标签覆盖，
      // 下一次提交也不能继续使用原确认框闭包里的旧版本。
      if (cause instanceof AdminV2RequestError && cause.status === 409 && contextIsCurrent(draftRevision)) {
        const freshViews = await load(true);
        const fresh = freshViews?.find((view) => view.id === current.id);
        if (fresh && contextIsCurrent(draftRevision)) {
          confirmUpdate(fresh, draftLabel, draftState);
          failureToast(cause);
        }
      }
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  // SPEC: 覆盖当前操作者的已保存视图前必须确认，其他操作者的私有记录不受影响。
  // INTENT: 后端只存当前 queryState，没有版本历史，覆盖确实不可恢复；按 ConfirmSpec 的约定，
  //         reversible:false 就得配确认串，不能只靠点一下。敲的是当前存着的那个名字
  //         （弹窗 placeholder 里写着），跟同一个 scope 里的删除流程用同一套口径。
  // 后端 PATCH 契约没有 reason 字段，所以 requireReason=false —— 不让运营填一个会被丢弃的原因。
  const confirmUpdate = (current: SavedViewRecord, draftLabel = label, draftState = currentState) => {
    // INVARIANT: 新版本需要重新键入确认，不能沿用旧版本已填写的名称。
    setConfirmRevision((revision) => revision + 1);
    setConfirmSpec({
      title: t("Overwrite Saved View"),
      consequence: {
        effect: t("Your saved view {label} will use this query. Its stored v{version} query is replaced and cannot be recovered.", { label: current.label, version: current.version }),
        reversible: false,
      },
      destructive: { expectedName: current.label, inputLabel: t("Saved view name") },
      requireReason: false,
      submitLabel: t("Overwrite"),
      onSubmit: () => updateSelected(current, draftLabel, draftState),
    });
  };

  // SPEC: 删除走确认框并要求敲出视图名 —— 和 Support 的删除同一套口径。
  // INTENT: 这个控件此前只有「保存 / 覆盖」，攒下来的视图删不掉，于是下拉框只会越来越长；
  //         而同一份契约里 DELETE 一直是完整可用的，缺的只是这个入口。本文件自己的注释
  //         （confirmUpdate 上方）早就写着「跟同一个 scope 里的删除流程用同一套口径」，
  //         指的就是这条当时还不存在的流程。
  const confirmDelete = (view: SavedViewRecord) => {
    setConfirmRevision((revision) => revision + 1);
    setConfirmSpec({
      title: t("Delete saved view {label}", { label: view.label }),
      destructive: { expectedName: view.label, inputLabel: t("Saved view name") },
      consequence: {
        effect: t("Your saved view is deleted. There is no recycle bin."),
        reversible: false,
      },
      // 后端 DELETE 契约没有 reason 字段。
      requireReason: false,
      submitLabel: t("Delete saved view"),
      onSubmit: async () => {
        await adminV2Operation("DELETE /api/v2/admin/saved-views/:id", {
          path: { id: view.id },
          ifMatch: view.version,
        });
        toast({ tone: "success", title: t("Saved view {label} deleted", { label: view.label }) });
        if (!contextIsCurrent()) return;
        setViews((items) => items.filter((item) => item.id !== view.id));
        // 删掉的正好是当前选中的那个，就把选择和 URL 参数一起清干净 —— 留着会让
        // 下一次 load() 拿不到它、再走一遍 clearSelection，中间那一帧标签还是旧的。
        if (view.id === selectedId) clearSelection();
      },
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
          <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("View label")}<input className={fieldClass} maxLength={80} onChange={(event) => { labelEdited.current = true; labelRevision.current += 1; setLabel(event.target.value); }} placeholder={t("e.g. Critical incidents I own")} value={label} /></label>
          <div className="flex flex-wrap gap-2"><WorkspaceButton disabled={busy || label.trim().length === 0} onClick={() => void saveNew()}><Save className="h-4 w-4" />{t("Save new")}</WorkspaceButton>{selected ? <WorkspaceButton aria-label={t("Overwrite saved view {label} (v{version})", { label: selected.label, version: selected.version })} disabled={busy || label.trim().length === 0} onClick={() => confirmUpdate(selected)}>{t("Overwrite v")}{selected.version}</WorkspaceButton> : null}{selected ? <WorkspaceButton aria-label={t("Delete saved view {label}", { label: selected.label })} disabled={busy} onClick={() => confirmDelete(selected)}><Trash2 className="h-4 w-4" />{t("Delete")}</WorkspaceButton> : null}<WorkspaceButton disabled={loading || busy} onClick={() => void load()}><RefreshCcw className="h-4 w-4" />{t("Reload")}</WorkspaceButton></div>
        </div>
        {loadError ? (
          <div className="mt-2">
            <AuthorityRequestError cause={loadError} message="Saved Views could not be loaded" onRetry={() => void load()} />
          </div>
        ) : null}
      </div>
      {confirmSpec ? <ConfirmDialog key={confirmRevision} onClose={() => setConfirmSpec((current) => current === confirmSpec ? null : current)} spec={confirmSpec} /> : null}
    </details>
  );
}
