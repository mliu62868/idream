"use client";

import {
  ArrowDown,
  ArrowUp,
  Flag,
  GripVertical,
  ImageIcon,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiGet,
  apiWrite,
} from "@/components/admin/api";
import { contentCharacterExploreListingSchema } from "@idream/shared/admin";
import { AdminText, useAdminI18n } from "@/components/admin/i18n";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination, type PageInfo } from "@/components/admin/ui/Pagination";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useFailureToast, useToast } from "@/components/admin/ui/Toast";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { useUnsavedChanges } from "@/components/admin/ui/useUnsavedChanges";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
  type AuthorityState,
} from "@/lib/authority-state";
import { createLatestRequestGate } from "@/lib/latest-request";
import { listPageFromParams, previousListPage, syncListUrl } from "@/components/admin/section-kit";
import {
  CONTENT_PAGE_SIZE,
  contentListPath,
  contentQueryFromSearch,
  contentWorkspaceUrl,
  type ContentQuery,
} from "./query";
import {
  FEATURED_MAX_CHARACTERS,
  featuredSaveBody,
  featuredVersionConflictFromError,
  moveFeaturedId,
  type FeaturedVersionConflict,
} from "./featured-save";

export { featuredVersionConflictFromError, type FeaturedVersionConflict };

type Row = Record<string, unknown>;
type CharacterResponse = { items: Row[]; pageInfo: PageInfo };
const listKeys = { cursor: "contentCursor", page: "contentPage" };
const FEATURED_SEARCH_DEBOUNCE_MS = 200;
export type FeaturedRuntimeBlocker = {
  code: string;
  message: string;
  repairDeepLink: string;
};
export type FeaturedItem = {
  id: string;
  name: string | null;
  visibility: string | null;
  status: string | null;
  thumbnailUrl: string | null;
  configuredPosition: number;
  configured: true;
  effective: boolean;
  blockers: FeaturedRuntimeBlocker[];
};
export type FeaturedSettingDiagnostic = {
  code:
    | "setting_not_object"
    | "character_ids_not_array"
    | "character_id_not_string"
    | "character_id_blank"
    | "character_id_duplicate"
    | "character_id_overflow";
  message: string;
  index?: number;
  id?: string;
};
type FeaturedResponse = {
  items: FeaturedItem[];
  characterIds: string[];
  configuredCharacterIds: string[];
  effectiveCharacterIds: string[];
  settingVersion: number;
  settingDiagnostics: FeaturedSettingDiagnostic[];
};
export type FeaturedWriteResult = {
  characterIds: string[];
  configuredCharacterIds: string[];
  effectiveCharacterIds: string[];
  settingVersion: number;
  settingDiagnostics: FeaturedSettingDiagnostic[];
  skipped: string[];
  invalid: Array<{
    id: string;
    reason: "character_not_found_or_not_configurable";
  }>;
  replayed?: boolean;
};
type FeaturedDraft = {
  ids: string[];
  baseline: { ids: string[]; version: number };
};

// 搜索结果和已保存条目共用的展示信息；只为显示，不是权威。
type FeaturedLabel = { name: string | null; thumbnailUrl: string | null };

function featuredDraftFrom(data: Pick<FeaturedResponse, "configuredCharacterIds" | "settingVersion">): FeaturedDraft {
  const ids = [...data.configuredCharacterIds];
  return { ids, baseline: { ids, version: data.settingVersion } };
}

function featuredDraftDirty(draft: FeaturedDraft | null) {
  return Boolean(draft && (
    draft.ids.length !== draft.baseline.ids.length ||
    draft.ids.some((id, index) => id !== draft.baseline.ids[index])
  ));
}

