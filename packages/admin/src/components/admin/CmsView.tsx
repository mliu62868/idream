"use client";

// SPEC: CMS/SEO operator workbench. Content is created and edited as a draft,
// validated by Main, and only then promoted through a CAS-protected publish
// command. Published content must be unpublished before it can be edited.
import {
  FilePenLine,
  Loader2,
  Plus,
  RefreshCcw,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cmsPageListResponseSchema, type CmsPageListResponse } from "@idream/shared/admin";
import { CmsArticleEditor } from "./CmsArticleEditor";
import { apiGet, apiWrite } from "@/components/admin/api";
import { Field } from "@/components/admin/ui/FormPage";
import { useAdminI18n, type AdminLocale } from "@/components/admin/i18n";
import { formatDateTime } from "@/components/admin/ui/format";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { Pagination } from "@/components/admin/ui/Pagination";
import { useUrlFilters } from "@/components/admin/ui/useUrlFilters";
import { useUnsavedChanges } from "@/components/admin/ui/useUnsavedChanges";
import { buildCompatibilityListUrl } from "@/features/compatibility-lists/query";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { createLatestRequestGate } from "@/lib/latest-request";
import { authorityRequestFailed, authorityRequestStarted, authorityRequestSucceeded, createAuthorityState } from "@/lib/authority-state";
import { WriteFeedbackBanner, listPageFromParams, requestErrorMessage, useWriteFeedback } from "@/components/admin/section-kit";

type ContentStatus = "template" | "draft" | "published";
type IndexingStatus = "noindex" | "index";
type PublicationIssue = {
  code: string;
  message: string;
  path: string;
};

type PageRow = {
  path: string;
  template: string;
  title: string;
  description: string;
  canonical: string | null;
  contentStatus: ContentStatus;
  contentSchemaVersion: number | null;
  indexingStatus: IndexingStatus;
  publishedAt: string | null;
  updatedAt: string;
  editable: boolean;
  publishability: "ready" | "blocked";
  issues: readonly PublicationIssue[];
};

type PageDetail = PageRow & {
  body: unknown;
};

type PublishDraft = {
  action: "set_status" | "revalidate";
  path: string;
  nextStatus: "draft" | "published";
  expectedUpdatedAt: string;
  reason: string;
  confirmation: string;
};

type EditDraft = {
  path: string;
  title: string;
  description: string;
  canonical: string;
  indexingStatus: IndexingStatus;
  bodyJson: string;
  expectedUpdatedAt: string;
  reason: string;
  confirmation: string;
};

const emptyArticleBody =
  '{\n  "heading": "",\n  "intro": "",\n  "sections": []\n}';
const inputClass =
  "rounded-md h-10 w-full min-w-0 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]";
const PAGE_SIZE = 25;
type CmsQuery = { search: string; status: ContentStatus | ""; cursor: string; before: string; page: number };
const emptyQuery: CmsQuery = { search: "", status: "", cursor: "", before: "", page: 1 };

function cmsQueryFromParams(params: URLSearchParams): CmsQuery {
  const status = params.get("cmsStatus");
  const cursor = params.get("cmsCursor")?.trim() ?? "";
  const before = cursor ? "" : params.get("cmsBefore")?.trim() ?? "";
  return {
    search: params.get("cmsSearch")?.trim() ?? "",
    status: status === "template" || status === "draft" || status === "published" ? status : "",
    cursor, before, page: cursor || before ? listPageFromParams(params) : 1,
  };
}

function cmsListPath(query: CmsQuery) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (query.search) params.set("q", query.search);
  if (query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.before) params.set("before", query.before);
  return `/api/v2/admin/cms/pages?${params}`;
}

