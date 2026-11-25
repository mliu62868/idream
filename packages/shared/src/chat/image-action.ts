import { z } from "zod";
import type { ChatToolDefinition } from "./openai-compatible-model";

export const EDIT_LAST_IMAGE_TOOL = "edit_last_image" as const;

export const imageEditScopeSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("local"),
    target: z.string().trim().min(1).max(120),
    selection: z.enum(["one", "all"]),
  }).strict(),
  z.object({ mode: z.literal("whole_image") }).strict(),
]);
export type ImageEditScope = z.infer<typeof imageEditScopeSchema>;

// Main pins the algorithm with the request. Changing segmentation or compositing
// must not silently change a recovered or retried edit's preservation contract.
export const LOCAL_IMAGE_EDIT_VERSION = "sam3-rgba-composite-1" as const;
export const LOCAL_IMAGE_EDIT_MODEL_SHA256 = "9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03" as const;
const samLocalizedImageEditSchema = z.object({
  ...imageEditScopeSchema.options[0].shape,
  version: z.literal(LOCAL_IMAGE_EDIT_VERSION),
  modelSha256: z.literal(LOCAL_IMAGE_EDIT_MODEL_SHA256),
}).strict();

export const CONFIRMED_IMAGE_EDIT_VERSION = "confirmed-mask-rgba-1" as const;
export const imageEditOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generate") }).strict(),
  z.object({ kind: z.literal("recolor"), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).transform(value => value.toLowerCase()) }).strict(),
]);
export type ImageEditOperation = z.infer<typeof imageEditOperationSchema>;

// Main constructs this pin after the owner confirms the exact frozen source,
// region and operation. A model's target phrase is never a confirmed mask.
export const confirmedImageEditSchema = z.object({
  ...imageEditScopeSchema.options[0].shape,
  version: z.literal(CONFIRMED_IMAGE_EDIT_VERSION),
  sourceSnapshotId: z.string().min(1).max(160),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().max(4_194_304),
  height: z.number().int().positive().max(4_194_304),
  maskPngBase64: z.string().min(1).max(699_052),
  maskSha256: z.string().regex(/^[a-f0-9]{64}$/),
  confirmationId: z.string().min(1).max(160),
  confirmedAt: z.iso.datetime(),
  operation: imageEditOperationSchema,
}).strict().refine(value => value.width * value.height <= 4_194_304, {
  message: "Confirmed edit source exceeds four megapixels", path: ["width"],
});
export type ConfirmedImageEdit = z.infer<typeof confirmedImageEditSchema>;
// Persisted pre-confirmation jobs retain their pinned SAM recovery contract.
// New local Chat requests wait for a user-confirmed pin before admission.
export const localizedImageEditSchema = z.discriminatedUnion("version", [
  samLocalizedImageEditSchema,
  confirmedImageEditSchema,
]);

// Historical edit receipts can include a caption. The model schema omits it.
export const editLastImageArgsSchema = z.object({
  instruction: z.string().trim().min(4).max(1_200),
  // Existing receipts and pre-cutover callers retain their original full-image
  // behavior. New native calls must choose a scope in the advertised schema.
  editScope: imageEditScopeSchema.optional(),
  caption: z.string().trim().min(1).max(300).optional(),
  requestedNudity: z.enum(["unspecified", "none", "full"]).optional(),
}).strict();

export type EditLastImageArgs = z.infer<typeof editLastImageArgsSchema>;

export const LOCAL_IMAGE_EDIT_TOOL_DEFINITION = {
  name: EDIT_LAST_IMAGE_TOOL,
  description: "Request a localized edit of the last delivered photo. The user chooses and confirms editable pixels before generation or charging.",
  parameters: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description: "English description of every requested edit to the last photo (4-1200 chars)",
      },
      editScope: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["local"] },
          target: { type: "string", description: "Short English noun phrase identifying the existing object or region to change, e.g. the striped scarf. No editing instructions." },
          selection: { type: "string", enum: ["one", "all"], description: "one requires an unambiguous single instance; all only when the user asks to edit every matching instance." },
        },
        required: ["mode", "target", "selection"],
        additionalProperties: false,
      },
      requestedNudity: { type: "string", enum: ["unspecified", "none", "full"], description: "Wardrobe intent in the current user request; preserve all concrete edit and clothing constraints in instruction." },
      independentTextRequest: { type: "boolean", description: "Set false only when the entire user message is solely this edit request with no separate question, story, or writing task; set true otherwise." },
    },
    required: ["instruction", "editScope"],
  },
} satisfies ChatToolDefinition;

export const EDIT_LAST_IMAGE_TOOL_DEFINITION = {
  ...LOCAL_IMAGE_EDIT_TOOL_DEFINITION,
  description:
    "Request an edit of the LAST delivered photo. Local edits return an area-confirmation card; no generation or charge occurs until the user confirms. Whole-image edits run asynchronously. completed confirms delivery, not visual correctness.",
  parameters: {
    ...LOCAL_IMAGE_EDIT_TOOL_DEFINITION.parameters,
    properties: {
      ...LOCAL_IMAGE_EDIT_TOOL_DEFINITION.parameters.properties,
      editScope: {
        oneOf: [
          LOCAL_IMAGE_EDIT_TOOL_DEFINITION.parameters.properties.editScope,
          { type: "object", properties: { mode: { type: "string", enum: ["whole_image"] } }, required: ["mode"], additionalProperties: false },
        ],
        description: "local for a change to an existing object: the user chooses and confirms editable pixels before execution. whole_image only for an explicitly requested overall restyle, redo, viewpoint, pose or composition change; it does not preserve other pixels. Never use whole_image to bypass confirmation for a localized request.",
      },
    },
  },
} satisfies ChatToolDefinition;

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
