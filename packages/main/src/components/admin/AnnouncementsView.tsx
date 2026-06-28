"use client";

// SPEC: 公告/banner 后台面板（ADMIN_PHASE4_DESIGN §3）。新建 / 启停 / 删除，写后 refetch。
// INTENT: 自取数、无 props；样式对齐 TagsView。启停/删除经 prompt 收 reason（≥3）。
import { useEffect, useState } from "react";
import { Loader2, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";

type Announcement = {
  id: string;
  title: string;
  body: string;
  level: "info" | "promo" | "warning";
  active: boolean;
  href: string | null;
  createdAt: string;
};

const inputClass =
  "h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30";

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
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  async function toggleActive(item: Announcement) {
    const reason = window.prompt(`Reason for ${item.active ? "deactivating" : "activating"} (≥3)`);
    if (!reason || reason.trim().length < 3) return;
    try {
      await apiWrite(`/api/v1/admin/announcements/${item.id}`, "PATCH", {
        active: !item.active,
        reason: reason.trim(),
        confirmation: "ANNOUNCE",
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  async function remove(item: Announcement) {
    const reason = window.prompt(`Reason for deleting "${item.title}" (≥3)`);
    if (!reason || reason.trim().length < 3) return;
    try {
      await apiDelete(`/api/v1/admin/announcements/${item.id}`, {
        reason: reason.trim(),
        confirmation: "DELETE",
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Announcements ({items.length})</h2>
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

      <CreateAnnouncementForm reload={load} />

      <section className="border border-white/10 bg-[rgb(18,18,18)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs text-[rgb(170,170,170)]">
            <tr>
              <th className="px-3 py-2 font-medium">title</th>
              <th className="px-3 py-2 font-medium">level</th>
              <th className="px-3 py-2 font-medium">active</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-white/5">
                <td className="px-3 py-2">{item.title}</td>
                <td className="px-3 py-2 text-[rgb(170,170,170)]">{item.level}</td>
                <td className="px-3 py-2">{item.active ? "yes" : "no"}</td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      className="inline-flex h-8 items-center gap-1 border border-white/10 px-2 text-xs"
                      onClick={() => void toggleActive(item)}
                      type="button"
                    >
                      {item.active ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      className="inline-flex h-8 items-center gap-1 border border-red-400/30 px-2 text-xs text-red-200"
                      onClick={() => void remove(item)}
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
                <td className="px-3 py-6 text-center text-xs text-[rgb(170,170,170)]" colSpan={4}>
                  No announcements.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function CreateAnnouncementForm({ reload }: { reload: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [level, setLevel] = useState<"info" | "promo" | "warning">("info");
  const [active, setActive] = useState(true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      await apiWrite("/api/v1/admin/announcements", "POST", {
        title: title.trim(),
        body: body.trim(),
        level,
        active,
        reason: reason.trim(),
        confirmation: "ANNOUNCE",
      });
      setTitle("");
      setBody("");
      setReason("");
      reload();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  const canCreate =
    !busy && title.trim().length > 0 && body.trim().length > 0 && reason.trim().length >= 3;

  return (
    <section className="border border-white/10 bg-[rgb(18,18,18)] p-4">
      <h2 className="text-sm font-semibold">Create announcement</h2>
      <p className="mt-1 text-xs text-[rgb(170,170,170)]">站内 banner（即站内广播渠道）。active 即对全站可见。</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <input className={inputClass} onChange={(e) => setTitle(e.target.value)} placeholder="Title" value={title} />
        <input className={inputClass} onChange={(e) => setBody(e.target.value)} placeholder="Body" value={body} />
        <select
          className={`${inputClass} appearance-none`}
          onChange={(e) => setLevel(e.target.value as "info" | "promo" | "warning")}
          value={level}
        >
          <option value="info">info</option>
          <option value="promo">promo</option>
          <option value="warning">warning</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-[rgb(170,170,170)]">
          <input checked={active} onChange={(e) => setActive(e.target.checked)} type="checkbox" />
          Active immediately
        </label>
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
          Create
        </button>
      </div>
      {err ? <p className="mt-2 text-xs text-red-300">{err}</p> : null}
    </section>
  );
}
