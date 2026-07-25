import {
  pocketTtsCatalogVoiceIdSchema,
  voiceDefaultPreviewRequestSchema,
  voiceDefaultPreviewResponseSchema,
  voiceDefaultSettingsSchema,
  voiceDefaultSettingsUpdateRequestSchema,
  voiceDefaultSettingsUpdateResponseSchema,
  type PocketTtsCatalogVoiceId,
  type VoiceDefaultSettings,
} from "@idream/shared/admin";
import type { AppSetting } from "@prisma/client";
import { z } from "zod";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { providers } from "@/server/providers";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

export const VOICE_DEFAULTS_SETTING_KEY = "voice.defaults";

export const POCKET_TTS_CATALOG = [
  { id: "alba", label: "Alba", presentation: "female" },
  { id: "fantine", label: "Fantine", presentation: "female" },
  { id: "cosette", label: "Cosette", presentation: "female" },
  { id: "eponine", label: "Éponine", presentation: "female" },
  { id: "azelma", label: "Azelma", presentation: "female" },
  { id: "marius", label: "Marius", presentation: "male" },
  { id: "javert", label: "Javert", presentation: "male" },
  { id: "jean", label: "Jean", presentation: "male" },
] as const;

const storedVoiceDefaultsSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultVoiceId: pocketTtsCatalogVoiceIdSchema,
    genderVoiceIds: z
      .object({
        female: pocketTtsCatalogVoiceIdSchema,
        male: pocketTtsCatalogVoiceIdSchema,
        trans: pocketTtsCatalogVoiceIdSchema,
      })
      .strict(),
  })
  .strict();

export async function getVoiceDefaultSettings(): Promise<VoiceDefaultSettings> {
  const setting = await prisma.appSetting.findUnique({
    where: { key: VOICE_DEFAULTS_SETTING_KEY },
  });
  return voiceDefaultSettingsDto(setting);
}

export async function resolveCharacterVoiceAuthority(input: {
  voiceId: string | null;
  gender: string;
}) {
  if (input.voiceId?.trim()) {
    return {
      voiceId: input.voiceId.trim(),
      source: "character_clone" as const,
      settingVersion: null,
    };
  }
  const defaults = await getVoiceDefaultSettings();
  return {
    voiceId: voiceIdForGender(defaults, input.gender),
    source: "system_default" as const,
    settingVersion: defaults.settingVersion,
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
        schemaVersion: 1,
        defaultVoiceId: request.defaultVoiceId,
        genderVoiceIds: request.genderVoiceIds,
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
  const voice = providers.voice;
  if (voice.providerKey !== "pocket_tts" || !voice.previewVoice) {
    throw Errors.unavailable("Pocket TTS catalog preview is unavailable", {
      configuredProvider: voice.providerKey,
    });
  }
  const result = await voice.previewVoice({
    text: request.text,
    voiceId: request.voiceId,
  });
  if (!result.ok) {
    throw Errors.unavailable("Pocket TTS could not render the catalog preview", result.error);
  }
  return voiceDefaultPreviewResponseSchema.parse({
    voiceId: request.voiceId,
    contentType: "audio/wav",
    audioBase64: Buffer.from(result.data.body).toString("base64"),
    durationMs: result.data.durationMs,
  });
}

export function voiceDefaultSettingsDto(
  setting: Pick<AppSetting, "value" | "version" | "updatedAt"> | null,
): VoiceDefaultSettings {
  const stored = storedVoiceDefaultsSchema.safeParse(setting?.value);
  const fallbackVoiceId = environmentDefaultVoiceId();
  return voiceDefaultSettingsSchema.parse({
    provider: "pocket_tts",
    source: stored.success ? "app_setting" : "environment",
    settingVersion: setting?.version ?? 0,
    updatedAt: setting?.updatedAt.toISOString() ?? null,
    defaultVoiceId: stored.success
      ? stored.data.defaultVoiceId
      : fallbackVoiceId,
    genderVoiceIds: stored.success
      ? stored.data.genderVoiceIds
      : {
          female: fallbackVoiceId,
          male: "marius",
          trans: fallbackVoiceId,
        },
    catalog: POCKET_TTS_CATALOG,
  });
}

export function voiceIdForGender(
  settings: VoiceDefaultSettings,
  gender: string,
): PocketTtsCatalogVoiceId {
  if (gender === "female" || gender === "male" || gender === "trans") {
    return settings.genderVoiceIds[gender];
  }
  return settings.defaultVoiceId;
}

function environmentDefaultVoiceId(): PocketTtsCatalogVoiceId {
  const parsed = pocketTtsCatalogVoiceIdSchema.safeParse(
    env.POCKET_TTS_DEFAULT_VOICE_ID,
  );
  return parsed.success ? parsed.data : "alba";
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
