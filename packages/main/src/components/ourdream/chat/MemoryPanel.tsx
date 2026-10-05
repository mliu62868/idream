"use client";

import { RotateCcw, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import { chatFailureCode } from "@/lib/chat-failure-copy";
import { parsePublicApiError } from "@/lib/public-api-contracts";
import { MemoryToggle } from "./MemoryToggle";
import { ChatContextSettings } from "./ChatContextSettings";
import { ProactiveSettings } from "./ProactiveSettings";

const clearScopeSchema = z.object({
  groups: z.array(z.object({
    title: z.string().nullable(),
    status: z.enum(["active", "archived"]),
    members: z.array(z.object({ characterId: z.string().min(1) })),
  })),
});

// SPEC: Official igrep owns item-level generic memory inside DSH. The product
// exposes memory on/off and clear all. Explicit user settings have separate,
// labelled Main authority; they are not a list of igrep's inferred memories.
type MemoryPanelProps = Readonly<{
  open: boolean;
  onClose: () => void;
  characterId: string | null;
  sessionId?: string;
  memoryEnabled: boolean;
  memoryPending: boolean;
  onToggleMemory: () => void;
  onProactiveChange?: (enabled: boolean) => void;
  groupConversation?: boolean;
  fetchForViewer: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}>;

export function MemoryPanel(props: MemoryPanelProps) {
  return props.open ? <MemoryPanelContent key={JSON.stringify([props.characterId, props.sessionId, props.groupConversation ?? false])} {...props} /> : null;
}

function MemoryPanelContent({
  open,
  onClose,
  characterId,
  sessionId,
  memoryEnabled,
  memoryPending,
  onToggleMemory,
  onProactiveChange,
  groupConversation = false,
  fetchForViewer,
}: MemoryPanelProps) {
  const scope = JSON.stringify([characterId, sessionId, groupConversation]);
  const [clearState, setClearState] = useState<{
    scope: string;
    status: "loading" | "ready" | "failed" | "clearing" | "uncertain";
    groups: string[];
    error?: string;
  } | null>(null);
  const requestEpoch = useRef(0);
  useLayoutEffect(() => {
    requestEpoch.current += 1;
    return () => { requestEpoch.current += 1; };
  }, [open, scope]);
  const currentClear = clearState?.scope === scope ? clearState : null;
  const resetConfirm = currentClear !== null;
  const resetting = currentClear?.status === "clearing";
  const resetFailed = currentClear?.status === "uncertain";
  const canConfirm = currentClear?.status === "ready" || resetFailed;

  async function loadClearScope() {
    if (!characterId) return;
    const epoch = ++requestEpoch.current;
    setClearState({ scope, status: "loading", groups: [] });
    try {
      const response = await fetchForViewer("/api/v1/chat/groups", { cache: "no-store" });
      if (!response.ok) throw new Error("group scope unavailable");
      const raw = clearScopeSchema.parse(await response.json());
      const groups = raw.groups
        .filter(group => group.status === "active" && group.members.some(member => member.characterId === characterId))
        .map(group => group.title || "Untitled group");
      if (epoch === requestEpoch.current) setClearState({ scope, status: "ready", groups });
    } catch {
      if (epoch === requestEpoch.current) setClearState({ scope, status: "failed", groups: [] });
    }
  }

  // SPEC: 重置成功后把用户送进一段全新对话。
  // INTENT: 服务端会归档这个角色的活跃会话，所以留在原地的用户下一条消息必然被
  // 拒（"This chat has been archived."）。重置的承诺是"start over"，那就真的把人
  // 带到新对话里；开不出新会话时才退回原地刷新，至少长期记忆已经清干净了。
  async function clearMemory() {
    if (!characterId) return;
    if (!resetConfirm) {
      void loadClearScope();
      return;
    }
    if (!canConfirm || !currentClear) return;
    const epoch = ++requestEpoch.current;
    const groups = currentClear.groups;
    setClearState({ scope, status: "clearing", groups });
    try {
      const response = await fetchForViewer(
        `/api/v1/chat/memory/${encodeURIComponent(characterId)}`,
        { method: "DELETE" },
      );
      if (epoch !== requestEpoch.current) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          const raw: unknown = await response.json().catch(() => null);
          if (epoch !== requestEpoch.current) return;
          // Main Chat uses a flat error envelope. Reuse the public parser
          // after normalizing it; an unreadable receipt remains uncertain.
          const rejection = parsePublicApiError(raw) ?? (
            raw && typeof raw === "object" && "message" in raw
              ? parsePublicApiError({ error: { code: chatFailureCode(raw), message: raw.message } })
              : null
          );
          if (rejection?.code?.trim() && rejection.message.trim()) {
            setClearState({ scope, status: "ready", groups, error: rejection.message });
            return;
          }
        }
        setClearState({ scope, status: "uncertain", groups });
        return;
      }
      if (groupConversation) {
        setClearState(null);
        window.location.href = "/chat/groups";
        return;
      }
      const started = await fetchForViewer("/api/v1/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId }),
      });
      if (epoch !== requestEpoch.current) return;
      if (started.ok) {
        const payload = (await started.json().catch(() => null)) as
          | { data?: { session?: { id?: unknown } } }
          | null;
        if (epoch !== requestEpoch.current) return;
        const sessionId = payload?.data?.session?.id;
        if (typeof sessionId === "string" && sessionId) {
          setClearState(null);
          window.location.href = `/chat/${sessionId}`;
          return;
        }
      }
      setClearState(null);
      window.location.href = "/chat";
    } catch {
      if (epoch === requestEpoch.current) setClearState({ scope, status: "uncertain", groups });
    }
  }

  if (!open) return null;

  function closePanel() {
    requestEpoch.current += 1;
    setClearState(null);
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
          {sessionId && !groupConversation ? <ProactiveSettings key={`proactive-${sessionId}`} sessionId={sessionId} onEnabledChange={onProactiveChange} /> : null}

          <div className="my-4 h-px bg-[rgb(36,36,36)]" />

          <h3 className="mb-1 text-[12px] font-bold uppercase tracking-wide text-[rgb(170,170,170)]">
            Clear memory
          </h3>
          {groupConversation ? <p className="mb-3 text-xs leading-5 text-white/70">Clearing this Character&apos;s memory also archives group conversations they belong to. Other Characters keep their own memories.</p> : null}
          {resetConfirm && canConfirm ? (
            <p className="mb-3 text-xs leading-5 text-[rgb(255,184,112)]" data-testid="memory-clear-groups" role="status">
              {currentClear.groups.length > 0 ? <>This also archives {currentClear.groups.length === 1 ? "the group chat" : `${currentClear.groups.length} group chats`} with this character: {currentClear.groups.join(", ")}. Archived groups stay readable but can&apos;t continue.</> : "No active group chats with this character were found."}
            </p>
          ) : null}
          {currentClear?.status === "loading" ? <p className="mb-3 text-xs text-white/70" role="status">Checking which group chats will be archived…</p> : null}
          {currentClear?.status === "failed" ? <div className="mb-3 text-xs text-[rgb(255,138,128)]" role="alert">Couldn&apos;t check which group chats will be archived. Nothing has been cleared.<button className="ml-2 underline" onClick={() => { void loadClearScope(); }} type="button">Retry</button></div> : null}
          <p className="mb-3 text-[12px] leading-4 text-[rgb(114,113,112)]">
            {resetConfirm
              ? "This clears learned memories and your pinned facts, and moves your current chats with this character to the archive. You'll start a new conversation. Your old chats stay readable. Custom instructions stay until you remove them."
              : "Clear learned memories and pinned facts, then start a new conversation. Custom instructions are kept."}
          </p>
          <button
            aria-label={resetConfirm ? "Confirm clear memory" : "Clear memory"}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[rgb(36,36,36)] px-4 py-2 text-[13px] font-semibold text-[rgb(170,170,170)] transition-colors hover:text-white disabled:opacity-50"
            data-testid="memory-clear"
            disabled={resetting || !characterId || (resetConfirm && !canConfirm)}
            onClick={clearMemory}
            type="button"
          >
            <RotateCcw className="h-4 w-4" />
            {resetConfirm ? "Confirm clear" : "Clear memory"}
          </button>
          {currentClear?.error ? <p className="mt-2 text-[12px] leading-4 text-[rgb(255,138,128)]" data-testid="memory-clear-error" role="alert">{currentClear.error}</p> : null}
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
