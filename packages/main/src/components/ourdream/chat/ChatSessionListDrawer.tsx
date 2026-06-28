"use client";

import { Archive, Compass, Pencil, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

// SPEC: Slide-over listing up to 50 non-deleted chat sessions with Archive/Delete.
// INTENT: lightweight "your chats" switcher; empty state guides to Explore/Create.
// NOTE: GET /sessions passes through the BFF raw (a JSON array, not {ok,data}).
type SessionRow = {
  id: string;
  title: string | null;
  characterId: string;
  status: string;
  memoryEnabled: boolean;
  lastMessageAt: string | null;
  memorySummary: string | null;
};

export function ChatSessionListDrawer({
  open,
  onClose,
  currentSessionId,
}: Readonly<{ open: boolean; onClose: () => void; currentSessionId: string }>) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Inline rename: editingId marks the row in edit mode, draft holds the input value.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      // Defer past a microtask so the loading reset isn't a synchronous setState
      // inside the effect body (react-hooks/set-state-in-effect).
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/v1/chat/sessions");
        if (!res.ok) throw new Error("sessions unavailable");
        const rows = (await res.json()) as SessionRow[];
        if (!cancelled) {
          setSessions(rows.filter((row) => row.status !== "deleted").slice(0, 50));
        }
      } catch {
        if (!cancelled) setError("Couldn't load your chats.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function archive(sessionId: string) {
    setBusyId(sessionId);
    try {
      const res = await fetch(
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/archive`,
        { method: "POST" },
      );
      if (res.ok) {
        setSessions((current) =>
          current.map((row) =>
            row.id === sessionId ? { ...row, status: "archived" } : row,
          ),
        );
      }
    } finally {
      setBusyId(null);
    }
  }

  function startRename(sessionId: string, currentTitle: string | null) {
    setEditingId(sessionId);
    setDraft(currentTitle ?? "");
    setError(null);
  }

  function cancelRename() {
    setEditingId(null);
    setDraft("");
  }

  async function saveRename(sessionId: string) {
    const title = draft.trim();
    if (!title) {
      cancelRename();
      return;
    }
    setBusyId(sessionId);
    try {
      const res = await fetch(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (res.ok) {
        const updated = (await res.json()) as { title: string | null };
        setSessions((current) =>
          current.map((row) =>
            row.id === sessionId ? { ...row, title: updated.title ?? title } : row,
          ),
        );
        cancelRename();
      } else {
        setError("Couldn't rename this chat.");
      }
    } catch {
      setError("Couldn't rename this chat.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(sessionId: string) {
    setBusyId(sessionId);
    try {
      const res = await fetch(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setSessions((current) => current.filter((row) => row.id !== sessionId));
      }
    } finally {
      setBusyId(null);
    }
  }

  if (!open) return null;

  return (
    <div
      aria-label="Your chats"
      aria-modal="true"
      className="fixed inset-0 z-50 flex"
      role="dialog"
    >
      <button aria-label="Close" className="absolute inset-0 bg-black/60" onClick={onClose} type="button" />
      <div className="relative mr-auto flex h-full w-full max-w-[360px] flex-col border-r border-white/10 bg-[rgb(18,18,18)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-4">
          <h2 className="text-[16px] font-black uppercase">Your chats</h2>
          <button
            aria-label="Close your chats"
            className="grid h-8 w-8 place-items-center rounded-full bg-[rgb(36,36,36)] text-[rgb(170,170,170)] hover:text-white"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {loading ? (
            <p className="px-2 py-6 text-[13px] text-[rgb(170,170,170)]" role="status">
              Loading…
            </p>
          ) : null}
          {error ? (
            <p className="px-2 py-6 text-[13px] font-semibold text-[#ff7ac8]" role="status">
              {error}
            </p>
          ) : null}
          {!loading && !error && sessions.length === 0 ? (
            <div className="px-2 py-8 text-center">
              <p className="text-[14px] font-semibold text-white">No chats yet</p>
              <p className="mt-1 text-[13px] text-[rgb(170,170,170)]">
                Find a character or create your own to start chatting.
              </p>
              <div className="mt-4 flex flex-col gap-2">
                <Link
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[rgb(36,36,36)] text-[13px] font-bold text-white hover:bg-[rgb(46,46,46)]"
                  href="/"
                  onClick={onClose}
                >
                  <Compass className="h-4 w-4" />
                  Explore
                </Link>
                <Link
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-[13px] font-bold text-white"
                  href="/create"
                  onClick={onClose}
                >
                  <Plus className="h-4 w-4" />
                  Create
                </Link>
              </div>
            </div>
          ) : null}

          <ul className="flex flex-col gap-1">
            {sessions.map((row) => (
              <li
                className={`group flex items-center gap-2 rounded-[12px] px-2 py-2 transition-colors hover:bg-[rgb(36,36,36)] ${
                  row.id === currentSessionId ? "bg-[rgb(36,36,36)]" : ""
                }`}
                data-testid="session-list-item"
                key={row.id}
              >
                {editingId === row.id ? (
                  <input
                    aria-label="Rename chat"
                    autoFocus
                    className="min-w-0 flex-1 rounded-[8px] border border-white/20 bg-[rgb(28,28,28)] px-2 py-1 text-[14px] font-semibold text-white outline-none focus:border-[#ff79d1]"
                    disabled={busyId === row.id}
                    maxLength={80}
                    onBlur={() => saveRename(row.id)}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void saveRename(row.id);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    type="text"
                    value={draft}
                  />
                ) : (
                  <Link
                    className="flex min-w-0 flex-1 flex-col"
                    href={`/chat/${row.id}`}
                    onClick={onClose}
                  >
                    <span className="truncate text-[14px] font-semibold text-white">
                      {row.title ?? "Untitled chat"}
                    </span>
                    {row.status === "archived" ? (
                      <span className="text-[11px] font-medium uppercase text-[rgb(114,113,112)]">
                        Archived
                      </span>
                    ) : null}
                  </Link>
                )}
                <button
                  aria-label="Rename chat"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[rgb(170,170,170)] hover:bg-black/40 hover:text-white disabled:opacity-50"
                  data-testid="session-rename"
                  disabled={busyId === row.id || editingId === row.id}
                  onClick={() => startRename(row.id, row.title)}
                  title="Rename chat"
                  type="button"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  aria-label="Archive chat"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[rgb(170,170,170)] hover:bg-black/40 hover:text-white disabled:opacity-50"
                  data-testid="session-archive"
                  disabled={busyId === row.id || row.status === "archived"}
                  onClick={() => archive(row.id)}
                  title="Archive chat"
                  type="button"
                >
                  <Archive className="h-4 w-4" />
                </button>
                <button
                  aria-label="Delete chat"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[rgb(170,170,170)] hover:bg-black/40 hover:text-white disabled:opacity-50"
                  data-testid="session-delete"
                  disabled={busyId === row.id}
                  onClick={() => remove(row.id)}
                  title="Delete chat"
                  type="button"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
