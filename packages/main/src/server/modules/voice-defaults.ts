import {
  DEFAULT_FISH_AUDIO_DELIVERY,
  fishAudioCatalogVoiceIdSchema,
  fishAudioDeliverySettingsSchema,
  voiceDefaultPreviewRequestSchema,
  voiceDefaultPreviewResponseSchema,
  voiceDefaultSettingsSchema,
  voiceDefaultSettingsUpdateRequestSchema,
  voiceDefaultSettingsUpdateResponseSchema,
  type FishAudioCatalogVoiceId,
  type VoiceDefaultSettings,
} from "@idream/shared/admin";
import type { AppSetting } from "@prisma/client";
import { z } from "zod";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { previewConfiguredVoiceIdentity } from "@/server/modules/admin-v2/characters/voice-identity";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

export const VOICE_DEFAULTS_SETTING_KEY = "voice.defaults";

export const FISH_AUDIO_CATALOG = [
  {
    id: "fish-female-default",
    label: "System Female",
    presentation: "female",
    description: "Curated adult female identity; delivery is configured separately",
  },
] as const;

const storedVoiceDefaultsSchema = z
  .object({
    schemaVersion: z.literal(2),
    defaultVoiceId: fishAudioCatalogVoiceIdSchema,
    genderVoiceIds: z
      .object({
        female: fishAudioCatalogVoiceIdSchema,
        male: fishAudioCatalogVoiceIdSchema,
        trans: fishAudioCatalogVoiceIdSchema,
      })
      .strict(),
    delivery: fishAudioDeliverySettingsSchema,
  })
  .strict();

export async function getVoiceDefaultSettings(): Promise<VoiceDefaultSettings> {
  const setting = await prisma.appSetting.findUnique({
    where: { key: VOICE_DEFAULTS_SETTING_KEY },
  });
  return voiceDefaultSettingsDto(setting);
}

export async function resolveCharacterVoiceAuthority(input: {
  characterId: string;
  voiceId: string | null;
  gender: string;
}) {
  if (input.voiceId?.trim()) {
    const profile = await prisma.characterVoiceProfile.findFirst({
      where: {
        characterId: input.characterId,
        providerVoiceId: input.voiceId.trim(),
        status: "active",
      },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      select: { deliverySettings: true, provider: true, version: true },
    });
    if (profile?.provider === "fish_audio") {
      return {
        voiceId: input.voiceId.trim(),
        source: "character_clone" as const,
        settingVersion: null,
        characterVoiceProfileVersion: profile.version,
        delivery: deliverySettings(profile.deliverySettings),
      };
    }
  }
  const defaults = await getVoiceDefaultSettings();
  return {
    voiceId: voiceIdForGender(defaults, input.gender),
    source: "system_default" as const,
    settingVersion: defaults.settingVersion,
    characterVoiceProfileVersion: null,
    delivery: defaults.delivery,
  };
}

