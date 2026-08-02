// SPEC: Character media operations — the cross-modality operations projection plus the
// voice profile/clone/default-settings surface it reports on.

import { z } from "zod";
import {
  adminIdSchema,
  adminIsoDateTimeSchema,
} from "./common";
import {
  DEFAULT_FISH_AUDIO_DELIVERY,
  fishAudioDeliverySettingsSchema,
} from "../../contracts/voice";

export {
  DEFAULT_FISH_AUDIO_DELIVERY,
  fishAudioDeliveryPresetSchema,
  fishAudioDeliverySettingsSchema,
} from "../../contracts/voice";
export type { FishAudioDeliverySettings } from "../../contracts/voice";

export const characterVoiceCloneCreateRequestSchema = z
  .object({
    language: z.string().trim().min(1).max(40).default("english"),
    referenceText: z.string().trim().min(3).max(2_000),
    sampleText: z.string().trim().min(3).max(500),
    delivery: fishAudioDeliverySettingsSchema.default(
      DEFAULT_FISH_AUDIO_DELIVERY,
    ),
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict();

export const fishAudioCatalogVoiceIdSchema = z.enum([
  "fish-female-default",
]);

export const fishAudioCatalogVoiceSchema = z
  .object({
    id: fishAudioCatalogVoiceIdSchema,
    label: z.string().trim().min(1),
    presentation: z.literal("female"),
    description: z.string().trim().min(1),
  })
  .strict();

export const voiceDefaultSettingsSchema = z
  .object({
    provider: z.literal("fish_audio"),
    source: z.enum(["environment", "app_setting"]),
    settingVersion: z.number().int().nonnegative(),
    updatedAt: adminIsoDateTimeSchema.nullable(),
    defaultVoiceId: fishAudioCatalogVoiceIdSchema,
    genderVoiceIds: z
      .object({
        female: fishAudioCatalogVoiceIdSchema,
        male: fishAudioCatalogVoiceIdSchema,
        trans: fishAudioCatalogVoiceIdSchema,
      })
      .strict(),
    delivery: fishAudioDeliverySettingsSchema,
    catalog: z.array(fishAudioCatalogVoiceSchema).min(1).readonly(),
  })
  .strict();

export const voiceDefaultSettingsUpdateRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    defaultVoiceId: fishAudioCatalogVoiceIdSchema,
    genderVoiceIds: z
      .object({
        female: fishAudioCatalogVoiceIdSchema,
        male: fishAudioCatalogVoiceIdSchema,
        trans: fishAudioCatalogVoiceIdSchema,
      })
      .strict(),
    delivery: fishAudioDeliverySettingsSchema,
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict();

export const voiceDefaultSettingsUpdateResponseSchema = z
  .object({
    settings: voiceDefaultSettingsSchema,
    replayed: z.boolean(),
  })
  .strict();

export const voiceDefaultPreviewRequestSchema = z
  .object({
    voiceId: fishAudioCatalogVoiceIdSchema,
    text: z.string().trim().min(3).max(240),
    delivery: fishAudioDeliverySettingsSchema,
  })
  .strict();

export const voiceDefaultPreviewResponseSchema = z
  .object({
    voiceId: fishAudioCatalogVoiceIdSchema,
    contentType: z.literal("audio/wav"),
    audioBase64: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export const characterVoiceProfileSchema = z
  .object({
    id: adminIdSchema,
    version: z.number().int().positive(),
    provider: z.enum(["pocket_tts", "fish_audio"]),
    providerVoiceId: z.string().trim().min(1),
    model: z.string().trim().min(1),
    language: z.string().trim().min(1),
    delivery: fishAudioDeliverySettingsSchema,
    status: z.enum(["candidate", "active", "archived", "failed"]),
    reference: z
      .object({
        assetId: adminIdSchema,
        filename: z.string().trim().min(1),
        contentType: z.string().trim().min(1),
        sizeBytes: z.number().int().nonnegative(),
        transcript: z.string().trim().min(1).nullable(),
      })
      .strict(),
    preview: z
      .object({
        assetId: adminIdSchema,
        url: z.string().trim().min(1),
        durationMs: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    sampleText: z.string(),
    createdById: adminIdSchema,
    createdAt: adminIsoDateTimeSchema,
    archivedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

export const characterVoiceWorkspaceSchema = z
  .object({
    provider: z.enum(["mock", "pipeline", "pocket_tts", "fish_audio"]),
    cloningAvailable: z.boolean(),
    runtimeStatus: z.enum(["ready", "unavailable", "inactive"]),
    runtimeEngine: z.enum(["omlx", "mlx_audio", "unknown", "inactive"]),
    runtimeVersion: z.string().trim().min(1).nullable(),
    runtimeLanguage: z.string().trim().min(1),
    currentVoiceId: z.string().nullable(),
    effectiveVoiceId: z.string().trim().min(1),
    authoritySource: z.enum(["system_default", "character_clone"]),
    systemDefaults: voiceDefaultSettingsSchema,
    activeProfile: characterVoiceProfileSchema.nullable(),
    candidateProfile: characterVoiceProfileSchema.nullable(),
    history: z.array(characterVoiceProfileSchema).readonly(),
  })
  .strict();

export const characterVoiceCloneCreateResponseSchema = z
  .object({
    profile: characterVoiceProfileSchema,
    replacedCandidateProfileId: adminIdSchema.nullable(),
    replayed: z.boolean(),
  })
  .strict();

export const characterVoiceActivationRequestSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
    expectedActiveProfileId: adminIdSchema.nullable(),
    expectedCurrentVoiceId: z.string().trim().min(1).nullable(),
  })
  .strict();

export const characterVoiceActivationResponseSchema = z
  .object({
    profile: characterVoiceProfileSchema,
    replacedActiveProfileId: adminIdSchema.nullable(),
    replayed: z.boolean(),
  })
  .strict();

export const characterVoiceSystemDefaultResetRequestSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
    expectedActiveProfileId: adminIdSchema.nullable(),
    expectedCurrentVoiceId: z.string().trim().min(1).nullable(),
  })
  .strict();

export const characterVoiceSystemDefaultResetResponseSchema = z
  .object({
    currentVoiceId: z.null(),
    archivedProfileId: adminIdSchema.nullable(),
    replayed: z.boolean(),
  })
  .strict();

export const characterVoiceClipReclaimRequestSchema = z
  .object({
    requestId: adminIdSchema,
    confirmation: z.string().trim().min(1),
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.confirmation !== `RECLAIM VOICE ${request.requestId}`) {
      context.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: "Confirmation must identify the durable Voice request",
      });
    }
  });

export const characterVoiceClipReclaimResponseSchema = z
  .object({
    requestId: adminIdSchema,
    status: z.enum(["succeeded", "failed", "skipped"]),
    attemptNo: z.number().int().positive(),
    mediaAssetId: adminIdSchema.nullable(),
    provider: z.string().trim().min(1).nullable(),
    replayed: z.boolean(),
  })
  .strict();

const characterMediaOperationSchema = (
  modality: "image" | "video" | "voice",
) => z
  .object({
    modality: z.literal(modality),
    requestId: adminIdSchema.nullable(),
    status: z.string().trim().min(1).nullable(),
    attempt: z
      .object({
        id: adminIdSchema.nullable(),
        number: z.number().int().positive(),
        status: z.string().trim().min(1),
        errorCode: z.string().trim().min(1).nullable(),
        retryability: z
          .enum(["retryable", "not_retryable", "operator_retry"])
          .nullable(),
        operatorGuidance: z.string().trim().min(1).nullable(),
      })
      .strict()
      .nullable(),
    provider: z
      .object({
        key: z.string().trim().min(1).nullable(),
        requestId: z.string().trim().min(1).nullable(),
      })
      .strict()
      .nullable(),
    timing: z
      .object({
        requestedAt: adminIsoDateTimeSchema,
        startedAt: adminIsoDateTimeSchema.nullable(),
        finishedAt: adminIsoDateTimeSchema.nullable(),
        latencyMs: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    costDreamcoins: z.number().int().nonnegative().nullable(),
    output: z
      .object({
        mediaAssetId: adminIdSchema.nullable(),
        availability: z.enum(["available", "deleted", "unavailable"]),
        url: z.string().trim().min(1).nullable(),
        createdAt: adminIsoDateTimeSchema.nullable(),
        durationMs: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    recoverability: z
      .object({
        state: z.enum([
          "unavailable",
          "not_needed",
          "retryable",
          "operator_action",
          "not_recoverable",
        ]),
        reason: z.string().trim().min(1).nullable(),
        actionHref: z
          .string()
          .startsWith("/api/v2/admin/characters/")
          .nullable()
          .default(null),
        actionConfirmation: z.string().trim().min(1).nullable().default(null),
      })
      .strict(),
    studioHref: z.string().startsWith("/admin/characters/"),
    operationsHref: z.string().startsWith("/admin/").nullable(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      (operation.recoverability.actionHref === null) !==
        (operation.recoverability.actionConfirmation === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["recoverability", "actionHref"],
        message: "Recovery action href and confirmation must be projected together",
      });
    }
    if (
      operation.recoverability.actionHref !== null &&
      (operation.modality !== "voice" ||
        operation.requestId === null ||
        operation.recoverability.state !== "operator_action")
    ) {
      context.addIssue({
        code: "custom",
        path: ["recoverability", "actionHref"],
        message: "Only an actionable Voice recovery may expose a command href",
      });
    }
    if (
      operation.requestId === null &&
      (
        operation.status !== null ||
        operation.attempt !== null ||
        operation.provider !== null ||
        operation.timing !== null ||
        operation.costDreamcoins !== null ||
        operation.output !== null ||
        operation.operationsHref !== null ||
        operation.recoverability.state !== "unavailable"
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["requestId"],
        message: "Missing request evidence must fail closed as null/unavailable",
      });
    }
  });

// SPEC: 这是 image/video/voice 三套既有 authority 的只读运营投影，不拥有写入语义。
// INTENT: 固定三行让运营可以比较最近一次请求；缺少证据时使用 null/unavailable，禁止猜测。
export const characterMediaOperationsProjectionSchema = z
  .object({
    projectionVersion: z.literal(1),
    asOf: adminIsoDateTimeSchema,
    operations: z
      .tuple([
        characterMediaOperationSchema("image"),
        characterMediaOperationSchema("video"),
        characterMediaOperationSchema("voice"),
      ])
      .readonly(),
  })
  .strict();

export type CharacterMediaOperationsProjection = z.infer<
  typeof characterMediaOperationsProjectionSchema
>;

export type CharacterVoiceProfile = z.infer<typeof characterVoiceProfileSchema>;

export type CharacterVoiceWorkspace = z.infer<typeof characterVoiceWorkspaceSchema>;

export type FishAudioCatalogVoiceId = z.infer<typeof fishAudioCatalogVoiceIdSchema>;

export type VoiceDefaultSettings = z.infer<typeof voiceDefaultSettingsSchema>;

export type CharacterVoiceCloneCreateRequest = z.infer<
  typeof characterVoiceCloneCreateRequestSchema
>;

export type CharacterVoiceCloneCreateResponse = z.infer<
  typeof characterVoiceCloneCreateResponseSchema
>;

export type CharacterVoiceActivationRequest = z.infer<
  typeof characterVoiceActivationRequestSchema
>;

export type CharacterVoiceClipReclaimRequest = z.infer<
  typeof characterVoiceClipReclaimRequestSchema
>;

export type CharacterVoiceClipReclaimResponse = z.infer<
  typeof characterVoiceClipReclaimResponseSchema
>;

export type CharacterVoiceActivationResponse = z.infer<
  typeof characterVoiceActivationResponseSchema
>;
