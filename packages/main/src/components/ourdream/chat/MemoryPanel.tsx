"use client";

import { Check, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { MemoryToggle } from "./MemoryToggle";

// SPEC: Slide-over to manage what a character remembers about you.
// INTENT: plain-language memory control — edit/delete individual memories, flip
//         the session's memory on/off, and reset the relationship to "new".
// INVARIANTS: never surface confidence or other internal memory fields.
type MemoryItem = {
  id: string;
  text: string;
  sourceMessageIds: string[];
};

type MemoriesResponse = { memories: MemoryItem[] };

export function MemoryPanel({
  open,
  onClose,
  characterId,
  memoryEnabled,
  memoryPending,
  onToggleMemory,
  onRelationshipReset,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  characterId: string | null;
  memoryEnabled: boolean;
  memoryPending: boolean;
  onToggleMemory: () => void;
  onRelationshipReset: () => void;
}>) {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!open || !characterId) return;
    const cid = characterId;
    let cancelled = false;
    async function load() {
      // Defer past a microtask so the loading reset isn't a synchronous setState
      // inside the effect body (react-hooks/set-state-in-effect).
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/chat/memories?characterId=${encodeURIComponent(cid)}`,
        );
        if (!res.ok) throw new Error("memories unavailable");
        const data = (await res.json()) as MemoriesResponse;
        if (!cancelled) setMemories(data.memories ?? []);
      } catch {
        if (!cancelled) setError("Couldn't load memories.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, characterId]);

  function startEdit(memory: MemoryItem) {
    setEditingId(memory.id);
    setDraft(memory.text);
  }

  async function saveEdit(memoryId: string) {
    const text = draft.trim();
    if (!text) return;
    setBusyId(memoryId);
    try {
      const res = await fetch(`/api/v1/chat/memories/${encodeURIComponent(memoryId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const updated = (await res.json()) as Partial<MemoryItem>;
        setMemories((current) =>
          current.map((memory) =>
            memory.id === memoryId ? { ...memory, text: updated.text ?? text } : memory,
          ),
        );
        setEditingId(null);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function deleteMemory(memoryId: string) {
    setBusyId(memoryId);
    try {
      const res = await fetch(`/api/v1/chat/memories/${encodeURIComponent(memoryId)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setMemories((current) => current.filter((memory) => memory.id !== memoryId));
        if (editingId === memoryId) setEditingId(null);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function resetRelationship() {
    if (!characterId) return;
    setResetting(true);
    try {
      const res = await fetch(
        `/api/v1/chat/relationships/${encodeURIComponent(characterId)}`,
        { method: "DELETE" },
      );
      if (res.ok) onRelationshipReset();
    } finally {
      setResetting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      aria-label="Memory and relationship"
      aria-modal="true"
      className="fixed inset-0 z-50 flex"
      role="dialog"
    >
      <button aria-label="Close" className="absolute inset-0 bg-black/60" onClick={onClose} type="button" />
      <div className="relative ml-auto flex h-full w-full max-w-[380px] flex-col border-l border-white/10 bg-[rgb(18,18,18)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-4">
          <h2 className="text-[16px] font-black uppercase">Memory</h2>
          <button
            aria-label="Close memory settings"
            className="grid h-8 w-8 place-items-center rounded-full bg-[rgb(36,36,36)] text-[rgb(170,170,170)] hover:text-white"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <MemoryToggle enabled={memoryEnabled} pending={memoryPending} onToggle={onToggleMemory} />
          <p className="mt-2 text-[12px] leading-4 text-[rgb(114,113,112)]">
            {memoryEnabled
              ? "This character remembers details you share across chats. Edit or remove anything below."
              : "Memory is off: nothing new is remembered. Your current chat history stays until you delete the session."}
          </p>

          <div className="my-4 h-px bg-[rgb(36,36,36)]" />

          <h3 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-[rgb(170,170,170)]">
            What they remember
          </h3>

          {loading ? (
            <p className="py-4 text-[13px] text-[rgb(170,170,170)]" role="status">
              Loading…
            </p>
          ) : null}
          {error ? (
            <p className="py-4 text-[13px] font-semibold text-[#ff7ac8]" role="status">
              {error}
            </p>
          ) : null}
          {!loading && !error && memories.length === 0 ? (
            <p className="py-4 text-[13px] text-[rgb(170,170,170)]">
              No memories yet. As you chat, important details will show up here.
            </p>
          ) : null}

          <ul className="flex flex-col gap-2">
            {memories.map((memory) => (
              <li
                className="rounded-[12px] border border-white/10 bg-[rgb(24,24,24)] p-3"
                data-testid="memory-item"
                key={memory.id}
              >
                {editingId === memory.id ? (
                  <div className="flex flex-col gap-2">
                    <textarea
                      aria-label="Edit memory"
                      className="min-h-[64px] w-full resize-y rounded-[10px] bg-[rgb(36,36,36)] p-2 text-[13px] leading-5 text-white outline-none"
                      onChange={(event) => setDraft(event.target.value)}
                      value={draft}
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        aria-label="Cancel edit"
                        className="grid h-8 w-8 place-items-center rounded-full bg-[rgb(36,36,36)] text-[rgb(170,170,170)] hover:text-white"
                        onClick={() => setEditingId(null)}
                        type="button"
                      >
                        <X className="h-4 w-4" />
                      </button>
                      <button
                        aria-label="Save memory"
                        className="grid h-8 w-8 place-items-center rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-white disabled:opacity-50"
                        data-testid="memory-save"
                        disabled={busyId === memory.id || !draft.trim()}
                        onClick={() => saveEdit(memory.id)}
                        type="button"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 text-[13px] leading-5 text-white">{memory.text}</p>
                    <button
                      aria-label="Edit memory"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[rgb(170,170,170)] hover:bg-black/40 hover:text-white"
                      data-testid="memory-edit"
                      onClick={() => startEdit(memory)}
                      type="button"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      aria-label="Delete memory"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[rgb(170,170,170)] hover:bg-black/40 hover:text-white disabled:opacity-50"
                      data-testid="memory-delete"
                      disabled={busyId === memory.id}
                      onClick={() => deleteMemory(memory.id)}
                      type="button"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="my-4 h-px bg-[rgb(36,36,36)]" />

          <h3 className="mb-1 text-[12px] font-bold uppercase tracking-wide text-[rgb(170,170,170)]">
            Relationship
          </h3>
          <p className="mb-3 text-[12px] leading-4 text-[rgb(114,113,112)]">
            Reset how close you are to start over from scratch.
          </p>
          <button
            aria-label="Reset relationship"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[rgb(36,36,36)] px-4 py-2 text-[13px] font-semibold text-[rgb(170,170,170)] transition-colors hover:text-white disabled:opacity-50"
            data-testid="relationship-reset"
            disabled={resetting || !characterId}
            onClick={resetRelationship}
            type="button"
          >
            <RotateCcw className="h-4 w-4" />
            Reset relationship
          </button>
        </div>
      </div>
    </div>
  );
}
