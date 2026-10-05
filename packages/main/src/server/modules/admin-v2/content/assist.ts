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
  requestId?: string,
) {
  const inputModeration = await moderateText("character_assist", "draft", body.seed, "input");
  if (inputModeration.status === "blocked") {
    throw Errors.forbidden("Generated draft failed safety checks", inputModeration);
  }
  assertAdminTextGenerationAvailable(runtime);
  const traits = [body.gender, body.style].filter(Boolean).join(", ");
  const context = traits ? `${body.seed} (${traits})` : body.seed;

  // INVARIANT: the configured local model is a single runtime. Concurrent
  // streams queue behind one model and later requests can exhaust their first-
  // token budget before inference starts, turning a healthy provider into 503.
  const description = await generateAdminText({
    messages: [
      {
        role: "system",
        content:
          "For the background bio field, output ONE plain, concise sentence about this ADULT (18+) AI companion. Use 12-20 words and target 120 characters; never exceed 200 characters including spaces and punctuation. Mention the defining role and one personality trait from the user's seed. No headings, lists, preface, or extra sentences.",
      },
      { role: "user", content: context },
    ],
  }, runtime, { stage: "description", maxTokens: 192, maxCharacters: 200, requestId });
  const detailsMarkdown = await generateAdminText({
    messages: [
      {
        role: "system",
        content:
          "Write concise Markdown details for an ADULT (18+) AI companion based on the user's seed. Use exactly 4 short sections: Personality, Voice, Background, Boundaries. Each section has 1-2 complete sentences. At most 160 words in total, including headings. Do not repeat name, age, gender, or the short character promise. Output Markdown only.",
      },
      { role: "user", content: context },
    ],
  }, runtime, { stage: "detailsMarkdown", maxTokens: 512, requestId });
  const firstMessage = await generateAdminText({
    messages: [
      {
        role: "system",
        content:
          "You are a fiction dialogue writer creating the first message spoken by an ADULT (18+) AI companion. Write directly in the character's voice to the visitor. Do not discuss the prompt or character setup with the operator, ask what to write, or request clarification about the task. Return only the spoken greeting: exactly 2 concise, complete sentences, at most 40 words in total, immediately playable, no headings or quotation marks.",
      },
      {
        role: "user",
        content: `Write the character's first greeting directly to a visitor arriving for their first meeting. Return only the spoken greeting, two concise complete sentences. Character concept: ${context}`,
      },
    ],
  }, runtime, { stage: "firstMessage", maxTokens: 192, requestId });
  const visualBrief = await generateAdminText({
    messages: [
      {
        role: "system",
        content:
          "Write a concise visual art direction for this ADULT (18+) character. At most 80 words in total, in 3-4 complete sentences. Include face, hair, silhouette, wardrobe, signature detail, palette, and lighting. Prose only.",
      },
      { role: "user", content: context },
    ],
  }, runtime, { stage: "visualBrief", maxTokens: 320, requestId });
  let nameIdeas: string[] = [];
  if (body.includeNameIdeas !== false) {
    const rawNameIdeas = await generateAdminText({
      messages: [
        {
          role: "system",
          content:
            "Suggest exactly 3 distinctive character names for this ADULT (18+) AI companion. One name per line, names only.",
        },
        { role: "user", content: context },
      ],
    }, runtime, { stage: "nameIdeas", maxTokens: 64, requestId });
    nameIdeas = nameIdeasFromText(rawNameIdeas);
  }

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
