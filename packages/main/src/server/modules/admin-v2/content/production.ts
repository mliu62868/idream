import { z } from "zod";
import type {
  ContentProductionDirectionsRequest,
  ContentProductionEstimateRequest,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { estimateCreativeRunCost } from "../creative/run-create";
import {
  adminTextRuntimeIdentity,
  assertAdminTextGenerationAvailable,
  generateAdminText,
  type AdminTextGenerationRuntime,
} from "./text-generation";

// SPEC: 建 Creative Run 之前的两件读侧辅助 —— AI 生成四条创意方向，以及一次 Run 的额度预估。
// INTENT: 两者都不写任何权威状态。Run 本身的创建、审阅、投放权威都在 admin-v2/creative，
//         这里不复制任何判断，成本预估直接向 `estimateCreativeRunCost` 要。

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

type CreativeDirection = z.infer<typeof creativeDirectionSchema>;

/** SPEC: 模型自由文本 → 四条结构化方向；解不出来就是 provider 不可用，不静默降级。 */
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
  input: ContentProductionDirectionsRequest,
  character: { name: string },
): ContentProductionDirectionsRequest {
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

function modelPrompt(input: ContentProductionDirectionsRequest, character: {
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
  body: ContentProductionDirectionsRequest,
  runtime?: AdminTextGenerationRuntime,
) {
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

  return {
    directions,
    source: "model" as const,
    runtime: adminTextRuntimeIdentity(runtime),
  };
}

export async function estimateProductionBatch(body: ContentProductionEstimateRequest) {
  return estimateCreativeRunCost(body);
}
