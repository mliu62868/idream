export const FEATURED_SETTING_KEY = "feed.featured";
export const FEATURED_CHARACTER_LIMIT = 24;

export type FeaturedSettingDiagnosticCode =
  | "setting_not_object"
  | "character_ids_not_array"
  | "character_id_not_string"
  | "character_id_blank"
  | "character_id_duplicate"
  | "character_id_overflow";

export type FeaturedSettingDiagnostic = {
  code: FeaturedSettingDiagnosticCode;
  message: string;
  index?: number;
  id?: string;
};

export type ParsedFeaturedSetting = {
  characterIds: string[];
  diagnostics: FeaturedSettingDiagnostic[];
};

/**
 * Canonical parser for every reader of AppSetting(feed.featured).
 *
 * Undefined means the setting does not exist yet and is a valid empty
 * configuration. A stored malformed value is also made safe, but diagnostics
 * remain available to Admin so historical corruption is never invisible.
 */
export function parseFeaturedSetting(value: unknown): ParsedFeaturedSetting {
  if (value === undefined) {
    return { characterIds: [], diagnostics: [] };
  }
  if (!isRecord(value)) {
    return {
      characterIds: [],
      diagnostics: [{
        code: "setting_not_object",
        message: "The stored Featured setting is not an object.",
      }],
    };
  }

  const rawIds = value.characterIds;
  if (!Array.isArray(rawIds)) {
    return {
      characterIds: [],
      diagnostics: [{
        code: "character_ids_not_array",
        message: "The stored Featured characterIds value is not an array.",
      }],
    };
  }

  const characterIds: string[] = [];
  const diagnostics: FeaturedSettingDiagnostic[] = [];
  const seen = new Set<string>();

  rawIds.forEach((rawId, index) => {
    if (typeof rawId !== "string") {
      diagnostics.push({
        code: "character_id_not_string",
        index,
        message: `Featured characterIds[${index}] is not a string.`,
      });
      return;
    }

    const id = rawId.trim();
    if (!id) {
      diagnostics.push({
        code: "character_id_blank",
        index,
        message: `Featured characterIds[${index}] is blank.`,
      });
      return;
    }
    if (seen.has(id)) {
      diagnostics.push({
        code: "character_id_duplicate",
        index,
        id,
        message: `Featured character ${id} is duplicated.`,
      });
      return;
    }
    seen.add(id);
    if (characterIds.length >= FEATURED_CHARACTER_LIMIT) {
      diagnostics.push({
        code: "character_id_overflow",
        index,
        id,
        message: `Featured character ${id} exceeds the ${FEATURED_CHARACTER_LIMIT}-character limit.`,
      });
      return;
    }
    characterIds.push(id);
  });

  return { characterIds, diagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