export async function updateVoiceDefaultSettings(input: {
  actor: AdminActor;
  idempotencyKey: string;
  requestId: string;
  request: unknown;
}) {
  const request = voiceDefaultSettingsUpdateRequestSchema.parse(input.request);
  const result = await executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    commandType: "voice.defaults.update",
    target: { type: "app_setting", id: VOICE_DEFAULTS_SETTING_KEY },
    expectedVersion: request.expectedVersion,
    payload: request,
    mutate: async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`app-setting:${VOICE_DEFAULTS_SETTING_KEY}`}))`;
      const before = await tx.appSetting.findUnique({
        where: { key: VOICE_DEFAULTS_SETTING_KEY },
      });
      const currentVersion = before?.version ?? 0;
      if (currentVersion !== request.expectedVersion) {
        throw voiceDefaultVersionConflict(request.expectedVersion, before);
      }
      const value = toInputJson({
        schemaVersion: 2,
        defaultVoiceId: request.defaultVoiceId,
        genderVoiceIds: request.genderVoiceIds,
        delivery: request.delivery,
      });
      if (before) {
        const updated = await tx.appSetting.updateMany({
          where: {
            key: VOICE_DEFAULTS_SETTING_KEY,
            version: request.expectedVersion,
          },
          data: {
            value,
            version: currentVersion + 1,
            status: "active",
          },
        });
        if (updated.count !== 1) {
          const current = await tx.appSetting.findUnique({
            where: { key: VOICE_DEFAULTS_SETTING_KEY },
          });
          throw voiceDefaultVersionConflict(request.expectedVersion, current);
        }
      } else {
        await tx.appSetting.create({
          data: {
            key: VOICE_DEFAULTS_SETTING_KEY,
            value,
            version: 1,
            status: "active",
          },
        });
      }
      const saved = await tx.appSetting.findUniqueOrThrow({
        where: { key: VOICE_DEFAULTS_SETTING_KEY },
      });
      const settings = voiceDefaultSettingsDto(saved);
      await tx.adminAuditLog.create({
        data: {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: "voice.defaults.updated",
          targetType: "app_setting",
          targetId: VOICE_DEFAULTS_SETTING_KEY,
          reason: request.reason,
          before: toInputJson({
            settings: voiceDefaultSettingsDto(before),
          }),
          after: toInputJson({ settings }),
          requestId: input.requestId,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "voice.defaults.updated.v1",
          aggregateType: "app_setting",
          aggregateId: VOICE_DEFAULTS_SETTING_KEY,
          payload: toInputJson({
            settingVersion: settings.settingVersion,
            defaultVoiceId: settings.defaultVoiceId,
            genderVoiceIds: settings.genderVoiceIds,
            delivery: settings.delivery,
            actorId: input.actor.id,
          }),
        },
      });
      return { settings };
    },
    decorateResult: (value, replayed) => ({
      ...(value as Record<string, unknown>),
      replayed,
    }),
  });
  return voiceDefaultSettingsUpdateResponseSchema.parse(result);
}

export async function previewVoiceDefault(input: unknown) {
  const request = voiceDefaultPreviewRequestSchema.parse(input);
  const preview = await previewConfiguredVoiceIdentity({
    text: request.text,
    voiceId: request.voiceId,
    delivery: request.delivery,
  });
  return voiceDefaultPreviewResponseSchema.parse({
    voiceId: request.voiceId,
    contentType: "audio/wav",
    audioBase64: Buffer.from(preview.body).toString("base64"),
    durationMs: preview.durationMs,
  });
}

export function voiceDefaultSettingsDto(
  setting: Pick<AppSetting, "value" | "version" | "updatedAt"> | null,
): VoiceDefaultSettings {
  const stored = storedVoiceDefaultsSchema.safeParse(setting?.value);
  const fallbackVoiceId = environmentDefaultVoiceId();
  return voiceDefaultSettingsSchema.parse({
    provider: "fish_audio",
    source: stored.success ? "app_setting" : "environment",
    settingVersion: setting?.version ?? 0,
    updatedAt: setting?.updatedAt.toISOString() ?? null,
    defaultVoiceId: stored.success ? stored.data.defaultVoiceId : fallbackVoiceId,
    genderVoiceIds: stored.success
      ? stored.data.genderVoiceIds
      : {
          female: fallbackVoiceId,
          male: fallbackVoiceId,
          trans: fallbackVoiceId,
        },
    delivery: stored.success
      ? stored.data.delivery
      : DEFAULT_FISH_AUDIO_DELIVERY,
    catalog: FISH_AUDIO_CATALOG,
  });
}

export function voiceIdForGender(
  settings: VoiceDefaultSettings,
  gender: string,
): FishAudioCatalogVoiceId {
  if (gender === "female" || gender === "male" || gender === "trans") {
    return settings.genderVoiceIds[gender];
  }
  return settings.defaultVoiceId;
}

function environmentDefaultVoiceId(): FishAudioCatalogVoiceId {
  const parsed = fishAudioCatalogVoiceIdSchema.safeParse(
    env.FISH_AUDIO_DEFAULT_VOICE_ID,
  );
  return parsed.success ? parsed.data : "fish-female-default";
}

function deliverySettings(value: unknown) {
  const parsed = fishAudioDeliverySettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_FISH_AUDIO_DELIVERY;
}

function voiceDefaultVersionConflict(
  expectedVersion: number,
  current: Pick<AppSetting, "value" | "version" | "updatedAt"> | null,
) {
  return Errors.conflict("System voice defaults changed before this save", {
    expectedVersion,
    currentVersion: current?.version ?? 0,
    currentSettings: voiceDefaultSettingsDto(current),
  });
}
