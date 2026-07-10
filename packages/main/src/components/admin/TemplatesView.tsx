"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, CheckCircle2, Loader2, Pencil, Plus, RefreshCcw, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";

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

type TemplateActionDraft = {
  templateId: string;
  templateName: string;
  active: boolean;
  reason: string;
  confirmation: string;
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
  const { t, value: valueLabel } = useAdminI18n();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [actionDraft, setActionDraft] = useState<TemplateActionDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  // AI 辅助：一句话 seed → 填充 summary（截断 200）+ 把性格特质并入 tags。
  const [seed, setSeed] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setNotice(null);
    setConfirmKey(null);
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
    setNotice(null);
    setConfirmKey(null);
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
    setNotice(null);
    setConfirmKey(null);
  }

  function updateForm(next: typeof form) {
    setForm(next);
    setNotice(null);
    setConfirmKey(null);
  }

  async function submit() {
    const nextKey = templateFormConfirmKey({ editingId, form });
    if (confirmKey !== nextKey) {
      setErr(null);
      setNotice(
        editingId
          ? "Press Confirm save template to update this character template."
          : "Press Confirm create template to publish this character template.",
      );
      setConfirmKey(nextKey);
      return;
    }
    setBusy(true);
    setErr(null);
    setNotice(null);
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
      setConfirmKey(null);
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

  function startToggleActive(template: Template) {
    setErr(null);
    setNotice(null);
    setActionDraft({
      templateId: template.id,
      templateName: template.name,
      active: !template.isActive,
      reason: "",
      confirmation: "",
    });
  }

  async function confirmToggleActive() {
    if (!actionDraft) return;
    setBusy(true);
    setErr(null);
    try {
      await apiWrite(`${ADMIN_LIST}/${actionDraft.templateId}/active`, "POST", {
        active: actionDraft.active,
        reason: actionDraft.reason.trim(),
        confirmation: actionDraft.confirmation.trim(),
      });
      setActionDraft(null);
      await reload();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = form.name.trim().length >= 1 && form.reason.trim().length >= 3;
  const formConfirming = confirmKey === templateFormConfirmKey({ editingId, form });
  const actionConfirmation = actionDraft?.templateId ?? "";
  const canConfirmAction =
    Boolean(actionDraft) &&
    !busy &&
    (actionDraft?.reason.trim().length ?? 0) >= 3 &&
    actionDraft?.confirmation.trim() === actionConfirmation;

  return (
    <div className="space-y-5">
      {notice ? (
        <div className="rounded-lg border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] px-4 py-3 text-sm text-[var(--ad-yellow-text)]">
          {notice}
        </div>
      ) : null}
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {editingId ? `${t("Edit template")} ${editingId}` : t("Create character template")}
          </h2>
          {editingId ? (
            <button
              className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text-muted)] hover:border-[var(--ad-ink)]"
              onClick={resetForm}
              type="button"
            >
              <X className="h-3.5 w-3.5" /> {t("Cancel")}
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
          模板是创建脚手架——前台选完即与已建角色脱钩，不做继承/版本。
        </p>
        <div className="rounded-lg mt-3 flex flex-col gap-2 border border-dashed border-[var(--ad-border)] bg-black/[0.03] p-3 sm:flex-row sm:items-center">
          <input
            className="rounded-md h-10 w-full flex-1 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => setSeed(event.target.value)}
            placeholder={t("AI seed: 一句话灵感 → 填充 Summary + Tags")}
            value={seed}
          />
          <button
            className="rounded-md inline-flex h-10 shrink-0 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm font-semibold disabled:opacity-50"
            disabled={assisting || seed.trim().length < 3}
            onClick={() => void generateWithAI()}
            type="button"
          >
            {assisting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {t("Generate with AI")}
          </button>
          {assistError ? <p className="text-xs text-[var(--ad-red-text)]">{assistError}</p> : null}
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => updateForm({ ...form, name: event.target.value })}
            placeholder={t("Name (≥1)")}
            value={form.name}
          />
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => updateForm({ ...form, summary: event.target.value })}
            placeholder={t("Summary (≤200)")}
            value={form.summary}
          />
          <select
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => updateForm({ ...form, scope: event.target.value })}
            value={form.scope}
          >
          <option value="built_in">{valueLabel("built_in")}</option>
          <option value="community">{valueLabel("community")}</option>
          </select>
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => updateForm({ ...form, gender: event.target.value })}
            placeholder={t("Gender")}
            value={form.gender}
          />
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => updateForm({ ...form, style: event.target.value })}
            placeholder={t("Style")}
            value={form.style}
          />
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => updateForm({ ...form, tags: event.target.value })}
            placeholder={t("Tags (comma-separated, ≤12)")}
            value={form.tags}
          />
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => updateForm({ ...form, sortOrder: event.target.value })}
            placeholder={t("Sort order")}
            value={form.sortOrder}
          />
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => updateForm({ ...form, reason: event.target.value })}
            placeholder={t("Reason (≥3)")}
            value={form.reason}
          />
          <button
            className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
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
            {formConfirming
              ? editingId
                ? t("Confirm save template")
                : t("Confirm create template")
              : editingId
                ? t("Save")
                : t("Create")}
          </button>
        </div>
        {err ? <p className="mt-2 text-xs text-[var(--ad-red-text)]">{err}</p> : null}
      </section>

      {actionDraft ? (
        <section className="rounded-lg border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">
                {actionDraft.active ? t("Confirm publish template") : t("Confirm offline template")}
              </h2>
              <p className="mt-1 text-xs text-[var(--ad-yellow-text)]/80">
                {actionDraft.templateName} · {t("Type")} {t("template ID")} {actionConfirmation}
              </p>
            </div>
            <button
              className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs"
              disabled={busy}
              onClick={() => setActionDraft(null)}
              type="button"
            >
              <X className="h-3.5 w-3.5" />
              {t("Cancel")}
            </button>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto]">
            <input
              aria-label="Template action reason"
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
              onChange={(event) => setActionDraft({ ...actionDraft, reason: event.target.value })}
              placeholder={t("Reason (≥3)")}
              value={actionDraft.reason}
            />
            <input
              aria-label="Template action confirmation"
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 font-mono text-sm outline-none focus:border-[var(--ad-ink)]"
              onChange={(event) => setActionDraft({ ...actionDraft, confirmation: event.target.value })}
              placeholder={actionConfirmation}
              value={actionDraft.confirmation}
            />
            <button
              className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-yellow-bg)] px-3 text-sm font-semibold text-[var(--ad-yellow-text)] disabled:opacity-50"
              disabled={!canConfirmAction}
              onClick={() => void confirmToggleActive()}
              type="button"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {actionDraft.active ? t("Confirm publish") : t("Confirm offline")}
            </button>
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <div className="flex items-center justify-between border-b border-[var(--ad-border)] px-4 py-3">
          <h2 className="text-sm font-semibold">{t("Character Starters")}</h2>
          <button
            className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text-muted)] hover:border-[var(--ad-ink)]"
            onClick={() => void reload()}
            type="button"
          >
            <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> {t("Reload")}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-[var(--ad-text-muted)]">
              <tr className="border-b border-[var(--ad-border)]">
                <th className="px-4 py-2 font-medium">{t("name")}</th>
                <th className="px-4 py-2 font-medium">{t("scope")}</th>
                <th className="px-4 py-2 font-medium">{t("active")}</th>
                <th className="px-4 py-2 font-medium">{t("sortOrder")}</th>
                <th className="px-4 py-2 font-medium">{t("tags")}</th>
                <th className="px-4 py-2 font-medium">{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-xs text-[var(--ad-text-muted)]" colSpan={6}>
                    {loading ? t("Loading…") : t("No templates yet.")}
                  </td>
                </tr>
              ) : (
                templates.map((template) => (
                  <tr className="border-b border-[var(--ad-border)]" key={template.id}>
                    <td className="px-4 py-2">{template.name}</td>
                    <td className="px-4 py-2 text-[var(--ad-text-muted)]">{valueLabel(template.scope)}</td>
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 text-xs",
                          template.isActive ? "text-[var(--ad-green-text)]" : "text-[var(--ad-text-muted)]",
                        )}
                      >
                        {template.isActive ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <Ban className="h-3.5 w-3.5" />
                        )}
                        {template.isActive ? valueLabel("active") : valueLabel("offline")}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-[var(--ad-text-muted)]">{template.sortOrder}</td>
                    <td className="px-4 py-2 text-xs text-[var(--ad-text-muted)]">
                      {template.tags.join(", ") || "—"}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs hover:border-[var(--ad-ink)] disabled:opacity-50"
                          disabled={busy}
                          onClick={() => startEdit(template)}
                          type="button"
                        >
                          <Pencil className="h-3.5 w-3.5" /> {t("Edit")}
                        </button>
                        <button
                          className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs hover:border-[var(--ad-ink)] disabled:opacity-50"
                          disabled={busy}
                          onClick={() => startToggleActive(template)}
                          type="button"
                        >
                          {template.isActive ? (
                            <>
                              <Ban className="h-3.5 w-3.5" /> {t("Offline")}
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="h-3.5 w-3.5" /> {t("Publish")}
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

function templateFormConfirmKey({ editingId, form }: { editingId: string | null; form: typeof EMPTY_FORM }) {
  return [
    editingId ? `template:update:${editingId}` : "template:create",
    form.name.trim(),
    form.summary.trim(),
    form.gender.trim(),
    form.style.trim(),
    form.scope,
    form.tags.trim(),
    form.sortOrder.trim(),
    form.reason.trim(),
  ].join(":");
}
