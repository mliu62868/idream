"use client";

// SPEC: 角色详情里的标签挂载面板 —— 从已治理的词表里勾选，整组保存。
//
// INTENT: 分类法链路此前缺最后一环。标签只能在创建时随 `legacyTagLabels` 写一次，而唯一传它的
// 入口是官方角色 CMS，那套 CMS 全仓没有前端；官方角色改 profile 还会显式拒绝改标签并让运营
// 「去 Taxonomy workspace」，但 Taxonomy 只治理词表本身（改名/合并/标敏感），挂载能力不存在。
// 结果是 22 个标签只有 2 条挂载，公开面的标签筛选没有内容可筛。挂载的正确位置是角色页——
// 运营是看着角色问「它该打什么标签」，而不是看着标签找角色。
//
// INVARIANTS: 只从服务端返回的词表里选，不在这里造标签（造词是 Taxonomy 的治理动作）；
// 保存走 content.tags.write 审计命令，confirmation 由前端按 `${characterId}:tags` 自动填充
// （运营不手敲内部 ID），reason 仍必填。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Tag as TagIcon } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { cn } from "@/lib/utils";

type TagRow = {
  id: string;
  label: string;
  category: string | null;
  isSensitive: boolean;
};

// v2 的角色详情契约把标签投影成扁平行（id/slug/label/category），不再透出 CharacterTag 关联行。
type CharacterTag = { id: string; label: string };

export function characterTagSelectionChanged(
  saved: readonly string[],
  draft: readonly string[],
) {
  if (saved.length !== draft.length) return true;
  const savedSet = new Set(saved);
  return draft.some((id) => !savedSet.has(id));
}

export function CharacterTagsPanel({
  characterId,
  canWrite,
}: {
  characterId: string;
  canWrite: boolean;
}) {
  const { t } = useAdminI18n();
  const [vocabulary, setVocabulary] = useState<TagRow[] | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [tags, character] = await Promise.all([
        apiGet<{ items: TagRow[] }>("/api/v2/admin/content/tags?limit=500"),
        apiGet<{ character: { tags: CharacterTag[] } }>(
          `/api/v2/admin/content/characters/${encodeURIComponent(characterId)}`,
        ),
      ]);
      const current = character.character.tags.map((tag) => tag.id);
      setVocabulary(tags.items);
      setSaved(current);
      setDraft(current);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Tags could not be loaded",
      );
    }
  }, [characterId]);

  // INTENT: 首轮取数排到 setTimeout(0)，与 CharacterCreateWizard / useAuthorityResource 一致 ——
  // 在 effect 体内同步 setState 会引发级联渲染，也会在 SSR 水合前就动状态。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const dirty = useMemo(
    () => saved !== null && characterTagSelectionChanged(saved, draft),
    [saved, draft],
  );

  function toggle(tagId: string) {
    setDraft((current) =>
      current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId],
    );
  }

  function save() {
    setConfirmSpec({
      title: t("Save character tags"),
      summary: (
        <p>
          {t(
            "Tags drive discovery filters on the public catalog. This replaces the character's whole tag set.",
          )}
        </p>
      ),
      reasonLabel: t("Operational reason (≥3)"),
      submitLabel: t("Save tags"),
      onSubmit: async (reason) => {
        await apiWrite(
          `/api/v2/admin/content/characters/${encodeURIComponent(characterId)}/tags`,
          "PUT",
          { tagIds: draft, reason, confirmation: `${characterId}:tags` },
          { "idempotency-key": crypto.randomUUID() },
        );
        await load();
      },
    });
  }

  return (
    <section className="mt-7">
      <div className="flex items-center justify-between gap-3">
        <h3 className="inline-flex items-center gap-2 text-sm font-semibold">
          <TagIcon aria-hidden="true" className="h-4 w-4" />
          {t("Tags")}
        </h3>
        {dirty && canWrite ? (
          <button
            className="min-h-10 text-sm font-semibold underline-offset-4 hover:underline"
            onClick={save}
            type="button"
          >
            {t("Save tags")}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="mt-3 text-xs text-[var(--ad-red-text)]" role="alert">
          {error}{" "}
          <button className="underline" onClick={() => void load()} type="button">
            {t("Retry")}
          </button>
        </p>
      ) : vocabulary === null ? (
        <p className="mt-3 inline-flex items-center gap-2 text-xs text-[var(--ad-text-muted)]" role="status">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          {t("Loading tags")}
        </p>
      ) : vocabulary.length === 0 ? (
        <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
          {t("No tags exist yet. Create them in Taxonomy first.")}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {vocabulary.map((tag) => {
            const selected = draft.includes(tag.id);
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "min-h-9 rounded-full border px-3 text-xs",
                  selected
                    ? "border-[var(--ad-ink)] bg-[var(--ad-ink)] font-semibold text-[var(--ad-surface)]"
                    : "border-[var(--ad-border)] text-[var(--ad-text-muted)]",
                  !canWrite && "cursor-not-allowed opacity-50",
                )}
                disabled={!canWrite}
                key={tag.id}
                onClick={() => toggle(tag.id)}
                type="button"
              >
                {tag.label}
                {tag.isSensitive ? (
                  <span className="ml-1.5" title={t("Sensitive")}>
                    ⚠
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      {!canWrite ? (
        <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
          {t("Read only · content.tag.write is not granted")}
        </p>
      ) : null}
      {confirmSpec ? (
        <ConfirmDialog onClose={() => setConfirmSpec(null)} spec={confirmSpec} />
      ) : null}
    </section>
  );
}
