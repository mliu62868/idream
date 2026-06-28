"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, CheckCircle2, Loader2, Pencil, Plus, RefreshCcw, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiGet, apiWrite } from "@/components/admin/api";

// SPEC: 角色创建模板库（特性 B）admin 视图——列出 / 新建 / 编辑 / 上下线模板。
// INTENT: 自取数、无 props；样式严格沿用 PromoView 的暗色表单/表格语汇。
// INVARIANTS: 写操作后 refetch；reason ≥3、name ≥1 才允许提交。

const ADMIN_LIST = "/api/v1/admin/content/templates";

type Template = {
  id: string;
  scope: string;
  name: string;
  summary: string | null;
  gender: string | null;
  style: string | null;
  tags: string[];
  isActive: boolean;
  sortOrder: number;
};

function intFromText(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tagsFromText(value: string) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

const EMPTY_FORM = {
  name: "",
  summary: "",
  gender: "",
  style: "",
  scope: "built_in",
  tags: "",
  sortOrder: "0",
  reason: "",
};

export function TemplatesView() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  // AI 辅助：一句话 seed → 填充 summary（截断 200）+ 把性格特质并入 tags。
  const [seed, setSeed] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await apiGet<{ items: Template[] }>(ADMIN_LIST);
      setTemplates(data.items);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  function resetForm() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
  }

  function startEdit(template: Template) {
    setEditingId(template.id);
    setForm({
      name: template.name,
      summary: template.summary ?? "",
      gender: template.gender ?? "",
      style: template.style ?? "",
      scope: template.scope,
      tags: template.tags.join(", "),
      sortOrder: String(template.sortOrder),
      reason: "",
    });
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        name: form.name.trim(),
        summary: form.summary.trim() || undefined,
        gender: form.gender.trim() || undefined,
        style: form.style.trim() || undefined,
        scope: form.scope,
        tags: tagsFromText(form.tags),
        sortOrder: intFromText(form.sortOrder, 0),
        reason: form.reason.trim(),
      };
      if (editingId) {
        await apiWrite(`${ADMIN_LIST}/${editingId}`, "PATCH", payload);
      } else {
        await apiWrite(ADMIN_LIST, "POST", payload);
      }
      resetForm();
      await reload();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function generateWithAI() {
    setAssisting(true);
    setAssistError(null);
    try {
      const data = await apiWrite<{ description: string; advancedDetails: { personality: string } }>(
        "/api/v1/admin/content/character-assist",
        "POST",
        { seed: seed.trim() },
      );
      const summary = data.description.slice(0, 200);
      const traits = data.advancedDetails?.personality?.trim() ?? "";
      setForm((f) => {
        const existing = f.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
        const added = traits.split(",").map((tag) => tag.trim()).filter(Boolean);
        const merged = [...new Set([...existing, ...added])].slice(0, 12).join(", ");
        return { ...f, summary, tags: merged };
      });
    } catch (error) {
      setAssistError(error instanceof Error ? error.message : "Generate failed");
    } finally {
      setAssisting(false);
    }
  }

  async function toggleActive(template: Template) {
    setBusy(true);
    setErr(null);
    try {
      await apiWrite(`${ADMIN_LIST}/${template.id}/active`, "POST", {
        active: !template.isActive,
        reason: template.isActive ? "take offline" : "publish",
      });
      await reload();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = form.name.trim().length >= 1 && form.reason.trim().length >= 3;

  return (
    <div className="space-y-5">
      <section className="border border-white/10 bg-[rgb(18,18,18)] p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {editingId ? `Edit template ${editingId}` : "Create character template"}
          </h2>
          {editingId ? (
            <button
              className="inline-flex h-8 items-center gap-1 border border-white/10 px-2 text-xs text-[rgb(170,170,170)] hover:border-white/30"
              onClick={resetForm}
              type="button"
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-[rgb(170,170,170)]">
          模板是创建脚手架——前台选完即与已建角色脱钩，不做继承/版本。
        </p>
        <div className="mt-3 flex flex-col gap-2 border border-dashed border-white/15 bg-black/20 p-3 sm:flex-row sm:items-center">
          <input
            className="h-10 w-full flex-1 border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setSeed(event.target.value)}
            placeholder="AI seed: 一句话灵感 → 填充 Summary + Tags"
            value={seed}
          />
          <button
            className="inline-flex h-10 shrink-0 items-center gap-2 border border-white/20 px-3 text-sm font-semibold disabled:opacity-50"
            disabled={assisting || seed.trim().length < 3}
            onClick={() => void generateWithAI()}
            type="button"
          >
            {assisting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Generate with AI
          </button>
          {assistError ? <p className="text-xs text-red-300">{assistError}</p> : null}
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
            placeholder="Name (≥1)"
            value={form.name}
          />
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setForm((f) => ({ ...f, summary: event.target.value }))}
            placeholder="Summary (≤200)"
            value={form.summary}
          />
          <select
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setForm((f) => ({ ...f, scope: event.target.value }))}
            value={form.scope}
          >
            <option value="built_in">built_in</option>
            <option value="community">community</option>
          </select>
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setForm((f) => ({ ...f, gender: event.target.value }))}
            placeholder="Gender"
            value={form.gender}
          />
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setForm((f) => ({ ...f, style: event.target.value }))}
            placeholder="Style"
            value={form.style}
          />
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setForm((f) => ({ ...f, tags: event.target.value }))}
            placeholder="Tags (comma-separated, ≤12)"
            value={form.tags}
          />
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setForm((f) => ({ ...f, sortOrder: event.target.value }))}
            placeholder="Sort order"
            value={form.sortOrder}
          />
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setForm((f) => ({ ...f, reason: event.target.value }))}
            placeholder="Reason (≥3)"
            value={form.reason}
          />
          <button
            className="inline-flex h-10 items-center justify-center gap-2 bg-white px-3 text-sm font-semibold text-black disabled:opacity-50"
            disabled={busy || !canSubmit}
            onClick={() => void submit()}
            type="button"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : editingId ? (
              <Pencil className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {editingId ? "Save" : "Create"}
          </button>
        </div>
        {err ? <p className="mt-2 text-xs text-red-300">{err}</p> : null}
      </section>

      <section className="border border-white/10 bg-[rgb(18,18,18)]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold">Templates</h2>
          <button
            className="inline-flex h-8 items-center gap-1 border border-white/10 px-2 text-xs text-[rgb(170,170,170)] hover:border-white/30"
            onClick={() => void reload()}
            type="button"
          >
            <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Reload
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-[rgb(170,170,170)]">
              <tr className="border-b border-white/10">
                <th className="px-4 py-2 font-medium">name</th>
                <th className="px-4 py-2 font-medium">scope</th>
                <th className="px-4 py-2 font-medium">active</th>
                <th className="px-4 py-2 font-medium">sortOrder</th>
                <th className="px-4 py-2 font-medium">tags</th>
                <th className="px-4 py-2 font-medium">actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-xs text-[rgb(170,170,170)]" colSpan={6}>
                    {loading ? "Loading…" : "No templates yet."}
                  </td>
                </tr>
              ) : (
                templates.map((template) => (
                  <tr className="border-b border-white/5" key={template.id}>
                    <td className="px-4 py-2">{template.name}</td>
                    <td className="px-4 py-2 text-[rgb(170,170,170)]">{template.scope}</td>
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 text-xs",
                          template.isActive ? "text-emerald-300" : "text-[rgb(170,170,170)]",
                        )}
                      >
                        {template.isActive ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <Ban className="h-3.5 w-3.5" />
                        )}
                        {template.isActive ? "active" : "offline"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-[rgb(170,170,170)]">{template.sortOrder}</td>
                    <td className="px-4 py-2 text-xs text-[rgb(170,170,170)]">
                      {template.tags.join(", ") || "—"}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          className="inline-flex h-8 items-center gap-1 border border-white/10 px-2 text-xs hover:border-white/30 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => startEdit(template)}
                          type="button"
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </button>
                        <button
                          className="inline-flex h-8 items-center gap-1 border border-white/10 px-2 text-xs hover:border-white/30 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => void toggleActive(template)}
                          type="button"
                        >
                          {template.isActive ? (
                            <>
                              <Ban className="h-3.5 w-3.5" /> Offline
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="h-3.5 w-3.5" /> Publish
                            </>
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
