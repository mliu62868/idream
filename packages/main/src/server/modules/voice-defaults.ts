import {
  DEFAULT_FISH_AUDIO_DELIVERY,
  fishAudioDeliverySettingsSchema,
  POCKET_TTS_CATALOG_VOICE_IDS,
  systemVoiceCatalogVoiceIdSchema,
  systemVoiceProviderSchema,
  voiceDefaultPreviewRequestSchema,
  voiceDefaultPreviewResponseSchema,
  voiceDefaultSettingsSchema,
  voiceDefaultSettingsUpdateRequestSchema,
  voiceDefaultSettingsUpdateResponseSchema,
  type SystemVoiceCatalogVoiceId,
  type VoiceDefaultSettings,
} from "@idream/shared/admin";
import type { AppSetting } from "@prisma/client";
import { z } from "zod";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { providers } from "@/server/providers";
import { characterVoiceProfileDto, previewConfiguredVoiceIdentity } from "@/server/modules/admin-v2/characters/voice-identity";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

export const VOICE_DEFAULTS_SETTING_KEY = "voice.defaults";

export const FISH_AUDIO_CATALOG = [
  {
    id: "fish-female-default",
    label: "System Female",
    presentation: "female",
    description:
      "Curated adult female identity; delivery is configured separately",
  },
] as const;

export const POCKET_TTS_CATALOG = POCKET_TTS_CATALOG_VOICE_IDS.map((id) => ({
  id,
  label: catalogVoiceLabel(id),
  presentation: "unspecified" as const,
  description: "Official English Pocket TTS voice",
}));

const storedVoiceDefaultsSchema = z
  .object({
    schemaVersion: z.literal(3),
    provider: systemVoiceProviderSchema,
    defaultVoiceId: systemVoiceCatalogVoiceIdSchema,
    genderVoiceIds: z
      .object({
        female: systemVoiceCatalogVoiceIdSchema,
        male: systemVoiceCatalogVoiceIdSchema,
        trans: systemVoiceCatalogVoiceIdSchema,
      })
      .strict(),
    delivery: fishAudioDeliverySettingsSchema,
  })
  .strict();

export async function getVoiceDefaultSettings(): Promise<VoiceDefaultSettings> {
  const setting = await prisma.appSetting.findUnique({
    where: { key: VOICE_DEFAULTS_SETTING_KEY },
  });
  return voiceDefaultSettingsDto(setting, providers.voice.clip.providerKey);
}

