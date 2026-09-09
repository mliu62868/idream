import { z } from "zod";
import type { ChatToolDefinition } from "./openai-compatible-model";

export const GENERATE_IMAGE_ASYNC_TOOL = "generate_image_async" as const;
export const EDIT_LAST_IMAGE_TOOL = "edit_last_image" as const;

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
export type RequestedNudity = "unspecified" | "none" | "full";
export interface RequiredImageAction {
  readonly name: ImageAgentToolCall["name"];
  readonly requestedNudity: RequestedNudity;
}

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
          description:
            "English scene prompt: action, pose, framing, setting, light, expression, and requested wardrobe/nudity only. Never add stable identity traits (age, hair, eyes, skin, face, body); Main pins identity/references.",
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
const ENGLISH_IMAGE_NOUN = "(?:photo|picture|pic|selfie|image|portrait|nude)";
const CHINESE_NON_NUDE_IMAGE_NOUN = "(?:自拍照?|随手照|写真(?:照|片)?|照片|相片|图片|图像)";
const ENGLISH_NON_NUDE_IMAGE_NOUN = "(?:photo|picture|pic|selfie|image|portrait)";

export type ImageIntentDecision =
  | {
      kind: "generate";
      reason: "explicit_media_command" | "show_companion_command" | "visual_gift_command" | "confirmed_image_offer";
      action: RequiredImageAction & { readonly name: typeof GENERATE_IMAGE_ASYNC_TOOL };
      confirmedOffer?: string;
    }
  | {
      kind: "edit";
      reason: "explicit_last_image_edit" | "contextual_image_edit";
      action: RequiredImageAction & { readonly name: typeof EDIT_LAST_IMAGE_TOOL };
    }
  | { kind: "none"; reason: "empty" | "negated" | "discussion_or_ambiguous" };

/**
 * SPEC: Chat owns explicit image actions. Soul may shape the accompanying words,
 * but neither the character nor the language model may negotiate the action away.
 */
export function imageIntentForUserRequest(input: {
  userText: string;
  hasRecentImageContext?: boolean;
  previousAssistantText?: string;
}): ImageIntentDecision {
  const userText = input.userText.replace(/\s+/g, " ").trim();
  if (!userText) return { kind: "none", reason: "empty" };
  if (negatesImageAction(userText)) return { kind: "none", reason: "negated" };

  // Discussion may quote an image command. Only the actionable sentences can
  // authorize spending; a separate direct request still works after a question.
  const actionableText = userText.split(/(?<=[.!?。！？])\s*/u)
    .filter((sentence) => !isImageDiscussion(sentence)).join(" ");
  if (explicitLastImageEdit(actionableText)) {
    return editDecision(userText, "explicit_last_image_edit");
  }
  if (input.hasRecentImageContext && contextualImageEdit(actionableText)) {
    return editDecision(userText, "contextual_image_edit");
  }

  const directReason = explicitNewImageRequest(actionableText);
  const confirmedOffer = directReason ? null : confirmedImageOffer(userText, input.previousAssistantText);
  const reason = directReason ?? (confirmedOffer ? "confirmed_image_offer" : null);
  if (!reason) return { kind: "none", reason: "discussion_or_ambiguous" };
  return {
    kind: "generate",
    reason,
    ...(confirmedOffer ? { confirmedOffer } : {}),
    action: {
      name: GENERATE_IMAGE_ASYNC_TOOL,
      requestedNudity: requestedNudityIntent(confirmedOffer ?? userText),
    },
  };
}

export function requiredImageActionForUserRequest(input: {
  userText: string;
  hasRecentImageContext?: boolean;
  previousAssistantText?: string;
}): RequiredImageAction | null {
  const decision = imageIntentForUserRequest(input);
  return decision.kind === "none" ? null : decision.action;
}

function isImageDiscussion(value: string): boolean {
  return /^\s*(?:if you (?:could|were to)\b|(?:please\s+)?(?:explain|describe|discuss|translate|imagine)\b|how (?:do|does|would|could|can|should)\b|(?:what|which|where) (?:would|could|should)\b|(?:can|could|would|will) you (?:please\s+)?(?:explain|describe|discuss|translate|tell me how)\b)/iu.test(value) ||
    /^\s*(?:请)?(?:解释|翻译|想象|设想)/u.test(value) ||
    /^\s*(?:假设|假如|要是|如果让你|如果你能).{0,100}(?:怎么|如何|什么|哪|你会|会选)/u.test(value) ||
    /^\s*(?:如何|怎样|怎么|你会如何|你会怎么).{0,80}(?:拍|画|生成|制作|修改)/u.test(value);
}

function confirmedImageOffer(userText: string, previousAssistantText?: string): string | null {
  if (!previousAssistantText) return null;
  const affirmative = /^(?:yes|yeah|yep|sure|okay|ok|please do|go ahead)(?:[,，]?\s*(?:please|do|send it|show me|go ahead))?[.!！。\s]*$/iu.test(userText) ||
    /^(?:好|好啊|好的|可以|行|要|想看)(?:[，,]?\s*(?:发吧|给我看|发给我|请发|看看))?[！!。\s]*$/u.test(userText);
  if (!affirmative) return null;
  const offer = previousAssistantText.replace(/\s+/g, " ").trim();
  if (!/[?？]$/u.test(offer) || (offer.match(/[?？]/gu)?.length ?? 0) !== 1) return null;
  const proposal = offer.match(new RegExp(`\\b(?:want me to|would you like me to|shall i|can i|may i|should i)\\s+(?:send|show|take|make|generate|create)\\b[^?!.]{0,60}\\b${ENGLISH_IMAGE_NOUN}s?\\b[^?!.]{0,60}\\?`, "i"))?.[0] ??
    offer.match(new RegExp(`\\b(?:do you want|would you like|want)\\s+(?:to see\\s+)?(?:(?:a|an|one|my)\\s+)?(?:new\\s+|another\\s+)?${ENGLISH_IMAGE_NOUN}\\b[^?!.]{0,60}\\?`, "i"))?.[0] ??
    offer.match(new RegExp(`(?:要不要|想不想)(?:我)?(?:给你|发|拍|生成|画|送你|看|看看)[^。？！]{0,24}${CHINESE_IMAGE_NOUN}[^。？！]{0,12}[？?]`, "u"))?.[0] ??
    offer.match(new RegExp(`想(?:看|要)[^。？！]{0,24}${CHINESE_IMAGE_NOUN}[^。？！]{0,12}吗[？?]`, "u"))?.[0];
  return proposal && !negatesImageAction(proposal) ? proposal : null;
}

