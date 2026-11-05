// SPEC: 批量导入的纯逻辑：把粘贴/上传的 JSON 数组解析成逐行结果，校验与创建向导同一份契约。
// INTENT: 能默认的视觉字段照向导默认，只把真正缺的东西告诉运营。
import {
  characterProjectProductionReadyDraftSchema,
  type CharacterProjectDraft,
} from "@idream/shared/admin";
import { characterCreateStepFieldErrors } from "./character-form-validation";
import { withVisualDirectionDefaults } from "./character-create-prefill";

export const CHARACTER_IMPORT_MAX_ROWS = 100;
export const CHARACTER_IMPORT_CONCURRENCY = 4;

export const CHARACTER_IMPORT_EXAMPLE = JSON.stringify([
  {
    name: "Mara Vale",
    age: 30,
    gender: "female",
    characterPromise: "A dry-witted night-shift nurse who remembers everything you tell her",
    firstMessage: "Long shift. Sit down, and tell me the real version of your day.",
    detailsMarkdown: "## Voice\nDry and unhurried.",
    style: "realistic",
    identityAnchor: "Composed night-shift nurse in her thirties",
    stableTraits: ["Dark wavy hair", "Warm brown eyes"],
    referenceDirection: "Warm low light, close-up portrait",
  },
  {
    name: "Ren Hale",
    age: 34,
    gender: "male",
    characterPromise: "A quiet bookshop owner with an old-fashioned sense of courtesy",
    firstMessage: "You came back. I kept the book you were reading aside.",
    stableTraits: ["Short black hair", "Round glasses"],
  },
], null, 2);

export type CharacterImportRow = {
  readonly index: number;
  readonly label: string;
  readonly draft: CharacterProjectDraft | null;
  readonly errors: readonly string[];
};

export type CharacterImportParseResult =
  | { readonly ok: true; readonly rows: readonly CharacterImportRow[] }
  | { readonly ok: false; readonly error: "invalid_json" | "not_array" | "empty" | "too_many" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Accepts the flat example shape and the API's nested shape.
function draftFromRow(row: Record<string, unknown>): CharacterProjectDraft {
  const persona = isRecord(row.persona) ? row.persona : row;
  const visual = isRecord(row.visualDirection) ? row.visualDirection : row;
  const traits = visual.stableTraits;
  return {
    persona: {
      name: String(persona.name ?? "").trim(),
      age: typeof persona.age === "number" ? persona.age : Number(persona.age ?? 18),
      gender: String(persona.gender ?? "female"),
      characterPromise: String(persona.characterPromise ?? persona.description ?? "").trim(),
      detailsMarkdown: String(persona.detailsMarkdown ?? "").trim(),
      firstMessage: String(persona.firstMessage ?? "").trim(),
    },
    visualDirection: {
      identityAnchor: String(visual.identityAnchor ?? "").trim(),
      stableTraits: Array.isArray(traits)
        ? traits.map((trait) => String(trait).trim()).filter(Boolean)
        : typeof traits === "string"
          ? traits.split("\n").map((trait) => trait.trim()).filter(Boolean)
          : [],
      style: String(visual.style ?? "realistic"),
      referenceDirection: String(visual.referenceDirection ?? "").trim(),
    },
  } as CharacterProjectDraft;
}

export function parseCharacterImport(text: string): CharacterImportParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!Array.isArray(value)) return { ok: false, error: "not_array" };
  if (value.length === 0) return { ok: false, error: "empty" };
  if (value.length > CHARACTER_IMPORT_MAX_ROWS) return { ok: false, error: "too_many" };
  return {
    ok: true,
    rows: value.map((row, index): CharacterImportRow => {
      if (!isRecord(row)) {
        return { index, label: "", draft: null, errors: ["This row must be an object."] };
      }
      const draft = withVisualDirectionDefaults(draftFromRow(row));
      const parsed = characterProjectProductionReadyDraftSchema.safeParse(draft);
      return {
        index,
        label: draft.persona.name,
        draft: parsed.success ? parsed.data : null,
        errors: parsed.success ? [] : Object.values(characterCreateStepFieldErrors(draft, 2)),
      };
    }),
  };
}

// INVARIANT: 键由「行 + 内容」决定：同一行重试复用同一把键，不会建出第二个角色；改了内容才是新请求。
export function characterImportIntent(row: Pick<CharacterImportRow, "index" | "draft">) {
  return `character-import:${row.index}:${JSON.stringify(row.draft)}`;
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  }));
}
