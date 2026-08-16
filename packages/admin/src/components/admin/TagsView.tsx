"use client";

// SPEC: 标签分类法治理面板（Character Management §C）—— 列表/编辑标签元数据 + 合并标签。
// INTENT: 自取数、无 props；spec §6.2 例外——2 字段实体不拆三件套，保持单页，只换 PageHeader +
// ConfirmDialog 皮（列表/行内改名/合并三块能力原样保留）。
//         接缝（在 AdminConsoleClient 注册此 View）由编排者接线。
// INVARIANTS: 写后 refetch；patchTagSchema/mergeTagsSchema（characters/tags.ts:19-42）都要求
// reason≥3——改名走 ConfirmDialog（非破坏性，confirmation 自动填充为 tag.slug，不是运营手敲）；
// 合并是破坏性操作（source 标签会被删除），走 ConfirmDialog 的 destructive.expectedName=目标标签
// label，confirmation 仍自动填充为 `${sourceId}:${targetId}`（mergeTags 要求的精确格式）。

import { useCallback, useEffect, useRef, useState } from "react";
import { GitMerge, Loader2, Pencil, RefreshCcw, Save, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
} from "@/lib/authority-state";
import { createLatestRequestGate } from "@/lib/latest-request";
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
};

const inputClass =
  "rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]";

