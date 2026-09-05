"use client";

import {
  Flag,
  Loader2,
  RotateCcw,
  Search,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AdminV2RequestError,
  apiGet,
  apiWrite,
} from "@/components/admin/api";
import { AdminText, useAdminI18n } from "@/components/admin/i18n";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination, type PageInfo } from "@/components/admin/ui/Pagination";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useFailureToast, useToast } from "@/components/admin/ui/Toast";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
  type AuthorityState,
} from "@/lib/authority-state";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  CONTENT_PAGE_SIZE,
  contentListPath,
  contentQueryFromSearch,
  contentWorkspaceUrl,
  type ContentQuery,
} from "./query";

type Row = Record<string, unknown>;
type CharacterResponse = { items: Row[]; pageInfo: PageInfo };
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
export type FeaturedVersionConflict = {
  settingVersion: number;
  configuredCharacterIds: string[];
};

export function ContentMerchandisingWorkspace({
  canWrite,
}: {
  canWrite: boolean;
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
  const [featuredInput, setFeaturedInput] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saveConflict, setSaveConflict] =
    useState<FeaturedVersionConflict | null>(null);
  const [saveResult, setSaveResult] = useState<FeaturedWriteResult | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  // 游标分页没有页码，只有「上一页用的是哪个游标」。这条轨迹就是 Pagination 的第 N 页。
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const characterGate = useRef(createLatestRequestGate());
  const featuredGate = useRef(createLatestRequestGate());
  const featuredKey = useRef<string | null>(null);

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
      if (!options.preserveInput) {
        setFeaturedInput(data.configuredCharacterIds.join(", "));
      }
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
      // 回退到的那一页是哪一页，历史条目里没记；不知道就说不知道，把「上一页」置灰。
      setCursorTrail([]);
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

  // SPEC: 任何改变结果集的动作都回到第一页 —— 所以 trail 默认清空，只有翻页自己传轨迹。
  function navigate(next: ContentQuery, trail: string[] = []) {
    window.history.pushState(
      null,
      "",
      contentWorkspaceUrl(
        window.location.pathname,
        window.location.search,
        next,
      ),
    );
    setQuery(next);
    setDraft(next);
    setCursorTrail(trail);
    void loadCharacters(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, cursor: "" });
  }

  const expectedConfirmation = parseCsv(featuredInput).join(",") || "CLEAR";
  async function saveFeatured() {
    featuredKey.current ??= crypto.randomUUID();
    setSaving(true);
    setSaveConflict(null);
    setSaveResult(null);
    try {
      const result = await apiWrite<FeaturedWriteResult>(
        "/api/v2/admin/content/featured",
        "PUT",
        {
          characterIds: parseCsv(featuredInput),
          expectedVersion: featured.data?.settingVersion ?? 0,
          reason: reason.trim(),
          confirmation: confirmation.trim(),
        },
        { "idempotency-key": featuredKey.current },
      );
      setSaveResult(result);
      featuredKey.current = null;
      setReason("");
      setConfirmation("");
      await loadFeatured();
    } catch (cause) {
      const conflict = featuredVersionConflictFromError(cause);
      if (conflict) {
        featuredKey.current = null;
        setSaveConflict(conflict);
        await loadFeatured({ preserveInput: true });
      } else {
        failureToast(cause);
      }
    } finally {
      setSaving(false);
    }
  }

  function command(id: string, field: "visibility" | "status", value: string) {
    const expected = `${id}:${field}:${value}`;
    const key = crypto.randomUUID();
    setConfirmSpec({
      title: field === "visibility"
        ? t("{action} character {id}", { action: t(contentCommandLabel(field, value)), id })
        : t("Take character {id} down", { id }),
      destructive: { expectedName: expected, inputLabel: t("Type confirmation") },
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
          { [field]: value, reason: commandReason, confirmation: expected },
          { "idempotency-key": key },
        );
        toast({
          tone: "success",
          title:
            field === "visibility"
              ? t("Character {id} is now {visibility}", { id, visibility: value })
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
  const featuredRows = (featured.data?.items ?? []).map((item) =>
    featuredTableRow(item, t),
  );
  const configuredFeaturedCount =
    featured.data?.configuredCharacterIds.length ?? 0;
  const effectiveFeaturedCount =
    featured.data?.effectiveCharacterIds.length ?? 0;
  const blockedFeaturedCount =
    configuredFeaturedCount - effectiveFeaturedCount;
  return (
    <section className="space-y-5">
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
        <AuthorityRequestError
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
        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_220px_260px_auto]">
          <input
            className="h-10 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 font-mono text-sm"
            disabled={!canWrite}
            onChange={(event) => {
              setFeaturedInput(event.target.value);
              setConfirmation("");
              setSaveResult(null);
              setSaveConflict(null);
              featuredKey.current = null;
            }}
            placeholder={t("char_a, char_b")}
            value={featuredInput}
          />
          <input
            className="h-10 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm"
            disabled={!canWrite}
            onChange={(event) => {
              setReason(event.target.value);
              setSaveResult(null);
              setSaveConflict(null);
              featuredKey.current = null;
            }}
            placeholder={t("Reason (≥3 chars)")}
            value={reason}
          />
          <input
            aria-label={t("Featured confirmation")}
            className="h-10 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 font-mono text-sm"
            disabled={!canWrite}
            onChange={(event) => {
              setConfirmation(event.target.value);
              setSaveResult(null);
              setSaveConflict(null);
              featuredKey.current = null;
            }}
            placeholder={
              expectedConfirmation === "CLEAR"
                ? "Type CLEAR"
                : "Type featured IDs"
            }
            value={confirmation}
          />
          <button
            className="inline-flex h-10 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
            disabled={
              !canWrite ||
              saving ||
              reason.trim().length < 3 ||
              confirmation.trim() !== expectedConfirmation
            }
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
        </div>
        <FeaturedDiff
          draftIds={parseCsv(featuredInput)}
          savedIds={featured.data.configuredCharacterIds}
        />
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
                "Latest authority was refreshed. Your draft remains in the fields; review it and save again to apply it.",
              )}
            </p>
            <p className="mt-1 font-mono">
              {t("Current version")} {saveConflict.settingVersion}
              {" · "}
              {t("Current configured IDs")}:{" "}
              {saveConflict.configuredCharacterIds.join(", ") || t("None")}
            </p>
          </div>
        ) : null}
        {saveResult ? (
          <FeaturedWriteResultNotice result={saveResult} t={t} />
        ) : null}
      </section> : null}
      {featured.data ? <DataTable
        caption={t("Featured configuration and live status")}
        empty={<EmptyState title={t("No configured featured characters")} />}
        headers={[
          t("Order"),
          "ID",
          t("Name"),
          t("Runtime state"),
          t("Blockers"),
        ]}
        rows={featuredRows}
      /> : null}
      {characters.error ? (
        <AuthorityRequestError
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
          hasPrevious={cursorTrail.length > 0}
          loading={characters.loading}
          onNext={() => {
            const endCursor = characters.data?.pageInfo.endCursor;
            if (!endCursor) return;
            navigate({ ...query, cursor: endCursor }, [...cursorTrail, query.cursor]);
          }}
          onPrevious={() =>
            navigate({ ...query, cursor: cursorTrail.at(-1) ?? "" }, cursorTrail.slice(0, -1))
          }
          page={cursorTrail.length + 1}
          pageSize={CONTENT_PAGE_SIZE}
          rowCount={characters.data.items.length}
        />
      ) : null}
      {confirmSpec ? (
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
 * INTENT: 精选配置是一个逗号分隔的长字符串输入框。运营粘一版新的进去，屏幕上没有任何东西
 * 告诉他这次动作的差异——要么自己逐个 ID 比对，要么保存完看结果。而这是直接改首页曝光的写操作。
 * INVARIANT: 两边都是真实数据（已保存配置 vs 当前输入），不预测生效结果——
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
  savedIds,
}: {
  draftIds: readonly string[];
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
          <dd className="font-mono break-all">{added.join(", ")}</dd>
        </div>
      ) : null}
      {removed.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <dt className="font-semibold">{t("Removing")}</dt>
          <dd className="font-mono break-all">{removed.join(", ")}</dd>
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

export function featuredTableRow(
  item: FeaturedItem,
  t: (key: string) => string = (key) => key,
): DataTableRow {
  const runtimeState: ReactNode = item.effective ? (
    <strong className="text-xs font-semibold text-[var(--ad-green-text)]">
      {t("Live featured")}
    </strong>
  ) : (
    <strong className="text-xs font-semibold text-[var(--ad-yellow-text)]">
      {t("Configured · not live")}
    </strong>
  );
  const blockers: ReactNode = item.effective ? (
    <span className="text-xs text-[var(--ad-text-muted)]">{t("None")}</span>
  ) : (
    <ul className="min-w-72 space-y-2">
      {item.blockers.map((blocker) => (
        <li className="text-xs" key={blocker.code}>
          <span className="block font-medium">
            {t(blocker.code.replaceAll("_", " "))}
          </span>
          <span className="mt-0.5 block text-[var(--ad-text-muted)]">
            {t(blocker.message)}
          </span>
          <Link
            className="mt-1 inline-flex min-h-8 items-center font-semibold underline"
            href={blocker.repairDeepLink}
          >
            {t("Resolve blocker")}
          </Link>
        </li>
      ))}
    </ul>
  );
  return {
    id: item.id,
    cells: [
      <span className="font-mono text-xs tabular-nums" key="order">
        {item.configuredPosition + 1}
      </span>,
      <span className="font-mono text-xs" key="id">
        {item.id}
      </span>,
      item.name ?? t("Unavailable"),
      runtimeState,
      blockers,
    ],
  };
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

// SPEC: 枚举走字典、时间走 format —— 和后台其他表一致。
// INTENT: 这张表原来所有单元格都走同一个 `cell()` 直接 String() 出去，于是中文界面上
//         性别 / 风格 / 可见性 / 状态 印的是 female / realistic / unlisted / approved，
//         创建时间印的是 `2026-08-11T18:18:31.703Z`。这几个取值在 zhValues 里早就有中文，
//         只是这张表没接上去。i18n 审计查不到这类漏翻——它来自数据，不是字面量。
export function characterTableRow(
  row: Row,
  canWrite: boolean,
  command: (id: string, field: "visibility" | "status", value: string) => void,
  valueLabel: (value: string) => string = (value) => value,
  dateTime: (value: unknown) => string = (value) => cell(value),
): DataTableRow {
  const id = stringValue(row.id);
  const actions: ReactNode = (
    <div className="flex gap-2">
      <button
        className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs disabled:opacity-50"
        disabled={!canWrite}
        onClick={() => command(id, "visibility", "unlisted")}
        type="button"
      >

        <AdminText text="Unlist" />
      </button>
      <button
        className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs disabled:opacity-50"
        disabled={!canWrite}
        onClick={() => command(id, "visibility", "private")}
        type="button"
      >

        <AdminText text="Make private" />
      </button>
      <button
        className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs disabled:opacity-50"
        disabled={!canWrite}
        onClick={() => command(id, "status", "removed")}
        type="button"
      >

        <AdminText text="Remove" />
      </button>
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
      enumCell(row.status, valueLabel),
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

export function featuredVersionConflictFromError(
  cause: unknown,
): FeaturedVersionConflict | null {
  if (
    !(cause instanceof AdminV2RequestError) ||
    cause.status !== 409 ||
    !isRecord(cause.details) ||
    cause.details.reason !== "featured_setting_version_conflict" ||
    typeof cause.details.settingVersion !== "number" ||
    !Number.isInteger(cause.details.settingVersion) ||
    cause.details.settingVersion < 0 ||
    !Array.isArray(cause.details.configuredCharacterIds) ||
    !cause.details.configuredCharacterIds.every(
      (id) => typeof id === "string",
    )
  ) {
    return null;
  }
  return {
    settingVersion: cause.details.settingVersion,
    configuredCharacterIds: cause.details.configuredCharacterIds,
  };
}

function parseCsv(value: string) {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
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