function requestedNudityIntent(value: string): RequestedNudity {
  const rejectsNudity =
    /(?:不要|别|不用|不想要|不能).{0,10}(?:裸照|裸体|全裸|赤裸|一丝不挂|脱光|露点)/u.test(value) ||
    /(?<!不)(?<!没)(?<!没有)(?:要|保持|继续)?穿着?(?:衣服|内衣|睡袍|长袍|泳装)/u.test(value) ||
    /\b(?:not|never)\s+(?:fully\s+)?(?:nude|naked|unclothed)\b/i.test(value) ||
    /\bno\s+nudity\b/i.test(value) ||
    /\bdon['’]?t\s+(?:be|look|pose|make (?:it|me|her|him))?\s*(?:nude|naked)\b/i.test(value) ||
    /\bkeep\b.{0,20}\bclothes\s+on\b/i.test(value);
  if (rejectsNudity) return "none";
  const requestsFullNudity =
    /(?:裸照|裸体|全裸|赤裸|一丝不挂|不穿(?:任何)?(?:衣服|内衣)|(?:没有?|没)穿(?:任何)?(?:衣服|内衣)|脱光)/u.test(value) ||
    /\b(?:nude|naked|fully unclothed|without (?:any )?clothes|no clothes)\b/i.test(value);
  return requestsFullNudity ? "full" : "unspecified";
}

function editDecision(
  userText: string,
  reason: "explicit_last_image_edit" | "contextual_image_edit",
): ImageIntentDecision {
  return {
    kind: "edit",
    reason,
    action: {
      name: EDIT_LAST_IMAGE_TOOL,
      requestedNudity: requestedNudityIntent(userText),
    },
  };
}

function negatesImageAction(value: string): boolean {
  const english = value.toLowerCase();
  // A preservation constraint ("do not change anything else") must not consume
  // an image noun from a later sentence or independent semicolon clause.
  // Genuine image cancellation in any clause still vetoes the whole request.
  return new RegExp(
      `(?:不要|别|不用|不必)(?:再)?(?:给我|给|发给我|发|拍|生成|创建|做|改|换|看)[^.!?;。！？；]{0,12}${CHINESE_NON_NUDE_IMAGE_NOUN}`,
    "u",
  ).test(value) ||
    new RegExp(`(?:不要|别|不用|不必|不想)(?:看|要)[^.!?;。！？；]{0,8}${CHINESE_NON_NUDE_IMAGE_NOUN}`, "u")
      .test(value) ||
    /(?:不要|别|不用|不必)(?:给我)?看(?:你现在|你的样子|你穿什么|你的身材)/u.test(value) ||
    new RegExp(
      `\\b(?:don['’]?t|do not|never|no need to|stop)\\s+(?:send|show|give|make|generate|create|take|edit|change)\\b[^.!?;。！？；]{0,40}\\b${ENGLISH_NON_NUDE_IMAGE_NOUN}s?\\b`,
      "i",
    ).test(english) ||
    new RegExp(`\\b(?:don['’]?t|do not)\\s+want\\b[^.!?;。！？；]{0,30}\\b${ENGLISH_NON_NUDE_IMAGE_NOUN}s?\\b`, "i")
      .test(english);
}

function explicitLastImageEdit(value: string): boolean {
  const english = value.toLowerCase();
  const chineseTarget = "(?:上一张|上张|刚才那张|之前那张|这张|那张)";
  const chineseEdit = "(?:改|换|重做|重新做|加上|加个|去掉|删掉|移除)";
  return new RegExp(`${chineseTarget}.{0,36}${chineseEdit}`, "u").test(value) ||
    new RegExp(`${chineseEdit}.{0,24}${chineseTarget}`, "u").test(value) ||
    // A delivered image may be identified by a relative clause, not just
    // "last/this photo". Discussion and negation are filtered before this seam.
    new RegExp(
      `\\b(?:edit|change|redo|remake|modify)\\s+(?:the\\s+)?${ENGLISH_IMAGE_NOUN}\\s+(?:that\\s+)?you\\s+(?:just\\s+)?(?:sent|generated|created|made)\\b`,
      "i",
    ).test(english) ||
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
      `\\b(?:send|show|give)\\s+(?:(?:me|your)\\s+)?(?:(?:a|an|one|some)\\s+)?(?:(?:fully|completely)\\s+)?${ENGLISH_IMAGE_NOUN}s?\\b`,
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
    /\b(?:show me|let me see)\b.{0,40}\b(?:you|your (?:naked )?body|your look|what you(?:'re| are) wearing)\b/i.test(english) ||
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

/** Required image replies must at least preserve the user's writing system. */
export function requiredImageReplyMatchesUserScript(userText: string, reply: string): boolean {
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
