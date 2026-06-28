"use client";

// SPEC: 标签分类法治理面板（Character Management §C）—— 列表/编辑标签元数据 + 合并标签。
// INTENT: 自取数、无 props；样式模仿 PromoView（边框分区 + 暗色输入 + 白底按钮）。
//         接缝（在 AdminConsoleClient 注册此 View）由编排者接线。
// INVARIANTS: 写后 refetch；编辑/合并都要求 reason≥3；合并需 confirmation==="MERGE"。

import { useEffect, useState } from "react";
import { GitMerge, Loader2, Pencil, RefreshCcw, Save, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { cn } from "@/lib/utils";

type TagRow = {
  id: string;
  slug: string;
  label: string;
  category: string | null;
  isSensitive: boolean;
  isMutedByDefault: boolean;
  characterCount: number;
};

type EditDraft = {
  label: string;
  category: string;
  isSensitive: boolean;
  isMutedByDefault: boolean;
  reason: string;
};

const inputClass =
  "h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30";

export function TagsView() {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: TagRow[] }>("/api/v1/admin/content/tags");
      setTags(data.items);
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
        <h2 className="text-sm font-semibold">Tag taxonomy ({tags.length})</h2>
        <button
          className="inline-flex h-9 items-center gap-2 border border-white/10 px-3 text-sm disabled:opacity-50"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          Refresh
        </button>
      </div>
      {error ? <p className="text-xs text-red-300">{error}</p> : null}

      <MergeSection tags={tags} reload={load} />

      <section className="border border-white/10 bg-[rgb(18,18,18)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs text-[rgb(170,170,170)]">
            <tr>
              <th className="px-3 py-2 font-medium">slug</th>
              <th className="px-3 py-2 font-medium">label</th>
              <th className="px-3 py-2 font-medium">category</th>
              <th className="px-3 py-2 font-medium">characters</th>
              <th className="px-3 py-2 font-medium">sensitive</th>
              <th className="px-3 py-2 font-medium">muted</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => (
              <TagRowItem key={tag.id} reload={load} tag={tag} />
            ))}
            {tags.length === 0 && !loading ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-[rgb(170,170,170)]" colSpan={7}>
                  No tags.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function TagRowItem({ tag, reload }: { tag: TagRow; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(() => toDraft(tag));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function startEdit() {
    setDraft(toDraft(tag));
    setErr(null);
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await apiWrite(`/api/v1/admin/content/tags/${tag.id}`, "PATCH", {
        label: draft.label.trim(),
        category: draft.category.trim() ? draft.category.trim() : null,
        isSensitive: draft.isSensitive,
        isMutedByDefault: draft.isMutedByDefault,
        reason: draft.reason.trim(),
      });
      setEditing(false);
      reload();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <tr className="border-b border-white/5">
        <td className="px-3 py-2 font-mono text-xs">{tag.slug}</td>
        <td className="px-3 py-2">{tag.label}</td>
        <td className="px-3 py-2 text-[rgb(170,170,170)]">{tag.category ?? "—"}</td>
        <td className="px-3 py-2">{tag.characterCount}</td>
        <td className="px-3 py-2">{tag.isSensitive ? "yes" : "no"}</td>
        <td className="px-3 py-2">{tag.isMutedByDefault ? "yes" : "no"}</td>
        <td className="px-3 py-2 text-right">
          <button
            className="inline-flex h-8 items-center gap-1 border border-white/10 px-2 text-xs"
            onClick={startEdit}
            type="button"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-white/5 bg-black/20 align-top">
      <td className="px-3 py-2 font-mono text-xs">{tag.slug}</td>
      <td className="px-3 py-2">
        <input
          className={inputClass}
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          placeholder="Label"
          value={draft.label}
        />
      </td>
      <td className="px-3 py-2">
        <input
          className={inputClass}
          onChange={(event) => setDraft({ ...draft, category: event.target.value })}
          placeholder="Category (blank=none)"
          value={draft.category}
        />
      </td>
      <td className="px-3 py-2">{tag.characterCount}</td>
      <td className="px-3 py-2">
        <ToggleButton
          active={draft.isSensitive}
          onClick={() => setDraft({ ...draft, isSensitive: !draft.isSensitive })}
        />
      </td>
      <td className="px-3 py-2">
        <ToggleButton
          active={draft.isMutedByDefault}
          onClick={() => setDraft({ ...draft, isMutedByDefault: !draft.isMutedByDefault })}
        />
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col items-stretch gap-2">
          <input
            className={inputClass}
            onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
            placeholder="Reason (≥3)"
            value={draft.reason}
          />
          <div className="flex justify-end gap-2">
            <button
              className="inline-flex h-8 items-center gap-1 bg-white px-2 text-xs font-semibold text-black disabled:opacity-50"
              disabled={busy || draft.label.trim().length < 1 || draft.reason.trim().length < 3}
              onClick={() => void save()}
              type="button"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
            <button
              className="inline-flex h-8 items-center gap-1 border border-white/10 px-2 text-xs"
              disabled={busy}
              onClick={() => setEditing(false)}
              type="button"
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </button>
          </div>
          {err ? <p className="text-xs text-red-300">{err}</p> : null}
        </div>
      </td>
    </tr>
  );
}

function MergeSection({ tags, reload }: { tags: TagRow[]; reload: () => void }) {
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function merge() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const data = await apiWrite<{ merged: boolean; movedCount: number }>(
        "/api/v1/admin/content/tags/merge",
        "POST",
        {
          sourceId,
          targetId,
          reason: reason.trim(),
          confirmation: confirmation.trim(),
        },
      );
      setResult(`Merged — moved ${data.movedCount} character link(s).`);
      setSourceId("");
      setTargetId("");
      setReason("");
      setConfirmation("");
      reload();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Merge failed");
    } finally {
      setBusy(false);
    }
  }

  const canMerge =
    !busy &&
    sourceId.length > 0 &&
    targetId.length > 0 &&
    sourceId !== targetId &&
    reason.trim().length >= 3 &&
    confirmation.trim() === "MERGE";

  return (
    <section className="border border-white/10 bg-[rgb(18,18,18)] p-4">
      <h2 className="text-sm font-semibold">Merge tags</h2>
      <p className="mt-1 text-xs text-[rgb(170,170,170)]">
        把 source 标签的角色全部迁到 target，并删除 source。输入 confirmation 为 MERGE 以确认。
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-5">
        <select
          className={cn(inputClass, "appearance-none")}
          onChange={(event) => setSourceId(event.target.value)}
          value={sourceId}
        >
          <option value="">Source tag…</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.slug} ({tag.characterCount})
            </option>
          ))}
        </select>
        <select
          className={cn(inputClass, "appearance-none")}
          onChange={(event) => setTargetId(event.target.value)}
          value={targetId}
        >
          <option value="">Target tag…</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.slug} ({tag.characterCount})
            </option>
          ))}
        </select>
        <input
          className={inputClass}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason (≥3)"
          value={reason}
        />
        <input
          className={cn(inputClass, "font-mono")}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder="Type MERGE"
          value={confirmation}
        />
        <button
          className="inline-flex h-10 items-center gap-2 bg-white px-3 text-sm font-semibold text-black disabled:opacity-50"
          disabled={!canMerge}
          onClick={() => void merge()}
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
          Merge
        </button>
      </div>
      {sourceId && sourceId === targetId ? (
        <p className="mt-2 text-xs text-red-300">Source and target must differ.</p>
      ) : null}
      {err ? <p className="mt-2 text-xs text-red-300">{err}</p> : null}
      {result ? <p className="mt-2 text-xs text-emerald-300">{result}</p> : null}
    </section>
  );
}

function ToggleButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        "inline-flex h-8 min-w-[3rem] items-center justify-center border px-2 text-xs",
        active ? "border-white/30 bg-white text-black" : "border-white/10 text-[rgb(170,170,170)]",
      )}
      onClick={onClick}
      type="button"
    >
      {active ? "yes" : "no"}
    </button>
  );
}

function toDraft(tag: TagRow): EditDraft {
  return {
    label: tag.label,
    category: tag.category ?? "",
    isSensitive: tag.isSensitive,
    isMutedByDefault: tag.isMutedByDefault,
    reason: "",
  };
}
