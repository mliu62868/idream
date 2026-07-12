"use client";

// SPEC: CMS/SEO 内容管理面板（ADMIN_PHASE3_DESIGN §3）。列页面 / 新建 / 发布。
// INTENT: 自取数、无 props；样式对齐 TagsView。body 用 JSON 文本域（{heading,intro,sections,cta}）。
// INVARIANTS: 写需 reason≥3 + confirmation=page path；写后 refetch。
import { useEffect, useState } from "react";
import { Loader2, Plus, RefreshCcw, UploadCloud } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";

type PageRow = {
  path: string;
  template: string;
  title: string;
  contentStatus: string;
  updatedAt: string;
};

type PublishDraft = {
  path: string;
  nextStatus: "draft" | "published";
  reason: string;
  confirmation: string;
};

const inputClass =
  "rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]";

export function CmsView() {
  const { t, value: valueLabel } = useAdminI18n();
  const [pages, setPages] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [publishDraft, setPublishDraft] = useState<PublishDraft | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: PageRow[] }>("/api/v1/admin/cms/pages");
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

  function startPublish(path: string, nextStatus: PublishDraft["nextStatus"]) {
    setError(null);
    setPublishDraft({ path, nextStatus, reason: "", confirmation: "" });
  }

  async function publish() {
    if (!publishDraft || !canConfirmPublish(publishDraft)) return;
    setPublishBusy(true);
    try {
      await apiWrite("/api/v1/admin/cms/pages/publish", "POST", {
        path: publishDraft.path,
        contentStatus: publishDraft.nextStatus,
        reason: publishDraft.reason.trim(),
        confirmation: publishDraft.confirmation.trim(),
      });
      setPublishDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("CMS pages")} ({pages.length})</h2>
        <button
          className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          {t("Refresh")}
        </button>
      </div>
      {error ? <p className="text-xs text-[var(--ad-red-text)]">{error}</p> : null}

      <CreatePageForm reload={load} />

      {publishDraft ? (
        <section className="rounded-lg border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] p-3">
          <p className="text-xs font-semibold text-[var(--ad-yellow-text)]">
            {t("Confirm CMS status change")} <span className="font-mono">{publishDraft.path}</span> →{" "}
            {valueLabel(publishDraft.nextStatus)}
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_260px_auto_auto]">
            <input
              aria-label={t("CMS publish reason")}
              className={inputClass}
              onChange={(event) => setPublishDraft({ ...publishDraft, reason: event.target.value })}
              placeholder={t("Reason (≥3)")}
              value={publishDraft.reason}
            />
            <input
              aria-label={t("CMS publish confirmation")}
              className={`${inputClass} font-mono`}
              onChange={(event) => setPublishDraft({ ...publishDraft, confirmation: event.target.value })}
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
              {publishBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t("Confirm publish change")}
            </button>
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">CMS pages</caption>
          <thead className="border-b border-[var(--ad-border)] text-xs text-[var(--ad-text-muted)]">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">{t("path")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("title")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("status")}</th>
              <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">{t("Actions")}</span></th>
            </tr>
          </thead>
          <tbody>
            {pages.map((page) => (
              <tr key={page.path} className="border-b border-[var(--ad-border)]">
                <td className="px-3 py-2 font-mono text-xs">{page.path}</td>
                <td className="px-3 py-2">{page.title}</td>
                <td className="px-3 py-2 text-[var(--ad-text-muted)]">{valueLabel(page.contentStatus)}</td>
                <td className="px-3 py-2 text-right">
                  {page.contentStatus === "published" ? (
                    <button
                      className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs"
                      disabled={publishBusy}
                      onClick={() => startPublish(page.path, "draft")}
                      type="button"
                    >
                      {t("Unpublish")}
                    </button>
                  ) : (
                    <button
                      className="inline-flex h-8 items-center gap-1 bg-[var(--ad-ink)] px-2 text-xs font-semibold text-white"
                      disabled={publishBusy}
                      onClick={() => startPublish(page.path, "published")}
                      type="button"
                    >
                      <UploadCloud className="h-3.5 w-3.5" />
                      {t("Publish")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {pages.length === 0 && !loading ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-[var(--ad-text-muted)]" colSpan={4}>
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

function canConfirmPublish(draft: PublishDraft) {
  const confirmation = draft.confirmation.trim();
  return draft.reason.trim().length >= 3 && confirmation === draft.path;
}

function CreatePageForm({ reload }: { reload: () => void }) {
  const { t } = useAdminI18n();
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [bodyJson, setBodyJson] = useState('{\n  "heading": "",\n  "intro": "",\n  "sections": []\n}');
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      let body: Record<string, unknown> = {};
      if (bodyJson.trim()) {
        const parsed = JSON.parse(bodyJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("body must be a JSON object");
        }
        body = parsed as Record<string, unknown>;
      }
      await apiWrite("/api/v1/admin/cms/pages", "POST", {
        path: path.trim(),
        title: title.trim(),
        description: description.trim(),
        body,
        contentStatus: "draft",
        reason: reason.trim(),
        confirmation: confirmation.trim(),
      });
      setPath("");
      setTitle("");
      setDescription("");
      setReason("");
      setConfirmation("");
      reload();
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
      <h2 className="text-sm font-semibold">{t("Create / overwrite page (draft)")}</h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
        path 须以 / 开头。已发布的页会覆盖同 path 的静态页（ISR 生效），未匹配静态集合的 path 即新页。
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <input className={inputClass} onChange={(e) => setPath(e.target.value)} placeholder="/guides/example" value={path} />
        <input className={inputClass} onChange={(e) => setTitle(e.target.value)} placeholder={t("Page title")} value={title} />
        <input
          className={`${inputClass} md:col-span-2`}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("Meta description")}
          value={description}
        />
        <textarea
          className="rounded-md min-h-32 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--ad-ink)] md:col-span-2"
          onChange={(e) => setBodyJson(e.target.value)}
          value={bodyJson}
        />
        <input
          className={inputClass}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("Reason (≥3)")}
          value={reason}
        />
        <input
          aria-label={t("CMS page confirmation")}
          className={`${inputClass} font-mono`}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder={t("Type page path")}
          value={confirmation}
        />
        <button
          className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50 md:col-span-2"
          disabled={!canCreate}
          onClick={() => void create()}
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t("Create draft")}
        </button>
      </div>
      {err ? <p className="mt-2 text-xs text-[var(--ad-red-text)]">{err}</p> : null}
    </section>
  );
}
