"use client";

// SPEC: CMS/SEO 内容管理面板（ADMIN_PHASE3_DESIGN §3）。列页面 / 新建 / 发布。
// INTENT: 自取数、无 props；样式对齐 TagsView。body 用 JSON 文本域（{heading,intro,sections,cta}）。
// INVARIANTS: 写需 reason≥3 + confirmation（create/patch=CMS，publish=PUBLISH）；写后 refetch。
import { useEffect, useState } from "react";
import { Loader2, Plus, RefreshCcw, UploadCloud } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";

type PageRow = {
  path: string;
  template: string;
  title: string;
  contentStatus: string;
  updatedAt: string;
};

const inputClass =
  "h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30";

export function CmsView() {
  const [pages, setPages] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  async function publish(path: string, contentStatus: string) {
    const reason = window.prompt(`Reason for setting ${path} → ${contentStatus} (≥3 chars)`);
    if (!reason || reason.trim().length < 3) return;
    try {
      await apiWrite("/api/v1/admin/cms/pages/publish", "POST", {
        path,
        contentStatus,
        reason: reason.trim(),
        confirmation: "PUBLISH",
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">CMS pages ({pages.length})</h2>
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

      <CreatePageForm reload={load} />

      <section className="border border-white/10 bg-[rgb(18,18,18)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs text-[rgb(170,170,170)]">
            <tr>
              <th className="px-3 py-2 font-medium">path</th>
              <th className="px-3 py-2 font-medium">title</th>
              <th className="px-3 py-2 font-medium">status</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {pages.map((page) => (
              <tr key={page.path} className="border-b border-white/5">
                <td className="px-3 py-2 font-mono text-xs">{page.path}</td>
                <td className="px-3 py-2">{page.title}</td>
                <td className="px-3 py-2 text-[rgb(170,170,170)]">{page.contentStatus}</td>
                <td className="px-3 py-2 text-right">
                  {page.contentStatus === "published" ? (
                    <button
                      className="inline-flex h-8 items-center gap-1 border border-white/10 px-2 text-xs"
                      onClick={() => void publish(page.path, "draft")}
                      type="button"
                    >
                      Unpublish
                    </button>
                  ) : (
                    <button
                      className="inline-flex h-8 items-center gap-1 bg-white px-2 text-xs font-semibold text-black"
                      onClick={() => void publish(page.path, "published")}
                      type="button"
                    >
                      <UploadCloud className="h-3.5 w-3.5" />
                      Publish
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {pages.length === 0 && !loading ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-[rgb(170,170,170)]" colSpan={4}>
                  No CMS pages yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function CreatePageForm({ reload }: { reload: () => void }) {
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [bodyJson, setBodyJson] = useState('{\n  "heading": "",\n  "intro": "",\n  "sections": []\n}');
  const [reason, setReason] = useState("");
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
        confirmation: "CMS",
      });
      setPath("");
      setTitle("");
      setDescription("");
      setReason("");
      reload();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  const canCreate =
    !busy && path.trim().startsWith("/") && title.trim().length > 0 && reason.trim().length >= 3;

  return (
    <section className="border border-white/10 bg-[rgb(18,18,18)] p-4">
      <h2 className="text-sm font-semibold">Create / overwrite page (draft)</h2>
      <p className="mt-1 text-xs text-[rgb(170,170,170)]">
        path 须以 / 开头。已发布的页会覆盖同 path 的静态页（ISR 生效），未匹配静态集合的 path 即新页。
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <input className={inputClass} onChange={(e) => setPath(e.target.value)} placeholder="/guides/example" value={path} />
        <input className={inputClass} onChange={(e) => setTitle(e.target.value)} placeholder="Page title" value={title} />
        <input
          className={`${inputClass} md:col-span-2`}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Meta description"
          value={description}
        />
        <textarea
          className="min-h-32 w-full border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs outline-none focus:border-white/30 md:col-span-2"
          onChange={(e) => setBodyJson(e.target.value)}
          value={bodyJson}
        />
        <input
          className={inputClass}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (≥3)"
          value={reason}
        />
        <button
          className="inline-flex h-10 items-center justify-center gap-2 bg-white px-3 text-sm font-semibold text-black disabled:opacity-50"
          disabled={!canCreate}
          onClick={() => void create()}
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Create draft
        </button>
      </div>
      {err ? <p className="mt-2 text-xs text-red-300">{err}</p> : null}
    </section>
  );
}
