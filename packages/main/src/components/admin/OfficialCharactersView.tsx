"use client";

// SPEC: 官方角色 CMS 后台视图（Feature A）。自取数：首次挂载拉 list，写操作后 refetch。
//       提供新建表单 + 每行 archive/publish 切换（带原因输入，服务端审计要求 reason≥3）。
// INTENT: className/表格/按钮/输入风格严格对齐 AdminConsoleClient 的 PromoView，保持后台一致观感。
// INVARIANTS: 所有写操作经 /api/v1/admin/content/official*，由 content.official.write 门控；错误本地展示。
import { useCallback, useEffect, useState } from "react";
import { Archive, Loader2, Plus, Sparkles, Upload } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { cn } from "@/lib/utils";

type OfficialStats = {
  chatsCount: number;
  likesCount: number;
  viewsCount: number;
} | null;

type OfficialRow = {
  id: string;
  name: string;
  gender: string;
  style: string;
  status: string;
  visibility: string;
  createdAt: string;
  stats: OfficialStats;
};

const GENDERS = ["female", "male", "trans"] as const;
const STYLES = ["realistic", "anime", "hybrid", "other"] as const;

function intFromText(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function OfficialCharactersView() {
  const [rows, setRows] = useState<OfficialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [age, setAge] = useState("24");
  const [gender, setGender] = useState<(typeof GENDERS)[number]>("female");
  const [style, setStyle] = useState<(typeof STYLES)[number]>("realistic");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [reason, setReason] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // AI 辅助：一句话 seed → 填充 description + 把性格特质并入 tags。
  const [seed, setSeed] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);

  // 每行待执行操作的原因输入（审计要求 reason≥3）。
  const [rowReason, setRowReason] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const data = await apiGet<{ items: OfficialRow[] }>("/api/v1/admin/content/official");
      setRows(data.items);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Load failed");
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

  async function generateWithAI() {
    setAssisting(true);
    setAssistError(null);
    try {
      const data = await apiWrite<{ description: string; advancedDetails: { personality: string } }>(
        "/api/v1/admin/content/character-assist",
        "POST",
        { seed: seed.trim(), gender, style },
      );
      setDescription(data.description);
      const traits = data.advancedDetails?.personality?.trim();
      if (traits) {
        setTags((prev) => {
          const existing = prev.split(",").map((tag) => tag.trim()).filter(Boolean);
          const added = traits.split(",").map((tag) => tag.trim()).filter(Boolean);
          return [...new Set([...existing, ...added])].join(", ");
        });
      }
    } catch (error) {
      setAssistError(error instanceof Error ? error.message : "Generate failed");
    } finally {
      setAssisting(false);
    }
  }

  async function createCharacter() {
    setCreating(true);
    setCreateError(null);
    try {
      await apiWrite("/api/v1/admin/content/official", "POST", {
        name: name.trim(),
        age: intFromText(age, 18),
        gender,
        style,
        description: description.trim(),
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        reason: reason.trim(),
      });
      setName("");
      setAge("24");
      setGender("female");
      setStyle("realistic");
      setDescription("");
      setTags("");
      setReason("");
      await reload();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function setState(id: string, status: "approved" | "archived") {
    const actionReason = (rowReason[id] ?? "").trim();
    setRowBusy(id);
    setRowError(null);
    try {
      await apiWrite(`/api/v1/admin/content/official/${id}/state`, "POST", {
        status,
        reason: actionReason,
      });
      setRowReason((prev) => ({ ...prev, [id]: "" }));
      await reload();
    } catch (error) {
      setRowError(error instanceof Error ? error.message : "Update failed");
    } finally {
      setRowBusy(null);
    }
  }

  const createDisabled =
    creating ||
    name.trim().length < 1 ||
    description.trim().length < 1 ||
    reason.trim().length < 3 ||
    intFromText(age, 0) < 18;

  return (
    <div className="space-y-5">
      <section className="border border-white/10 bg-[rgb(18,18,18)] p-4">
        <h2 className="text-sm font-semibold">Create official character</h2>
        <p className="mt-1 text-xs text-[rgb(170,170,170)]">
          官方角色直接 approved + public，跳过用户审核但仍过 moderation。age 必须 ≥18。
        </p>
        <div className="mt-3 flex flex-col gap-2 border border-dashed border-white/15 bg-black/20 p-3 sm:flex-row sm:items-center">
          <input
            className="h-10 w-full flex-1 border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setSeed(event.target.value)}
            placeholder="AI seed: 一句话灵感，如 “爱雨夜的害羞画家”"
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
        <div className="mt-3 grid gap-3 md:grid-cols-5">
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setName(event.target.value)}
            placeholder="Name (1-80)"
            value={name}
          />
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setAge(event.target.value)}
            placeholder="Age (≥18)"
            value={age}
          />
          <select
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setGender(event.target.value as (typeof GENDERS)[number])}
            value={gender}
          >
            {GENDERS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setStyle(event.target.value as (typeof STYLES)[number])}
            value={style}
          >
            {STYLES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setTags(event.target.value)}
            placeholder="Tags (comma-sep)"
            value={tags}
          />
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <textarea
            className="min-h-20 w-full border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description (1-1500)"
            value={description}
          />
          <textarea
            className="min-h-20 w-full border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (≥3, for audit)"
            value={reason}
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            className="inline-flex h-10 items-center gap-2 bg-white px-3 text-sm font-semibold text-black disabled:opacity-50"
            disabled={createDisabled}
            onClick={() => void createCharacter()}
            type="button"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create
          </button>
          {createError ? <p className="text-xs text-red-300">{createError}</p> : null}
        </div>
      </section>

      <section className="border border-white/10 bg-[rgb(18,18,18)]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold">Official characters</h2>
          <span className="text-xs text-[rgb(170,170,170)]">{rows.length} total</span>
        </div>
        {rowError ? <p className="px-4 pt-2 text-xs text-red-300">{rowError}</p> : null}
        {listError ? <p className="px-4 py-3 text-xs text-red-300">{listError}</p> : null}
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-[rgb(170,170,170)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-[rgb(140,140,140)]">
                <tr className="border-b border-white/10">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Gender</th>
                  <th className="px-4 py-2 font-medium">Style</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Chats</th>
                  <th className="px-4 py-2 font-medium">Reason</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-[rgb(170,170,170)]" colSpan={7}>
                      No official characters yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const busy = rowBusy === row.id;
                    const canAct = (rowReason[row.id] ?? "").trim().length >= 3 && !busy;
                    return (
                      <tr className="border-b border-white/5" key={row.id}>
                        <td className="px-4 py-2">
                          <div className="font-medium">{row.name}</div>
                          <div className="font-mono text-xs text-[rgb(140,140,140)]">{row.id}</div>
                        </td>
                        <td className="px-4 py-2">{row.gender}</td>
                        <td className="px-4 py-2">{row.style}</td>
                        <td className="px-4 py-2">
                          <span
                            className={cn(
                              "inline-flex items-center px-2 py-0.5 text-xs",
                              row.status === "approved"
                                ? "bg-emerald-500/15 text-emerald-300"
                                : "bg-white/10 text-[rgb(180,180,180)]",
                            )}
                          >
                            {row.status}
                          </span>
                        </td>
                        <td className="px-4 py-2">{row.stats?.chatsCount ?? 0}</td>
                        <td className="px-4 py-2">
                          <input
                            className="h-9 w-40 border border-white/10 bg-black/30 px-2 text-xs outline-none focus:border-white/30"
                            onChange={(event) =>
                              setRowReason((prev) => ({ ...prev, [row.id]: event.target.value }))
                            }
                            placeholder="Reason (≥3)"
                            value={rowReason[row.id] ?? ""}
                          />
                        </td>
                        <td className="px-4 py-2">
                          {row.status === "approved" ? (
                            <button
                              className="inline-flex h-9 items-center gap-1 border border-white/10 px-2 text-xs font-medium text-[rgb(220,220,220)] hover:border-white/30 disabled:opacity-40"
                              disabled={!canAct}
                              onClick={() => void setState(row.id, "archived")}
                              type="button"
                            >
                              {busy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Archive className="h-3.5 w-3.5" />
                              )}
                              Archive
                            </button>
                          ) : (
                            <button
                              className="inline-flex h-9 items-center gap-1 border border-white/10 px-2 text-xs font-medium text-[rgb(220,220,220)] hover:border-white/30 disabled:opacity-40"
                              disabled={!canAct}
                              onClick={() => void setState(row.id, "approved")}
                              type="button"
                            >
                              {busy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Upload className="h-3.5 w-3.5" />
                              )}
                              Publish
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
