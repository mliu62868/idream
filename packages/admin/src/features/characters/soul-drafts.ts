import type { CharacterDraftPersona, CharacterDraftVisualDirection } from "@idream/shared/admin";

// Stable traits stay raw text while editing so a trailing newline can start the next trait.
export type SoulVisualForm = Omit<CharacterDraftVisualDirection, "stableTraits"> & { stableTraits: string };

export type SoulDraft = {
  persona: CharacterDraftPersona;
  visual: SoulVisualForm;
  projectVersion: number;
  contentVersionId: string;
};

// Keep edits across panel unmounts even when browser storage is full or blocked.
// Null entries prevent a failed removal from resurrecting an already committed draft.
const drafts = new Map<string, SoulDraft | null>();

export function readSoulDraft(key: string): { draft: SoulDraft | null; error?: string } {
  if (drafts.has(key)) return { draft: drafts.get(key) ?? null };
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return { draft: null };
    const saved = JSON.parse(raw);
    const persona = saved?.persona;
    const visual = saved?.visual;
    if (typeof saved?.projectVersion !== "number" || typeof saved?.contentVersionId !== "string"
      || !persona || !["name", "gender", "characterPromise", "detailsMarkdown", "firstMessage"].every((field) => typeof persona[field] === "string")
      || typeof persona.age !== "number" || !Number.isFinite(persona.age)
      || !visual || !["identityAnchor", "stableTraits", "style", "referenceDirection"].every((field) => typeof visual[field] === "string")) {
      return { draft: null, error: "Saved draft could not be restored." };
    }
    drafts.set(key, saved);
    return { draft: saved };
  } catch {
    return { draft: null, error: "Draft kept until this tab reloads. Browser storage is unavailable." };
  }
}

export function writeSoulDraft(key: string, draft: SoulDraft): boolean {
  drafts.set(key, draft);
  try { window.sessionStorage.setItem(key, JSON.stringify(draft)); return true; }
  catch { return false; }
}

export function clearSoulDraft(key: string): boolean {
  drafts.set(key, null);
  try { window.sessionStorage.removeItem(key); return true; }
  catch { return false; }
}

export function hasSoulDrafts(actorId: string): boolean {
  const prefix = `idream.admin.soul-draft:${actorId}:`;
  if ([...drafts].some(([key, draft]) => key.startsWith(prefix) && draft !== null)) return true;
  try {
    return Object.keys(window.sessionStorage).some((key) => key.startsWith(prefix) && !drafts.has(key));
  } catch { return false; }
}
