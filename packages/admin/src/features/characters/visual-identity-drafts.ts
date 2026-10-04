export type VisualIdentityDraft = {
  identity?: {
    identityId: string | null;
    identityVersion: number;
    identityPrompt: string;
    negativeIdentityPrompt: string;
    style: string;
    defaultSeed: string;
    reason: string;
  };
  references?: {
    authority: string;
    selectedIds: string[];
    reason: string;
  };
};

// The two edits have separate authority: publishing references must not discard
// a partly written identity prompt, and creating an identity invalidates both.
// Cache survives panel unmounts when browser storage is blocked; null entries keep
// a failed removal from resurrecting a committed or discarded draft.
const drafts = new Map<string, VisualIdentityDraft | null>();

export function readVisualIdentityDraft(key: string): { draft: VisualIdentityDraft | null; error?: string } {
  if (drafts.has(key)) return { draft: drafts.get(key) ?? null };
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return { draft: null };
    const saved = JSON.parse(raw);
    const identity = saved?.identity;
    const references = saved?.references;
    if (!saved || typeof saved !== "object" || Array.isArray(saved)
      || (!identity && !references)
      || (identity && ((identity.identityId !== null && typeof identity.identityId !== "string")
        || !Number.isSafeInteger(identity.identityVersion) || identity.identityVersion < 0
        || !["identityPrompt", "negativeIdentityPrompt", "style", "defaultSeed", "reason"].every((field) => typeof identity[field] === "string")
        || !["realistic", "anime", "hybrid", "other"].includes(identity.style)))
      || (references && (typeof references.authority !== "string" || typeof references.reason !== "string"
        || !Array.isArray(references.selectedIds) || !references.selectedIds.every((id: unknown) => typeof id === "string")))) {
      return { draft: null, error: "Saved draft could not be restored." };
    }
    drafts.set(key, saved);
    return { draft: saved };
  } catch {
    return { draft: null, error: "Draft kept until this tab reloads. Browser storage is unavailable." };
  }
}

export function writeVisualIdentityDraft(key: string, draft: VisualIdentityDraft | null): boolean {
  drafts.set(key, draft);
  try {
    if (draft) window.sessionStorage.setItem(key, JSON.stringify(draft));
    else window.sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
}