export function CmsView({ canWrite = false }: { canWrite?: boolean }) {
  const { locale, t, value: valueLabel } = useAdminI18n();
  const [viewPage, setViewPage] = useState<PageDetail | null>(null);
  const [list, setList] = useState(() => createAuthorityState<CmsPageListResponse>());
  // INVARIANT: 存异常对象而不只是它的 message —— AuthorityRequestError 要靠 cause 才能按错误码
  // 出人话；只有 message 时运营读到的仍是 authority 的英文原文。
  const [error, setError] = useState<{ message: string; cause: unknown; viewTarget?: PageRow } | null>(null);
  const [publishDraft, setPublishDraft] = useState<PublishDraft | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editBaseline, setEditBaseline] = useState<EditDraft | null>(null);
  const [editLoadingPath, setEditLoadingPath] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const { feedback, reportSuccess, reportFailure, clearFeedback } = useWriteFeedback();
  const requestGate = useRef(createLatestRequestGate());
  // INTENT: 阅读目标与列表刷新独立；新选择、关闭和卸载都使旧阅读回执失效。
  const viewRequestGate = useRef(createLatestRequestGate());
  const { confirmDiscard, guard } = useUnsavedChanges(Boolean(
    (editDraft && JSON.stringify(editDraft) !== JSON.stringify(editBaseline)) ||
    (publishDraft && (publishDraft.reason || publishDraft.confirmation)),
  ));

  const load = useCallback(async (query = cmsQueryFromParams(new URLSearchParams(window.location.search))) => {
    const request = requestGate.current.begin();
    const queryKey = cmsListPath(query);
    setList((current) => authorityRequestStarted(current, queryKey));
    setError(null);
    try {
      const data = await apiGet<unknown>(queryKey);
      if (!request.isCurrent()) return;
      const parsed = cmsPageListResponseSchema.safeParse(data);
      if (!parsed.success) {
        throw new Error(t("The CMS page list response was incomplete."));
      }
      setList(authorityRequestSucceeded(queryKey, parsed.data));
    } catch (err) {
      if (!request.isCurrent()) return;
      setList((current) => authorityRequestFailed(current, queryKey, requestErrorMessage(err, t), err));
    }
  }, [t]);

  const filters = useUrlFilters<CmsQuery>({
    initial: emptyQuery,
    parse: cmsQueryFromParams,
    toUrl: (query, location) => buildCompatibilityListUrl(location.pathname, location.search, {
      cmsSearch: query.search.trim() || null,
      cmsStatus: query.status || null,
      cmsCursor: query.cursor || null,
      cmsBefore: query.before || null,
      page: query.page > 1 ? String(query.page) : null,
    }),
    load: (query) => void load(query),
  });

  useEffect(() => {
    const onRefresh = () => void load();
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, onRefresh);
  }, [load]);

  useEffect(() => {
    const gate = requestGate.current;
    const viewGate = viewRequestGate.current;
    return () => { gate.invalidate(); viewGate.invalidate(); };
  }, []);

  const pages = list.data?.items ?? [];
  const loading = list.loading;
  const pageInfo = list.data?.pageInfo;
  const filtered = Boolean(filters.query.search || filters.query.status);
  function applyFilters(next: CmsQuery) {
    filters.apply({ ...next, search: next.search.trim(), cursor: "", before: "", page: 1 });
  }

  function startPublish(
    page: PageRow,
    nextStatus: PublishDraft["nextStatus"],
    action: PublishDraft["action"] = "set_status",
  ) {
    if (!canWrite || editBusy || publishBusy || editLoadingPath !== null) return;
    confirmDiscard(() => {
      setError(null);
      setEditDraft(null);
      setPublishDraft({
        action,
        path: page.path,
        nextStatus,
        expectedUpdatedAt: page.updatedAt,
        reason: "",
        confirmation: "",
      });
    });
  }

  async function publish() {
    if (!canWrite || publishBusy || !publishDraft || !canConfirmPublish(publishDraft)) return;
    setPublishBusy(true);
    setError(null);
    try {
      // SPEC: cacheRevalidated records whether Next accepted cache invalidation.
      // Visitor read-back still verifies the page served after the command.
      // INTENT: 契约里一直有这个字段，服务端每次都算（pages.ts:95 的 revalidateCmsPage 失败
      //       时返回 false 并只写一条 warn 日志），而后台从来没读过它：无论缓存刷没刷新，
      //       运营看到的都是「已发布」。刷新失败时数据库是 published、站上还是旧页，
      //       没有任何一处会告诉运营这件事。
      const result = await apiWrite<{ cacheRevalidated?: boolean }>(
        "/api/v2/admin/cms/pages/publish",
        "POST",
        {
          action: publishDraft.action,
          path: publishDraft.path,
          contentStatus: publishDraft.nextStatus,
          expectedUpdatedAt: publishDraft.expectedUpdatedAt,
          reason: publishDraft.reason.trim(),
          confirmation: publishDraft.confirmation.trim(),
        },
      );
      const { path, nextStatus, action } = publishDraft;
      setPublishDraft(null);
      await load();
      // INVARIANT: 缓存没刷新不是「成功」—— 走 reportFailure 那条不会自动消失的通道，
      //            因为这条要人去做点什么（本文件顶部的注释：运营没读到的失败等于没发生）。
      if (result.cacheRevalidated === false) {
        reportFailure(
          nextStatus === "published"
            ? t("{path} is published in the authority, but the cache did not refresh — visitors may see the old page. Use Refresh public cache; if it keeps failing this is an engineering issue.", { path })
            : t("{path} is unpublished in the authority, but the cache did not refresh — visitors may still reach the old page. Use Refresh public cache; if it keeps failing this is an engineering issue.", { path }),
        );
      } else {
        reportSuccess(
          action === "revalidate"
            ? t("Public cache invalidation completed for {path}. Its publication state is unchanged.", { path })
            : nextStatus === "published"
            ? t("{path} is published and indexable per its indexing status.", { path })
            : t("{path} is unpublished and back to draft. It is no longer served.", { path }),
        );
      }
    } catch (err) {
      // A status command is a one-shot operation against the exact row version
      // displayed to the operator. Never retain a stale confirmation.
      setPublishDraft(null);
      await load();
      setError({ message: requestErrorMessage(err, t), cause: err });
    } finally {
      setPublishBusy(false);
    }
  }

  async function view(page: PageRow) {
    const request = viewRequestGate.current.begin();
    setError(null);
    try {
      const data = await apiGet<{ page: unknown }>(`/api/v2/admin/cms/page?path=${encodeURIComponent(page.path)}`);
      if (!request.isCurrent()) return;
      if (!isPageDetail(data.page)) throw new Error(t("The CMS page response was incomplete."));
      setViewPage(data.page);
    } catch (cause) {
      if (!request.isCurrent()) return;
      setError({ message: requestErrorMessage(cause, t), cause, viewTarget: page });
    }
  }

  function closeView() {
    viewRequestGate.current.invalidate();
    setViewPage(null);
    setError((current) => current?.viewTarget ? null : current);
  }

  function startEdit(page: PageRow) {
    if (!canWrite || editBusy || publishBusy || editLoadingPath !== null || !page.editable || page.contentStatus === "published") return;
    confirmDiscard(async () => {
      setError(null);
      setPublishDraft(null);
      setEditLoadingPath(page.path);
      try {
        const data = await apiGet<{ page: unknown }>(
          `/api/v2/admin/cms/page?path=${encodeURIComponent(page.path)}`,
        );
        if (!isPageDetail(data.page)) {
          throw new Error(t("The CMS page response was incomplete."));
        }
        const nextDraft: EditDraft = {
          path: data.page.path,
          title: data.page.title,
          description: data.page.description,
          canonical: data.page.canonical ?? "",
          indexingStatus: data.page.indexingStatus,
          bodyJson: JSON.stringify(data.page.body, null, 2),
          expectedUpdatedAt: data.page.updatedAt,
          reason: "",
          confirmation: "",
        };
        setEditDraft(nextDraft);
        setEditBaseline(nextDraft);
      } catch (err) {
        setError({ message: requestErrorMessage(err, t), cause: err });
      } finally {
        setEditLoadingPath(null);
      }
    });
  }

  async function saveEdit() {
    if (!canWrite || editBusy || editLoadingPath !== null || !editDraft || !canSaveEdit(editDraft)) return;
    setEditBusy(true);
    setError(null);
    try {
      const body = parseBodyObject(editDraft.bodyJson, t("The article body must be a JSON object."));
      await apiWrite("/api/v2/admin/cms/pages", "PATCH", {
        path: editDraft.path,
        template: "article",
        title: editDraft.title.trim(),
        description: editDraft.description.trim(),
        canonical: editDraft.canonical.trim() || null,
        indexingStatus: editDraft.indexingStatus,
        body,
        expectedUpdatedAt: editDraft.expectedUpdatedAt,
        reason: editDraft.reason.trim(),
        confirmation: editDraft.confirmation.trim(),
      });
      const savedPath = editDraft.path;
      setEditDraft(null);
      await load();
      reportSuccess(t("Draft saved for {path}. Publishing is still a separate action.", { path: savedPath }));
    } catch (err) {
      const message = requestErrorMessage(err, t);
      if (/changed|since it was loaded/i.test(message)) {
        // Refresh the authority, but keep the operator's copy and original CAS.
        // Reopening the fresh version is an explicit, guarded discard.
        await load();
      }
      setError({ message, cause: err });
    } finally {
      setEditBusy(false);
    }
  }

  const tableRows: DataTableRow[] = pages.map((page) => ({
    id: page.path,
    cells: [
      <span className="font-mono text-xs" key="path">{page.path}</span>,
      <div key="title">
        <p>{page.title}</p>
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
          {t("Updated")} {formatTimestamp(page.updatedAt, locale)}
        </p>
      </div>,
      <div className="text-[var(--ad-text-muted)]" key="status">
        {valueLabel(page.contentStatus)}
        {page.publishedAt ? <p className="mt-1 text-xs">{formatTimestamp(page.publishedAt, locale)}</p> : null}
      </div>,
      <div className="text-[var(--ad-text-muted)]" key="indexing">
        {valueLabel(page.indexingStatus)}
        {page.canonical ? <p className="mt-1 max-w-44 truncate font-mono text-xs">{page.canonical}</p> : null}
      </div>,
      <div key="readiness">
        <p className={page.publishability === "ready" ? "text-[var(--ad-green-text)]" : "text-[var(--ad-yellow-text)]"}>
          {valueLabel(page.publishability)}
        </p>
        <CmsPublicationIssues issues={page.issues} />
      </div>,
      <div className="flex justify-end gap-2" key="actions">
        <button className="min-h-8 rounded-md border border-[var(--ad-border)] px-2 text-xs" type="button" onClick={() => void view(page)}>{t("View page")}</button>
        {canWrite ? <>
        {page.contentStatus !== "published" ? (
          <button
            className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs disabled:opacity-50"
            disabled={!page.editable || editLoadingPath !== null || publishBusy || editBusy}
            onClick={() => void startEdit(page)}
            title={page.editable ? t("Edit draft") : t("This route is application-owned")}
            type="button"
          >
            {editLoadingPath === page.path ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FilePenLine className="h-3.5 w-3.5" />
            )}
            {t("Edit")}
          </button>
        ) : null}
        {page.contentStatus !== "template" && !page.issues.some((issue) => issue.code === "path_not_cms_owned") ? (
          <button
            className="min-h-8 rounded-md border border-[var(--ad-border)] px-2 text-xs disabled:opacity-50"
            disabled={publishBusy || editBusy || editLoadingPath !== null}
            onClick={() => startPublish(page, page.contentStatus === "published" ? "published" : "draft", "revalidate")}
            type="button"
          >
            {t("Refresh public cache")}
          </button>
        ) : null}
        {page.contentStatus === "published" ? (
          <button
            className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs"
            disabled={publishBusy || editBusy || editLoadingPath !== null}
            onClick={() => startPublish(page, "draft")}
            type="button"
          >
            {t("Unpublish")}
          </button>
        ) : page.contentStatus === "draft" ? (
          <button
            className="inline-flex h-8 items-center gap-1 bg-[var(--ad-ink)] px-2 text-xs font-semibold text-white disabled:opacity-50"
            disabled={publishBusy || editBusy || editLoadingPath !== null || page.publishability !== "ready"}
            onClick={() => startPublish(page, "published")}
            type="button"
          >
            <UploadCloud className="h-3.5 w-3.5" />
            {t("Publish")}
          </button>
        ) : null}
        </> : <span className="text-xs text-[var(--ad-text-muted)]">{t("Read only")}</span>}
      </div>,
    ],
  }));

  return (
    <div className="space-y-5">
      {guard}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {t("CMS pages")}
        </h2>
        <button
          className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCcw className="h-4 w-4" />
          )}
          {t("Refresh")}
        </button>
      </div>
      <WriteFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
      {list.error ? <AuthorityRequestError cause={list.cause} message={list.error} requestKind="read" snapshotAt={list.refreshedAt} onRetry={() => void load()} /> : null}
      {error ? (
        <AuthorityRequestError cause={error.cause} message={error.message} requestKind={error.viewTarget ? "read" : "write"} onRetry={() => error.viewTarget ? void view(error.viewTarget) : void load()} />
      ) : null}

      <FilterBar
        collapsible
        search={filters.draft.search}
        onSearch={(search) => filters.setDraft({ search })}
        searchPlaceholder={t("Search paths or titles")}
        selects={[{ name: t("CMS status"), value: filters.draft.status, onChange: (status) => filters.setDraft({ status: status as CmsQuery["status"] }), options: [
          { value: "", label: t("All statuses") },
          ...(["template", "draft", "published"] as const).map((status) => ({ value: status, label: valueLabel(status) })),
        ] }]}
        chips={[
          ...(filters.query.search ? [{ key: "search", label: t("Search"), value: filters.query.search, onClear: () => applyFilters({ ...filters.query, search: "" }) }] : []),
          ...(filters.query.status ? [{ key: "status", label: t("Status"), value: valueLabel(filters.query.status), onClear: () => applyFilters({ ...filters.query, status: "" }) }] : []),
        ]}
        onApply={() => applyFilters(filters.draft)}
        onReset={() => applyFilters(emptyQuery)}
      />

      <CreatePageForm canWrite={canWrite} onCreated={reportSuccess} reload={load} />
      {!canWrite ? <p className="text-sm text-[var(--ad-text-muted)]">{t("You can browse CMS pages. Creating, editing and publishing requires CMS write access.")}</p> : null}

      {viewPage ? <section className="space-y-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{viewPage.title}</h3><p className="mt-1 text-sm text-[var(--ad-text-muted)]">{viewPage.path} · {valueLabel(viewPage.contentStatus)}</p></div><button className="min-h-9 px-3 text-sm" type="button" onClick={closeView}>{t("Close")}</button></div>
        <p className="text-sm">{viewPage.description}</p>
        <CmsArticleEditor bodyJson={JSON.stringify(viewPage.body, null, 2)} onChange={() => undefined} readOnly />
      </section> : null}

      {canWrite && editDraft ? (
        <EditPageForm
          busy={editBusy || editLoadingPath !== null}
          draft={editDraft}
          onCancel={() => setEditDraft(null)}
          onChange={setEditDraft}
          onSave={() => void saveEdit()}
        />
      ) : null}

      {canWrite && publishDraft ? (
        <section className="rounded-lg border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] p-3">
          <p className="text-xs font-semibold text-[var(--ad-yellow-text)]">
            {t(publishDraft.action === "revalidate" ? "Confirm cache refresh" : "Confirm CMS status change")}{" "}
            <span className="font-mono">{publishDraft.path}</span> →{" "}
            {valueLabel(publishDraft.nextStatus)}
          </p>
          <fieldset className="mt-3 grid gap-3 md:grid-cols-[1fr_260px_auto_auto]" disabled={publishBusy}>
            <Field label={t("Reason (≥3)")}>
              <input
                aria-label={t("CMS publish reason")}
                className={inputClass}
                onChange={(event) =>
                  setPublishDraft({
                    ...publishDraft,
                    reason: event.target.value,
                  })
                }
                placeholder={t("Reason (≥3)")}
                value={publishDraft.reason}
              />
            </Field>
            <Field label={t("Type page path")}>
              <input
                aria-label={t("CMS publish confirmation")}
                className={`${inputClass} font-mono`}
                onChange={(event) =>
                  setPublishDraft({
                    ...publishDraft,
                    confirmation: event.target.value,
                  })
                }
                placeholder={t("Type page path")}
                value={publishDraft.confirmation}
              />
            </Field>
            <button
              className="rounded-md inline-flex h-10 items-center justify-center border border-[var(--ad-border)] px-3 text-sm"
              disabled={publishBusy}
              onClick={() => setPublishDraft(null)}
              type="button"
            >
              {t("Cancel")}
            </button>
            <button
              className="inline-flex h-10 items-center justify-center bg-[var(--ad-yellow-bg)] px-3 text-sm font-semibold text-[var(--ad-yellow-text)] disabled:opacity-50"
              disabled={publishBusy || !canConfirmPublish(publishDraft)}
              onClick={() => void publish()}
              type="button"
            >
              {publishBusy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {t(publishDraft.action === "revalidate" ? "Confirm cache refresh" : "Confirm publish change")}
            </button>
          </fieldset>
        </section>
      ) : null}

      {(error || list.error) && pages.length === 0 ? null : (
        <DataTable
          caption="CMS pages"
          empty={
            <EmptyState
              hint={filtered ? t("The authority searched every CMS page. Clear the filters to see them all.") : canWrite ? t("Create a draft above; it is not served until you publish it.") : t("No pages have been created yet. Refresh later to check for updates.")}
              kind={filtered ? "filtered" : "empty"}
              onClearFilters={filtered ? () => applyFilters(emptyQuery) : undefined}
              title={filtered ? t("No CMS pages match these filters.") : t("No CMS pages yet.")}
            />
          }
          headers={[
            { label: t("Path"), width: "16rem" },
            t("Title"),
            t("Status"),
            t("Indexing"),
            { label: t("Publication readiness"), width: "20rem" },
            { label: t("Actions"), align: "right" },
          ]}
          loading={loading}
          minimumWidthClassName="min-w-[920px]"
          rows={tableRows}
          stickyLastColumn
        />
      )}
      <Pagination
        page={filters.query.page}
        pageSize={PAGE_SIZE}
        rowCount={pages.length}
        hasPrevious={pageInfo ? Boolean(pageInfo.hasPreviousPage) : Boolean(filters.query.cursor || filters.query.before)}
        hasNext={Boolean(pageInfo?.hasNextPage && pageInfo.endCursor)}
        loading={loading}
        onPrevious={() => pageInfo?.startCursor
          ? filters.apply({ ...filters.query, cursor: "", before: pageInfo.startCursor, page: Math.max(1, filters.query.page - 1) })
          : applyFilters(filters.query)}
        onNext={() => { if (pageInfo?.endCursor) filters.apply({ ...filters.query, cursor: pageInfo.endCursor, before: "", page: filters.query.page + 1 }); }}
      />
    </div>
  );
}