// A permission read may predate an Admin activation. Resolve the pointer,
// profile and defaults from one database snapshot, never from caller-held fields.
export async function resolveCharacterVoiceAuthority(input: { characterId: string }) {
  return prisma.$transaction(async (tx) => {
    const character = await tx.character.findFirst({
        where: { id: input.characterId, deletedAt: null },
        select: {
          voiceId: true,
          gender: true,
        },
      });
    const setting = await tx.appSetting.findUnique({ where: { key: VOICE_DEFAULTS_SETTING_KEY } });
    if (!character) throw Errors.notFound("Character not found");
    const defaults = voiceDefaultSettingsDto(setting, providers.voice.clip.providerKey);
    const profile = character.voiceId?.trim()
      ? await tx.characterVoiceProfile.findFirst({
          where: { characterId: input.characterId, providerVoiceId: character.voiceId.trim(), status: "active" },
          orderBy: [{ version: "desc" }, { id: "desc" }],
          include: {
            referenceAsset: { select: { id: true, metadata: true, contentType: true } },
            previewAsset: { select: { id: true, metadata: true, url: true } },
          },
        })
      : null;
    // Legacy or dangling pointers have always inherited the system default.
    // Keep that contract, but evaluate both sides from the same snapshot.
    const activeProfile = profile &&
      (profile.provider === "fish_audio" || profile.provider === "pocket_tts") &&
      profile.providerVoiceId === character.voiceId?.trim()
        ? characterVoiceProfileDto(profile) : null;
    const workspace = {
      currentVoiceId: character.voiceId,
      activeProfile,
      systemDefaults: defaults,
    };
    if (activeProfile) {
      return {
        ...workspace,
        providerKey: activeProfile.provider,
        voiceId: activeProfile.providerVoiceId,
        source: "character_clone" as const,
        settingVersion: null,
        characterVoiceProfileVersion: activeProfile.version,
        delivery: activeProfile.delivery,
      };
    }
    return {
      ...workspace,
      providerKey: defaults.provider,
      voiceId: voiceIdForGender(defaults, character.gender),
      source: "system_default" as const,
      settingVersion: defaults.settingVersion,
      characterVoiceProfileVersion: null,
      delivery: defaults.delivery,
    };
  }, { isolationLevel: "RepeatableRead" });
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
      const providerKey = providers.voice.clip.providerKey;
      if (request.provider !== providerKey) {
        throw Errors.conflict("System voice provider changed before this save", {
          expectedProvider: request.provider,
          currentProvider: providerKey,
        });
      }
      assertCatalogVoiceIds(request, systemVoiceCatalog(providerKey));
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`app-setting:${VOICE_DEFAULTS_SETTING_KEY}`}))`;
      const before = await tx.appSetting.findUnique({
        where: { key: VOICE_DEFAULTS_SETTING_KEY },
      });
      const currentVersion = before?.version ?? 0;
      if (currentVersion !== request.expectedVersion) {
        throw voiceDefaultVersionConflict(request.expectedVersion, before);
      }
      const value = toInputJson({
        schemaVersion: 3,
        provider: request.provider,
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
            provider: settings.provider,
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
  const providerKey = providers.voice.clip.providerKey;
  if (request.provider !== providerKey) {
    throw Errors.conflict("System voice provider changed before this preview", {
      expectedProvider: request.provider,
      currentProvider: providerKey,
    });
  }
  if (providerKey !== "pocket_tts" && providerKey !== "fish_audio") {
    throw Errors.unavailable(
      "System voice preview requires Pocket TTS or Fish Audio",
      { providerKey },
    );
  }
  assertCatalogVoiceIds(
    {
      defaultVoiceId: request.voiceId,
      genderVoiceIds: {
        female: request.voiceId,
        male: request.voiceId,
        trans: request.voiceId,
      },
    },
    systemVoiceCatalog(providerKey),
  );
  const preview = await previewConfiguredVoiceIdentity({
    providerKey,
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
  providerKey = providers.voice.clip.providerKey,
): VoiceDefaultSettings {
  const stored = storedVoiceDefaultsSchema.safeParse(setting?.value);
  const catalog = systemVoiceCatalog(providerKey);
  const fallbackVoiceId = environmentDefaultVoiceId(providerKey, catalog);
  const storedData =
    stored.success &&
    stored.data.provider === providerKey &&
    voiceIdsInCatalog(stored.data, catalog)
      ? stored.data
      : null;
  return voiceDefaultSettingsSchema.parse({
    provider: providerKey,
    source: storedData ? "app_setting" : "environment",
    settingVersion: setting?.version ?? 0,
    updatedAt: setting?.updatedAt.toISOString() ?? null,
    defaultVoiceId: storedData
      ? storedData.defaultVoiceId
      : fallbackVoiceId,
    genderVoiceIds: storedData
      ? storedData.genderVoiceIds
      : {
          female: fallbackVoiceId,
          male: fallbackVoiceId,
          trans: fallbackVoiceId,
        },
    delivery: storedData
      ? storedData.delivery
      : DEFAULT_FISH_AUDIO_DELIVERY,
    catalog,
  });
}

export function voiceIdForGender(
  settings: VoiceDefaultSettings,
  gender: string,
): SystemVoiceCatalogVoiceId {
  if (gender === "female" || gender === "male" || gender === "trans") {
    return settings.genderVoiceIds[gender];
  }
  return settings.defaultVoiceId;
}

function environmentDefaultVoiceId(
  providerKey: VoiceDefaultSettings["provider"],
  catalog: VoiceDefaultSettings["catalog"],
): SystemVoiceCatalogVoiceId {
  const configured =
    providerKey === "pocket_tts"
      ? env.POCKET_TTS_DEFAULT_VOICE_ID
      : providerKey === "fish_audio"
        ? env.FISH_AUDIO_DEFAULT_VOICE_ID
        : providerKey === "pipeline"
          ? (env.PIPELINE_VOICE_DEFAULT_VOICE_ID ?? "default")
          : "default";
  return catalog.some((voice) => voice.id === configured)
    ? configured
    : catalog[0]!.id;
}

function systemVoiceCatalog(
  providerKey: VoiceDefaultSettings["provider"],
): VoiceDefaultSettings["catalog"] {
  if (providerKey === "pocket_tts") return POCKET_TTS_CATALOG;
  if (providerKey === "fish_audio") {
    const configured = env.FISH_AUDIO_DEFAULT_VOICE_ID;
    return configured === FISH_AUDIO_CATALOG[0].id
      ? FISH_AUDIO_CATALOG
      : [
          {
            id: configured,
            label: catalogVoiceLabel(configured),
            presentation: "unspecified" as const,
            description: "Configured Fish Audio system voice",
          },
          ...FISH_AUDIO_CATALOG,
        ];
  }
  const configured =
    providerKey === "pipeline"
      ? (env.PIPELINE_VOICE_DEFAULT_VOICE_ID ?? "default")
      : "default";
  return [
    {
      id: configured,
      label: catalogVoiceLabel(configured),
      presentation: "unspecified" as const,
      description: "Configured system voice",
    },
  ];
}

function voiceIdsInCatalog(
  input: {
    defaultVoiceId: string;
    genderVoiceIds: { female: string; male: string; trans: string };
  },
  catalog: VoiceDefaultSettings["catalog"],
) {
  const catalogIds = new Set(catalog.map((voice) => voice.id));
  return [input.defaultVoiceId, ...Object.values(input.genderVoiceIds)].every(
    (voiceId) => catalogIds.has(voiceId),
  );
}

function assertCatalogVoiceIds(
  input: {
    defaultVoiceId: string;
    genderVoiceIds: { female: string; male: string; trans: string };
  },
  catalog: VoiceDefaultSettings["catalog"],
) {
  if (voiceIdsInCatalog(input, catalog)) return;
  throw Errors.badRequest("System voice defaults must use the active provider catalog", {
    providerCatalog: catalog.map((voice) => voice.id),
  });
}

function catalogVoiceLabel(voiceId: string) {
  return voiceId
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function voiceDefaultVersionConflict(
  expectedVersion: number,
  current: Pick<AppSetting, "value" | "version" | "updatedAt"> | null,
) {
  return Errors.conflict("System voice defaults changed before this save", {
    expectedVersion,
    currentVersion: current?.version ?? 0,
    currentSettings: voiceDefaultSettingsDto(
      current,
      providers.voice.clip.providerKey,
    ),
  });
}
