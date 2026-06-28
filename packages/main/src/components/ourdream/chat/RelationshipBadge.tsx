"use client";

import { Heart } from "lucide-react";
import { useEffect, useState } from "react";

// SPEC: Show ONLY a qualitative relationship stage label — never numbers/progress.
// INTENT: warm, human framing; hide entirely if the relationship can't be loaded.
// EXAMPLE: stage "committed" -> "Close & committed"
type RelationshipStage = "new" | "familiar" | "close" | "committed";

type RelationshipResponse = {
  characterId: string;
  stage: RelationshipStage;
  summary: string | null;
  version: number;
};

const STAGE_LABELS: Record<RelationshipStage, string> = {
  new: "Getting to know each other",
  familiar: "Familiar",
  close: "Close",
  committed: "Close & committed",
};

export function RelationshipBadge({
  characterId,
  refreshKey = 0,
}: Readonly<{ characterId: string | null; refreshKey?: number }>) {
  const [stage, setStage] = useState<RelationshipStage | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Defer past a microtask so resets aren't a synchronous setState inside the
      // effect body (react-hooks/set-state-in-effect).
      await Promise.resolve();
      if (cancelled) return;
      if (!characterId) {
        setStage(null);
        return;
      }
      try {
        const res = await fetch(
          `/api/v1/chat/relationships/${encodeURIComponent(characterId)}`,
        );
        if (!res.ok) throw new Error("relationship unavailable");
        const data = (await res.json()) as RelationshipResponse;
        if (!cancelled) setStage(isStage(data.stage) ? data.stage : null);
      } catch {
        if (!cancelled) setStage(null);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [characterId, refreshKey]);

  if (!stage) return null;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[rgb(36,36,36)] px-3 py-1 text-[12px] font-semibold text-[rgb(170,170,170)]"
      data-testid="relationship-badge"
      role="status"
    >
      <Heart className="h-3.5 w-3.5 text-[#ff7ac8]" />
      {STAGE_LABELS[stage]}
    </span>
  );
}

function isStage(value: string): value is RelationshipStage {
  return (
    value === "new" || value === "familiar" || value === "close" || value === "committed"
  );
}
