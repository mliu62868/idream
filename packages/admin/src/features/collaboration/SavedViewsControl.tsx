"use client";

import type { CollaborationTargetType, SavedViewQueryState } from "@idream/shared/admin";
import { Bookmark, RefreshCcw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError, adminV2Request } from "@/lib/admin-v2-api";
import {
  savedViewListSchema,
  savedViewMutationSchema,
  type SavedViewRecord,
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
  const [views, setViews] = useState<SavedViewRecord[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await adminV2Request(`/api/v2/admin/saved-views?scope=${scope}`, { schema: savedViewListSchema });
      setViews(response.items);
      const selected = response.items.find((view) => view.id === selectedId);
      if (selected) setLabel(selected.label);
      else if (selectedId) onSelectedChange(null);
    } catch (cause) {
      setError(message(cause, "Saved Views could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [onSelectedChange, scope, selectedId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const select = (id: string) => {
    const view = views.find((item) => item.id === id);
    onSelectedChange(view?.id ?? null);
    if (view) {
      setLabel(view.label);
      setNotice(`Applied ${view.label}.`);
      setError(null);
      onApply(view);
    }
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
      onSelectedChange(response.view.id);
      onApply(response.view);
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
        body: { expectedVersion: current.version, label: label.trim(), queryState: currentState },
        schema: savedViewUpdateResponseSchema,
      });
      setViews((items) => items.map((item) => item.id === response.view.id ? response.view : item));
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
  return (
    <section aria-labelledby={`${scope}-saved-views-title`} className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold" id={`${scope}-saved-views-title`}><Bookmark className="h-4 w-4" />Saved Views</h3>
          <label className="mt-2 grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Select a server view<select className={fieldClass} disabled={loading} onChange={(event) => select(event.target.value)} value={selectedId ?? ""}><option value="">{loading ? "Loading views…" : views.length === 0 ? "No saved views yet" : "Choose a saved view"}</option>{views.map((view) => <option key={view.id} value={view.id}>{view.label} · v{view.version}</option>)}</select></label>
        </div>
        <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">View label<input className={fieldClass} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Critical incidents I own" value={label} /></label>
        <div className="flex flex-wrap gap-2"><WorkspaceButton disabled={busy || label.trim().length === 0} onClick={() => void saveNew()}><Save className="h-4 w-4" />Save new</WorkspaceButton>{selected ? <WorkspaceButton disabled={busy || label.trim().length === 0} onClick={() => void updateSelected()}>Update v{selected.version}</WorkspaceButton> : null}<WorkspaceButton disabled={loading || busy} onClick={() => void load()}><RefreshCcw className="h-4 w-4" />Reload</WorkspaceButton></div>
      </div>
      <div aria-atomic="true" aria-live="polite" className="mt-2 min-h-5 text-xs">{error ? <p className="text-[var(--ad-red-text)]" role="alert">{error}</p> : notice ? <p className="text-[var(--ad-green-text)]" role="status">{notice}</p> : null}</div>
    </section>
  );
}

const savedViewUpdateResponseSchema = {
  parse(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("view" in value)) throw new Error("Saved View authority returned an invalid update response");
    const mutation = savedViewMutationSchema.parse({ view: value.view, duplicate: false });
    return { view: mutation.view };
  },
};

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
