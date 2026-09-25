import { CHARACTER_STYLES, GENDERS } from "@idream/shared/catalog";
import { z } from "zod";
import { CREATE_SOUL_DETAIL_FIELDS } from "@/lib/create-soul-catalog";
import { Errors } from "@/server/lib/errors";
import type { ChatModel } from "@/server/providers/types";

// SPEC: POST /v1/character-drafts/quick-start — one sentence in, suggested
// Create-wizard fields out (PRD CR-10).
// INTENT: this is only a prefill. Nothing is written here: no draft, no
//   character, no image. The client applies the fields through the same path as
//   a template and the user still walks and edits all five wizard steps.
// INVARIANT: every returned field is one the wizard already has; catalog-backed
//   fields carry only catalog members. An invalid field is dropped rather than
//   failing the whole draft — a partial prefill is still useful.
// INVARIANT: an implied age under 18 is refused, never raised to 18.

export const characterQuickStartRequestSchema = z.object({
  brief: z.string().trim().min(3).max(500),
}).strict();

const soulCatalog = (label: "Personality" | "Occupation" | "Relationship") =>
  CREATE_SOUL_DETAIL_FIELDS.find((field) => field.label === label)!.suggestions as readonly string[];

const PERSONALITIES = soulCatalog("Personality");
const OCCUPATIONS = soulCatalog("Occupation");
const RELATIONSHIPS = soulCatalog("Relationship");

const MIN_AGE = 18;
const MAX_AGE = 120;

const text = (max: number) => z.string().trim().min(1).max(max);
// Catalog values are matched case-insensitively and returned in catalog spelling.
const catalog = (values: readonly string[]) =>
  z.string().trim().transform((value, ctx) => {
    const match = values.find((item) => item.toLowerCase() === value.toLowerCase());
    if (!match) ctx.addIssue({ code: "custom", message: "Not a catalog value" });
    return match ?? z.NEVER;
  });

// Limits mirror the wizard/draft write schema (name 80, promise 1,000, first message 4,000).
const fieldSchemas = {
  name: text(80),
  gender: catalog(GENDERS),
  style: catalog(CHARACTER_STYLES),
  appearance: text(300),
  ethnicity: text(80),
  skinTone: text(80),
  eyeColor: text(80),
  faceShape: text(120),
  hair: text(160),
  body: text(160),
  description: text(1_000),
  firstMessage: text(4_000),
  personality: catalog(PERSONALITIES),
  occupation: catalog(OCCUPATIONS),
  relationship: catalog(RELATIONSHIPS),
} as const;

type QuickStartTextField = keyof typeof fieldSchemas;

export type CharacterQuickStartDraft = Partial<Record<QuickStartTextField, string>> & {
  age?: number;
};

export type CharacterQuickStartRuntime = {
  /** False when Main's chat provider is the mock: there is no model to ask. */
  available: boolean;
  /** Main's configured OpenAI-compatible chat model; it owns the request timeout. */
  stream: ChatModel["stream"];
  moderate: (
    content: string,
    layer: "input" | "output",
  ) => Promise<{ status: string; policyCode?: string }>;
};

const ADULTS_ONLY_MESSAGE =
  "Characters must be adults (18+). Describe an adult character and try again.";

function underageRefusal() {
  return Errors.forbidden(ADULTS_ONLY_MESSAGE, { policyCode: "age_under_18" });
}

const UNDERAGE_POLICIES = new Set(["age_under_18", "potential_underage_content"]);

function moderationRefusal(policyCode: string | undefined) {
  if (!policyCode || UNDERAGE_POLICIES.has(policyCode)) return underageRefusal();
  return Errors.forbidden("That description did not pass safety checks. Rephrase it and try again.", { policyCode });
}

function retryable(message: string) {
  return Errors.unavailable(message, { retryable: true });
}

/**
 * Maps parsed model JSON onto wizard fields. Unknown keys and invalid values
 * are dropped; `age` is rounded and capped at 120, and below 18 it is refused.
 */
export function mapQuickStartOutput(raw: unknown): CharacterQuickStartDraft {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const draft: CharacterQuickStartDraft = {};
  for (const key of Object.keys(fieldSchemas) as QuickStartTextField[]) {
    const parsed = fieldSchemas[key].safeParse(record[key]);
    if (parsed.success) draft[key] = parsed.data;
  }
  const age = typeof record.age === "string" ? Number(record.age.trim()) : record.age;
  if (typeof age === "number" && Number.isFinite(age)) {
    if (age < MIN_AGE) throw underageRefusal();
    draft.age = Math.min(MAX_AGE, Math.round(age));
  }
  return draft;
}

/** Extracts the one JSON object from a model reply, tolerating code fences and prose around it. */
export function parseQuickStartJson(output: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function quickStartMessages(brief: string): Parameters<ChatModel["stream"]>[0]["messages"] {
  return [
    {
      role: "system",
      content: [
        "You turn a one-sentence character idea into a draft for an adult (18+) AI companion character.",
        "Reply with exactly one JSON object and nothing else. Omit any key you cannot fill well.",
        "Keys:",
        '- "name": a fitting first name (and optional surname).',
        `- "age": integer. The character is an adult; use the age the description states or implies. If the description implies someone under 18, return that real age — never invent an adult age for a minor.`,
        `- "gender": one of ${GENDERS.join(", ")}.`,
        `- "style": one of ${CHARACTER_STYLES.join(", ")} (art style of the character's images; realistic unless the idea suggests anime or illustration).`,
        '- "appearance", "ethnicity", "skinTone", "eyeColor", "faceShape", "hair", "body": short English phrases describing the look; they are sent to an image model.',
        '- "description": one or two sentences that sell the character, written in the language of the idea.',
        '- "firstMessage": the character\'s opening chat message, in character, 1-3 sentences, in the language of the idea.',
        `- "personality": copy exactly one of: ${PERSONALITIES.join("; ")}.`,
        `- "occupation": copy exactly one of: ${OCCUPATIONS.join("; ")}.`,
        `- "relationship" (to the user): copy exactly one of: ${RELATIONSHIPS.join("; ")}.`,
        "For personality, occupation and relationship pick the closest listed value; never write a value that is not listed.",
      ].join("\n"),
    },
    { role: "user", content: brief },
  ];
}

export async function generateCharacterQuickStart(
  brief: string,
  runtime: CharacterQuickStartRuntime,
): Promise<CharacterQuickStartDraft> {
  const input = await runtime.moderate(brief, "input");
  if (input.status === "blocked") throw moderationRefusal(input.policyCode);
  if (!runtime.available) {
    throw Errors.unavailable(
      "Quick Start is unavailable right now. Start from a template or from scratch.",
    );
  }

  let output = "";
  try {
    for await (const chunk of runtime.stream({ messages: quickStartMessages(brief) })) {
      output += chunk.delta;
    }
  } catch {
    throw retryable("Quick Start could not reach the character model. Try again.");
  }

  const draft = mapQuickStartOutput(parseQuickStartJson(output));
  if (Object.keys(draft).length === 0) {
    throw retryable("Quick Start could not turn that into a draft. Try again or rephrase.");
  }

  const generated = await runtime.moderate(
    Object.values(draft).filter((value) => typeof value === "string").join("\n"),
    "output",
  );
  if (generated.status === "blocked") throw moderationRefusal(generated.policyCode);
  return draft;
}
