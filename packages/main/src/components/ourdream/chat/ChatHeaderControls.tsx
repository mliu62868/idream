"use client";

import { List, Settings, Sparkles } from "lucide-react";
import Link from "next/link";
import { MemoryToggle } from "./MemoryToggle";
import { RelationshipBadge } from "./RelationshipBadge";

// SPEC: Chat header control row — relationship stage, memory on/off, Generate link,
//       and entry points to the session list + memory panel.
// INTENT: mobile-first; wraps cleanly at 390px so nothing is occluded.
export function ChatHeaderControls({
  characterId,
  memoryEnabled,
  memoryPending,
  relationshipRefreshKey,
  onToggleMemory,
  onOpenSessions,
  onOpenMemory,
}: Readonly<{
  characterId: string | null;
  memoryEnabled: boolean;
  memoryPending: boolean;
  relationshipRefreshKey: number;
  onToggleMemory: () => void;
  onOpenSessions: () => void;
  onOpenMemory: () => void;
}>) {
  const generateHref = characterId
    ? `/generate?characterId=${encodeURIComponent(characterId)}`
    : "/generate";

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <RelationshipBadge characterId={characterId} refreshKey={relationshipRefreshKey} />
        <MemoryToggle enabled={memoryEnabled} pending={memoryPending} onToggle={onToggleMemory} />
        <Link
          className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[rgb(36,36,36)] px-3 py-1 text-[12px] font-semibold text-[rgb(170,170,170)] transition-colors hover:text-white"
          href={generateHref}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Generate
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <button
            aria-label="Open your chats"
            className="grid h-8 w-8 place-items-center rounded-full border border-white/10 bg-[rgb(36,36,36)] text-[rgb(170,170,170)] transition-colors hover:text-white"
            data-testid="session-list-open"
            onClick={onOpenSessions}
            title="Your chats"
            type="button"
          >
            <List className="h-4 w-4" />
          </button>
          <button
            aria-label="Open memory settings"
            className="grid h-8 w-8 place-items-center rounded-full border border-white/10 bg-[rgb(36,36,36)] text-[rgb(170,170,170)] transition-colors hover:text-white"
            data-testid="memory-panel-open"
            onClick={onOpenMemory}
            title="Memory & relationship"
            type="button"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>
      <p className="mt-2 text-[12px] leading-4 text-[rgb(114,113,112)]">
        {memoryEnabled
          ? "Memory on: this character remembers details across your chats."
          : "No-memory: this character won't read or write long-term memory. Your current chat history stays until you delete the session."}
      </p>
    </div>
  );
}
