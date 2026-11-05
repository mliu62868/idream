// SPEC: 创建向导的预填来源（一句话灵感、模板）统一成一份「建议」，只填运营还没写的字段。
// INVARIANT: 预填不写服务端，选完即与来源脱钩；所有字段照常走创建校验。
import {
  type CharacterProjectDraft,
  type ContentCharacterAssistResponse,
  type ContentTemplate,
} from "@idream/shared/admin";
import { CHARACTER_STYLES, GENDERS, isCatalogMember } from "@idream/shared/catalog";
import { starterDetailsMarkdown, starterTextField } from "@/components/admin/starters/starters-api";

type Persona = CharacterProjectDraft["persona"];
type Visual = CharacterProjectDraft["visualDirection"];

export type CharacterDraftSuggestion = {
  gender?: Persona["gender"];
  style?: Visual["style"];
  name?: string;
  characterPromise?: string;
  detailsMarkdown?: string;
  firstMessage?: string;
  identityAnchor?: string;
  stableTraits?: readonly string[];
  referenceDirection?: string;
};

const TEXT_FIELDS = {
  name: ["persona", "Name"],
  characterPromise: ["persona", "Short description"],
  firstMessage: ["persona", "Opening message"],
  detailsMarkdown: ["persona", "Additional details"],
  identityAnchor: ["visualDirection", "Look in one line"],
  referenceDirection: ["visualDirection", "Image mood and framing"],
} as const;

export type CharacterDraftFillResult = {
  draft: CharacterProjectDraft;
  /** Field labels the suggestion wrote. */
  filled: string[];
  /** Field labels that kept the operator's own text. */
  kept: string[];
};

export function fillEmptyDraftFields(
  draft: CharacterProjectDraft,
  suggestion: CharacterDraftSuggestion,
): CharacterDraftFillResult {
  const next = {
    persona: { ...draft.persona },
    visualDirection: { ...draft.visualDirection },
  };
  const filled: string[] = [];
  const kept: string[] = [];
  for (const [field, [section, label]] of Object.entries(TEXT_FIELDS) as [keyof typeof TEXT_FIELDS, (typeof TEXT_FIELDS)[keyof typeof TEXT_FIELDS]][]) {
    const value = suggestion[field]?.trim();
    if (!value) continue;
    const target = next[section] as Record<string, unknown>;
    if (String(target[field] ?? "").trim()) {
      kept.push(label);
    } else {
      target[field] = value;
      filled.push(label);
    }
  }
  if (suggestion.stableTraits?.length) {
    if (next.visualDirection.stableTraits.length > 0) {
      kept.push("Features that never change");
    } else {
      next.visualDirection.stableTraits = [...suggestion.stableTraits];
      filled.push("Features that never change");
    }
  }
  // Gender and style always hold a value, so a template's choice is applied and reported.
  if (suggestion.gender && suggestion.gender !== next.persona.gender) {
    next.persona.gender = suggestion.gender;
    filled.push("Gender");
  }
  if (suggestion.style && suggestion.style !== next.visualDirection.style) {
    next.visualDirection.style = suggestion.style;
    filled.push("Visual style");
  }
  return { draft: next, filled, kept };
}

export function assistSuggestion(result: ContentCharacterAssistResponse): CharacterDraftSuggestion {
  return {
    name: result.nameIdeas[0],
    characterPromise: result.description,
    detailsMarkdown: result.advancedDetails.detailsMarkdown,
    firstMessage: result.advancedDetails.firstMessage,
    identityAnchor: result.visualDirection?.identityAnchor,
    stableTraits: result.visualDirection?.stableTraits,
    referenceDirection: result.advancedDetails.visualBrief,
  };
}

function jsonField(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function textFrom(value: unknown, ...keys: string[]): string {
  if (typeof value === "string") return value.trim();
  for (const key of keys) {
    const text = starterTextField(value, key).trim();
    if (text) return text;
  }
  return "";
}

// INTENT: 模板有两种形状——种子的 face/hair/body，与后台表单的 notes/visualBrief；两种都要能用。
export function templateSuggestion(
  template: Pick<ContentTemplate, "summary" | "gender" | "style" | "appearance" | "advancedDetails">,
): CharacterDraftSuggestion {
  const { appearance, advancedDetails } = template;
  const face = jsonField(appearance, "face");
  const noteLines = starterTextField(appearance, "notes").split("\n").map((line) => line.trim()).filter(Boolean);
  const eyes = textFrom(face, "eyes", "eyeColor");
  const traits = [
    textFrom(jsonField(appearance, "hair"), "prompt", "summary"),
    textFrom(jsonField(appearance, "body"), "type", "prompt", "summary"),
    eyes ? `${eyes} eyes` : "",
    ...noteLines,
  ].filter(Boolean);
  return {
    gender: isCatalogMember(GENDERS, template.gender) ? template.gender : undefined,
    style: isCatalogMember(CHARACTER_STYLES, template.style) ? template.style : undefined,
    characterPromise: template.summary || starterTextField(advancedDetails, "description"),
    detailsMarkdown: starterDetailsMarkdown(advancedDetails),
    firstMessage: starterTextField(advancedDetails, "firstMessage"),
    identityAnchor: textFrom(face, "prompt", "summary") || noteLines[0],
    stableTraits: traits,
    referenceDirection: starterTextField(appearance, "visualBrief") || starterTextField(advancedDetails, "visualBrief"),
  };
}

const DEFAULT_REFERENCE_DIRECTION = "Soft natural light, head-and-shoulders portrait, clean uncluttered background";

// SPEC: 必填项能默认就默认。一句话形象取短描述，画面风格给一个通用肖像；外貌特征没有合理默认。
export function withVisualDirectionDefaults(draft: CharacterProjectDraft): CharacterProjectDraft {
  const { visualDirection, persona } = draft;
  if (visualDirection.identityAnchor.trim() && visualDirection.referenceDirection.trim()) return draft;
  return {
    ...draft,
    visualDirection: {
      ...visualDirection,
      identityAnchor: visualDirection.identityAnchor.trim() ? visualDirection.identityAnchor : persona.characterPromise.trim(),
      referenceDirection: visualDirection.referenceDirection.trim() ? visualDirection.referenceDirection : DEFAULT_REFERENCE_DIRECTION,
    },
  };
}
