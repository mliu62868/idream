// SPEC: 角色模板 Starters 三件套的共享契约 —— 类型/端点/payload 构造（SSoT，三页共用）。
// INVARIANT: 新建与编辑共用内容字段；编辑调用额外携带读取时的 expectedUpdatedAt。
import { characterTemplateDetailsMarkdown } from "@idream/shared/chat/persona-render";

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
  updatedAt: string;
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
  detailsMarkdown: string;
  firstMessage: string;
  appearanceNotes: string;
  visualBrief: string;
  reason: string;
};

export function starterTextField(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

export function starterDetailsMarkdown(value: unknown): string {
  const current = characterTemplateDetailsMarkdown(value);
  // A saved Markdown is the operator's current text; the fields below were folded into it.
  if (value && typeof value === "object" && Object.hasOwn(value, "detailsMarkdown")) return current;
  const creativeBrief = starterTextField(value, "creativeBrief").trim();
  const archetype = starterTextField(value, "archetype").trim();
  return [
    current,
    creativeBrief ? `## Creative brief\n\n${creativeBrief}` : "",
    archetype ? `## Archetype\n\n${archetype}` : "",
  ].filter(Boolean).join("\n\n");
}

function starterJsonText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value)
    .map(([key, entry]) => [key, starterJsonText(entry)] as const)
    .filter(([, text]) => text)
    .map(([key, text]) => (key === "prompt" ? text : `${key}: ${text}`))
    .join(" · ");
}

// SPEC: 表单没有编辑入口、但保存时保留且主站预填会读取的内容（种子模板的 face/hair/body 等）。
// INTENT: 不展示的话运营会以为这个模板的外观是空的。
export function starterPreservedFields(row: Pick<Starter, "appearance" | "advancedDetails">) {
  const appearance = row.appearance && typeof row.appearance === "object" && !Array.isArray(row.appearance)
    ? Object.entries(row.appearance).filter(([key]) => key !== "notes" && key !== "visualBrief")
    : [];
  const fields = appearance
    .map(([key, entry]) => ({ key, text: starterJsonText(entry) }))
    .filter((field) => field.text);
  const description = starterTextField(row.advancedDetails, "description").trim();
  return description ? [...fields, { key: "description", text: description }] : fields;
}

function intFromText(text: string, fallback: number): number {
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function tagsFromText(text: string): string[] {
  return text.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
}

// INVARIANT: 空的 summary / gender / style 发 null —— 编辑页清空这些字段必须真的清掉，
//            发 undefined 服务端会当成「不改」，而页面却提示已保存。
export function starterPayload(draft: StarterDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    summary: draft.summary.trim() || null,
    gender: draft.gender.trim() || null,
    style: draft.style.trim() || null,
    scope: draft.scope,
    tags: tagsFromText(draft.tags),
    appearance: {
      notes: draft.appearanceNotes.trim(),
      visualBrief: draft.visualBrief.trim(),
    },
    advancedDetails: {
      detailsMarkdown: draft.detailsMarkdown.trim(),
      firstMessage: draft.firstMessage.trim(),
    },
    sortOrder: intFromText(draft.sortOrder, 0),
    reason: draft.reason.trim(),
  };
}
