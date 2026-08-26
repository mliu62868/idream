import type { ContentCharacterAssistRequest } from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import {
  adminTextRuntimeIdentity,
  assertAdminTextGenerationAvailable,
  generateAdminText,
  type AdminTextGenerationRuntime,
} from "./text-generation";
import { moderateText } from "@/server/moderation/text-authority";

// SPEC: AI 辅助生成 —— 一句话 seed → 基本信息 + 一段可自由编辑的 Soul Markdown。
// INTENT: 仅产出建议，不落库；admin 在 UI 里二次编辑后再走 official / template 的创建流。
// INVARIANT: seed 与生成结果都要过 moderation，blocked → 403。

function nameIdeasFromText(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

export async function generateCharacterDraft(
  body: ContentCharacterAssistRequest,
  runtime?: AdminTextGenerationRuntime,
) {
  const inputModeration = await moderateText("character_assist", "draft", body.seed, "input");
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
  const detailsMarkdown = await generateAdminText({
    messages: [
      {
        role: "system",
        content:
          "Write concise Markdown details for an ADULT (18+) AI companion based on the user's seed. Use only useful sections such as Personality, Voice, Background, Boundaries, or Dialogue examples. Do not repeat name, age, gender, relationship, or the short character promise. Output Markdown only.",
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
    `${body.seed} ${description} ${detailsMarkdown} ${firstMessage} ${visualBrief} ${nameIdeas.join(" ")}`,
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Generated draft failed safety checks", moderation);
  }

  return {
    description,
    nameIdeas,
    advancedDetails: { detailsMarkdown, firstMessage, visualBrief },
    runtime: adminTextRuntimeIdentity(runtime),
  };
}
