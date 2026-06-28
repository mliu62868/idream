// AI 辅助生成：一句话 seed → 角色 description + personality 草稿（CHARACTER_MANAGEMENT_PLAN §8 后置增强）。
// 仅产出建议，不落库；admin 在 UI 里二次编辑后再走 official/template 的创建流。
// 硬底线：生成结果与 seed 一并过 moderation，blocked → 403（守未成年拦截）。
import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { providers } from "@/server/providers";
import { actorWithPermission, jsonBody } from "@/server/modules/admin/service";
import { moderateText } from "@/server/modules/ourdream/service";

const assistSchema = z.object({
  seed: z.string().trim().min(3).max(400),
  gender: z.enum(["female", "male", "trans"]).optional(),
  style: z.enum(["realistic", "anime", "hybrid", "other"]).optional(),
});

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function aggregate(messages: ChatMessage[]): Promise<string> {
  let text = "";
  for await (const chunk of providers.chat.stream({ messages })) {
    text += chunk.delta;
  }
  return text.trim();
}

// POST /api/v1/admin/content/character-assist
export async function generateCharacterDraft(request: Request): Promise<Response> {
  await actorWithPermission(request, "content.official.write");
  const body = assistSchema.parse(await jsonBody(request));
  const traits = [body.gender, body.style].filter(Boolean).join(", ");
  const context = traits ? `${body.seed} (${traits})` : body.seed;

  const [description, personality] = await Promise.all([
    aggregate([
      {
        role: "system",
        content:
          "Write a vivid 2-3 sentence background bio for an ADULT (18+) AI companion based on the user's seed. Tasteful, safe, prose only — no headings or lists.",
      },
      { role: "user", content: context },
    ]),
    aggregate([
      {
        role: "system",
        content:
          "List 3-5 concise personality traits (comma-separated) for an ADULT (18+) AI companion based on the user's seed. Output the comma-separated traits only.",
      },
      { role: "user", content: context },
    ]),
  ]);

  const moderation = await moderateText(
    "character_assist",
    "draft",
    `${body.seed} ${description} ${personality}`,
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Generated draft failed safety checks", moderation);
  }

  return ok({ description, advancedDetails: { personality } });
}