export function ContentMerchandisingWorkspace({
  canWrite,
  canCurate = false,
}: {
  /** 目录行的下架 / 可见性动作：content.takedown.write。 */
  canWrite: boolean;
  /** 精选编排：content.placement.write。 */
  canCurate?: boolean;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const format = useAdminFormat();
  const { toast } = useToast();
  const failureToast = useFailureToast();
  const [query, setQuery] = useState<ContentQuery>(() => contentQueryFromSearch(""));
  const [draft, setDraft] = useState<ContentQuery>(() => contentQueryFromSearch(""));
  const [characters, setCharacters] =
    useState(() => createAuthorityState<CharacterResponse>());
  const [featured, setFeatured] =
    useState(() => createAuthorityState<FeaturedResponse>());
  const [featuredDraft, setFeaturedDraft] = useState<FeaturedDraft | null>(null);
  const [pickedLabels, setPickedLabels] = useState<Record<string, FeaturedLabel>>({});
  const savingRef = useRef(false);
  const { guard } = useUnsavedChanges(featuredDraftDirty(featuredDraft));
  const [saveConflict, setSaveConflict] =
    useState<FeaturedVersionConflict | null>(null);
  const [saveResult, setSaveResult] = useState<FeaturedWriteResult | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const [page, setPage] = useState(1);
  const [hasPageHistory, setHasPageHistory] = useState(false);
  const characterGate = useRef(createLatestRequestGate());
  const featuredGate = useRef(createLatestRequestGate());

  const loadCharacters = useCallback(async (next: ContentQuery) => {
    const queryKey = contentListPath(next);
    const request = characterGate.current.begin();
    setCharacters((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<CharacterResponse>(queryKey);
      if (!request.isCurrent()) return;
      setCharacters(authorityRequestSucceeded(queryKey, data));
    } catch (cause) {
      if (!request.isCurrent()) return;
      setCharacters((current) => authorityRequestFailed(
        current,
        queryKey,
        errorMessage(cause, "Characters could not be loaded"),
        cause,
      ));
    }
  }, []);

  const loadFeatured = useCallback(async (
    options: { preserveInput?: boolean } = {},
  ) => {
    const queryKey = "/api/v2/admin/content/featured";
    const request = featuredGate.current.begin();
    setFeatured((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<FeaturedResponse>(queryKey);
      if (!request.isCurrent()) return;
      setFeatured(authorityRequestSucceeded(queryKey, data));
      // Read projections can advance while an operator owns a draft. Only a clean
      // editor adopts them; its original CAS remains paired with the edited copy.
      setFeaturedDraft((current) => current &&
        (options.preserveInput || savingRef.current || featuredDraftDirty(current))
        ? current : featuredDraftFrom(data));
    } catch (cause) {
      if (!request.isCurrent()) return;
      setFeatured((current) => authorityRequestFailed(
        current,
        queryKey,
        errorMessage(cause, "Featured content could not be loaded"),
        cause,
      ));
    }
  }, []);

  const load = useCallback(
    (next: ContentQuery) => {
      void loadCharacters(next);
      void loadFeatured();
    },
    [loadCharacters, loadFeatured],
  );

  useEffect(() => {
    const currentCharacterGate = characterGate.current;
    const currentFeaturedGate = featuredGate.current;
    const restore = () => {
      const next = currentQuery();
      setQuery(next);
      setDraft(next);
      const params = new URLSearchParams(contentWorkspaceUrl(window.location.pathname, window.location.search, next).split("?")[1] ?? "");
      setPage(syncListUrl(params, listPageFromParams(params, listKeys.page), listKeys));
      setHasPageHistory(previousListPage(listKeys).hasHistory);
      load(next);
    };
    restore();
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      currentCharacterGate.invalidate();
      currentFeaturedGate.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
  }, [load]);

  // Filters return to page one. Visited cursor history lives with each URL entry.
  function navigate(next: ContentQuery, nextPage = 1) {
    const href = contentWorkspaceUrl(
        window.location.pathname,
        window.location.search,
        next,
    );
    setPage(syncListUrl(new URLSearchParams(href.split("?")[1] ?? ""), nextPage, listKeys));
    setHasPageHistory(previousListPage(listKeys).hasHistory);
    setQuery(next);
    setDraft(next);
    void loadCharacters(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, cursor: "" });
  }

  async function saveFeatured() {
    if (!canCurate || !featuredDraft || savingRef.current) return;
    const submitted = featuredDraft;
    // A conflict explicitly shows the current version and list before the operator
    // retries. Ordinary refreshes never confer that approval on an older draft.
    const expectedVersion = saveConflict?.settingVersion ?? submitted.baseline.version;
    savingRef.current = true;
    setSaving(true);
    setSaveConflict(null);
    setSaveResult(null);
    try {
      const result = await apiWrite<FeaturedWriteResult>(
        "/api/v2/admin/content/featured",
        "PUT",
        featuredSaveBody(submitted.baseline.ids, submitted.ids, expectedVersion),
      );
      setSaveResult(result);
      const saved = featuredDraftFrom(result);
      setFeaturedDraft((current) => current === submitted ? saved : current
        ? { ...current, baseline: saved.baseline } : saved);
      await loadFeatured();
    } catch (cause) {
      const conflict = featuredVersionConflictFromError(cause);
      if (conflict) {
        setSaveConflict(conflict);
        await loadFeatured({ preserveInput: true });
      } else {
        failureToast(cause);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // entityVersion：官方角色改挂牌消费 Serving 乐观锁版本；不带就是必然 409。
  function command(
    id: string,
    field: "visibility" | "status",
    value: string,
    entityVersion?: number,
  ) {
    const expected = `${id}:${field}:${value}`;
    if (!canWrite) return;
    setConfirmSpec({
      title: field === "visibility"
        ? t("{action} character {id}", { action: t(contentCommandLabel(field, value)), id })
        : t("Take character {id} down", { id }),
      // SPEC: 改可见性可逆，一个普通确认框就够，原因自动填；移除仍是审核动作，保留键入和原因。
      ...(field === "visibility"
        ? { requireReason: false }
        : { destructive: { expectedName: expected, inputLabel: t("Type confirmation") } }),
      // INTENT: 改可见性还能改回来；下架（status=removed）在这个台面上没有反向入口，
      //         而且会把角色从 Featured 里一并踢掉——按不可撤回处理。
      consequence:
        field === "visibility"
          ? {
              effect: t("The character leaves the public catalog at once. Setting visibility back to public restores it."),
              reversible: true,
            }
          : {
              effect: t("The character is taken down from every public surface and drops out of Featured. This console has no command to put it back."),
              reversible: false,
            },
      submitLabel: contentCommandLabel(field, value),
      onSubmit: async (commandReason) => {
        await apiWrite(
          `/api/v2/admin/content/characters/${encodeURIComponent(id)}/${field}`,
          "POST",
          {
            [field]: value,
            ...(field === "visibility" && entityVersion !== undefined ? { entityVersion } : {}),
            reason: field === "visibility" ? contentCommandLabel(field, value) : commandReason,
            confirmation: expected,
          },
        );
        toast({
          tone: "success",
          title:
            field === "visibility"
              ? t("Character {id} is now {visibility}", { id, visibility: valueLabel(value) })
              : t("Character {id} taken down", { id }),
        });
        await loadCharacters(query);
        await loadFeatured();
      },
    });
  }

  const characterRows = (characters.data?.items ?? []).map((row) =>
    characterTableRow(row, canWrite, command, valueLabel, format.dateTime),
  );
  const featuredDraftIds = featuredDraft?.ids ?? [];
  const featuredDirty = featuredDraftDirty(featuredDraft);
  const featuredLabels: Record<string, FeaturedLabel> = {
    ...pickedLabels,
    ...Object.fromEntries((featured.data?.items ?? []).filter((item) => item.name).map((item) =>
      [item.id, { name: item.name, thumbnailUrl: item.thumbnailUrl }])),
  };
  const featuredName = (id: string) => featuredLabels[id]?.name ?? id;
  function editFeatured(ids: string[]) {
    setFeaturedDraft((current) => current ? { ...current, ids } : current);
    setSaveResult(null);
  }
  const configuredFeaturedCount =
    featured.data?.configuredCharacterIds.length ?? 0;
  const effectiveFeaturedCount =
    featured.data?.effectiveCharacterIds.length ?? 0;
  const blockedFeaturedCount =
    configuredFeaturedCount - effectiveFeaturedCount;
  return (
    <section className="space-y-5">
      {guard}
      <PageHeader
        purpose={t("Search the catalog, control visibility and lifecycle state, and curate the public featured feed.")}
        title={t("Featured Merchandising")}
      />
      <div
        className="flex flex-wrap justify-between gap-3 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        <div className="flex gap-3">
          <Freshness authority="Characters" state={characters} />
          <Freshness authority="Featured" state={featured} />
        </div>
        {!canCurate ? <PermissionNotice permission="content.placement.write" /> : null}
        {!canWrite ? <PermissionNotice permission="content.takedown.write" /> : null}
      </div>
      <form
        className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-4"
        onSubmit={apply}
      >
        <Field
          label="Search"
          onChange={(search) => setDraft((value) => ({ ...value, search }))}
          value={draft.search}
        />
        <Select
          label="Status"
          onChange={(status) => setDraft((value) => ({ ...value, status }))}
          options={[
            "",
            "draft",
            "pending_review",
            "approved",
            "rejected",
            "removed",
            "archived",
          ]}
          value={draft.status}
        />
        <Select
          label="Visibility"
          onChange={(visibility) =>
            setDraft((value) => ({ ...value, visibility }))
          }
          options={["", "private", "unlisted", "public"]}
          value={draft.visibility}
        />
        <div className="flex items-end gap-2">
          <button
            className="inline-flex h-11 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white"
            type="submit"
          >
            <Search className="h-4 w-4" />

            {t("Apply")}
          </button>
          <button
            className="inline-flex h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-4 text-sm"
            onClick={() =>
              navigate({ search: "", status: "", visibility: "", cursor: "" })
            }
            type="button"
          >
            <RotateCcw className="h-4 w-4" />

            {t("Reset")}
          </button>
        </div>
      </form>
      {featured.error ? (
        <AuthorityRequestError requestKind="read"
          cause={featured.cause}
          message={featured.error}
          onRetry={() => void loadFeatured()}
          snapshotAt={featured.data ? featured.refreshedAt : null}
        />
      ) : null}
      {featured.loading && featured.data === null ? (
        <p className="text-sm text-[var(--ad-text-muted)]" role="status">

          {t("Loading featured content…")}
        </p>
      ) : null}
      {featured.data ? <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("Featured curation")}</h2>
          <span className="font-mono text-[11px] text-[var(--ad-text-muted)]">
            {t("Configuration version")} {featured.data.settingVersion}
          </span>
        </div>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--ad-text-muted)]">
          {t(
            "This order is the saved configuration. A character is live featured only while the public audience authority also passes, including its primary image, Character Release, qualification, and Serving state.",
          )}
        </p>
        {featured.data.settingDiagnostics.length > 0 ? (
          <div
            className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]"
            role="alert"
          >
            <p className="flex items-center gap-2 font-semibold">
              <TriangleAlert className="h-4 w-4 shrink-0" />
              {t("Stored Featured configuration needs repair")}
            </p>
            <p className="mt-1">
              {t(
                "The canonical preview below is safe and de-duplicated. Save it to repair the stored configuration.",
              )}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {featured.data.settingDiagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.code}:${diagnostic.index ?? index}`}>
                  <strong>
                    {t(diagnostic.code.replaceAll("_", " "))}
                  </strong>
                  {diagnostic.id ? (
                    <>
                      {" · "}
                      <code>{diagnostic.id}</code>
                    </>
                  ) : null}
                  {diagnostic.index !== undefined ? (
                    <>
                      {" · "}
                      {t("Position")} {diagnostic.index + 1}
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <dl className="mt-3 grid gap-px overflow-hidden rounded-md border border-[var(--ad-border)] bg-[var(--ad-border)] sm:grid-cols-3">
          <FeaturedCount
            label={t("Configured")}
            value={configuredFeaturedCount}
          />
          <FeaturedCount
            label={t("Live featured")}
            tone="live"
            value={effectiveFeaturedCount}
          />
          <FeaturedCount
            label={t("Configured · not live")}
            tone={blockedFeaturedCount > 0 ? "blocked" : undefined}
            value={blockedFeaturedCount}
          />
        </dl>
        {canCurate ? (
          <FeaturedCharacterPicker
            full={featuredDraftIds.length >= FEATURED_MAX_CHARACTERS}
            onAdd={(character) => {
              setPickedLabels((current) => ({ ...current, [character.id]: character }));
              editFeatured([...featuredDraftIds, character.id]);
            }}
            selectedIds={featuredDraftIds}
          />
        ) : null}
        <FeaturedCurationList
          canEdit={canCurate}
          ids={featuredDraftIds}
          items={featured.data.items}
          labels={featuredLabels}
          onChange={editFeatured}
        />
        <FeaturedDiff
          draftIds={featuredDraftIds}
          nameOf={featuredName}
          savedIds={featured.data.configuredCharacterIds}
        />
        {canCurate ? (
          <button
            className="mt-3 inline-flex h-10 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            disabled={saving || !(featuredDirty || featured.data.settingDiagnostics.length > 0 || saveConflict)}
            onClick={() => void saveFeatured()}
            type="button"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Flag className="h-4 w-4" />
            )}
            {t("Save featured")}
          </button>
        ) : null}
        {saveConflict ? (
          <div
            className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]"
            role="alert"
          >
            <p className="font-semibold">
              {t("Another operator changed Featured before your save.")}
            </p>
            <p className="mt-1">
              {t(
                "Latest authority was refreshed. Your list is kept below; review it and save again to apply it.",
              )}
            </p>
            <p className="mt-1">
              {t("Current version")} {saveConflict.settingVersion}
              {" · "}
              {t("Currently saved")}:{" "}
              {saveConflict.configuredCharacterIds.map(featuredName).join(", ") || t("None")}
            </p>
          </div>
        ) : null}
        {saveResult ? (
          <FeaturedWriteResultNotice result={saveResult} t={t} />
        ) : null}
      </section> : null}
      {characters.error ? (
        <AuthorityRequestError requestKind="read"
          cause={characters.cause}
          message={characters.error}
          onRetry={() => void loadCharacters(query)}
          snapshotAt={characters.data ? characters.refreshedAt : null}
        />
      ) : null}
      {characters.loading && characters.data === null ? (
        <p className="text-sm text-[var(--ad-text-muted)]" role="status">

          {t("Loading characters…")}
        </p>
      ) : null}
      {characters.data ? <DataTable
        caption="Characters"
        empty={<EmptyState title={t("No characters match these filters")} />}
        // SPEC: width 是**文本盒**宽度，单元格左右还各有 1rem 内边距，真实列宽 ≈ width + 2rem；
        //       八列合计 1224px，就是下面的 minimumWidthClassName。
        // INTENT: 八列原来全传字符串、也没给最小宽度，于是角色 ID 吃掉大半，三个操作按钮各剩
        //         两个字的位置——「取消/公开/列出」「设/为/私/密」「移/除」竖排，行高被撑到三倍。
        headers={[
          { label: "ID", truncate: true, width: "10rem" },
          { label: "Name", truncate: true, width: "9rem" },
          // 四个枚举列：中文最长两字（女性 / 写实 / 私密 / 已通过三字），truncate 保证不折行。
          { label: "Gender", truncate: true, width: "3.5rem" },
          { label: "Style", truncate: true, width: "4rem" },
          // 「不公开列出」是五个汉字，4rem 会把它截成「不公开…」。
          { label: "Visibility", truncate: true, width: "5.5rem" },
          { label: "Status", truncate: true, width: "4rem" },
          { label: "Created", truncate: true, width: "9.5rem" },
          // 三个按钮（取消公开列出 / 设为私密 / 移除）连同间距实测 ~240px。
          { label: "Actions", width: "15rem" },
        ]}
        minimumWidthClassName="min-w-[1224px]"
        rows={characterRows}
      /> : null}
      {characters.data ? (
        <Pagination
          hasNext={Boolean(
            characters.data.pageInfo.hasNextPage && characters.data.pageInfo.endCursor,
          )}
          hasPrevious={Boolean(query.cursor)}
          previousLabel={query.cursor && !hasPageHistory ? t("Back to first page") : undefined}
          loading={characters.loading}
          onNext={() => {
            const endCursor = characters.data?.pageInfo.endCursor;
            if (!endCursor) return;
            navigate({ ...query, cursor: endCursor }, page + 1);
          }}
          onPrevious={() => {
            const previous = previousListPage(listKeys);
            navigate({ ...query, cursor: previous.cursor ?? "" }, previous.page);
          }}
          page={page}
          pageSize={CONTENT_PAGE_SIZE}
          rowCount={characters.data.items.length}
        />
      ) : null}
      {canWrite && confirmSpec ? (
        <ConfirmDialog
          onClose={() => setConfirmSpec(null)}
          spec={confirmSpec}
        />
      ) : null}
    </section>
  );
}

/**
 * SPEC: 保存前把「这一次到底改了什么」摆出来：加了谁、去掉了谁、有没有只是换了顺序。
 *
 * INTENT: 这是直接改首页曝光的写操作，保存前要看得出差异，而不是保存完看结果。
 * INVARIANT: 两边都是真实数据（已保存配置 vs 当前列表），不预测生效结果——
 *            某个角色加进来能不能真的上首页由 audience authority 决定，保存后那张表才知道。
 */
export function featuredDiff(savedIds: readonly string[], draftIds: readonly string[]) {
  const saved = new Set(savedIds);
  const draft = new Set(draftIds);
  const added = draftIds.filter((id) => !saved.has(id));
  const removed = savedIds.filter((id) => !draft.has(id));
  const reordered =
    added.length === 0 &&
    removed.length === 0 &&
    savedIds.some((id, index) => draftIds[index] !== id);
  return { added, removed, reordered };
}

function FeaturedDiff({
  draftIds,
  nameOf,
  savedIds,
}: {
  draftIds: readonly string[];
  nameOf: (id: string) => string;
  savedIds: readonly string[];
}) {
  const { t } = useAdminI18n();
  const { added, removed, reordered } = featuredDiff(savedIds, draftIds);
  if (added.length === 0 && removed.length === 0 && !reordered) {
    return (
      <p className="mt-3 text-xs text-[var(--ad-text-muted)]" role="status">
        {t("This matches the saved configuration. Nothing would change.")}
      </p>
    );
  }
  return (
    <dl className="mt-3 space-y-1 rounded-md bg-black/[0.04] px-3 py-2 text-xs" role="status">
      {added.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <dt className="font-semibold">{t("Adding")}</dt>
          <dd className="break-all">{added.map(nameOf).join(", ")}</dd>
        </div>
      ) : null}
      {removed.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <dt className="font-semibold">{t("Removing")}</dt>
          <dd className="break-all">{removed.map(nameOf).join(", ")}</dd>
        </div>
      ) : null}
      {reordered ? (
        <div className="flex flex-wrap gap-2">
          <dt className="font-semibold">{t("Reordering")}</dt>
          <dd>{t("Same characters, new order.")}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function Freshness<T>({
  authority,
  state,
}: {
  authority: string;
  state: AuthorityState<T>;
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  // 后缀本来就过 t()，唯独数据源名字漏了。
  const name = t(authority);
  if (state.loading) return <span>{name}{t(": refreshing")}</span>;
  if (state.error) {
    return (
      <span>
        {name}: {state.data ? t("stale") : t("unavailable")}  {t("· retry available")}
      </span>
    );
  }
  return (
    <span>
      {name}{t(": fresh")}{" "}
      {state.refreshedAt ? format.time(state.refreshedAt) : ""}
    </span>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useAdminI18n();
  return (
    <label className="grid gap-1 text-xs font-medium text-[var(--ad-text-muted)]">
      {t(label)}
      <input
        className="h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)]"
        onChange={(event) => onChange(event.target.value)}
        type="search"
        value={value}
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  // 选项是状态/可见性枚举，走 value() —— 和 StatusBadge 共用同一份译文；
  // 空选项是「全部」，走 t()。原来两者都是裸串，中文界面直接印 All / published。
  const { t, value: enumLabel } = useAdminI18n();
  return (
    <label className="grid gap-1 text-xs font-medium text-[var(--ad-text-muted)]">
      {t(label)}
      <select
        className="h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)]"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option || "all"} value={option}>
            {option === "pending_review" ? t("Awaiting publication preparation") : option ? enumLabel(option) : t("All")}
          </option>
        ))}
      </select>
    </label>
  );
}

function FeaturedCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "live" | "blocked";
}) {
  return (
    <div className="bg-[var(--ad-surface)] px-3 py-2">
      <dt className="text-[11px] font-medium text-[var(--ad-text-muted)]">
        {label}
      </dt>
      <dd
        className={
          tone === "live"
            ? "mt-0.5 text-lg font-semibold tabular-nums text-[var(--ad-green-text)]"
            : tone === "blocked"
              ? "mt-0.5 text-lg font-semibold tabular-nums text-[var(--ad-yellow-text)]"
              : "mt-0.5 text-lg font-semibold tabular-nums"
        }
      >
        {value}
      </dd>
    </div>
  );
}

export function FeaturedWriteResultNotice({
  result,
  t = (key) => key,
}: {
  result: FeaturedWriteResult;
  t?: (key: string) => string;
}) {
  const blockedCount =
    result.configuredCharacterIds.length - result.effectiveCharacterIds.length;
  const hasInvalid = result.invalid.length > 0 || result.skipped.length > 0;
  const invalidIds = result.invalid.length > 0
    ? result.invalid.map((item) => item.id)
    : result.skipped;
  return (
    <div
      className={
        hasInvalid
          ? "mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]"
          : "mt-3 rounded-md bg-[var(--ad-green-bg)] px-3 py-2 text-xs text-[var(--ad-green-text)]"
      }
      role={hasInvalid ? "alert" : "status"}
    >
      <p>
        <strong>{t("Featured configuration saved")}</strong>
        {" · "}
        {result.configuredCharacterIds.length} {t("Configured")}
        {" · "}
        {result.effectiveCharacterIds.length} {t("Live featured")}
        {" · "}
        {blockedCount} {t("Configured · not live")}
      </p>
      {hasInvalid ? (
        <p className="mt-1">
          <strong>{t("Skipped invalid character IDs")}:</strong>{" "}
          <code className="break-all">{invalidIds.join(", ")}</code>.{" "}
          {t(
            "These characters were not found or cannot be configured, so they were not saved.",
          )}
        </p>
      ) : null}
    </div>
  );
}

// SPEC: 一行精选的实际上线状态；未上线时就地说明原因并给出修复入口。
export function FeaturedRuntimeStatus({ item }: { item: FeaturedItem | undefined }) {
  const { t } = useAdminI18n();
  if (!item) {
    return <span className="text-xs text-[var(--ad-text-muted)]">{t("Not saved yet")}</span>;
  }
  if (item.effective) {
    return (
      <strong className="text-xs font-semibold text-[var(--ad-green-text)]">
        {t("Live featured")}
      </strong>
    );
  }
  return (
    <div className="text-xs">
      <strong className="font-semibold text-[var(--ad-yellow-text)]">
        {t("Configured · not live")}
      </strong>
      <ul className="mt-1 space-y-1">
        {item.blockers.map((blocker) => (
          <li key={blocker.code}>
            <span className="text-[var(--ad-text-muted)]">{t(blocker.message)}</span>{" "}
            <Link
              className="inline-flex min-h-6 items-center font-semibold underline"
              href={blocker.repairDeepLink}
            >
              {t("Resolve blocker")}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeaturedThumbnail({ url }: { url: string | null | undefined }) {
  return (
    <span className="grid h-12 w-10 shrink-0 place-items-center overflow-hidden rounded bg-black/[0.04] [&>div]:h-12 [&>div]:w-10">
      {url ? (
        <AssetImage asset={{ url, thumbnailUrl: url }} compact />
      ) : (
        <ImageIcon aria-hidden="true" className="h-4 w-4 text-[var(--ad-text-muted)]" />
      )}
    </span>
  );
}

// SPEC: 搜索角色 → 点选加入。运营永远不接触内部 ID。
function FeaturedCharacterPicker({
  full,
  onAdd,
  selectedIds,
}: {
  full: boolean;
  onAdd: (character: { id: string; name: string; thumbnailUrl: string | null }) => void;
  selectedIds: readonly string[];
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(createLatestRequestGate());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const currentGate = gate.current;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      currentGate.invalidate();
    };
  }, []);

  function change(next: string) {
    setSearch(next);
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    const term = next.trim();
    const request = gate.current.begin();
    if (!term) {
      setResults(null);
      return;
    }
    timer.current = setTimeout(() => {
      const params = new URLSearchParams({ search: term, limit: "8" });
      apiGet<CharacterResponse>(`/api/v2/admin/content/characters?${params}`).then(
        (data) => { if (request.isCurrent()) setResults(data.items); },
        (cause: unknown) => { if (request.isCurrent()) setError(errorMessage(cause, "Characters could not be loaded")); },
      );
    }, FEATURED_SEARCH_DEBOUNCE_MS);
  }

  return (
    <div className="mt-3">
      <label className="grid gap-1 text-xs font-medium text-[var(--ad-text-muted)]">
        {t("Add a character")}
        <input
          className="h-10 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)]"
          onChange={(event) => change(event.target.value)}
          placeholder={t("Search by character name")}
          type="search"
          value={search}
        />
      </label>
      {error ? <p className="mt-2 text-xs text-[var(--ad-red-text)]" role="alert">{t(error)}</p> : null}
      {full ? <p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t("Featured is full ({max})", { max: FEATURED_MAX_CHARACTERS })}</p> : null}
      {results?.length === 0 ? <p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t("No characters match these filters")}</p> : null}
      {results && results.length > 0 ? (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2" data-testid="featured-search-results">
          {results.map((row) => {
            const id = stringValue(row.id);
            const name = stringValue(row.name) || id;
            const image = isRecord(row.imageAsset) ? row.imageAsset : null;
            const thumbnailUrl = image ? stringValue(image.thumbnailUrl) || stringValue(image.url) || null : null;
            const selected = selectedIds.includes(id);
            const state = stringValue(row.servingState) || stringValue(row.status);
            return (
              <li key={id}>
                <button
                  className="flex w-full items-center gap-3 rounded-md border border-[var(--ad-border)] p-2 text-left text-sm disabled:opacity-50"
                  disabled={selected || full}
                  onClick={() => onAdd({ id, name, thumbnailUrl })}
                  type="button"
                >
                  <FeaturedThumbnail url={thumbnailUrl} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{name}</span>
                    <span className="block truncate text-xs text-[var(--ad-text-muted)]">
                      {state ? valueLabel(state) : null}
                      {typeof row.visibility === "string" ? ` · ${valueLabel(row.visibility)}` : null}
                    </span>
                  </span>
                  {selected ? (
                    <span className="text-xs text-[var(--ad-text-muted)]">{t("Added")}</span>
                  ) : (
                    <Plus aria-hidden="true" className="h-4 w-4 shrink-0" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// SPEC: 精选的唯一列表：顺序就是线上顺序，拖拽或上下按钮排序，每行说明实际上线状态。
function FeaturedCurationList({
  canEdit,
  ids,
  items,
  labels,
  onChange,
}: {
  canEdit: boolean;
  ids: readonly string[];
  items: readonly FeaturedItem[];
  labels: Readonly<Record<string, FeaturedLabel>>;
  onChange: (ids: string[]) => void;
}) {
  const { t } = useAdminI18n();
  const dragFrom = useRef<number | null>(null);
  if (ids.length === 0) {
    return <div className="mt-3"><EmptyState title={t("No configured featured characters")} /></div>;
  }
  return (
    <ol aria-label={t("Featured configuration and live status")} className="mt-3 divide-y divide-[var(--ad-border)] rounded-md border border-[var(--ad-border)]">
      {ids.map((id, index) => {
        const label = labels[id];
        const name = label?.name ?? t("Unavailable");
        return (
          <li
            className="flex flex-wrap items-center gap-3 px-3 py-2"
            draggable={canEdit}
            key={id}
            onDragOver={(event) => { if (canEdit) event.preventDefault(); }}
            onDragStart={() => { dragFrom.current = index; }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragFrom.current !== null) onChange(moveFeaturedId(ids, dragFrom.current, index));
              dragFrom.current = null;
            }}
          >
            {canEdit ? <GripVertical aria-hidden="true" className="h-4 w-4 shrink-0 cursor-grab text-[var(--ad-text-muted)]" /> : null}
            <span className="w-5 shrink-0 text-right font-mono text-xs tabular-nums">{index + 1}</span>
            <FeaturedThumbnail url={label?.thumbnailUrl} />
            <span className="min-w-32 flex-1 truncate text-sm font-medium" title={id}>{name}</span>
            <div className="min-w-48 flex-[2]">
              <FeaturedRuntimeStatus item={items.find((item) => item.id === id)} />
            </div>
            {canEdit ? (
              <span className="flex shrink-0 gap-1">
                <button aria-label={t("Move {name} up", { name })} className="grid h-9 w-9 place-items-center rounded border border-[var(--ad-border)] disabled:opacity-40" disabled={index === 0} onClick={() => onChange(moveFeaturedId(ids, index, index - 1))} type="button"><ArrowUp aria-hidden="true" className="h-4 w-4" /></button>
                <button aria-label={t("Move {name} down", { name })} className="grid h-9 w-9 place-items-center rounded border border-[var(--ad-border)] disabled:opacity-40" disabled={index === ids.length - 1} onClick={() => onChange(moveFeaturedId(ids, index, index + 1))} type="button"><ArrowDown aria-hidden="true" className="h-4 w-4" /></button>
                <button aria-label={t("Remove {name} from Featured", { name })} className="grid h-9 w-9 place-items-center rounded border border-[var(--ad-border)]" onClick={() => onChange(ids.filter((value) => value !== id))} type="button"><X aria-hidden="true" className="h-4 w-4" /></button>
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * SPEC: 下架动作的文案由目标值决定，不是写死的「Make private」。
 *
 * INTENT: 这张表的可见性筛选器有 private / unlisted / public 三档，但动作按钮只能把角色打到
 * private —— 「从公开目录里拿掉、但保留直链」这个状态在后台无法产出，尽管服务端
 * (content.visibility.write) 和清理工具 (applyPublicContentCleanup) 都用 unlisted 表达它。
 * 上线验证内容正是这一类：不该占公开首位，也不该被收成 owner-only。
 */
export function contentCommandLabel(
  field: "visibility" | "status",
  value: string,
) {
  if (field === "status") return "Remove";
  return value === "unlisted" ? "Unlist" : "Make private";
}

// 权威给的是原因码，运营看的是「差什么、去哪修」。
export const EXPLORE_LISTING_BLOCKED_COPY = {
  character_not_live:
    "This Character is not live, so its Explore listing cannot change here.",
  private_needs_serving_command:
    "An official Character leaves the catalog through Pause or Retire on its release, not by going private here.",
} as const satisfies Record<string, string>;

export const OFFICIAL_REMOVE_BLOCKED_COPY =
  "An official Character is taken down through its release, not removed here.";

// SPEC: 目录每行只占一行短语，完整解释放进 tooltip 和读屏文本。
// INTENT: 这段解释曾在每行重复，窄列里折成好几行，把表格撑得又高又乱。
function ListingBlockedHint({
  details,
  id,
  repairDeepLink,
}: {
  details: readonly string[];
  id: string;
  repairDeepLink: string | null;
}) {
  const { t } = useAdminI18n();
  const full = details.map((detail) => t(detail)).join(" ");
  return (
    <p className="truncate text-[11px] text-[var(--ad-text-muted)]" id={id} title={full}>
      <span aria-hidden="true">{t("Managed by its release")}</span>
      <span className="sr-only">{full}</span>
      {repairDeepLink ? (
        <>
          {" · "}
          <Link className="underline" href={repairDeepLink}>
            {t("Open release")}
          </Link>
        </>
      ) : null}
    </p>
  );
}

// SPEC: 枚举走字典、时间走 format —— 和后台其他表一致。
// INTENT: 这张表原来所有单元格都走同一个 `cell()` 直接 String() 出去，于是中文界面上
//         性别 / 风格 / 可见性 / 状态 印的是 female / realistic / unlisted / approved，
//         创建时间印的是 `2026-08-11T18:18:31.703Z`。这几个取值在 zhValues 里早就有中文，
//         只是这张表没接上去。i18n 审计查不到这类漏翻——它来自数据，不是字面量。
export function characterTableRow(
  row: Row,
  canWrite: boolean,
  command: (
    id: string,
    field: "visibility" | "status",
    value: string,
    entityVersion?: number,
  ) => void,
  valueLabel: (value: string) => string = (value) => value,
  dateTime: (value: unknown) => string = (value) => cell(value),
): DataTableRow {
  const id = stringValue(row.id);
  // SPEC: 挂牌动作的可用性用权威随行下发的结论，不在前端重算一遍规则。
  // INTENT: 这三个按钮过去只看写权限，于是对暂停的角色、以及任何官方角色的「设为私密」，
  //         都画成可点 —— 点下去必吃 409。缺字段时（老响应）退回旧行为，不把行变成死的。
  const listing = contentCharacterExploreListingSchema.safeParse(row.exploreListing);
  const eligibility = listing.success ? listing.data : null;
  const canUnlist = canWrite && (eligibility?.canUnlist ?? true);
  const canMakePrivate = canWrite && (eligibility?.canMakePrivate ?? true);
  const servingVersion = typeof row.servingVersion === "number" ? row.servingVersion : undefined;
  // 官方角色的 status 归 Release / Serving 管，服务端 rejectOfficialCharacter 必回 409。
  const official = row.source === "official";
  const canRemove = canWrite && !official;
  const blockedReasonId = `explore-listing-blocked-${id}`;
  const blockedReason = eligibility && (!canUnlist || !canMakePrivate)
    ? eligibility.blockedReason
    : null;
  const repairDeepLink = eligibility?.repairDeepLink ??
    (official ? `/admin/characters/${id}?tab=release` : null);
  const blocked = Boolean(blockedReason) || official;
  const actions: ReactNode = (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <button
          aria-describedby={blockedReason ? blockedReasonId : undefined}
          className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs disabled:opacity-50"
          disabled={!canUnlist}
          onClick={() => command(id, "visibility", "unlisted", servingVersion)}
          type="button"
        >

          <AdminText text="Unlist" />
        </button>
        <button
          aria-describedby={blockedReason ? blockedReasonId : undefined}
          className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs disabled:opacity-50"
          disabled={!canMakePrivate}
          onClick={() => command(id, "visibility", "private", servingVersion)}
          type="button"
        >

          <AdminText text="Make private" />
        </button>
        <button
          aria-describedby={official ? blockedReasonId : undefined}
          className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs disabled:opacity-50"
          disabled={!canRemove}
          onClick={() => command(id, "status", "removed")}
          type="button"
        >

          <AdminText text="Remove" />
        </button>
      </div>
      {blocked ? (
        <ListingBlockedHint
          details={[
            ...(blockedReason ? [EXPLORE_LISTING_BLOCKED_COPY[blockedReason]] : []),
            ...(official ? [OFFICIAL_REMOVE_BLOCKED_COPY] : []),
          ]}
          id={blockedReasonId}
          repairDeepLink={repairDeepLink}
        />
      ) : null}
    </div>
  );
  return {
    id,
    cells: [
      cell(row.id),
      cell(row.name),
      enumCell(row.gender, valueLabel),
      enumCell(row.style, valueLabel),
      enumCell(row.visibility, valueLabel),
      // SPEC: 目录状态旁边跟一行 Serving 事实。
      // INTENT: 暂停角色会把 status 投影成 archived，这一列就只写「已归档」，而角色工作台
      //         顶部写的是「已暂停」—— 同一件事两个词。两个都显示，运营不必猜哪个是真的。
      <span key="status">
        {enumCell(row.status, valueLabel)}
        {typeof row.servingState === "string" ? (
          <span className="mt-1 block text-[11px] text-[var(--ad-text-muted)]">
            <AdminText text="Serving" />: {valueLabel(row.servingState)}
          </span>
        ) : null}
      </span>,
      dateTime(row.createdAt),
      actions,
    ],
  };
}

function enumCell(value: unknown, valueLabel: (value: string) => string) {
  return typeof value === "string" && value ? valueLabel(value) : cell(value);
}

function cell(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return JSON.stringify(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentQuery() {
  return typeof window === "undefined"
    ? contentQueryFromSearch("")
    : contentQueryFromSearch(window.location.search);
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
