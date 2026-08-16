// SPEC: 生成预设三件套的共享契约 —— 类型/端点/payload 构造（SSoT，三页共用）。
// INVARIANTS: payload 字段与后端 presetAdminSchema（service.ts:339-346）一致，**无 reason 字段**——
// 与 Starters/Official 不同，写操作（编辑/归档/恢复）不采集一个后端根本不收的 reason（T14 评审确立的规则）。

export type PresetRow = {
  id: string;
  scope: string;
  type: string;
  category: string | null;
  label: string;
  controls: Record<string, unknown>;
  visibility: string;
  status: string;
};

export const PRESET_TYPES = ["background", "pose", "outfit", "mode"] as const;
export const PRESET_VISIBILITY = ["public", "private", "unlisted"] as const;
export const PRESETS_LIST = "/api/v2/admin/generation/presets";

export type PresetDraft = {
  type: (typeof PRESET_TYPES)[number];
  category: string;
  label: string;
  controlsJson: string;
  visibility: (typeof PRESET_VISIBILITY)[number];
};

export const defaultPresetDraft: PresetDraft = {
  type: "background",
  category: "",
  label: "New background",
  controlsJson: "{}",
  visibility: "public",
};

// SPEC: controlsJson 非法 JSON 或解析结果非普通对象（数组/原始值/null）时抛 Error——
// 表单就地显示，不吞异常；空白 controlsJson 视为空对象 {}。
export function presetPayload(draft: PresetDraft): Record<string, unknown> {
  const trimmed = draft.controlsJson.trim();
  let controls: Record<string, unknown> = {};
  if (trimmed.length > 0) {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("controls must be a JSON object");
    }
    controls = parsed as Record<string, unknown>;
  }
  return {
    type: draft.type,
    label: draft.label.trim(),
    category: draft.category.trim() || undefined,
    controls,
    visibility: draft.visibility,
  };
}
