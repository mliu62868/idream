import { z } from "zod";
import type { ChatToolDefinition } from "./openai-compatible-model";

export const GENERATE_IMAGE_ASYNC_TOOL = "generate_image_async" as const;
export const EDIT_LAST_IMAGE_TOOL = "edit_last_image" as const;

export const generateImageAsyncArgsSchema = z.object({
  prompt: z.string().trim().min(12).max(1_200),
  subject: z.enum(["companion", "scene"]),
  caption: z.string().trim().min(1).max(500).optional(),
  orientation: z.enum(["4:5", "1:1", "16:9"]).optional(),
  outputCount: z.number().int().min(1).max(4).optional(),
  requestedNudity: z.enum(["unspecified", "none", "full"]).optional(),
}).strict();

export const editLastImageArgsSchema = z.object({
  instruction: z.string().trim().min(4).max(1_200),
  caption: z.string().trim().min(1).max(300).optional(),
  requestedNudity: z.enum(["unspecified", "none", "full"]).optional(),
}).strict();

export interface GenerateImageAsyncArgs {
  prompt: string;
  subject: "companion" | "scene";
  caption?: string;
  orientation: "4:5" | "1:1" | "16:9";
  outputCount: number;
  requestedNudity?: RequestedNudity;
}
export type EditLastImageArgs = z.infer<typeof editLastImageArgsSchema>;

export interface GenerateImageAsyncToolCall {
  name: typeof GENERATE_IMAGE_ASYNC_TOOL;
  arguments: GenerateImageAsyncArgs;
}

export interface EditLastImageToolCall {
  name: typeof EDIT_LAST_IMAGE_TOOL;
  arguments: EditLastImageArgs;
}

export type ImageAgentToolCall = GenerateImageAsyncToolCall | EditLastImageToolCall;
export type RequestedNudity = "unspecified" | "none" | "full";

export const IMAGE_AGENT_TOOL_DEFINITIONS: readonly ChatToolDefinition[] = [
  {
    name: GENERATE_IMAGE_ASYNC_TOOL,
    // INTENT: chat renders exactly one image per request (the chat route's
    // capability). Advertising a count or a square format let the Character
    // promise "three ways" or "both angles" and deliver one.
    description:
      "Create exactly one photo for a new photo request by calling this tool. A spoken promise creates no photo. Returns acceptance; the attachment delivers it.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "English scene, subjects, wardrobe/nudity and exclusions. Never add stable identity traits (age, hair, eyes, skin, face, body); Main pins identity/references.",
        },
        subject: {
          type: "string", enum: ["companion", "scene"],
          description: "Follow the latest user: companion for selfies/scenes with you; scene for objects/scenery without you or no-people requests. Only companion adds identity.",
        },
        caption: {
          type: "string",
          description: "Short in-character message to accompany the photo",
        },
        requestedNudity: { type: "string", enum: ["unspecified", "none", "full"], description: "Current wardrobe intent: none for clothed, full for nude, unspecified when neither is requested. All wardrobe clauses in prompt must agree with this value: full depicts a fully nude adult without clothes; none preserves requested clothing. Drop conflicting outfits from earlier photos or default appearance." },
        orientation: { type: "string", enum: ["4:5", "16:9"], description: "4:5 portrait (default) or 16:9 landscape" },
      },
      required: ["prompt", "subject"],
    },
  },
  {
    name: EDIT_LAST_IMAGE_TOOL,
    description:
      "Edit the LAST photo you sent to the user (img2img). Use when the user asks to change or redo that photo, not for a new unrelated scene. Keep identity consistent.",
    parameters: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "English description of every requested edit to the last photo (4-1200 chars)",
        },
        caption: {
          type: "string",
          description: "Short in-character message to accompany the edited photo",
        },
        requestedNudity: { type: "string", enum: ["unspecified", "none", "full"], description: "Wardrobe intent in the current user request; preserve all concrete edit and clothing constraints in instruction." },
      },
      required: ["instruction"],
    },
  },
];

export function parseImageAgentToolCall(
  name: string,
  rawArguments: unknown,
): ImageAgentToolCall | null {
  if (name === GENERATE_IMAGE_ASYNC_TOOL) {
    const result = generateImageAsyncArgsSchema.safeParse(rawArguments);
    return result.success
      ? {
          name: GENERATE_IMAGE_ASYNC_TOOL,
          arguments: {
            ...result.data,
            orientation: result.data.orientation ?? "4:5",
            outputCount: result.data.outputCount ?? 1,
          },
        }
      : null;
  }
  if (name === EDIT_LAST_IMAGE_TOOL) {
    const result = editLastImageArgsSchema.safeParse(rawArguments);
    return result.success
      ? { name: EDIT_LAST_IMAGE_TOOL, arguments: result.data }
      : null;
  }
  return null;
}

/** Image replies must at least preserve the user's writing system. */
export function imageReplyMatchesUserScript(userText: string, reply: string): boolean {
  const scriptChecks = [
    /\p{Script=Han}/u,
    /\p{Script=Hiragana}|\p{Script=Katakana}/u,
    /\p{Script=Hangul}/u,
    /\p{Script=Cyrillic}/u,
    /\p{Script=Arabic}/u,
    /\p{Script=Devanagari}/u,
  ];
  const userScript = scriptChecks.find((pattern) => pattern.test(userText));
  return userScript ? userScript.test(reply) : /\p{Letter}/u.test(reply);
}
