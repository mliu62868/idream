import { z } from "zod";
import type { ChatToolDefinition } from "./openai-compatible-model";
import { EDIT_LAST_IMAGE_TOOL, EDIT_LAST_IMAGE_TOOL_DEFINITION } from "./image-action";

export const REQUEST_CHARACTER_MEDIA_TOOL = "request_character_media" as const;
export const RESEND_SESSION_MEDIA_TOOL = "resend_session_media" as const;
export const companionMediaToolNameSchema = z.enum([REQUEST_CHARACTER_MEDIA_TOOL, RESEND_SESSION_MEDIA_TOOL, EDIT_LAST_IMAGE_TOOL]);
// Main-side lockless read-only fulfillment routing budget before falling back to live Gen.
export const CHAT_MEDIA_FULFILLMENT_ROUTE_BUDGET_MS = 1_500;

const fact = z.string().trim().min(1).max(160);
const mediaId = z.string().trim().min(1).max(160);

export const requestCharacterMediaArgsSchema = z.object({
  kind: z.enum(["image", "video"]),
  direction: z.string().trim().min(1).max(1_200),
  subject: z.enum(["companion", "scene"]),
  requestedNudity: z.enum(["unspecified", "none", "partial", "full"]).default("unspecified"),
  mustHave: z.array(fact).max(16).default([]),
  mustExclude: z.array(fact).max(16).default([]),
  mode: z.enum(["auto", "force_new", "existing_only", "availability"]).default("auto"),
  orientation: z.enum(["portrait", "landscape", "square"]).optional(),
  minDurationSeconds: z.number().finite().nonnegative().max(600).optional(),
  maxDurationSeconds: z.number().finite().positive().max(600).optional(),
  hasAudio: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (
    value.minDurationSeconds !== undefined
    && value.maxDurationSeconds !== undefined
    && value.minDurationSeconds > value.maxDurationSeconds
  ) {
    context.addIssue({
      code: "custom",
      path: ["maxDurationSeconds"],
      message: "Maximum duration must cover the minimum duration",
    });
  }
  if (
    value.kind === "image"
    && (value.minDurationSeconds !== undefined
      || value.maxDurationSeconds !== undefined
      || value.hasAudio !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ["kind"],
      message: "Duration and audio constraints apply only to video",
    });
  }
});

export const resendSessionMediaArgsSchema = z.object({
  previousMediaAssetId: mediaId,
}).strict();

export const requestCharacterMediaResultSchema = z.discriminatedUnion("status", [
  z.object({
    accepted: z.literal(true),
    duplicate: z.boolean(),
    status: z.literal("accepted"),
    attachmentId: mediaId,
    kind: z.enum(["image", "video"]),
    generationJobId: mediaId.nullable(),
    mediaAssetId: z.null(),
    costDreamcoins: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    accepted: z.literal(true),
    duplicate: z.boolean(),
    status: z.literal("awaiting_confirmation"),
    confirmationKind: z.literal("paid_media_quote"),
    attachmentId: mediaId,
    kind: z.enum(["image", "video"]),
    generationJobId: z.null(),
    mediaAssetId: z.null(),
    costDreamcoins: z.number().int().positive(),
  }).strict(),
  z.object({
    accepted: z.literal(true),
    duplicate: z.boolean(),
    status: z.literal("completed"),
    attachmentId: mediaId,
    kind: z.enum(["image", "video"]),
    generationJobId: mediaId.nullable(),
    mediaAssetId: mediaId,
    costDreamcoins: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    accepted: z.literal(true),
    duplicate: z.literal(false),
    status: z.enum(["available", "no_match", "unavailable"]),
    kind: z.enum(["image", "video"]),
    costDreamcoins: z.literal(0),
    suggestedAction: z.enum(["custom_video_quote", "photo_instead"]).optional(),
  }).strict(),
]);

export const resendSessionMediaResultSchema = z.object({
  accepted: z.literal(true),
  duplicate: z.boolean(),
  status: z.literal("completed"),
  attachmentId: mediaId,
  kind: z.enum(["image", "video"]),
  mediaAssetId: mediaId,
  generationJobId: z.null(),
  costDreamcoins: z.literal(0),
  source: z.literal("previous_media"),
  description: z.string().max(4_000).nullable().optional(),
}).strict();

