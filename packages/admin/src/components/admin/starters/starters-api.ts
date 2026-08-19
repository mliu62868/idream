// SPEC: 角色模板 Starters 三件套的共享契约 —— 类型/端点/payload 构造（SSoT，三页共用）。
// INVARIANTS: payload 字段与旧单页角色模板视图的 POST/PATCH body 完全一致（后端不变）。

export type Starter = {
  id: string;
  scope: string;
  name: string;
  summary: string | null;
  gender: string | null;
  style: string | null;
  appearance: unknown;
  advancedDetails: unknown;
  tags: string[];
  isActive: boolean;
  sortOrder: number;
};

export const SCOPES = ["built_in", "community"] as const;
export const STARTER_GENDERS = ["", "female", "male", "trans"] as const;
export const STARTER_STYLES = ["", "realistic", "anime", "hybrid", "other"] as const;
export const STARTERS_LIST = "/api/v2/admin/content/templates";

export type StarterDraft = {
  name: string;
  summary: string;
  gender: string;
  style: string;
  scope: (typeof SCOPES)[number];
  tags: string;
  sortOrder: string;
  creativeBrief: string;
  archetype: string;
  relationship: string;
  personality: string;
  speakingStyle: string;
  firstMessage: string;
  exampleDialogue: string;
  appearanceNotes: string;
  visualBrief: string;
  reason: string;
};

export function starterTextField(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function intFromText(text: string, fallback: number): number {
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function tagsFromText(text: string): string[] {
  return text.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
}

export function starterPayload(draft: StarterDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    summary: draft.summary.trim() || undefined,
    gender: draft.gender.trim() || undefined,
    style: draft.style.trim() || undefined,
    scope: draft.scope,
    tags: tagsFromText(draft.tags),
    appearance: {
      notes: draft.appearanceNotes.trim(),
      visualBrief: draft.visualBrief.trim(),
    },
    advancedDetails: {
      creativeBrief: draft.creativeBrief.trim(),
      archetype: draft.archetype.trim(),
      relationship: draft.relationship.trim(),
      personality: draft.personality.trim(),
      speakingStyle: draft.speakingStyle.trim(),
      firstMessage: draft.firstMessage.trim(),
      exampleDialogue: draft.exampleDialogue.trim(),
      visualBrief: draft.visualBrief.trim(),
    },
    sortOrder: intFromText(draft.sortOrder, 0),
    reason: draft.reason.trim(),
  };
}
