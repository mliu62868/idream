import { z } from "zod";
import type { BuiltContext } from "./context.js";
import { identityPromptLine } from "./context.js";
import type { ChatModel, ChatToolDefinition, ModelMessage } from "./providers.js";
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

// SPEC: one entry per agent-callable tool. `intentHints` gates the (non-FC)
// planner path; `toChatTool` is the function-calling wire shape for providers
// that support native tool calls.
export type AgentTool = {
  name: string;
  description: string;
  intentHints: RegExp[];
  argsSchema: z.ZodType<unknown>;
  toChatTool(): ChatToolDefinition;
};

const generateImageAsyncTool: AgentTool = {
  name: GENERATE_IMAGE_ASYNC_TOOL,
  description:
    "Generate and send a photo of yourself to the user. Use whenever the user asks for a picture, selfie, or to see you or a scene.",
  // INVARIANT: same EN keyword pairing + ZH regex as the original hasVisualRequestIntent.
  // The EN case required BOTH a trigger word and a visual noun; encoded here as one
  // regex with two lookaheads so each array entry stays an independent OR alternative.
  intentHints: [
    /(?=.*\b(?:photo|picture|image|pic|selfie|portrait|draw|drawing|show me|send me|generate|make)\b)(?=.*\b(?:photo|picture|image|pic|selfie|portrait|drawing)\b)/,
    /照片|图片|图像|自拍|画像|相片|发.*照|给我.*图|生成.*图/,
  ],
  argsSchema: generateImageAsyncArgsSchema,
  toChatTool: () => ({
    name: GENERATE_IMAGE_ASYNC_TOOL,
    description:
      "Generate and send a photo of yourself to the user. Use whenever the user asks for a picture, selfie, or to see you or a scene.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Concrete visual description of the photo (12-1200 chars), English preferred" },
        caption: { type: "string", description: "Short in-character message to accompany the photo" },
        orientation: { type: "string", enum: ["4:5", "1:1", "16:9"] },
        outputCount: { type: "integer", minimum: 1, maximum: 4 },
      },
      required: ["prompt"],
    },
  }),
};

export const AGENT_TOOL_REGISTRY: AgentTool[] = [generateImageAsyncTool];

export function findAgentTool(name: string): AgentTool | undefined {
  return AGENT_TOOL_REGISTRY.find((tool) => tool.name === name);
}

export function registryChatTools(): ChatToolDefinition[] {
  return AGENT_TOOL_REGISTRY.map((tool) => tool.toChatTool());
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
  const toolListing = AGENT_TOOL_REGISTRY.map((tool) => `${tool.name}: ${tool.description}`).join("\n");
  const system = [
    "You are the tool planner for a private AI companion chat.",
    `Character: ${persona.name}, an adult ${companionRole(persona.relationship)}.`,
    persona.systemPrompt ?? persona.description,
    identityPromptLine(persona),
    context.sessionSummary ? `Session summary: ${context.sessionSummary}` : "",
    context.longTermMemories.length ? `Long-term memories:\n${context.longTermMemories.map((m) => `- ${m}`).join("\n")}` : "",
    [
      "Available tool:",
      toolListing,
      "Call it only when the next assistant turn should create a visual output for the user.",
      "If calling it, write arguments.prompt as a concrete image-generation prompt grounded in the character, the user's request, and the recent scene.",
      "The prompt must describe the subject, pose/action, setting, camera/framing, lighting, visual style, and important continuity details.",
      "arguments.caption is the short in-character assistant text shown in chat while the image is generated.",
      `Return only JSON: {"tool": null} or {"tool":{"name":"${GENERATE_IMAGE_ASYNC_TOOL}","arguments":{"prompt":"...","caption":"...","orientation":"4:5","outputCount":1}}}.`,
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

// SPEC: registry-driven port of the intent gate — a message matches when it hits
// any hint in any tool's intentHints array (see generateImageAsyncTool.intentHints
// for how the original AND-of-two-regexes EN gate is preserved as one alternative).
function hasVisualRequestIntent(text: string): boolean {
  const normalized = text.toLowerCase();
  return AGENT_TOOL_REGISTRY.some((tool) => tool.intentHints.some((hint) => hint.test(normalized)));
}
