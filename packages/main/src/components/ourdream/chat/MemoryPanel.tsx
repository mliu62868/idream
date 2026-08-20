"use client";

import { RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { MemoryToggle } from "./MemoryToggle";

// SPEC: Official igrep owns item-level generic memory inside DSH. The product
// exposes only the supported authority controls: memory on/off and a whole
// relationship reset. It must not invent a second list/edit/delete authority.
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
  const [resetting, setResetting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);

  async function resetRelationship() {
    if (!characterId) return;
    if (!resetConfirm) {
      setResetConfirm(true);
      return;
    }
    setResetting(true);
    try {
      const response = await fetch(
        `/api/v1/chat/relationships/${encodeURIComponent(characterId)}`,
        { method: "DELETE" },
      );
      if (response.ok) {
        setResetConfirm(false);
        onRelationshipReset();
      }
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
      aria-label="Memory and relationship"
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
              : "Memory is off: new turns use a private workspace and are not retained."}
          </p>

          <div className="my-4 h-px bg-[rgb(36,36,36)]" />

          <h3 className="mb-1 text-[12px] font-bold uppercase tracking-wide text-[rgb(170,170,170)]">
            Relationship
          </h3>
          <p className="mb-3 text-[12px] leading-4 text-[rgb(114,113,112)]">
            Reset the entire relationship and its companion memory to start over.
          </p>
          <button
            aria-label={resetConfirm ? "Confirm reset relationship" : "Reset relationship"}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[rgb(36,36,36)] px-4 py-2 text-[13px] font-semibold text-[rgb(170,170,170)] transition-colors hover:text-white disabled:opacity-50"
            data-testid="relationship-reset"
            disabled={resetting || !characterId}
            onClick={resetRelationship}
            type="button"
          >
            <RotateCcw className="h-4 w-4" />
            {resetConfirm ? "Confirm reset" : "Reset relationship"}
          </button>
        </div>
      </div>
    </div>
  );
}
