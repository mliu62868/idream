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
import { useCallback, useEffect, useState } from "react";
import { CmsArticleEditor } from "./CmsArticleEditor";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n, type AdminLocale } from "@/components/admin/i18n";
import { formatDateTime } from "@/components/admin/ui/format";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { WriteFeedbackBanner, requestErrorMessage, useWriteFeedback } from "@/components/admin/section-kit";

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
  issues: PublicationIssue[];
};

type PageDetail = PageRow & {
  body: unknown;
};

type PublishDraft = {
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
  "rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]";

export function CmsView({ canWrite = false }: { canWrite?: boolean }) {
  const { locale, t, value: valueLabel } = useAdminI18n();
  const [viewPage, setViewPage] = useState<PageDetail | null>(null);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState(true);
  // INVARIANT: 存异常对象而不只是它的 message —— AuthorityRequestError 要靠 cause 才能按错误码
  // 出人话；只有 message 时运营读到的仍是 authority 的英文原文。
  const [error, setError] = useState<{ message: string; cause: unknown } | null>(null);
  const [publishDraft, setPublishDraft] = useState<PublishDraft | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editLoadingPath, setEditLoadingPath] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const { feedback, reportSuccess, clearFeedback } = useWriteFeedback();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: unknown }>(
        "/api/v2/admin/cms/pages",
      );
      if (!Array.isArray(data.items) || !data.items.every(isPageRow)) {
        throw new Error(t("The CMS page list response was incomplete."));
      }
      setPages(data.items);
    } catch (err) {
      setError({ message: requestErrorMessage(err, t), cause: err });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function startPublish(
    page: PageRow,
    nextStatus: PublishDraft["nextStatus"],
  ) {
    if (!canWrite) return;
    setError(null);
    setEditDraft(null);
    setPublishDraft({
      path: page.path,
      nextStatus,
      expectedUpdatedAt: page.updatedAt,
      reason: "",
      confirmation: "",
    });
  }

  async function publish() {
    if (!canWrite || !publishDraft || !canConfirmPublish(publishDraft)) return;
    setPublishBusy(true);
    setError(null);
    try {
      await apiWrite("/api/v2/admin/cms/pages/publish", "POST", {
        path: publishDraft.path,
        contentStatus: publishDraft.nextStatus,
        expectedUpdatedAt: publishDraft.expectedUpdatedAt,
        reason: publishDraft.reason.trim(),
        confirmation: publishDraft.confirmation.trim(),
      });
      const { path, nextStatus } = publishDraft;
      setPublishDraft(null);
      await load();
      reportSuccess(
        nextStatus === "published"
          ? t("{path} is published and indexable per its indexing status.", { path })
          : t("{path} is unpublished and back to draft. It is no longer served.", { path }),
      );
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
    setError(null);
    try {
      const data = await apiGet<{ page: unknown }>(`/api/v2/admin/cms/page?path=${encodeURIComponent(page.path)}`);
      if (!isPageDetail(data.page)) throw new Error(t("The CMS page response was incomplete."));
      setViewPage(data.page);
    } catch (cause) { setError({ message: requestErrorMessage(cause, t), cause }); }
  }

  async function startEdit(page: PageRow) {
    if (!canWrite || !page.editable || page.contentStatus === "published") return;
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
      setEditDraft({
        path: data.page.path,
        title: data.page.title,
        description: data.page.description,
        canonical: data.page.canonical ?? "",
        indexingStatus: data.page.indexingStatus,
        bodyJson: JSON.stringify(data.page.body, null, 2),
        expectedUpdatedAt: data.page.updatedAt,
        reason: "",
        confirmation: "",
      });
    } catch (err) {
      setError({ message: requestErrorMessage(err, t), cause: err });
    } finally {
      setEditLoadingPath(null);
    }
  }

  async function saveEdit() {
    if (!canWrite || !editDraft || !canSaveEdit(editDraft)) return;
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
        setEditDraft(null);
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
            disabled={!page.editable || editLoadingPath !== null || publishBusy}
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
        {page.contentStatus === "published" ? (
          <button
            className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs"
            disabled={publishBusy}
            onClick={() => startPublish(page, "draft")}
            type="button"
          >
            {t("Unpublish")}
          </button>
        ) : page.contentStatus === "draft" ? (
          <button
            className="inline-flex h-8 items-center gap-1 bg-[var(--ad-ink)] px-2 text-xs font-semibold text-white disabled:opacity-50"
            disabled={publishBusy || page.publishability !== "ready"}
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
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {t("CMS pages")} ({pages.length})
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
      {error ? (
        <AuthorityRequestError cause={error.cause} message={error.message} onRetry={() => void load()} />
      ) : null}

      {canWrite ? <CreatePageForm onCreated={reportSuccess} reload={load} /> : <p className="text-sm text-[var(--ad-text-muted)]">{t("You can browse CMS pages. Creating, editing and publishing requires CMS write access.")}</p>}

      {viewPage ? <section className="space-y-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{viewPage.title}</h3><p className="mt-1 text-sm text-[var(--ad-text-muted)]">{viewPage.path} · {valueLabel(viewPage.contentStatus)}</p></div><button className="min-h-9 px-3 text-sm" type="button" onClick={() => setViewPage(null)}>{t("Close")}</button></div>
        <p className="text-sm">{viewPage.description}</p>
        <CmsArticleEditor bodyJson={JSON.stringify(viewPage.body, null, 2)} onChange={() => undefined} readOnly />
      </section> : null}

      {canWrite && editDraft ? (
        <EditPageForm
          busy={editBusy}
          draft={editDraft}
          onCancel={() => setEditDraft(null)}
          onChange={setEditDraft}
          onSave={() => void saveEdit()}
        />
      ) : null}

      {canWrite && publishDraft ? (
        <section className="rounded-lg border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] p-3">
          <p className="text-xs font-semibold text-[var(--ad-yellow-text)]">
            {t("Confirm CMS status change")}{" "}
            <span className="font-mono">{publishDraft.path}</span> →{" "}
            {valueLabel(publishDraft.nextStatus)}
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_260px_auto_auto]">
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
            <button
              className="rounded-md inline-flex h-10 items-center justify-center border border-[var(--ad-border)] px-3 text-sm"
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
              {t("Confirm publish change")}
            </button>
          </div>
        </section>
      ) : null}

      {error && pages.length === 0 ? null : (
        <DataTable
          caption="CMS pages"
          empty={
            <EmptyState
              hint={canWrite ? t("Create a draft above; it is not served until you publish it.") : t("No pages have been created yet. Refresh later to check for updates.")}
              title={t("No CMS pages yet.")}
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
    </div>
  );
}

function CmsPublicationIssues({ issues }: { issues: PublicationIssue[] }) {
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
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <input
          className={inputClass}
          onChange={(event) =>
            onChange({ ...draft, title: event.target.value })
          }
          placeholder={t("Page title")}
          value={draft.title}
        />
        <select
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
        </select>
        <input
          className={`${inputClass} md:col-span-2`}
          onChange={(event) =>
            onChange({ ...draft, description: event.target.value })
          }
          placeholder={t("Meta description")}
          value={draft.description}
        />
        <input
          className={`${inputClass} font-mono md:col-span-2`}
          onChange={(event) =>
            onChange({ ...draft, canonical: event.target.value })
          }
          placeholder={t("Canonical path (blank uses the page path)")}
          value={draft.canonical}
        />
        <CmsArticleEditor bodyJson={draft.bodyJson} onChange={(bodyJson) => onChange({ ...draft, bodyJson })} />
        <input
          className={inputClass}
          onChange={(event) =>
            onChange({ ...draft, reason: event.target.value })
          }
          placeholder={t("Reason (≥3)")}
          value={draft.reason}
        />
        <input
          aria-label={t("CMS edit confirmation")}
          className={`${inputClass} font-mono`}
          onChange={(event) =>
            onChange({ ...draft, confirmation: event.target.value })
          }
          placeholder={t("Type page path")}
          value={draft.confirmation}
        />
        <div className="flex justify-end gap-2 md:col-span-2">
          <button
            className="rounded-md inline-flex h-10 items-center justify-center border border-[var(--ad-border)] px-3 text-sm"
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
      </div>
    </section>
  );
}

function CreatePageForm({ onCreated, reload }: { onCreated: (message: string) => void; reload: () => Promise<void> }) {
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

  async function create() {
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

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h2 className="text-sm font-semibold">{t("Create new page draft")}</h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
        {t(
          "Use a new lowercase CMS path. Duplicate and application-owned paths are rejected.",
        )}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <input
          className={inputClass}
          onChange={(event) => setPath(event.target.value)}
          placeholder={t("/guides/example")}
          value={path}
        />
        <input
          className={inputClass}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("Page title")}
          value={title}
        />
        <input
          className={`${inputClass} md:col-span-2`}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t("Meta description")}
          value={description}
        />
        <input
          className={`${inputClass} font-mono`}
          onChange={(event) => setCanonical(event.target.value)}
          placeholder={t("Canonical path (optional)")}
          value={canonical}
        />
        <select
          aria-label={t("CMS indexing status")}
          className={inputClass}
          onChange={(event) =>
            setIndexingStatus(event.target.value as IndexingStatus)
          }
          value={indexingStatus}
        >
          <option value="noindex">{t("noindex")}</option>
          <option value="index">{t("index")}</option>
        </select>
        <CmsArticleEditor bodyJson={bodyJson} onChange={setBodyJson} />
        <input
          className={inputClass}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t("Reason (≥3)")}
          value={reason}
        />
        <input
          aria-label={t("CMS page confirmation")}
          className={`${inputClass} font-mono`}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={t("Type page path")}
          value={confirmation}
        />
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
      </div>
      {err ? (
        <AuthorityRequestError cause={err.cause} message={err.message} onRetry={() => void reload()} />
      ) : null}
    </section>
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
