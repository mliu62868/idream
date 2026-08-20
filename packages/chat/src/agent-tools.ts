import { z } from "zod";
import type { ChatToolDefinition } from "@idream/shared";

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

export const EDIT_LAST_IMAGE_TOOL = "edit_last_image" as const;

export const editLastImageArgsSchema = z.object({
  instruction: z.string().trim().min(4).max(1_200),
  caption: z.string().trim().max(300).optional(),
});

export type EditLastImageArgs = z.infer<typeof editLastImageArgsSchema>;

export interface EditLastImageToolCall {
  name: typeof EDIT_LAST_IMAGE_TOOL;
  arguments: EditLastImageArgs;
}

export type ImageAgentToolCall = GenerateImageAsyncToolCall | EditLastImageToolCall;

// INVARIANT: Chat validates the DSH call against this discriminated form before
// reserving any image effect in the terminal attempt ledger.
export type AgentTool = {
  name: string;
  description: string;
  toChatTool(): ChatToolDefinition;
  parseCall(rawArgs: unknown): ImageAgentToolCall | null;
};

const generateImageAsyncTool: AgentTool = {
  name: GENERATE_IMAGE_ASYNC_TOOL,
  description:
    "Generate and send a photo of yourself to the user. Use whenever the user asks for a picture, selfie, or to see you or a scene.",
  parseCall: (rawArgs) => {
    const result = generateImageAsyncArgsSchema.safeParse(rawArgs);
    if (!result.success) return null;
    return { name: GENERATE_IMAGE_ASYNC_TOOL, arguments: result.data };
  },
  toChatTool: () => ({
    name: GENERATE_IMAGE_ASYNC_TOOL,
    description:
      "Generate and send a photo of yourself to the user. Use whenever the user asks for a picture, selfie, or to see you or a scene.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Concrete visual description of the photo (12-1200 chars), English preferred",
        },
        caption: {
          type: "string",
          description: "Short in-character message to accompany the photo",
        },
        orientation: { type: "string", enum: ["4:5", "1:1", "16:9"] },
        outputCount: { type: "integer", minimum: 1, maximum: 4 },
      },
      required: ["prompt"],
    },
  }),
};

const editLastImageTool: AgentTool = {
  name: EDIT_LAST_IMAGE_TOOL,
  description:
    "Edit the LAST photo you sent to the user (img2img). Use when the user asks to change or redo that photo — e.g. a different background, outfit, or pose — NOT for a brand new unrelated scene. Keep the person's face and identity consistent with the original photo.",
  parseCall: (rawArgs) => {
    const result = editLastImageArgsSchema.safeParse(rawArgs);
    if (!result.success) return null;
    return { name: EDIT_LAST_IMAGE_TOOL, arguments: result.data };
  },
  toChatTool: () => ({
    name: EDIT_LAST_IMAGE_TOOL,
    description:
      "Edit the LAST photo you sent to the user (img2img). Use when the user asks to change or redo that photo — e.g. a different background, outfit, or pose — NOT for a brand new unrelated scene. Keep the person's face and identity consistent with the original photo.",
    parameters: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "Concrete description of the edit to make to the last photo (4-1200 chars)",
        },
        caption: {
          type: "string",
          description: "Short in-character message to accompany the edited photo",
        },
      },
      required: ["instruction"],
    },
  }),
};

export const AGENT_TOOL_REGISTRY: AgentTool[] = [
  generateImageAsyncTool,
  editLastImageTool,
];

export function findAgentTool(name: string): AgentTool | undefined {
  return AGENT_TOOL_REGISTRY.find((tool) => tool.name === name);
}

export function registryChatTools(): ChatToolDefinition[] {
  return AGENT_TOOL_REGISTRY.map((tool) => tool.toChatTool());
}

export function imageToolCaption(
  toolCall: ImageAgentToolCall,
  characterName: string,
): string {
  const caption = toolCall.arguments.caption?.trim();
  if (caption) return caption;
  return `${characterName || "I"} will make that image for you now.`;
}
