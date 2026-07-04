import { z } from "zod";
import type { BuiltContext } from "./context.js";
import type { ChatModel, ModelMessage } from "./providers.js";
import { companionRole } from "@idream/shared";

export const GENERATE_IMAGE_ASYNC_TOOL = "generate_image_async" as const;

export const generateImageAsyncArgsSchema = z.object({
  prompt: z.string().trim().min(12).max(1_200),
  caption: z.string().trim().min(1).max(500).optional(),
  orientation: z.enum(["4:5", "1:1", "16:9"]).default("4:5"),
  outputCount: z.number().int().min(1).max(4).default(1),
});

export type GenerateImageAsyncArgs = z.infer<typeof generateImageAsyncArgsSchema>;

export interface GenerateImageAsyncToolCall {
  name: typeof GENERATE_IMAGE_ASYNC_TOOL;
  arguments: GenerateImageAsyncArgs;
}

export interface AgentToolPlan {
  toolCall: GenerateImageAsyncToolCall | null;
  raw: string;
}

const agentToolPlanSchema = z.object({
  tool: z
    .object({
      name: z.literal(GENERATE_IMAGE_ASYNC_TOOL),
      arguments: generateImageAsyncArgsSchema,
    })
    .nullable(),
});

export async function planAgentToolCall(input: {
  chat: ChatModel;
  model: string;
  context: BuiltContext;
}): Promise<AgentToolPlan> {
  const messages = buildToolPlannerMessages(input.context);
  const completion = await input.chat.complete({
    model: input.model,
    messages,
    maxTokens: 1_400,
  });
  return parseAgentToolPlan(completion.content);
}

export function buildToolPlannerMessages(context: BuiltContext): ModelMessage[] {
  const persona = context.persona;
  const recent = context.recentMessages.slice(-8);
  const system = [
    "You are the tool planner for a private AI companion chat.",
    `Character: ${persona.name}, an adult ${companionRole(persona.relationship)}.`,
    persona.systemPrompt ?? persona.description,
    context.sessionSummary ? `Session summary: ${context.sessionSummary}` : "",
    context.longTermMemories.length ? `Long-term memories:\n${context.longTermMemories.map((m) => `- ${m}`).join("\n")}` : "",
    [
      "Available tool:",
      `${GENERATE_IMAGE_ASYNC_TOOL} asynchronously creates an in-character image and attaches it to the current assistant message.`,
      "Call it only when the next assistant turn should create a visual output for the user.",
      "If calling it, write arguments.prompt as a concrete image-generation prompt grounded in the character, the user's request, and the recent scene.",
      "The prompt must describe the subject, pose/action, setting, camera/framing, lighting, visual style, and important continuity details.",
      "arguments.caption is the short in-character assistant text shown in chat while the image is generated.",
      "Return only JSON: {\"tool\": null} or {\"tool\":{\"name\":\"generate_image_async\",\"arguments\":{\"prompt\":\"...\",\"caption\":\"...\",\"orientation\":\"4:5\",\"outputCount\":1}}}.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    ...recent.map((message) => ({ role: message.role, content: message.content }) satisfies ModelMessage),
  ];
}

export function shouldPlanImageTool(context: BuiltContext): boolean {
  const lastUser = [...context.recentMessages].reverse().find((message) => message.role === "user");
  if (!lastUser) return false;
  return hasVisualRequestIntent(lastUser.content);
}

export function parseAgentToolPlan(raw: string): AgentToolPlan {
  const json = extractFirstJsonObject(raw);
  if (!json) return { toolCall: null, raw };
  try {
    const parsed = agentToolPlanSchema.safeParse(JSON.parse(json) as unknown);
    if (!parsed.success || !parsed.data.tool) return { toolCall: null, raw };
    return { toolCall: parsed.data.tool, raw };
  } catch {
    return { toolCall: null, raw };
  }
}

export function imageToolCaption(toolCall: GenerateImageAsyncToolCall, characterName: string): string {
  const caption = toolCall.arguments.caption?.trim();
  if (caption) return caption;
  return `${characterName || "I"} will make that image for you now.`;
}

function extractFirstJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }

  return null;
}

function hasVisualRequestIntent(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\b(photo|picture|image|pic|selfie|portrait|draw|drawing|show me|send me|generate|make)\b/.test(normalized) &&
    /\b(photo|picture|image|pic|selfie|portrait|drawing)\b/.test(normalized)
  ) || /照片|图片|图像|自拍|画像|相片|发.*照|给我.*图|生成.*图/.test(text);
}
