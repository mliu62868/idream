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
import { PageHeader } from "@/components/admin/ui/PageHeader";
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
  contentListPath,
  contentQueryFromSearch,
  contentWorkspaceUrl,
  type ContentQuery,
} from "./query";

type Row = Record<string, unknown>;
type PageInfo = { endCursor: string | null; hasNextPage: boolean };
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
  const { t } = useAdminI18n();
  const [query, setQuery] = useState<ContentQuery>(() => currentQuery());
  const [draft, setDraft] = useState<ContentQuery>(() => currentQuery());
  const [characters, setCharacters] =
    useState(() => createAuthorityState<CharacterResponse>());
  const [featured, setFeatured] =
    useState(() => createAuthorityState<FeaturedResponse>());
  const [featuredInput, setFeaturedInput] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] =
    useState<FeaturedVersionConflict | null>(null);
  const [saveResult, setSaveResult] = useState<FeaturedWriteResult | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const characterGate = useRef(createLatestRequestGate());
  const featuredGate = useRef(createLatestRequestGate());
  const featuredKey = useRef<string | null>(null);
  const initialQuery = useRef(query);

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
      load(next);
    };
    load(initialQuery.current);
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      currentCharacterGate.invalidate();
      currentFeaturedGate.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
  }, [load]);

  function navigate(next: ContentQuery) {
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
    setSaveError(null);
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
        setSaveError(errorMessage(cause, "Featured content could not be saved"));
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
        ? `${contentCommandLabel(field, value)} ${id}`
        : `Remove ${id}`,
      destructive: { expectedName: expected, inputLabel: "Type confirmation" },
      submitLabel: contentCommandLabel(field, value),
      onSubmit: async (commandReason) => {
        await apiWrite(
          `/api/v2/admin/content/characters/${encodeURIComponent(id)}/${field}`,
          "POST",
          { [field]: value, reason: commandReason, confirmation: expected },
          { "idempotency-key": key },
        );
        await loadCharacters(query);
        await loadFeatured();
      },
    });
  }

  const characterRows = (characters.data?.items ?? []).map((row) =>
    characterTableRow(row, canWrite, command),
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
        purpose="Search the catalog, control visibility and lifecycle state, and curate the public featured feed."
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
        {!canWrite ? (
          <strong>{t("Read only · content.takedown.write is not granted")}</strong>
        ) : null}
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
          message={featured.error}
          onRetry={() => void loadFeatured()}
          snapshotAt={featured.data ? featured.refreshedAt : null}
        />
      ) : null}
      {featured.loading && featured.data === null ? (
        <p className="text-sm text-[var(--ad-text-muted)]" role="status">

          {t("Loading featured authority…")}
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
        {saveError ? (
          <p className="mt-2 text-xs text-[var(--ad-red-text)]" role="alert">
            {saveError}
          </p>
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
          message={characters.error}
          onRetry={() => void loadCharacters(query)}
          snapshotAt={characters.data ? characters.refreshedAt : null}
        />
      ) : null}
      {characters.loading && characters.data === null ? (
        <p className="text-sm text-[var(--ad-text-muted)]" role="status">

          {t("Loading character authority…")}
        </p>
      ) : null}
      {characters.data ? <DataTable
        caption="Characters"
        empty={<EmptyState title={t("No characters match these filters")} />}
        headers={[
          "ID",
          "Name",
          "Gender",
          "Style",
          "Visibility",
          "Status",
          "Created",
          "Actions",
        ]}
        rows={characterRows}
      /> : null}
      {characters.data?.pageInfo.hasNextPage &&
      characters.data.pageInfo.endCursor ? (
        <button
          className="inline-flex h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-4 text-sm"
          onClick={() =>
            navigate({
              ...query,
              cursor: characters.data?.pageInfo.endCursor ?? "",
            })
          }
          type="button"
        >

          {t("Next page")}
        </button>
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

function Freshness<T>({
  authority,
  state,
}: {
  authority: string;
  state: AuthorityState<T>;
}) {
  const { t } = useAdminI18n();
  if (state.loading) return <span>{authority}{t(": refreshing")}</span>;
  if (state.error) {
    return (
      <span>
        {authority}: {state.data ? t("stale") : t("unavailable")}  {t("· retry available")}
      </span>
    );
  }
  return (
    <span>
      {authority}{t(": fresh")}{" "}
      {state.refreshedAt
        ? new Date(state.refreshedAt).toLocaleTimeString()
        : ""}
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
  return (
    <label className="grid gap-1 text-xs font-medium text-[var(--ad-text-muted)]">
      {label}
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
  return (
    <label className="grid gap-1 text-xs font-medium text-[var(--ad-text-muted)]">
      {label}
      <select
        className="h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)]"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option || "all"} value={option}>
            {option || "All"}
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

export function characterTableRow(
  row: Row,
  canWrite: boolean,
  command: (id: string, field: "visibility" | "status", value: string) => void,
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
      cell(row.gender),
      cell(row.style),
      cell(row.visibility),
      cell(row.status),
      cell(row.createdAt),
      actions,
    ],
  };
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