function CmsPublicationIssues({ issues }: { issues: readonly PublicationIssue[] }) {
  const { t } = useAdminI18n();
  if (issues.length === 0) return null;
  function fieldLabel(path: string) {
    const paragraph = /^body\.sections\.(\d+)\.paragraphs\.(\d+)$/.exec(path);
    if (paragraph) return t("Section {section}, paragraph {paragraph}", { section: Number(paragraph[1]) + 1, paragraph: Number(paragraph[2]) + 1 });
    const section = /^body\.sections\.(\d+)\.(heading|paragraphs)$/.exec(path);
    if (section) return section[2] === "heading" ? t("Section {section} heading", { section: Number(section[1]) + 1 }) : t("Section {section} paragraphs", { section: Number(section[1]) + 1 });
    switch (path) {
      case "title": return t("Page title");
      case "description": return t("Meta description");
      case "body.heading": return t("Article heading");
      case "body.intro": return t("Introduction");
      case "body.sections": return t("Article sections");
      case "body.cta.label": return t("Button label");
      case "body.cta.href": return t("Button destination");
      case "canonical": return t("Canonical path");
      case "path": return t("Page path");
      default: return t("Page content");
    }
  }
  // Zod can emit both nonblank and minimum-length issues for one field. Show the
  // strongest bound once, while retaining every original issue for diagnostics.
  const grouped = new Map<string, PublicationIssue>();
  const bound = (issue: PublicationIssue) => Number(/[<>]=?(\d+)/.exec(issue.message)?.[1] ?? 0);
  for (const issue of issues) {
    const key = `${issue.path}:${issue.code}${["too_small", "too_big"].includes(issue.code) ? "" : `:${issue.message}`}`;
    const previous = grouped.get(key);
    if (!previous || (issue.code === "too_small" && bound(issue) > bound(previous)) || (issue.code === "too_big" && bound(issue) < bound(previous))) grouped.set(key, issue);
  }
  function message(issue: PublicationIssue) {
    const field = fieldLabel(issue.path);
    const count = bound(issue);
    if (count && issue.code === "too_small") return t(issue.message.includes("array") ? "{field}: at least {count} items." : "{field} needs at least {count} characters.", { field, count });
    if (count && issue.code === "too_big") return t(issue.message.includes("array") ? "{field}: at most {count} items." : "{field} allows at most {count} characters.", { field, count });
    if (issue.code === "template_requires_edit") return t("Edit and save this template as a draft before publishing.");
    if (issue.code === "path_not_cms_owned") return t("This page path is managed by the application.");
    if (issue.message === "section headings must be unique") return t("Give each section a different heading.");
    if (issue.message === "an indexable page must be self-canonical") return t("For an indexed page, use its own page path as the canonical path.");
    if (issue.message === "CMS body must not exceed 128 KiB") return t("The article is too large. Keep its content below 128 KiB.");
    if (issue.code === "invalid_type") return t("Complete {field} before publishing.", { field });
    return t("Check {field} before publishing.", { field });
  }
  return <div className="mt-1 text-xs text-[var(--ad-text-muted)]">
    <ul className="space-y-1">{[...grouped.entries()].map(([key, issue]) => <li key={key}>{message(issue)}</li>)}</ul>
    <details className="mt-2"><summary className="cursor-pointer">{t("Technical details")}</summary><ul className="mt-2 space-y-1 break-words font-mono">{issues.map((issue, index) => <li key={index}>{issue.path || "page"}: {issue.message}</li>)}</ul></details>
  </div>;
}