export type RequestCharacterMediaArgs = z.infer<typeof requestCharacterMediaArgsSchema>;
export type ResendSessionMediaArgs = z.infer<typeof resendSessionMediaArgsSchema>;
export type RequestCharacterMediaResult = z.infer<typeof requestCharacterMediaResultSchema>;
export type ResendSessionMediaResult = z.infer<typeof resendSessionMediaResultSchema>;

export const COMPANION_MEDIA_TOOL_DEFINITIONS: readonly ChatToolDefinition[] = [
  {
    name: REQUEST_CHARACTER_MEDIA_TOOL,
    description: "Request delivery or check availability for a photo or video. Preserve every explicit outfit, setting, pose, prop, and exclusion.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["image", "video"] },
        direction: { type: "string", description: "Complete visual direction in English, including scene, framing, lighting, pose, clothing and exclusions. Resolve references from the conversation. Main adds the stable Character appearance." },
        subject: { type: "string", enum: ["companion", "scene"], description: "Use 'companion' when the Character appears, or 'scene' for a scenery/object photo without the Character." },
        requestedNudity: { type: "string", enum: ["unspecified", "none", "partial", "full"], description: "Wardrobe level explicitly requested: fully clothed (none), revealing/lingerie/swimwear (partial), fully nude (full), or unspecified." },
        mustHave: { type: "array", items: { type: "string" }, description: "Concise required visible details explicitly requested by the user." },
        mustExclude: { type: "array", items: { type: "string" }, description: "Concise items or details the user explicitly asked to exclude (e.g., glasses, hat)." },
        mode: { type: "string", enum: ["auto", "force_new", "existing_only", "availability"], description: "auto for ordinary delivery; force_new for explicitly new creation; existing_only when they rule out new generation; availability for a read-only inquiry with no delivery, quote or charge." },
        orientation: { type: "string", enum: ["portrait", "landscape", "square"] },
        minDurationSeconds: { type: "number", description: "Explicit numeric lower bound for video only." },
        maxDurationSeconds: { type: "number", description: "Explicit numeric upper bound for video only. Keep qualitative length in direction." },
        hasAudio: { type: "boolean", description: "Explicit video audio-track requirement. A track cannot prove a specific sound or speech." },
      },
      required: ["kind", "direction", "subject"],
      additionalProperties: false,
    },
  },
  {
    name: RESEND_SESSION_MEDIA_TOOL,
    description: "Instantly resend a previously delivered photo or video from this chat session for free using its exact mediaAssetId.",
    parameters: {
      type: "object",
      properties: {
        previousMediaAssetId: { type: "string", description: "Exact mediaAssetId from recentMedia in this session." },
      },
      required: ["previousMediaAssetId"],
      additionalProperties: false,
    },
  },
  EDIT_LAST_IMAGE_TOOL_DEFINITION,
];

export const COMPANION_MEDIA_REQUEST_GUIDANCE = [
  "Character photo and video requests:",
  "- For a current request to receive one photo or video, call request_character_media once. Resolve short confirmations against a specific offer from this Character. Keep every explicit visual and technical condition in direction and the relevant structured fields. Current wardrobe, pose and location override earlier photos and Soul defaults.",
  "- Use availability for an explicit availability check, existing_only if the user rules out new generation, and force_new if they explicitly ask for new creation. Casual discussion, memories and refusals do not request media.",
  "- The attachment is the receipt. awaiting_confirmation means the user must approve the shown price before any charge. accepted means preparation has started. completed means delivered. Continue only independently requested text. Never invent a delivery, its visual details, or a payment.",
].join("\n");

export const COMPANION_MEDIA_RESEND_GUIDANCE = [
  "Previously delivered media:",
  "- For an explicit resend, call resend_session_media with the exact previously delivered asset ID as previousMediaAssetId. When the user adds conditions, verify them against the recorded facts first. Unknown facts cannot satisfy an explicit requirement. A completed receipt confirms free redelivery of the same asset.",
].join("\n");
