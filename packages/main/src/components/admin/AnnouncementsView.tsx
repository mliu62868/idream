"use client";

// SPEC: 公告/banner 后台面板（ADMIN_PHASE4_DESIGN §3）。新建 / 启停 / 删除，写后 refetch。
// INTENT: 自取数、无 props；样式对齐 TagsView。启停/删除经 inline typed confirmation。
import { useEffect, useState } from "react";
import { Loader2, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";

type Announcement = {
  id: string;
  title: string;
  body: string;
  level: "info" | "promo" | "warning";
  active: boolean;
  href: string | null;
  createdAt: string;
};

type AnnouncementActionDraft = {
  kind: "toggle" | "delete";
  item: Announcement;
  reason: string;
  confirmation: string;
};

const inputClass =
  "rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]";

async function apiDelete(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(path, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { ok: boolean; error?: { message?: string } };
  if (!payload.ok) throw new Error(payload.error?.message ?? "Delete failed");
}

export function AnnouncementsView() {
  const { t, value: valueLabel } = useAdminI18n();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionDraft, setActionDraft] = useState<AnnouncementActionDraft | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: Announcement[] }>("/api/v1/admin/announcements");
      setItems(data.items);
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

  function startAction(kind: AnnouncementActionDraft["kind"], item: Announcement) {
    setError(null);
    setActionDraft({ kind, item, reason: "", confirmation: "" });
  }

  async function submitAction() {
    if (!actionDraft || !canConfirmAnnouncementAction(actionDraft)) return;
    setActionBusy(true);
    try {
      if (actionDraft.kind === "toggle") {
        await apiWrite(`/api/v1/admin/announcements/${actionDraft.item.id}`, "PATCH", {
          active: !actionDraft.item.active,
          reason: actionDraft.reason.trim(),
          confirmation: actionDraft.confirmation.trim(),
        });
      } else {
        await apiDelete(`/api/v1/admin/announcements/${actionDraft.item.id}`, {
          reason: actionDraft.reason.trim(),
          confirmation: actionDraft.confirmation.trim(),
        });
      }
      setActionDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Announcement action failed");
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("Announcements")} ({items.length})</h2>
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

      <CreateAnnouncementForm reload={load} />

      {actionDraft ? (
        <section className="rounded-lg border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] p-3">
          <p className="text-xs font-semibold text-[var(--ad-yellow-text)]">
            {actionDraft.kind === "delete"
              ? t("Confirm announcement delete")
              : actionDraft.item.active
                ? t("Confirm announcement deactivation")
                : t("Confirm announcement activation")}{" "}
            <span className="font-mono">{actionDraft.item.id}</span>
          </p>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{actionDraft.item.title}</p>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_260px_auto_auto]">
            <input
              aria-label={t("Announcement action reason")}
              className={inputClass}
              onChange={(event) => setActionDraft({ ...actionDraft, reason: event.target.value })}
              placeholder={t("Reason (≥3)")}
              value={actionDraft.reason}
            />
            <input
              aria-label={t("Announcement action confirmation")}
              className={`${inputClass} font-mono`}
              onChange={(event) => setActionDraft({ ...actionDraft, confirmation: event.target.value })}
              placeholder={actionDraft.item.id}
              value={actionDraft.confirmation}
            />
            <button
              className="rounded-md inline-flex h-10 items-center justify-center border border-[var(--ad-border)] px-3 text-sm"
              onClick={() => setActionDraft(null)}
              type="button"
            >
              {t("Cancel")}
            </button>
            <button
              className="inline-flex h-10 items-center justify-center bg-[var(--ad-yellow-bg)] px-3 text-sm font-semibold text-[var(--ad-yellow-text)] disabled:opacity-50"
              disabled={actionBusy || !canConfirmAnnouncementAction(actionDraft)}
              onClick={() => void submitAction()}
              type="button"
            >
              {actionBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {actionDraft.kind === "delete" ? t("Confirm delete") : t("Confirm update")}
            </button>
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--ad-border)] text-xs text-[var(--ad-text-muted)]">
            <tr>
              <th className="px-3 py-2 font-medium">{t("title")}</th>
              <th className="px-3 py-2 font-medium">{t("level")}</th>
              <th className="px-3 py-2 font-medium">{t("active")}</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-[var(--ad-border)]">
                <td className="px-3 py-2">{item.title}</td>
                <td className="px-3 py-2 text-[var(--ad-text-muted)]">{valueLabel(item.level)}</td>
                <td className="px-3 py-2">{item.active ? t("yes") : t("no")}</td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs"
                      disabled={actionBusy}
                      onClick={() => startAction("toggle", item)}
                      type="button"
                    >
                      {item.active ? t("Deactivate") : t("Activate")}
                    </button>
                    <button
                      aria-label={t("Delete announcement")}
                      className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-red-text)]/20 px-2 text-xs text-[var(--ad-red-text)]"
                      disabled={actionBusy}
                      onClick={() => startAction("delete", item)}
                      type="button"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && !loading ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-[var(--ad-text-muted)]" colSpan={4}>
                  {t("No announcements.")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function canConfirmAnnouncementAction(draft: AnnouncementActionDraft) {
  const confirmation = draft.confirmation.trim();
  return draft.reason.trim().length >= 3 && confirmation === draft.item.id;
}

function CreateAnnouncementForm({ reload }: { reload: () => void }) {
  const { t, value: valueLabel } = useAdminI18n();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [href, setHref] = useState("");
  const [level, setLevel] = useState<"info" | "promo" | "warning">("info");
  const [active, setActive] = useState(true);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const trimmedTitle = title.trim();

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      await apiWrite("/api/v1/admin/announcements", "POST", {
        title: title.trim(),
        body: body.trim(),
        href: href.trim() || null,
        level,
        active,
        reason: reason.trim(),
        confirmation: confirmation.trim(),
      });
      setTitle("");
      setBody("");
      setHref("");
      setReason("");
      setConfirmation("");
      reload();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  const canCreate =
    !busy &&
    trimmedTitle.length > 0 &&
    body.trim().length > 0 &&
    reason.trim().length >= 3 &&
    confirmation.trim() === trimmedTitle;

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h2 className="text-sm font-semibold">{t("Create announcement")}</h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">站内 banner（即站内广播渠道）。active 即对全站可见。</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <input className={inputClass} onChange={(e) => setTitle(e.target.value)} placeholder={t("Title")} value={title} />
        <input className={inputClass} onChange={(e) => setBody(e.target.value)} placeholder={t("Body")} value={body} />
        <input
          aria-label={t("Link URL (optional)")}
          className={inputClass}
          onChange={(e) => setHref(e.target.value)}
          placeholder={t("Link URL (optional)")}
          value={href}
        />
        <select
          className={`${inputClass} appearance-none`}
          onChange={(e) => setLevel(e.target.value as "info" | "promo" | "warning")}
          value={level}
        >
          <option value="info">{valueLabel("info")}</option>
          <option value="promo">{valueLabel("promo")}</option>
          <option value="warning">{valueLabel("warning")}</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-[var(--ad-text-muted)]">
          <input checked={active} onChange={(e) => setActive(e.target.checked)} type="checkbox" />
          {t("Active immediately")}
        </label>
        <input
          className={inputClass}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("Reason (≥3)")}
          value={reason}
        />
        <input
          aria-label={t("Announcement create confirmation")}
          className={inputClass}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder={t("Type title to confirm")}
          value={confirmation}
        />
        <button
          className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={!canCreate}
          onClick={() => void create()}
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t("Create")}
        </button>
      </div>
      {err ? <p className="mt-2 text-xs text-[var(--ad-red-text)]">{err}</p> : null}
    </section>
  );
}