function EditPageForm({
  busy,
  draft,
  onCancel,
  onChange,
  onSave,
}: {
  busy: boolean;
  draft: EditDraft;
  onCancel: () => void;
  onChange: (draft: EditDraft) => void;
  onSave: () => void;
}) {
  const { t } = useAdminI18n();
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h2 className="text-sm font-semibold">
        {t("Edit CMS draft")}{" "}
        <span className="font-mono">{draft.path}</span>
      </h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
        {t(
          "Saving creates a draft. Publication remains a separate validated action.",
        )}
      </p>
      {/* A pending save owns this draft until it settles. Reads can refresh the list. */}
      <fieldset className="mt-3 grid gap-3 md:grid-cols-2" disabled={busy}>
        <Field label={t("Page title")}>
          <input
            className={inputClass}
            onChange={(event) =>
              onChange({ ...draft, title: event.target.value })
            }
            placeholder={t("Page title")}
            value={draft.title}
          />
        </Field>
        <Field label={t("CMS indexing status")}><select
          aria-label={t("CMS indexing status")}
          className={inputClass}
          onChange={(event) =>
            onChange({
              ...draft,
              indexingStatus: event.target.value as IndexingStatus,
            })
          }
          value={draft.indexingStatus}
        >
          <option value="noindex">{t("noindex")}</option>
          <option value="index">{t("index")}</option>
        </select></Field>
        <Field label={t("Meta description")} className="md:col-span-2">
          <input
            className={inputClass}
            onChange={(event) =>
              onChange({ ...draft, description: event.target.value })
            }
            placeholder={t("Meta description")}
            value={draft.description}
          />
        </Field>
        <Field label={t("Canonical path")} className="md:col-span-2">
          <input
            className={`${inputClass} font-mono`}
            onChange={(event) =>
              onChange({ ...draft, canonical: event.target.value })
            }
            placeholder={t("Canonical path (blank uses the page path)")}
            value={draft.canonical}
          />
        </Field>
        <CmsArticleEditor bodyJson={draft.bodyJson} onChange={(bodyJson) => onChange({ ...draft, bodyJson })} />
        <Field label={t("Reason (≥3)")}>
          <input
            className={inputClass}
            onChange={(event) =>
              onChange({ ...draft, reason: event.target.value })
            }
            placeholder={t("Reason (≥3)")}
            value={draft.reason}
          />
        </Field>
        <Field label={t("Type page path")}>
          <input
            aria-label={t("CMS edit confirmation")}
            className={`${inputClass} font-mono`}
            onChange={(event) =>
              onChange({ ...draft, confirmation: event.target.value })
            }
            placeholder={t("Type page path")}
            value={draft.confirmation}
          />
        </Field>
        <div className="flex justify-end gap-2 md:col-span-2">
          <button
            className="rounded-md inline-flex h-10 items-center justify-center border border-[var(--ad-border)] px-3 text-sm"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            {t("Cancel")}
          </button>
          <button
            className="inline-flex h-10 items-center justify-center bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy || !canSaveEdit(draft)}
            onClick={onSave}
            type="button"
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {t("Save draft")}
          </button>
        </div>
      </fieldset>
    </section>
  );
}

