import type {
  ContentCharacterAssistRequest,
  ContentCharacterAssistStage,
} from "@idream/shared/admin";
import { AppError, Errors } from "@/server/lib/errors";
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
// INVARIANT: 单个字段失败只让该字段留空并列入 failedStages；全部失败才算失败（503）。

function nameIdeasFromText(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

function visualIdentityFromText(value: string) {
  const [identityAnchor, ...stableTraits] = value
    .split(/\r?\n/)
    .map((item) => item.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean);
  if (!identityAnchor || stableTraits.length === 0) {
    throw Errors.unavailable("AI text generation returned no usable visual traits", {
      stage: "visualIdentity",
      failureKind: "empty_output",
    });
  }
  return { identityAnchor, stableTraits: stableTraits.slice(0, 6) };
}

// INTENT: 输出超限、输出为空只影响这一个字段，后面的字段值得继续试；连接失败或超时说明模型本身
// 不可用，继续只会让运营再等几个超时。
const MODEL_OUTPUT_FAILURES = new Set(["output_limit", "summary_limit", "empty_output"]);

function failureKindOf(error: AppError) {
  const details = error.details;
  return details && typeof details === "object" && "failureKind" in details
    ? String(details.failureKind)
    : null;
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

  const failures: AppError[] = [];
  const failedStages: ContentCharacterAssistStage[] = [];
  let modelUnavailable = false;
  let completed = 0;
  // INVARIANT: the configured local model is a single runtime. Concurrent
  // streams queue behind one model and later requests can exhaust their first-
  // token budget before inference starts, turning a healthy provider into 503.
  const attempt = async <T>(stage: ContentCharacterAssistStage, run: () => Promise<T>): Promise<T | null> => {
    if (modelUnavailable) {
      failedStages.push(stage);
      return null;
    }
    try {
      const result = await run();
      completed += 1;
      return result;
    } catch (cause) {
      if (!(cause instanceof AppError) || cause.code !== "unavailable") throw cause;
      failures.push(cause);
      failedStages.push(stage);
      if (!MODEL_OUTPUT_FAILURES.has(failureKindOf(cause) ?? "")) modelUnavailable = true;
      return null;
    }
  };

  const description = await attempt("description", () => generateAdminText({
    messages: [
      {
        role: "system",
        content:
          "For the background bio field, output ONE plain, concise sentence about this ADULT (18+) AI companion. Use 12-20 words and target 120 characters; never exceed 200 characters including spaces and punctuation. Mention the defining role and one personality trait from the user's seed. No headings, lists, preface, or extra sentences.",
      },
      { role: "user", content: context },
    ],
  }, runtime, { stage: "description", maxTokens: 192, maxCharacters: 200, requestId }));
  const detailsMarkdown = await attempt("detailsMarkdown", () => generateAdminText({
    messages: [
      {
        role: "system",
        content:
          "Write concise Markdown details for an ADULT (18+) AI companion based on the user's seed. Use exactly 4 short sections: Personality, Voice, Background, Boundaries. Each section has 1-2 complete sentences. At most 160 words in total, including headings. Do not repeat name, age, gender, or the short character promise. Output Markdown only.",
      },
      { role: "user", content: context },
    ],
  }, runtime, { stage: "detailsMarkdown", maxTokens: 512, requestId }));
  const firstMessage = await attempt("firstMessage", () => generateAdminText({
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
  }, runtime, { stage: "firstMessage", maxTokens: 192, requestId }));
  const visualBrief = await attempt("visualBrief", () => generateAdminText({
    messages: [
      {
        role: "system",
        content:
          "Write a concise visual art direction for this ADULT (18+) character. At most 80 words in total, in 3-4 complete sentences. Include face, hair, silhouette, wardrobe, signature detail, palette, and lighting. Prose only.",
      },
      { role: "user", content: context },
    ],
  }, runtime, { stage: "visualBrief", maxTokens: 320, requestId }));
  const visualIdentity = body.includeVisualDirection === true
    ? await attempt("visualIdentity", async () => visualIdentityFromText(await generateAdminText({
        messages: [
          {
            role: "system",
            content:
              "Describe how to recognize this ADULT (18+) character in every image. Line 1: one short phrase saying who they look like at a glance, naming their adult role. Lines 2-6: one visible physical trait per line that never changes, such as hair or eye color. Plain lines only, no headings or labels.",
          },
          { role: "user", content: context },
        ],
      }, runtime, { stage: "visualIdentity", maxTokens: 192, requestId })))
    : null;
  const rawNameIdeas = body.includeNameIdeas !== false
    ? await attempt("nameIdeas", () => generateAdminText({
        messages: [
          {
            role: "system",
            content:
              "Suggest exactly 3 distinctive character names for this ADULT (18+) AI companion. One name per line, names only.",
          },
          { role: "user", content: context },
        ],
      }, runtime, { stage: "nameIdeas", maxTokens: 64, requestId }))
    : null;
  const nameIdeas = rawNameIdeas ? nameIdeasFromText(rawNameIdeas) : [];

  if (completed === 0 && failures[0]) throw failures[0];

  const moderation = await moderateText(
    "character_assist",
    "draft",
    [
      body.seed, description, detailsMarkdown, firstMessage, visualBrief,
      visualIdentity?.identityAnchor, ...(visualIdentity?.stableTraits ?? []), ...nameIdeas,
    ].filter(Boolean).join(" "),
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Generated draft failed safety checks", moderation);
  }

  return {
    description: description ?? "",
    nameIdeas,
    advancedDetails: {
      detailsMarkdown: detailsMarkdown ?? "",
      firstMessage: firstMessage ?? "",
      visualBrief: visualBrief ?? "",
    },
    ...(visualIdentity ? { visualDirection: visualIdentity } : {}),
    failedStages,
    runtime: adminTextRuntimeIdentity(runtime),
  };
}
