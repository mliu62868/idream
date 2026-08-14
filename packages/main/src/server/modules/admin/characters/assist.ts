// AI 辅助生成：一句话 seed → 可分区编辑的角色创作底稿。
// 仅产出建议，不落库；admin 在 UI 里二次编辑后再走 official/template 的创建流。
// 硬底线：生成结果与 seed 一并过 moderation，blocked → 403（守未成年拦截）。
import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  adminTextRuntimeIdentity,
  assertAdminTextGenerationAvailable,
  generateAdminText,
  type AdminTextGenerationRuntime,
} from "@/server/modules/admin/shared/admin-text-generation";
import { actorWithPermission, jsonBody } from "@/server/modules/admin/shared/legacy-primitives";
import { moderateText } from "@/server/moderation/text-authority";
import { CHARACTER_STYLES, GENDERS } from "@idream/shared/catalog";

const assistSchema = z.object({
  seed: z.string().trim().min(3).max(400),
  gender: z.enum(GENDERS).optional(),
  style: z.enum(CHARACTER_STYLES).optional(),
});

function nameIdeasFromText(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

// POST /api/v1/admin/content/character-assist
export async function generateCharacterDraft(
  request: Request,
  runtime?: AdminTextGenerationRuntime,
): Promise<Response> {
  await actorWithPermission(request, "content.official.write");
  const body = assistSchema.parse(await jsonBody(request));
  const inputModeration = await moderateText(
    "character_assist",
    "draft",
    body.seed,
    "input",
  );
  if (inputModeration.status === "blocked") {
    throw Errors.forbidden("Generated draft failed safety checks", inputModeration);
  }
  assertAdminTextGenerationAvailable(runtime);
  const traits = [body.gender, body.style].filter(Boolean).join(", ");
  const context = traits ? `${body.seed} (${traits})` : body.seed;

  // INVARIANT: the configured local model is a single runtime. Six concurrent
  // streams queue behind one model and later requests can exhaust their first-
  // token budget before inference starts, turning a healthy provider into 503.
  const description = await generateAdminText({
      messages: [
        {
          role: "system",
          content:
            "Write a vivid 2-3 sentence background bio for an ADULT (18+) AI companion based on the user's seed. Tasteful, safe, prose only — no headings or lists.",
        },
        { role: "user", content: context },
      ],
    }, runtime);
  const personality = await generateAdminText({
      messages: [
        {
          role: "system",
          content:
            "List 3-5 concise personality traits (comma-separated) for an ADULT (18+) AI companion based on the user's seed. Output the comma-separated traits only.",
        },
        { role: "user", content: context },
      ],
    }, runtime);
  const speakingStyle = await generateAdminText({
      messages: [
        {
          role: "system",
          content:
            "Describe this ADULT (18+) AI companion's speaking style in 2 concise sentences. Cover rhythm, vocabulary, warmth, and one distinctive verbal habit. Prose only.",
        },
        { role: "user", content: context },
      ],
    }, runtime);
  const firstMessage = await generateAdminText({
      messages: [
        {
          role: "system",
          content:
            "Write the first message this ADULT (18+) AI companion sends when meeting the user. 2-4 sentences, immediately playable, no headings or quotation marks.",
        },
        { role: "user", content: context },
      ],
    }, runtime);
  const visualBrief = await generateAdminText({
      messages: [
        {
          role: "system",
          content:
            "Write a concise visual art direction for this ADULT (18+) character. Include face, hair, silhouette, wardrobe, signature detail, palette, and lighting. Prose only.",
        },
        { role: "user", content: context },
      ],
    }, runtime);
  const rawNameIdeas = await generateAdminText({
      messages: [
        {
          role: "system",
          content:
            "Suggest exactly 3 distinctive character names for this ADULT (18+) AI companion. One name per line, names only.",
        },
        { role: "user", content: context },
      ],
    }, runtime);

  const nameIdeas = nameIdeasFromText(rawNameIdeas);

  const moderation = await moderateText(
    "character_assist",
    "draft",
    `${body.seed} ${description} ${personality} ${speakingStyle} ${firstMessage} ${visualBrief} ${nameIdeas.join(" ")}`,
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Generated draft failed safety checks", moderation);
  }

  return ok({
    description,
    nameIdeas,
    advancedDetails: { personality, speakingStyle, firstMessage, visualBrief },
    runtime: adminTextRuntimeIdentity(runtime),
  });
}
