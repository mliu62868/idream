import { z } from "zod";
import type { ChatToolDefinition } from "./openai-compatible-model";

export const GENERATE_IMAGE_ASYNC_TOOL = "generate_image_async" as const;
export const EDIT_LAST_IMAGE_TOOL = "edit_last_image" as const;

export const REQUIRED_IMAGE_CAPTION_INSTRUCTION = [
  "Chat has accepted and durably reserved the required image action for this turn.",
  "Do not refuse it, negotiate it, or call another image tool.",
  "Reply with one in-character caption of at most 20 words.",
  "Do not narrate taking, generating, sending, or completing the image; the attachment state tells the user what actually happened.",
].join(" ");

export const generateImageAsyncArgsSchema = z.object({
  prompt: z.string().trim().min(12).max(1_200),
  caption: z.string().trim().min(1).max(500).optional(),
  orientation: z.enum(["4:5", "1:1", "16:9"]).optional(),
  outputCount: z.number().int().min(1).max(4).optional(),
}).strict();

export const editLastImageArgsSchema = z.object({
  instruction: z.string().trim().min(4).max(1_200),
  caption: z.string().trim().min(1).max(300).optional(),
}).strict();

export interface GenerateImageAsyncArgs {
  prompt: string;
  caption?: string;
  orientation: "4:5" | "1:1" | "16:9";
  outputCount: number;
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

export const IMAGE_AGENT_TOOL_DEFINITIONS: readonly ChatToolDefinition[] = [
  {
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
          description: "Concrete description of the edit to make to the last photo (4-1200 chars)",
        },
        caption: {
          type: "string",
          description: "Short in-character message to accompany the edited photo",
        },
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

const CHINESE_IMAGE_NOUN = "(?:裸照|自拍照?|随手照|写真(?:照|片)?|照片|相片|图片|图像)";
const ENGLISH_IMAGE_NOUN = "(?:photo|picture|pic|selfie|image|nude)";

export type ImageIntentDecision =
  | {
      kind: "generate";
      reason: "explicit_media_command" | "show_companion_command" | "visual_gift_command";
      toolCall: GenerateImageAsyncToolCall;
    }
  | {
      kind: "edit";
      reason: "explicit_last_image_edit" | "contextual_image_edit";
      toolCall: EditLastImageToolCall;
    }
  | { kind: "none"; reason: "empty" | "negated" | "discussion_or_ambiguous" };

/**
 * SPEC: Chat owns explicit image actions. Soul may shape the accompanying words,
 * but neither the character nor the language model may negotiate the action away.
 */
export function imageIntentForUserRequest(input: {
  userText: string;
  characterName: string;
  hasRecentImageContext?: boolean;
}): ImageIntentDecision {
  const userText = input.userText.replace(/\s+/g, " ").trim();
  if (!userText) return { kind: "none", reason: "empty" };
  if (negatesImageAction(userText)) return { kind: "none", reason: "negated" };

  if (explicitLastImageEdit(userText)) {
    return editDecision(userText, "explicit_last_image_edit");
  }
  if (input.hasRecentImageContext && contextualImageEdit(userText)) {
    return editDecision(userText, "contextual_image_edit");
  }

  const reason = explicitNewImageRequest(userText);
  if (!reason) return { kind: "none", reason: "discussion_or_ambiguous" };
  const characterName = input.characterName.trim() || "the character";
  const prefix = `Create an in-character photo of ${characterName}. User request: `;
  return {
    kind: "generate",
    reason,
    toolCall: {
      name: GENERATE_IMAGE_ASYNC_TOOL,
      arguments: {
        prompt: `${prefix}${userText.slice(0, Math.max(0, 1_200 - prefix.length))}`,
        orientation: "4:5",
        outputCount: 1,
      },
    },
  };
}

export function requiredImageToolCallForUserRequest(input: {
  userText: string;
  characterName: string;
  hasRecentImageContext?: boolean;
}): ImageAgentToolCall | null {
  const decision = imageIntentForUserRequest(input);
  return decision.kind === "none" ? null : decision.toolCall;
}

export type RequiredImageCaptionAuthority =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: "empty" | "too_long" | "negotiation" | "invented_completion";
    };

/** The attachment owns delivery truth; a character caption may only add voice. */
export function requiredImageCaptionAuthority(
  value: string,
): RequiredImageCaptionAuthority {
  const caption = value.replace(/\s+/g, " ").trim();
  if (!caption) return { valid: false, reason: "empty" };
  if (caption.length > 320 || caption.split(/\s+/).length > 40) {
    return { valid: false, reason: "too_long" };
  }
  if (
    /(?:不行|不可以|不能|先.{0,8}(?:聊|说)|再考虑|尊重我的节奏|还没到|别老盯着|求我|说服我)/u.test(caption) ||
    /\b(?:can(?:not|'t)|won't|refuse|not ready|too soon|convince me|ask nicely|earn it)\b/i.test(caption)
  ) {
    return { valid: false, reason: "negotiation" };
  }
  if (
    /(?:拍好了|生成好了|做好了|发给你了|发过去了|传给你了|已经发|给你发了|照片在这|图片在这)/u.test(caption) ||
    /\b(?:just\s+)?(?:snaps?|snapped|generated|created|sent|uploaded|delivered)\b/i.test(caption) ||
    /\b(?:here it is|there you go|check your (?:phone|messages|inbox))\b/i.test(caption)
  ) {
    return { valid: false, reason: "invented_completion" };
  }
  return { valid: true };
}

function editDecision(
  userText: string,
  reason: "explicit_last_image_edit" | "contextual_image_edit",
): ImageIntentDecision {
  return {
    kind: "edit",
    reason,
    toolCall: {
      name: EDIT_LAST_IMAGE_TOOL,
      arguments: { instruction: userText.slice(0, 1_200) },
    },
  };
}

function negatesImageAction(value: string): boolean {
  const english = value.toLowerCase();
  if (/(?:别|不要)(?:光|只|再)(?:聊天|说话|说了|废话).{0,12}(?:给|发|拍|生成|做)/u.test(value)) {
    return false;
  }
  return new RegExp(
    `(?:不要|别|不用|不必|不想).{0,10}(?:发|给|看|生成|创建|做|拍|改|换|${CHINESE_IMAGE_NOUN})`,
    "u",
  ).test(value) ||
    new RegExp(
      `\\b(?:don['’]?t|do not|never|no need to|stop)\\b.{0,20}\\b(?:send|show|give|make|generate|create|take|edit|change|want)\\b.{0,40}\\b${ENGLISH_IMAGE_NOUN}s?\\b`,
      "i",
    ).test(english) ||
    new RegExp(`\\b(?:don['’]?t|do not)\\s+want\\b.{0,30}\\b${ENGLISH_IMAGE_NOUN}s?\\b`, "i")
      .test(english);
}

function explicitLastImageEdit(value: string): boolean {
  const english = value.toLowerCase();
  const chineseTarget = "(?:上一张|上张|刚才那张|之前那张|这张|那张)";
  const chineseEdit = "(?:改|换|重做|重新做|加上|加个|去掉|删掉|移除)";
  return new RegExp(`${chineseTarget}.{0,36}${chineseEdit}`, "u").test(value) ||
    new RegExp(`${chineseEdit}.{0,24}${chineseTarget}`, "u").test(value) ||
    new RegExp(
      `\\b(?:edit|change|redo|remake|modify|add|remove)\\b.{0,40}\\b(?:last|previous|this|that)\\b.{0,24}\\b${ENGLISH_IMAGE_NOUN}\\b`,
      "i",
    ).test(english) ||
    new RegExp(
      `\\b(?:last|previous|this|that)\\b.{0,24}\\b${ENGLISH_IMAGE_NOUN}\\b.{0,40}\\b(?:edit|change|redo|remake|modify|add|remove)\\b`,
      "i",
    ).test(english);
}

function contextualImageEdit(value: string): boolean {
  const english = value.toLowerCase();
  return /^(?:再)?(?:换|改|试)(?:个|一下|一版)?(?:姿势|动作|背景|衣服|服装|穿搭|发型|表情|角度|场景)/u.test(value) ||
    /^把(?:姿势|动作|背景|衣服|服装|穿搭|发型|表情|角度|场景).{0,24}(?:换|改|变|调)/u.test(value) ||
    /\b(?:change|try|use)\b.{0,18}\b(?:another|a different|the)\b.{0,12}\b(?:pose|background|outfit|clothes|hairstyle|expression|angle|scene)\b/i.test(english);
}

function explicitNewImageRequest(
  value: string,
): "explicit_media_command" | "show_companion_command" | "visual_gift_command" | null {
  const english = value.toLowerCase();
  const chineseVerb = "(?:给|发|发给|生成|创建|做|画|拍)";
  const chineseCount = "(?:我)?(?:一|几|个|张|一张|几张)?(?:你的)?";
  if (
    new RegExp(`${chineseVerb}${chineseCount}.{0,24}${CHINESE_IMAGE_NOUN}`, "u").test(value) ||
    new RegExp(`(?:给我|发我|发给我|我要|我想要|我想看|让我看|给我看看|来(?:一|几)张).{0,48}${CHINESE_IMAGE_NOUN}`, "u").test(value) ||
    new RegExp(`(?:${CHINESE_IMAGE_NOUN}).{0,20}(?:给我|发我|发给我|来一张)`, "u").test(value) ||
    /拍给我(?:看|看看|看下|瞧瞧)/u.test(value) ||
    new RegExp(
      `\\b(?:send|show|give)\\s+(?:(?:me|your)\\s+)?(?:(?:a|an|one|some)\\s+)?${ENGLISH_IMAGE_NOUN}s?\\b`,
      "i",
    ).test(english) ||
    new RegExp(
      `\\b(?:i want|i['’]d like|i would like|let me see)\\b.{0,60}\\b${ENGLISH_IMAGE_NOUN}s?\\b`,
      "i",
    ).test(english) ||
    new RegExp(
      `\\b(?:make|create|generate|take)\\s+(?:me\\s+)?(?:a|an|one|some|\\d+)\\b.{0,40}\\b${ENGLISH_IMAGE_NOUN}s?\\b`,
      "i",
    ).test(english)
  ) {
    return "explicit_media_command";
  }
  if (
    /(?:让我|给我|想|能|可以|可不可以)?(?:看|看看|看下|瞧瞧).{0,16}(?:你(?:现在)?(?:的)?(?:样子|模样|穿什么|穿着|打扮|身材)|你现在|你穿)/u.test(value) ||
    /(?:穿|换上).{1,24}(?:给我|让我)(?:看|看看|看下|瞧瞧)/u.test(value) ||
    /\b(?:show me|let me see)\b.{0,40}\b(?:you|your body|your look|what you(?:'re| are) wearing)\b/i.test(english) ||
    /\b(?:wear|put on)\b.{1,40}\b(?:for me|and show me)\b/i.test(english)
  ) {
    return "show_companion_command";
  }
  if (
    /(?:来点|给点|整点).{0,8}(?:福利)/u.test(value) ||
    /\b(?:send|show|give)\s+me\s+something\s+(?:spicy|sexy|hot)\b/i.test(english)
  ) {
    return "visual_gift_command";
  }
  return null;
}
