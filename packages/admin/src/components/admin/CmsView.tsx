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
import { useEffect, useState } from "react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";

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
const textAreaClass =
  "rounded-md min-h-44 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--ad-ink)]";

export function CmsView() {
  const { t, value: valueLabel } = useAdminI18n();
  const [pages, setPages] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [publishDraft, setPublishDraft] = useState<PublishDraft | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editLoadingPath, setEditLoadingPath] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: unknown }>(
        "/api/v1/admin/cms/pages",
      );
      if (!Array.isArray(data.items) || !data.items.every(isPageRow)) {
        throw new Error("CMS page list response was incomplete");
      }
      setPages(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  function startPublish(
    page: PageRow,
    nextStatus: PublishDraft["nextStatus"],
  ) {
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
    if (!publishDraft || !canConfirmPublish(publishDraft)) return;
    setPublishBusy(true);
    setError(null);
    try {
      await apiWrite("/api/v1/admin/cms/pages/publish", "POST", {
        path: publishDraft.path,
        contentStatus: publishDraft.nextStatus,
        expectedUpdatedAt: publishDraft.expectedUpdatedAt,
        reason: publishDraft.reason.trim(),
        confirmation: publishDraft.confirmation.trim(),
      });
      setPublishDraft(null);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Publish failed";
      // A status command is a one-shot operation against the exact row version
      // displayed to the operator. Never retain a stale confirmation.
      setPublishDraft(null);
      await load();
      setError(message);
    } finally {
      setPublishBusy(false);
    }
  }

  async function startEdit(page: PageRow) {
    if (!page.editable || page.contentStatus === "published") return;
    setError(null);
    setPublishDraft(null);
    setEditLoadingPath(page.path);
    try {
      const data = await apiGet<{ page: unknown }>(
        `/api/v1/admin/cms/pages?path=${encodeURIComponent(page.path)}`,
      );
      if (!isPageDetail(data.page)) {
        throw new Error("CMS page response was incomplete");
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
      setError(err instanceof Error ? err.message : "Page load failed");
    } finally {
      setEditLoadingPath(null);
    }
  }

  async function saveEdit() {
    if (!editDraft || !canSaveEdit(editDraft)) return;
    setEditBusy(true);
    setError(null);
    try {
      const body = parseBodyObject(editDraft.bodyJson);
      await apiWrite("/api/v1/admin/cms/pages", "PATCH", {
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
      setEditDraft(null);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed";
      if (/changed|since it was loaded/i.test(message)) {
        setEditDraft(null);
        await load();
      }
      setError(message);
    } finally {
      setEditBusy(false);
    }
  }

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
      {error ? (
        <p className="text-xs text-[var(--ad-red-text)]" role="alert">
          {error}
        </p>
      ) : null}

      <CreatePageForm reload={load} />

      {editDraft ? (
        <EditPageForm
          busy={editBusy}
          draft={editDraft}
          onCancel={() => setEditDraft(null)}
          onChange={setEditDraft}
          onSave={() => void saveEdit()}
        />
      ) : null}

      {publishDraft ? (
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

      <section className="overflow-x-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <table className="w-full min-w-[920px] text-left text-sm">
          <caption className="sr-only">CMS pages</caption>
          <thead className="border-b border-[var(--ad-border)] text-xs text-[var(--ad-text-muted)]">
            <tr>
              <th className="px-3 py-2 font-medium" scope="col">
                {t("path")}
              </th>
              <th className="px-3 py-2 font-medium" scope="col">
                {t("title")}
              </th>
              <th className="px-3 py-2 font-medium" scope="col">
                {t("status")}
              </th>
              <th className="px-3 py-2 font-medium" scope="col">
                {t("Indexing")}
              </th>
              <th className="px-3 py-2 font-medium" scope="col">
                {t("Publication readiness")}
              </th>
              <th className="px-3 py-2 font-medium" scope="col">
                <span className="sr-only">{t("Actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pages.map((page) => (
              <tr
                className="border-b border-[var(--ad-border)] align-top"
                key={page.path}
              >
                <td className="px-3 py-3 font-mono text-xs">{page.path}</td>
                <td className="px-3 py-3">
                  <p>{page.title}</p>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    Updated {formatTimestamp(page.updatedAt)}
                  </p>
                </td>
                <td className="px-3 py-3 text-[var(--ad-text-muted)]">
                  {valueLabel(page.contentStatus)}
                  {page.publishedAt ? (
                    <p className="mt-1 text-xs">
                      {formatTimestamp(page.publishedAt)}
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-3 text-[var(--ad-text-muted)]">
                  {valueLabel(page.indexingStatus)}
                  {page.canonical ? (
                    <p className="mt-1 max-w-44 truncate font-mono text-xs">
                      {page.canonical}
                    </p>
                  ) : null}
                </td>
                <td className="max-w-80 px-3 py-3">
                  <p
                    className={
                      page.publishability === "ready"
                        ? "text-[var(--ad-green-text)]"
                        : "text-[var(--ad-yellow-text)]"
                    }
                  >
                    {valueLabel(page.publishability)}
                  </p>
                  {page.issues.slice(0, 3).map((issue) => (
                    <p
                      className="mt-1 text-xs text-[var(--ad-text-muted)]"
                      key={`${issue.path}-${issue.code}-${issue.message}`}
                    >
                      {issue.path || "page"}: {issue.message}
                    </p>
                  ))}
                </td>
                <td className="px-3 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    {page.contentStatus !== "published" ? (
                      <button
                        className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs disabled:opacity-50"
                        disabled={
                          !page.editable ||
                          editLoadingPath !== null ||
                          publishBusy
                        }
                        onClick={() => void startEdit(page)}
                        title={
                          page.editable
                            ? t("Edit draft")
                            : t("This route is application-owned")
                        }
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
                        disabled={
                          publishBusy || page.publishability !== "ready"
                        }
                        onClick={() => startPublish(page, "published")}
                        type="button"
                      >
                        <UploadCloud className="h-3.5 w-3.5" />
                        {t("Publish")}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {pages.length === 0 && !loading && !error ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-xs text-[var(--ad-text-muted)]"
                  colSpan={6}
                >
                  {t("No CMS pages yet.")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
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
          <option value="noindex">noindex</option>
          <option value="index">index</option>
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
        <textarea
          aria-label={t("CMS article body JSON")}
          className={`${textAreaClass} md:col-span-2`}
          onChange={(event) =>
            onChange({ ...draft, bodyJson: event.target.value })
          }
          value={draft.bodyJson}
        />
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

function CreatePageForm({ reload }: { reload: () => Promise<void> }) {
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
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const body = parseBodyObject(bodyJson);
      await apiWrite("/api/v1/admin/cms/pages", "POST", {
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
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Create failed");
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
          placeholder="/guides/example"
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
          <option value="noindex">noindex</option>
          <option value="index">index</option>
        </select>
        <textarea
          aria-label={t("CMS article body JSON")}
          className={`${textAreaClass} md:col-span-2`}
          onChange={(event) => setBodyJson(event.target.value)}
          value={bodyJson}
        />
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
        <p className="mt-2 text-xs text-[var(--ad-red-text)]" role="alert">
          {err}
        </p>
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

function parseBodyObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body must be a JSON object");
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

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}