export function TagsView() {
  const { t } = useAdminI18n();
  const [authority, setAuthority] = useState(() => createAuthorityState<TagRow[]>());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft>(emptyDraft());
  const [renaming, setRenaming] = useState(false);
  const requestGate = useRef(createLatestRequestGate());

  const load = useCallback(async () => {
    const queryKey = "/api/v2/admin/content/tags";
    const request = requestGate.current.begin();
    setAuthority((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<{ items: TagRow[] }>("/api/v2/admin/content/tags");
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

  const tags = authority.data ?? [];

  function startEdit(tag: TagRow) {
    setEditingId(tag.id);
    setDraft(toDraft(tag));
  }

  const editingTag = tags.find((tag) => tag.id === editingId) ?? null;

  const renameSpec: ConfirmSpec | null =
    renaming && editingTag
      ? {
          title: t("Save changes"),
          submitLabel: t("Save changes"),
          onSubmit: async (reason) => {
            await apiWrite(`/api/v2/admin/content/tags/${editingTag.id}`, "PATCH", {
              label: draft.label.trim(),
              category: draft.category.trim() ? draft.category.trim() : null,
              isSensitive: draft.isSensitive,
              isMutedByDefault: draft.isMutedByDefault,
              reason,
              confirmation: editingTag.slug,
            });
            setEditingId(null);
            await load();
          },
        }
      : null;

  return (
    <div className="space-y-5">
      <PageHeader
        action={
          <button
            className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
            disabled={authority.loading}
            onClick={() => void load()}
            type="button"
          >
            {authority.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            {t("Refresh")}
          </button>
        }
        purpose={t("Manage the tag vocabulary for characters.")}
        title={t("Tags")}
      />
      {authority.error ? <AuthorityRequestError message={authority.error} onRetry={() => void load()} snapshotAt={authority.data ? authority.refreshedAt : null} /> : null}

      {authority.loading && authority.data === null ? (
        <p className="text-sm text-[var(--ad-text-muted)]" role="status">{t("Loading…")}</p>
      ) : null}

      {authority.data ? <MergeSection reload={load} tags={tags} /> : null}

      {authority.data ? <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <div className="border-b border-[var(--ad-border)] px-3 py-2">
          <h2 className="text-sm font-semibold">{t("Tag taxonomy")} ({tags.length})</h2>
        </div>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{t("Tag taxonomy")}</caption>
          <thead className="border-b border-[var(--ad-border)] text-xs text-[var(--ad-text-muted)]">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">{t("slug")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("label")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("category")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("characters")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("sensitive")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("muted")}</th>
              <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">{t("Actions")}</span></th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => (
              <TagRowItem
                draft={editingId === tag.id ? draft : null}
                key={tag.id}
                onCancel={() => setEditingId(null)}
                onChangeDraft={setDraft}
                onSave={() => setRenaming(true)}
                onStartEdit={() => startEdit(tag)}
                tag={tag}
              />
            ))}
            {tags.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-[var(--ad-text-muted)]" colSpan={7}>
                  {t("No tags.")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section> : null}

      {renameSpec ? <ConfirmDialog onClose={() => setRenaming(false)} spec={renameSpec} /> : null}
    </div>
  );
}

function TagRowItem({
  draft,
  onCancel,
  onChangeDraft,
  onSave,
  onStartEdit,
  tag,
}: {
  draft: EditDraft | null;
  onCancel: () => void;
  onChangeDraft: (draft: EditDraft) => void;
  onSave: () => void;
  onStartEdit: () => void;
  tag: TagRow;
}) {
  const { t } = useAdminI18n();

  if (!draft) {
    return (
      <tr className="border-b border-[var(--ad-border)]">
        <td className="px-3 py-2 font-mono text-xs">{tag.slug}</td>
        <td className="px-3 py-2">{tag.label}</td>
        <td className="px-3 py-2 text-[var(--ad-text-muted)]">{tag.category ?? "—"}</td>
        <td className="px-3 py-2">{tag.characterCount}</td>
        <td className="px-3 py-2">{tag.isSensitive ? t("yes") : t("no")}</td>
        <td className="px-3 py-2">{tag.isMutedByDefault ? t("yes") : t("no")}</td>
        <td className="px-3 py-2 text-right">
          <button
            className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs"
            onClick={onStartEdit}
            type="button"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t("Edit")}
          </button>
        </td>
      </tr>
    );
  }

  const canSave = draft.label.trim().length >= 1;

  return (
    <tr className="border-b border-[var(--ad-border)] bg-black/[0.03] align-top">
      <td className="px-3 py-2 font-mono text-xs">{tag.slug}</td>
      <td className="px-3 py-2">
        <input
          className={inputClass}
          onChange={(event) => onChangeDraft({ ...draft, label: event.target.value })}
          placeholder={t("Label")}
          value={draft.label}
        />
      </td>
      <td className="px-3 py-2">
        <input
          className={inputClass}
          onChange={(event) => onChangeDraft({ ...draft, category: event.target.value })}
          placeholder={t("Category (blank=none)")}
          value={draft.category}
        />
      </td>
      <td className="px-3 py-2">{tag.characterCount}</td>
      <td className="px-3 py-2">
        <ToggleButton
          active={draft.isSensitive}
          onClick={() => onChangeDraft({ ...draft, isSensitive: !draft.isSensitive })}
        />
      </td>
      <td className="px-3 py-2">
        <ToggleButton
          active={draft.isMutedByDefault}
          onClick={() => onChangeDraft({ ...draft, isMutedByDefault: !draft.isMutedByDefault })}
        />
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-end gap-2">
          <button
            className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs"
            onClick={onCancel}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
            {t("Cancel")}
          </button>
          <button
            className="inline-flex h-8 items-center gap-1 bg-[var(--ad-ink)] px-2 text-xs font-semibold text-white disabled:opacity-50"
            disabled={!canSave}
            onClick={onSave}
            type="button"
          >
            <Save className="h-3.5 w-3.5" />
            {t("Save changes")}
          </button>
        </div>
      </td>
    </tr>
  );
}

function MergeSection({ tags, reload }: { tags: TagRow[]; reload: () => void }) {
  const { t } = useAdminI18n();
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const sourceTag = tags.find((tag) => tag.id === sourceId) ?? null;
  const targetTag = tags.find((tag) => tag.id === targetId) ?? null;
  const canOpen = sourceId.length > 0 && targetId.length > 0 && sourceId !== targetId;

  const confirmSpec: ConfirmSpec | null =
    confirming && sourceTag && targetTag
      ? {
          title: t("Merge tags"),
          summary: t("Moves every character from {source} to {target}, then deletes {source}.", {
            source: sourceTag.slug,
            target: targetTag.slug,
          }),
          destructive: { expectedName: targetTag.label },
          submitLabel: t("Merge"),
          onSubmit: async (reason) => {
            const data = await apiWrite<{ merged: boolean; movedCount: number }>(
              "/api/v2/admin/content/tags/merge",
              "POST",
              { sourceId, targetId, reason, confirmation: `${sourceId}:${targetId}` },
            );
            setResult(t("Merged — moved {count} character link(s).", { count: data.movedCount }));
            setSourceId("");
            setTargetId("");
            await reload();
          },
        }
      : null;

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h2 className="text-sm font-semibold">{t("Merge tags")}</h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
        {t("Move every character from the source tag to the target tag, then delete the source tag.")}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <select
          aria-label={t("Source tag")}
          className={cn(inputClass, "appearance-none")}
          onChange={(event) => setSourceId(event.target.value)}
          value={sourceId}
        >
          <option value="">{t("Source tag…")}</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.slug} ({tag.characterCount})
            </option>
          ))}
        </select>
        <select
          aria-label={t("Target tag")}
          className={cn(inputClass, "appearance-none")}
          onChange={(event) => setTargetId(event.target.value)}
          value={targetId}
        >
          <option value="">{t("Target tag…")}</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.slug} ({tag.characterCount})
            </option>
          ))}
        </select>
        <button
          className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={!canOpen}
          onClick={() => setConfirming(true)}
          type="button"
        >
          <GitMerge className="h-4 w-4" />
          {t("Merge")}
        </button>
      </div>
      {sourceId && sourceId === targetId ? (
        <p className="mt-2 text-xs text-[var(--ad-red-text)]">{t("Source and target must differ.")}</p>
      ) : null}
      {result ? <p className="mt-2 text-xs text-[var(--ad-green-text)]">{result}</p> : null}
      {confirmSpec ? <ConfirmDialog onClose={() => setConfirming(false)} spec={confirmSpec} /> : null}
    </section>
  );
}

function ToggleButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { t } = useAdminI18n();

  return (
    <button
      className={cn(
        "rounded-md inline-flex h-8 min-w-[3rem] items-center justify-center border px-2 text-xs",
        active ? "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-white" : "border-[var(--ad-border)] text-[var(--ad-text-muted)]",
      )}
      onClick={onClick}
      type="button"
    >
      {active ? t("yes") : t("no")}
    </button>
  );
}

function emptyDraft(): EditDraft {
  return { label: "", category: "", isSensitive: false, isMutedByDefault: false };
}

function toDraft(tag: TagRow): EditDraft {
  return {
    label: tag.label,
    category: tag.category ?? "",
    isSensitive: tag.isSensitive,
    isMutedByDefault: tag.isMutedByDefault,
  };
}
