"use client";

import { Brain } from "lucide-react";

// SPEC: One-tap switch for a session's long-term memory.
// INTENT: Same control reused in the header and the memory panel (SSoT for styling).
// INVARIANTS: never exposes confidence/internal fields — only on/off.
export function MemoryToggle({
  enabled,
  pending,
  onToggle,
}: Readonly<{ enabled: boolean; pending: boolean; onToggle: () => void }>) {
  return (
    <button
      aria-label={enabled ? "Memory on. Turn off memory." : "No-memory. Turn on memory."}
      aria-pressed={enabled}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors disabled:opacity-50 ${
        enabled
          ? "border-[#ff1cac]/40 bg-[#ff1cac]/15 text-white"
          : "border-white/10 bg-[rgb(36,36,36)] text-[rgb(170,170,170)] hover:text-white"
      }`}
      data-testid="memory-toggle"
      disabled={pending}
      onClick={onToggle}
      title="No-memory means this character won't read or write long-term memory. Your current chat history stays until you delete the session."
      type="button"
    >
      <Brain className="h-3.5 w-3.5" />
      {enabled ? "Memory on" : "No-memory"}
    </button>
  );
}
