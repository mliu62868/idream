"use client";

import { RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { MemoryToggle } from "./MemoryToggle";
import { ChatContextSettings } from "./ChatContextSettings";

// SPEC: Official igrep owns item-level generic memory inside DSH. The product
// exposes memory on/off and clear all. Explicit user settings have separate,
// labelled Main authority; they are not a list of igrep's inferred memories.
export function MemoryPanel({
  open,
  onClose,
  characterId,
  sessionId,
  memoryEnabled,
  memoryPending,
  onToggleMemory,
  groupConversation = false,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  characterId: string | null;
  sessionId?: string;
  memoryEnabled: boolean;
  memoryPending: boolean;
  onToggleMemory: () => void;
  groupConversation?: boolean;
}>) {
  const [resetting, setResetting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);

  // SPEC: 重置成功后把用户送进一段全新对话。
  // INTENT: 服务端会归档这个角色的活跃会话，所以留在原地的用户下一条消息必然被
  // 拒（"This chat has been archived."）。重置的承诺是"start over"，那就真的把人
  // 带到新对话里；开不出新会话时才退回原地刷新，至少长期记忆已经清干净了。
  async function clearMemory() {
    if (!characterId) return;
    if (!resetConfirm) {
      setResetConfirm(true);
      return;
    }
    setResetting(true);
    setResetFailed(false);
    try {
      const response = await fetch(
        `/api/v1/chat/memory/${encodeURIComponent(characterId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        setResetFailed(true);
        return;
      }
      setResetConfirm(false);
      if (groupConversation) {
        window.location.href = "/chat/groups";
        return;
      }
      const started = await fetch("/api/v1/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId }),
      });
      if (started.ok) {
        const payload = (await started.json().catch(() => null)) as
          | { data?: { session?: { id?: unknown } } }
          | null;
        const sessionId = payload?.data?.session?.id;
        if (typeof sessionId === "string" && sessionId) {
          window.location.href = `/chat/${sessionId}`;
          return;
        }
      }
      window.location.href = "/chat";
    } catch {
      setResetFailed(true);
    } finally {
      setResetting(false);
    }
  }

  if (!open) return null;

  function closePanel() {
    setResetConfirm(false);
    onClose();
  }

  return (
    <div
      aria-label="Memory settings"
      aria-modal="true"
      className="fixed inset-0 z-50 flex"
      role="dialog"
    >
      <button
        aria-label="Close"
        className="absolute inset-0 bg-black/60"
        onClick={closePanel}
        type="button"
      />
      <div className="relative ml-auto flex h-full w-full max-w-[380px] flex-col border-l border-white/10 bg-[rgb(18,18,18)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-4">
          <h2 className="text-[16px] font-black uppercase">Memory</h2>
          <button
            aria-label="Close memory settings"
            className="grid h-8 w-8 place-items-center rounded-full bg-[rgb(36,36,36)] text-[rgb(170,170,170)] hover:text-white"
            onClick={closePanel}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <MemoryToggle
            enabled={memoryEnabled}
            pending={memoryPending}
            onToggle={onToggleMemory}
          />
          <p className="mt-2 text-[12px] leading-4 text-[rgb(114,113,112)]">
            {memoryEnabled
              ? "This character can remember details across chats. Turn memory off for private turns."
              : "Memory is off: new messages do not read or save long-term memories. This chat stays in your history."}
          </p>

          {sessionId ? <ChatContextSettings key={sessionId} sessionId={sessionId} memoryEnabled={memoryEnabled} /> : null}

          <div className="my-4 h-px bg-[rgb(36,36,36)]" />

          <h3 className="mb-1 text-[12px] font-bold uppercase tracking-wide text-[rgb(170,170,170)]">
            Clear memory
          </h3>
          {groupConversation ? <p className="mb-3 text-xs leading-5 text-white/70">Clearing this Character&apos;s memory also archives group conversations they belong to. Other Characters keep their own memories.</p> : null}
          <p className="mb-3 text-[12px] leading-4 text-[rgb(114,113,112)]">
            {resetConfirm
              ? "This clears learned memories and your pinned facts, and moves your current chats with this character to the archive. You'll start a new conversation. Your old chats stay readable. Custom instructions stay until you remove them."
              : "Clear learned memories and pinned facts, then start a new conversation. Custom instructions are kept."}
          </p>
          <button
            aria-label={resetConfirm ? "Confirm clear memory" : "Clear memory"}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[rgb(36,36,36)] px-4 py-2 text-[13px] font-semibold text-[rgb(170,170,170)] transition-colors hover:text-white disabled:opacity-50"
            data-testid="memory-clear"
            disabled={resetting || !characterId}
            onClick={clearMemory}
            type="button"
          >
            <RotateCcw className="h-4 w-4" />
            {resetConfirm ? "Confirm clear" : "Clear memory"}
          </button>
          {resetFailed ? (
            <p
              className="mt-2 text-[12px] leading-4 text-[rgb(255,138,128)]"
              data-testid="memory-clear-error"
              role="status"
            >
              Couldn&apos;t confirm memory was cleared. Old chats may already be archived — try again.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
