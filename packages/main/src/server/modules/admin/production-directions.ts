import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { providers } from "@/server/providers";
import { actorWithPermission, jsonBody } from "./service";

const purposeSchema = z.enum([
  "character_cover",
  "character_hero",
  "character_chat",
  "feed",
  "homepage",
  "seo",
  "template_cover",
  "campaign",
  "model_eval",
]);

const consistencyModeSchema = z.enum(["strict", "balanced", "creative"]);

const directionRequestSchema = z.object({
  characterId: z.string().trim().min(1).max(180),
  purpose: purposeSchema,
  creativeBrief: z.string().trim().max(240).default(""),
  scenePrompt: z.string().trim().max(1_200).default(""),
  mood: z.string().trim().max(120).default(""),
  setting: z.string().trim().max(120).default(""),
  outfit: z.string().trim().max(120).default(""),
  camera: z.string().trim().max(120).default(""),
  lighting: z.string().trim().max(120).default(""),
  consistencyMode: consistencyModeSchema.default("balanced"),
});

const creativeDirectionSchema = z.object({
  title: z.string().trim().min(2).max(80),
  scenePrompt: z.string().trim().min(12).max(1_200),
  mood: z.string().trim().min(1).max(120),
  setting: z.string().trim().min(1).max(120),
  outfit: z.string().trim().min(1).max(120),
  camera: z.string().trim().min(1).max(120),
  lighting: z.string().trim().min(1).max(120),
});

const creativeDirectionsSchema = z.array(creativeDirectionSchema).length(4);

type DirectionRequest = z.infer<typeof directionRequestSchema>;
type CreativeDirection = z.infer<typeof creativeDirectionSchema>;
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function aggregate(messages: ChatMessage[]): Promise<string> {
  let text = "";
  for await (const chunk of providers.chat.stream({ messages })) text += chunk.delta;
  return text.trim();
}

function parseDirections(text: string): CreativeDirection[] | null {
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const arrayStart = unfenced.indexOf("[");
  const arrayEnd = unfenced.lastIndexOf("]");
  if (arrayStart < 0 || arrayEnd <= arrayStart) return null;
  try {
    return creativeDirectionsSchema.parse(JSON.parse(unfenced.slice(arrayStart, arrayEnd + 1)));
  } catch {
    return null;
  }
}

function valueOrFallback(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function withStarterPrompt(
  input: DirectionRequest,
  character: { name: string },
): DirectionRequest {
  const purpose = input.purpose.replaceAll("_", " ");
  const creativeBrief = valueOrFallback(
    input.creativeBrief,
    valueOrFallback(input.scenePrompt, `${purpose} creative exploration for ${character.name}`),
  );
  const scenePrompt = valueOrFallback(
    input.scenePrompt,
    valueOrFallback(
      input.creativeBrief,
      `Create a compelling ${purpose} scene featuring ${character.name} while preserving the locked character identity`,
    ),
  );
  return { ...input, creativeBrief, scenePrompt };
}

export function fallbackCreativeDirections(input: DirectionRequest): CreativeDirection[] {
  const mood = valueOrFallback(input.mood, "cinematic and emotionally present");
  const setting = valueOrFallback(input.setting, "a setting that supports the story moment");
  const outfit = valueOrFallback(input.outfit, "an outfit consistent with the character");
  const lighting = valueOrFallback(input.lighting, "soft directional light with clear facial detail");
  const base = input.scenePrompt.trim().replace(/[.!?]+$/, "");
  return [
    {
      title: "Intimate close-up",
      scenePrompt: `${base}. Focus on a quiet, emotionally readable close-up and one natural gesture that makes the moment feel candid.`,
      mood,
      setting,
      outfit,
      camera: valueOrFallback(input.camera, "85mm close portrait, shallow depth of field"),
      lighting,
    },
    {
      title: "Environmental story",
      scenePrompt: `${base}. Pull back to show the environment and let foreground and background details explain what happened just before this moment.`,
      mood,
      setting,
      outfit,
      camera: "35mm environmental portrait, layered composition",
      lighting,
    },
    {
      title: "Candid movement",
      scenePrompt: `${base}. Capture the character mid-action with natural body language, a believable imperfect moment, and subtle motion in the scene.`,
      mood,
      setting,
      outfit,
      camera: "50mm candid frame, eye-level, gentle motion",
      lighting,
    },
    {
      title: "Editorial variation",
      scenePrompt: `${base}. Reinterpret the same story beat with a stronger graphic composition, a distinctive camera angle, and polished editorial restraint.`,
      mood,
      setting,
      outfit,
      camera: "editorial portrait, deliberate negative space",
      lighting: valueOrFallback(input.lighting, "controlled cinematic key light and practical highlights"),
    },
  ];
}

function modelPrompt(input: DirectionRequest, character: {
  name: string;
  age: number;
  style: string;
  description: string;
  identityPrompt: string | null;
}) {
  return JSON.stringify({
    character: {
      name: character.name,
      age: character.age,
      style: character.style,
      description: character.description.slice(0, 500),
      lockedIdentity: character.identityPrompt?.slice(0, 700) ?? null,
    },
    production: input,
  });
}

export async function generateProductionDirections(request: Request): Promise<Response> {
  await actorWithPermission(request, "content.production.write");
  const body = directionRequestSchema.parse(await jsonBody(request));
  const character = await prisma.character.findUnique({
    where: { id: body.characterId, deletedAt: null },
    select: {
      name: true,
      age: true,
      style: true,
      description: true,
      visualProfiles: {
        where: { status: "active" },
        orderBy: { version: "desc" },
        take: 1,
        select: { identityPrompt: true },
      },
    },
  });
  if (!character) throw Errors.notFound("Character not found");
  const input = withStarterPrompt(body, character);

  let directions: CreativeDirection[] | null = null;
  try {
    const result = await aggregate([
      {
        role: "system",
        content: [
          "You are a senior image content director for an AI companion product.",
          "Create exactly four meaningfully different, production-ready visual directions for the supplied adult character and operator brief.",
          "The character identity is locked: never rewrite face, age, body, or signature identity in scenePrompt.",
          "Vary story beat, action, composition, camera distance, and lighting while preserving the requested theme.",
          "Return JSON only: an array of four objects with keys title, scenePrompt, mood, setting, outfit, camera, lighting.",
          "Keep titles short and scenePrompt under 120 words.",
        ].join(" "),
      },
      {
        role: "user",
        content: modelPrompt(input, {
          ...character,
          identityPrompt: character.visualProfiles[0]?.identityPrompt ?? null,
        }),
      },
    ]);
    directions = parseDirections(result);
  } catch {
    directions = null;
  }

  return ok({
    directions: directions ?? fallbackCreativeDirections(input),
    source: directions ? "model" : "fallback",
  });
}