function CreatePageForm({ canWrite, onCreated, reload }: { canWrite: boolean; onCreated: (message: string) => void; reload: () => Promise<void> }) {
  const { t } = useAdminI18n();
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [canonical, setCanonical] = useState("");
  const [indexingStatus, setIndexingStatus] =
    useState<IndexingStatus>("noindex");
  const [bodyJson, setBodyJson] = useState(emptyArticleBody);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; cause: unknown } | null>(null);
  const { guard } = useUnsavedChanges(Boolean(
    path || title || description || canonical || indexingStatus !== "noindex" ||
    bodyJson !== emptyArticleBody || reason || confirmation,
  ));

  async function create() {
    if (!canWrite || !canCreate) return;
    setBusy(true);
    setErr(null);
    try {
      const body = parseBodyObject(bodyJson, t("The article body must be a JSON object."));
      await apiWrite("/api/v2/admin/cms/pages", "POST", {
        path: path.trim(),
        template: "article",
        title: title.trim(),
        description: description.trim(),
        canonical: canonical.trim() || null,
        indexingStatus,
        body,
        reason: reason.trim(),
        confirmation: confirmation.trim(),
      });
      setPath("");
      setTitle("");
      setDescription("");
      setCanonical("");
      setIndexingStatus("noindex");
      setBodyJson(emptyArticleBody);
      setReason("");
      setConfirmation("");
      await reload();
      onCreated(t("Created draft {path}. It is not served until you publish it.", { path: expectedPath }));
    } catch (error) {
      setErr({ message: requestErrorMessage(error, t), cause: error });
    } finally {
      setBusy(false);
    }
  }

  const expectedPath = path.trim();
  const canCreate =
    !busy &&
    expectedPath.startsWith("/") &&
    title.trim().length > 0 &&
    reason.trim().length >= 3 &&
    confirmation.trim() === expectedPath;

  if (!canWrite) return guard;

  return (
    <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      {guard}
      <summary className="cursor-pointer text-sm font-semibold"><h2 className="inline">{t("Create new page draft")}</h2></summary>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
        {t(
          "Use a new lowercase CMS path. Duplicate and application-owned paths are rejected.",
        )}
      </p>
      <fieldset className="mt-3 grid gap-3 md:grid-cols-2" disabled={busy}>
        <Field label={t("Page path")}>
          <input
            className={inputClass}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t("/guides/example")}
            value={path}
          />
        </Field>
        <Field label={t("Page title")}>
          <input
            className={inputClass}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("Page title")}
            value={title}
          />
        </Field>
        <Field label={t("Meta description")} className="md:col-span-2">
          <input
            className={inputClass}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("Meta description")}
            value={description}
          />
        </Field>
        <Field label={t("Canonical path")}>
          <input
            className={`${inputClass} font-mono`}
            onChange={(event) => setCanonical(event.target.value)}
            placeholder={t("Canonical path (optional)")}
            value={canonical}
          />
        </Field>
        <Field label={t("CMS indexing status")}><select
          aria-label={t("CMS indexing status")}
          className={inputClass}
          onChange={(event) =>
            setIndexingStatus(event.target.value as IndexingStatus)
          }
          value={indexingStatus}
        >
          <option value="noindex">{t("noindex")}</option>
          <option value="index">{t("index")}</option>
        </select></Field>
        <CmsArticleEditor bodyJson={bodyJson} onChange={setBodyJson} />
        <Field label={t("Reason (≥3)")}>
          <input
            className={inputClass}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("Reason (≥3)")}
            value={reason}
          />
        </Field>
        <Field label={t("Type page path")}>
          <input
            aria-label={t("CMS page confirmation")}
            className={`${inputClass} font-mono`}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={t("Type page path")}
            value={confirmation}
          />
        </Field>
        <button
          className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50 md:col-span-2"
          disabled={!canCreate}
          onClick={() => void create()}
          type="button"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {t("Create draft")}
        </button>
      </fieldset>
      {err ? (
        <AuthorityRequestError cause={err.cause} message={err.message} onRetry={() => void reload()} />
      ) : null}
    </details>
  );
}

