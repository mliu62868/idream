// SPEC: 提示词配方三件套的共享契约 —— 类型/端点/payload 构造 + 状态文案（SSoT，三页共用）。
// INVARIANT: 编辑只提交表单展示的字段，不能用新建默认值覆盖已有配置和验证记录。
// recipePatchSchema/recipeSchema 均无 reason 字段，编辑无需审计原因。

export type Recipe = {
  id: string;
  recipeKey: string;
  label: string;
  mode: string;
  useCase: string;
  body: string;
  negativeBase: string | null;
  version: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  sampleMatrix?: unknown;
  dryRunSummary?: Record<string, unknown> | null;
};

export const MODES = ["image", "video", "negative"] as const;
export const USE_CASES = ["character", "freeplay", "negative", "enhance"] as const;
export const RECIPES_LIST = "/api/v2/admin/generation/recipes";

export type RecipeDraft = {
  recipeKey: string;
  label: string;
  mode: (typeof MODES)[number];
  useCase: (typeof USE_CASES)[number];
  body: string;
  negativeBase: string;
};

export const defaultRecipeDraft: RecipeDraft = {
  recipeKey: "template_image_character_v2",
  label: "Image character v2",
  mode: "image",
  useCase: "character",
  body: "Character image generation template with appearance, pose, outfit, background, style, and quality blocks.",
  negativeBase: "low quality, distorted anatomy, extra fingers, watermark, text",
};

function nullableText(text: string): string | null {
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

export function recipeDraftPayload(draft: RecipeDraft): Record<string, unknown> {
  return {
    recipeKey: draft.recipeKey.trim(),
    label: draft.label.trim(),
    mode: draft.mode,
    useCase: draft.useCase,
    body: draft.body.trim(),
    negativeBase: nullableText(draft.negativeBase),
  };
}

// SPEC: operator-facing state phrase for a prompt recipe (mirrors profileStateLabelKey).
// INTENT: fold the raw draft/active/archived status into a plain sentence for list/detail
// copy; never show the machine status word outside the StatusPill badge.
export function recipeStateLabelKey(recipe: { status: string }): string {
  const status = recipe.status;
  if (status === "active") return "Published";
  if (status === "archived") return "Archived";
  if (status === "draft") return "Draft";
  return status || "draft";
}
