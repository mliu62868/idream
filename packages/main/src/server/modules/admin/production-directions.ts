import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  adminTextRuntimeIdentity,
  assertAdminTextGenerationAvailable,
  generateAdminText,
  type AdminTextGenerationRuntime,
} from "./shared/admin-text-generation";
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

export async function generateProductionDirections(
  request: Request,
  runtime?: AdminTextGenerationRuntime,
): Promise<Response> {
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
  assertAdminTextGenerationAvailable(runtime);

  const result = await generateAdminText({
    messages: [
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
    ],
  }, runtime);
  const directions = parseDirections(result);
  if (!directions) {
    throw Errors.unavailable(
      "AI creative directions returned an invalid model response. Check the chat model and try again",
    );
  }

  return ok({
    directions,
    source: "model",
    runtime: adminTextRuntimeIdentity(runtime),
  });
}