function canConfirmPublish(draft: PublishDraft) {
  return (
    draft.reason.trim().length >= 3 &&
    draft.confirmation.trim() === draft.path
  );
}

function canSaveEdit(draft: EditDraft) {
  return (
    draft.title.trim().length > 0 &&
    draft.reason.trim().length >= 3 &&
    draft.confirmation.trim() === draft.path
  );
}

// INTENT: 文案由调用方注入——这是个模块级纯函数，拿不到 t()，硬编码英文会在中文 locale 露馅。
function parseBodyObject(value: string, invalidMessage: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(invalidMessage); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(invalidMessage);
  }
  return parsed as Record<string, unknown>;
}

function isPageRow(value: unknown): value is PageRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.path === "string" &&
    typeof row.template === "string" &&
    typeof row.title === "string" &&
    typeof row.description === "string" &&
    (row.canonical === null || typeof row.canonical === "string") &&
    isContentStatus(row.contentStatus) &&
    (row.contentSchemaVersion === null ||
      typeof row.contentSchemaVersion === "number") &&
    isIndexingStatus(row.indexingStatus) &&
    (row.publishedAt === null || typeof row.publishedAt === "string") &&
    typeof row.updatedAt === "string" &&
    typeof row.editable === "boolean" &&
    (row.publishability === "ready" || row.publishability === "blocked") &&
    Array.isArray(row.issues) &&
    row.issues.every(isPublicationIssue)
  );
}

function isPageDetail(value: unknown): value is PageDetail {
  return isPageRow(value) && Object.hasOwn(value, "body");
}

function isContentStatus(value: unknown): value is ContentStatus {
  return (
    value === "template" || value === "draft" || value === "published"
  );
}

function isIndexingStatus(value: unknown): value is IndexingStatus {
  return value === "noindex" || value === "index";
}

function isPublicationIssue(value: unknown): value is PublicationIssue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const issue = value as Record<string, unknown>;
  return (
    typeof issue.code === "string" &&
    typeof issue.message === "string" &&
    typeof issue.path === "string"
  );
}

function formatTimestamp(value: string, locale: AdminLocale) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDateTime(value, locale) : value;
}
