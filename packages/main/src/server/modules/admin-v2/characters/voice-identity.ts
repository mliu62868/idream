import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_FISH_AUDIO_DELIVERY,
  characterVoiceActivationResponseSchema,
  characterVoiceCloneCreateRequestSchema,
  characterVoiceCloneCreateResponseSchema,
  characterVoicePresetCreateResponseSchema,
  characterVoiceProfileSchema,
  characterVoiceSystemDefaultResetResponseSchema,
  fishAudioDeliverySettingsSchema,
  type CharacterVoiceProfile,
  type CharacterVoiceWorkspace,
  type FishAudioDeliverySettings,
} from "@idream/shared/admin";
import type { CharacterVoiceProfile as CharacterVoiceProfileRecord, MediaAsset, Prisma } from "@prisma/client";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { providers } from "@/server/providers";
import { createVoicePortsForKey } from "@/server/providers/voice/factory";
import type {
  VoiceIdentityPort,
  VoiceProviderKey,
} from "@/server/providers/types";
import type {
  AdminActor,
  AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { operationalCharacterWhere } from "@/server/modules/metric-data-scope";

const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
const MIN_REFERENCE_BYTES = 1_024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/flac",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
]);

type VoiceProfileWithAssets = CharacterVoiceProfileRecord & {
  referenceAsset: MediaAsset;
  previewAsset: MediaAsset | null;
};

type CharacterVoiceProviderKey = Extract<
  VoiceProviderKey,
  "fish_audio" | "pocket_tts"
>;

export type ConfiguredVoiceIdentityRuntime = Pick<
  CharacterVoiceWorkspace,
  | "provider"
  | "cloningAvailable"
  | "runtimeStatus"
  | "runtimeEngine"
  | "runtimeVersion"
  | "runtimeLanguage"
  | "catalogVoiceIds"
>;

// SPEC: Voice Identity owns the meaning of provider health for Character operations.
// INTENT: Workspace consumes a stable runtime projection and never reaches into the
// provider registry or translates provider-specific capability fields itself.
export async function inspectConfiguredVoiceIdentityRuntime(): Promise<ConfiguredVoiceIdentityRuntime> {
  const configuredProvider = configuredVoiceIdentityProviderKey();
  if (!isCharacterVoiceProviderKey(configuredProvider)) {
    return {
      provider: configuredProvider,
      runtimeLanguage: env.FISH_AUDIO_LANGUAGE,
      cloningAvailable: false,
      runtimeStatus: "inactive",
      runtimeEngine: "inactive",
      runtimeVersion: null,
      catalogVoiceIds: [],
    };
  }
  return inspectVoiceIdentityProviderRuntime(configuredProvider);
}

async function inspectVoiceIdentityProviderRuntime(
  providerKey: CharacterVoiceProviderKey,
): Promise<ConfiguredVoiceIdentityRuntime> {
  const base = {
    provider: providerKey,
    runtimeLanguage:
      providerKey === "pocket_tts"
        ? env.POCKET_TTS_LANGUAGE
        : env.FISH_AUDIO_LANGUAGE,
  } as const;
  try {
    const voice = voiceIdentityPortForKey(providerKey);
    const capabilities = await voice.inspectCapabilities();
    const expectedRuntime =
      providerKey === "pocket_tts" ? "pocket_tts" : "mlx_audio";
    const expectedAcceleration =
      providerKey === "pocket_tts" ? "cpu" : "mlx";
    const runtimeCompatible =
      capabilities.ok &&
      capabilities.data.runtime === expectedRuntime &&
      capabilities.data.acceleration === expectedAcceleration;
    const catalogVoiceIds =
      runtimeCompatible && providerKey === "pocket_tts"
        ? [...(capabilities.data.catalogVoices ?? [])]
        : [];
    const cloningAvailable =
      runtimeCompatible && capabilities.data.voiceCloning;
    const ready =
      runtimeCompatible &&
      (providerKey === "pocket_tts"
        ? catalogVoiceIds.length > 0
        : cloningAvailable);
    return {
      ...base,
      cloningAvailable,
      runtimeStatus: ready ? "ready" : "unavailable",
      runtimeEngine:
        capabilities.ok && capabilities.data.runtime === expectedRuntime
          ? expectedRuntime
          : "unknown",
      runtimeVersion: capabilities.ok
        ? (capabilities.data.runtimeVersion ?? null)
        : null,
      catalogVoiceIds,
    };
  } catch {
    return {
      ...base,
      cloningAvailable: false,
      runtimeStatus: "unavailable",
      runtimeEngine: "unknown",
      runtimeVersion: null,
      catalogVoiceIds: [],
    };
  }
}

export async function previewConfiguredVoiceIdentity(input: {
  readonly providerKey?: CharacterVoiceProviderKey;
  readonly text: string;
  readonly voiceId: string;
  readonly delivery: FishAudioDeliverySettings;
}) {
  const providerKey =
    input.providerKey ?? configuredCharacterVoiceIdentity().providerKey;
  const voice = voiceIdentityPortForKey(providerKey);
  const result = await voice.previewVoice(input);
  if (!result.ok) {
    throw Errors.unavailable(
      `${voiceProviderLabel(providerKey)} could not render the voice preview`,
      result.error,
    );
  }
  return result.data;
}

export type ParsedVoiceCloneForm = {
  language: string;
  referenceText: string;
  sampleText: string;
  delivery: FishAudioDeliverySettings;
  reason: string;
  reference: {
    filename: string;
    contentType: string;
    body: Uint8Array;
    sha256: string;
  };
};

export async function parseVoiceCloneForm(request: Request): Promise<ParsedVoiceCloneForm> {
  const form = await request.formData();
  const fields = characterVoiceCloneCreateRequestSchema.parse({
    language: stringField(form, "language") || "english",
    referenceText: stringField(form, "referenceText"),
    sampleText: stringField(form, "sampleText"),
    delivery: jsonFormField(form, "delivery"),
    reason: stringField(form, "reason"),
  });
  const audio = form.get("audio");
  if (!(audio instanceof File)) {
    throw Errors.badRequest("Voice reference audio is required");
  }
  if (audio.size < MIN_REFERENCE_BYTES) {
    throw Errors.badRequest("Voice reference audio is too small");
  }
  if (audio.size > MAX_REFERENCE_BYTES) {
    throw Errors.badRequest("Voice reference audio must be 15 MB or smaller");
  }
  const contentType = normalizedAudioContentType(audio.type, audio.name);
  if (!ALLOWED_AUDIO_TYPES.has(contentType)) {
    throw Errors.badRequest("Voice reference must be WAV, MP3, FLAC, or OGG audio");
  }
  const body = new Uint8Array(await audio.arrayBuffer());
  return {
    ...fields,
    reference: {
      filename: safeFilename(audio.name || `voice-reference${extensionFor(contentType)}`),
      contentType,
      body,
      sha256: createHash("sha256").update(body).digest("hex"),
    },
  };
}

export async function createCharacterVoiceClone(input: {
  characterId: string;
  actor: AdminActor;
  idempotencyKey: string;
  requestId: string;
  form: ParsedVoiceCloneForm;
}) {
  const { providerKey, voice } = configuredCharacterVoiceIdentity();
  const character = await prisma.character.findFirst({
    where: operationalCharacterWhere({
      id: input.characterId,
      deletedAt: null,
    }),
    select: { id: true },
  });
  if (!character) throw Errors.notFound("Character not found");
  const runtime = await inspectVoiceIdentityProviderRuntime(providerKey);
  if (!runtime.cloningAvailable || runtime.runtimeStatus !== "ready") {
    throw Errors.unavailable(
      `${voiceProviderLabel(providerKey)} voice cloning is unavailable`,
      runtime,
    );
  }

  // Every external preparation attempt owns a distinct provider voice. The
  // idempotency receipt decides which attempt wins; losing attempts can then be
  // cleaned up without deleting the committed voice.
  const voiceId = `idream-${randomUUID()}`;
  const referenceAssetId = `media_voice_reference_${voiceId}`;
  const previewAssetId = `media_voice_preview_${voiceId}`;
  const profileId = `voice_profile_${voiceId}`;
  const referenceKey =
    `voice-references/${input.characterId}/${voiceId}${extensionFor(input.form.reference.contentType)}`;
  const previewKey = `voice-previews/${input.characterId}/${voiceId}.wav`;
  const preparedArtifacts: {
    voiceId: string | null;
    previewKey: string | null;
    referenceStored: boolean;
  } = {
    voiceId: null,
    previewKey: null,
    referenceStored: false,
  };
  let mutationCompleted = false;

  try {
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      commandType: "character.voice.clone",
      target: { type: "character", id: input.characterId },
      payload: {
        provider: providerKey,
        language: input.form.language,
        sampleText: input.form.sampleText,
        delivery: input.form.delivery,
        reason: input.form.reason,
        referenceFilename: input.form.reference.filename,
        referenceText: input.form.referenceText,
        referenceContentType: input.form.reference.contentType,
        referenceSizeBytes: input.form.reference.body.byteLength,
        referenceSha256: input.form.reference.sha256,
      },
      prepare: async () => {
        const cloned = await voice.cloneVoice({
          voiceId,
          audio: input.form.reference.body,
          contentType: input.form.reference.contentType,
          filename: input.form.reference.filename,
          language: input.form.language,
          referenceText: input.form.referenceText,
        });
        if (!cloned.ok) {
          throw Errors.unavailable(
            `${voiceProviderLabel(providerKey)} could not clone the reference voice`,
            cloned.error,
          );
        }
        preparedArtifacts.voiceId = cloned.data.voiceId;
        const preview = await voice.previewVoice({
          text: input.form.sampleText,
          voiceId: cloned.data.voiceId,
          delivery: input.form.delivery,
        });
        if (!preview.ok) {
          await voice.deleteVoice({ voiceId: cloned.data.voiceId });
          throw Errors.unavailable(
            `${voiceProviderLabel(providerKey)} cloned the voice but could not render its preview`,
            preview.error,
          );
        }
        const storedPreview = await providers.blob.putPrivate({
          key: previewKey,
          body: preview.data.body,
          contentType: preview.data.contentType,
        });
        if (!storedPreview.ok) {
          await voice.deleteVoice({ voiceId: cloned.data.voiceId });
          throw Errors.unavailable(
            `${voiceProviderLabel(providerKey)} rendered the preview but storage failed`,
            storedPreview.error,
          );
        }
        preparedArtifacts.previewKey = storedPreview.data.key;
        const storedReference = await providers.blob.putPrivate({
          key: referenceKey,
          body: input.form.reference.body,
          contentType: input.form.reference.contentType,
        });
        if (!storedReference.ok) {
          await Promise.all([
            voice.deleteVoice({ voiceId: cloned.data.voiceId }),
            providers.blob.delete({ key: storedPreview.data.key }),
          ]);
          throw Errors.unavailable("Voice reference storage failed", storedReference.error);
        }
        preparedArtifacts.referenceStored = true;
        return {
          cloned: cloned.data,
          preview: {
            key: storedPreview.data.key,
            durationMs: preview.data.durationMs,
          },
        };
      },
      mutate: async (tx, prepared) => {
        await tx.$queryRaw`SELECT "id" FROM "characters" WHERE "id" = ${input.characterId} FOR UPDATE`;
        const currentCandidate = await tx.characterVoiceProfile.findFirst({
          where: { characterId: input.characterId, status: "candidate" },
          orderBy: [{ version: "desc" }, { id: "desc" }],
        });
        const latest = await tx.characterVoiceProfile.findFirst({
          where: { characterId: input.characterId },
          orderBy: [{ version: "desc" }, { id: "desc" }],
          select: { version: true },
        });
        const now = new Date();
        if (currentCandidate) {
          await tx.characterVoiceProfile.update({
            where: { id: currentCandidate.id },
            data: { status: "archived", archivedAt: now },
          });
        }
        await tx.mediaAsset.create({
          data: {
            id: referenceAssetId,
            ownerId: input.actor.id,
            characterId: input.characterId,
            type: "voice",
            url: mediaViewUrl(
              referenceAssetId,
              extensionFor(input.form.reference.contentType),
            ),
            storageKey: referenceKey,
            contentType: input.form.reference.contentType,
            visibility: "private",
            safetyStatus: "passed",
            metadata: toInputJson({
              purpose: "voice_clone_reference",
              filename: input.form.reference.filename,
              referenceText: input.form.referenceText,
              sizeBytes: input.form.reference.body.byteLength,
              sha256: input.form.reference.sha256,
              provider: providerKey,
              providerVoiceId: prepared.cloned.voiceId,
              delivery: input.form.delivery,
            }),
          },
        });
        await tx.mediaAsset.create({
          data: {
            id: previewAssetId,
            ownerId: input.actor.id,
            characterId: input.characterId,
            type: "voice",
            url: mediaViewUrl(previewAssetId, ".wav"),
            storageKey: prepared.preview.key,
            contentType: "audio/wav",
            visibility: "private",
            safetyStatus: "passed",
            metadata: toInputJson({
              purpose: "voice_clone_preview",
              durationMs: prepared.preview.durationMs,
              provider: providerKey,
              providerVoiceId: prepared.cloned.voiceId,
              delivery: input.form.delivery,
            }),
          },
        });
        const profile = await tx.characterVoiceProfile.create({
          data: {
            id: profileId,
            characterId: input.characterId,
            version: (latest?.version ?? 0) + 1,
            provider: providerKey,
            providerVoiceId: prepared.cloned.voiceId,
            model: prepared.cloned.model,
            language: prepared.cloned.language,
            deliverySettings: toInputJson(input.form.delivery),
            status: "candidate",
            referenceAssetId,
            previewAssetId,
            sampleText: input.form.sampleText,
            createdById: input.actor.id,
          },
          include: {
            referenceAsset: true,
            previewAsset: true,
          },
        });
        await tx.adminAuditLog.create({
          data: {
            actorId: input.actor.id,
            actorRole: input.actor.role,
            action: "character.voice_candidate.created",
            targetType: "character_voice_profile",
            targetId: profile.id,
            reason: input.form.reason,
            after: toInputJson({
              characterId: input.characterId,
              profileId: profile.id,
              version: profile.version,
              provider: profile.provider,
              providerVoiceId: profile.providerVoiceId,
              replacedCandidateProfileId: currentCandidate?.id ?? null,
            }),
            requestId: input.requestId,
          },
        });
        await tx.mainOutboxEvent.create({
          data: {
            eventType: "character.voice_candidate.created.v2",
            aggregateType: "character",
            aggregateId: input.characterId,
            payload: toInputJson({
              characterId: input.characterId,
              profileId: profile.id,
              version: profile.version,
              provider: profile.provider,
              providerVoiceId: profile.providerVoiceId,
              actorId: input.actor.id,
            }),
          },
        });
        return {
          profile: characterVoiceProfileDto(profile),
          replacedCandidateProfileId: currentCandidate?.id ?? null,
        };
      },
      decorateResult: (result, replayed) => ({
        ...(result as Record<string, unknown>),
        replayed,
      }),
    });
    mutationCompleted = true;
    const parsed = characterVoiceCloneCreateResponseSchema.parse(result);
    if (parsed.replayed && preparedArtifacts.previewKey) {
      await cleanupPreparedArtifacts({
        voice,
        preparedArtifacts,
        referenceKey,
      });
    }
    return parsed;
  } catch (cause) {
    if (!mutationCompleted && preparedArtifacts.voiceId) {
      await cleanupPreparedArtifacts({
        voice,
        preparedArtifacts,
        referenceKey,
      });
    }
    throw cause;
  }
}

type VoicePresetRequest = AdminV2RequestBody<
  "characterVoicePresetCreateRequestSchema+idempotency-key"
>;

export async function createCharacterVoicePreset(input: {
  characterId: string;
  actor: AdminActor;
  idempotencyKey: string;
  requestId: string;
  request: VoicePresetRequest;
}) {
  const { providerKey, voice } = configuredCharacterVoiceIdentity();
  if (providerKey !== "pocket_tts" || !voice.createPresetVoice) {
    throw Errors.unavailable(
      "Official voice presets require VOICE_IDENTITY_PROVIDER=pocket-tts",
      { providerKey },
    );
  }
  const character = await prisma.character.findFirst({
    where: operationalCharacterWhere({
      id: input.characterId,
      deletedAt: null,
    }),
    select: { id: true },
  });
  if (!character) throw Errors.notFound("Character not found");
  const runtime = await inspectVoiceIdentityProviderRuntime(providerKey);
  if (
    runtime.runtimeStatus !== "ready" ||
    !runtime.catalogVoiceIds.includes(input.request.presetVoiceId)
  ) {
    throw Errors.unavailable(
      "The requested Pocket TTS English catalog voice is unavailable",
      {
        requestedVoiceId: input.request.presetVoiceId,
        runtime,
      },
    );
  }

  // INVARIANT: every Character candidate owns a distinct durable alias even
  // when several Characters select the same official Pocket catalog voice.
  const voiceId = `idream-${randomUUID()}`;
  const referenceAssetId = `media_voice_reference_${voiceId}`;
  const previewAssetId = `media_voice_preview_${voiceId}`;
  const profileId = `voice_profile_${voiceId}`;
  const referenceKey =
    `voice-references/${input.characterId}/${voiceId}.json`;
  const previewKey = `voice-previews/${input.characterId}/${voiceId}.wav`;
  const preparedArtifacts = {
    voiceId: null as string | null,
    previewKey: null as string | null,
    referenceStored: false,
  };
  let mutationCompleted = false;

  try {
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      commandType: "character.voice.preset",
      target: { type: "character", id: input.characterId },
      payload: {
        provider: providerKey,
        presetVoiceId: input.request.presetVoiceId,
        sampleText: input.request.sampleText,
        reason: input.request.reason,
      },
      prepare: async () => {
        const created = await voice.createPresetVoice!({
          voiceId,
          presetVoiceId: input.request.presetVoiceId,
          language: runtime.runtimeLanguage,
        });
        if (!created.ok) {
          throw Errors.unavailable(
            "Pocket TTS could not create the catalog voice alias",
            created.error,
          );
        }
        preparedArtifacts.voiceId = created.data.voiceId;
        const preview = await voice.previewVoice({
          text: input.request.sampleText,
          voiceId: created.data.voiceId,
          delivery: DEFAULT_FISH_AUDIO_DELIVERY,
        });
        if (!preview.ok) {
          await voice.deleteVoice({ voiceId: created.data.voiceId });
          throw Errors.unavailable(
            "Pocket TTS created the voice alias but could not render its preview",
            preview.error,
          );
        }
        const storedPreview = await providers.blob.putPrivate({
          key: previewKey,
          body: preview.data.body,
          contentType: preview.data.contentType,
        });
        if (!storedPreview.ok) {
          await voice.deleteVoice({ voiceId: created.data.voiceId });
          throw Errors.unavailable(
            "Pocket TTS rendered the preview but storage failed",
            storedPreview.error,
          );
        }
        preparedArtifacts.previewKey = storedPreview.data.key;
        const descriptor = new TextEncoder().encode(JSON.stringify({
          schemaVersion: 1,
          provider: providerKey,
          providerVoiceId: created.data.voiceId,
          presetVoiceId: created.data.presetVoiceId,
          model: created.data.model,
          language: created.data.language,
        }));
        const storedReference = await providers.blob.putPrivate({
          key: referenceKey,
          body: descriptor,
          contentType: "application/vnd.idream.pocket-tts-preset+json",
        });
        if (!storedReference.ok) {
          await Promise.all([
            voice.deleteVoice({ voiceId: created.data.voiceId }),
            providers.blob.delete({ key: storedPreview.data.key }),
          ]);
          throw Errors.unavailable(
            "Pocket TTS voice descriptor storage failed",
            storedReference.error,
          );
        }
        preparedArtifacts.referenceStored = true;
        return {
          created: created.data,
          reference: {
            key: storedReference.data.key,
            sizeBytes: storedReference.data.size,
            sha256: createHash("sha256").update(descriptor).digest("hex"),
          },
          preview: {
            key: storedPreview.data.key,
            durationMs: preview.data.durationMs,
          },
        };
      },
      mutate: async (tx, prepared) => {
        await tx.$queryRaw`SELECT "id" FROM "characters" WHERE "id" = ${input.characterId} FOR UPDATE`;
        const currentCandidate = await tx.characterVoiceProfile.findFirst({
          where: { characterId: input.characterId, status: "candidate" },
          orderBy: [{ version: "desc" }, { id: "desc" }],
        });
        const latest = await tx.characterVoiceProfile.findFirst({
          where: { characterId: input.characterId },
          orderBy: [{ version: "desc" }, { id: "desc" }],
          select: { version: true },
        });
        const now = new Date();
        if (currentCandidate) {
          await tx.characterVoiceProfile.update({
            where: { id: currentCandidate.id },
            data: { status: "archived", archivedAt: now },
          });
        }
        await tx.mediaAsset.create({
          data: {
            id: referenceAssetId,
            ownerId: input.actor.id,
            characterId: input.characterId,
            type: "voice",
            url: mediaViewUrl(referenceAssetId, ".json"),
            storageKey: prepared.reference.key,
            contentType: "application/vnd.idream.pocket-tts-preset+json",
            visibility: "private",
            safetyStatus: "passed",
            metadata: toInputJson({
              purpose: "voice_preset_reference",
              filename: `${input.request.presetVoiceId}.pocket-voice`,
              sizeBytes: prepared.reference.sizeBytes,
              sha256: prepared.reference.sha256,
              provider: providerKey,
              providerVoiceId: prepared.created.voiceId,
              presetVoiceId: prepared.created.presetVoiceId,
            }),
          },
        });
        await tx.mediaAsset.create({
          data: {
            id: previewAssetId,
            ownerId: input.actor.id,
            characterId: input.characterId,
            type: "voice",
            url: mediaViewUrl(previewAssetId, ".wav"),
            storageKey: prepared.preview.key,
            contentType: "audio/wav",
            visibility: "private",
            safetyStatus: "passed",
            metadata: toInputJson({
              purpose: "voice_preset_preview",
              durationMs: prepared.preview.durationMs,
              provider: providerKey,
              providerVoiceId: prepared.created.voiceId,
              presetVoiceId: prepared.created.presetVoiceId,
            }),
          },
        });
        const profile = await tx.characterVoiceProfile.create({
          data: {
            id: profileId,
            characterId: input.characterId,
            version: (latest?.version ?? 0) + 1,
            provider: providerKey,
            providerVoiceId: prepared.created.voiceId,
            model: prepared.created.model,
            language: prepared.created.language,
            deliverySettings: toInputJson(DEFAULT_FISH_AUDIO_DELIVERY),
            status: "candidate",
            referenceAssetId,
            previewAssetId,
            sampleText: input.request.sampleText,
            createdById: input.actor.id,
          },
          include: {
            referenceAsset: true,
            previewAsset: true,
          },
        });
        await tx.adminAuditLog.create({
          data: {
            actorId: input.actor.id,
            actorRole: input.actor.role,
            action: "character.voice_candidate.created",
            targetType: "character_voice_profile",
            targetId: profile.id,
            reason: input.request.reason,
            after: toInputJson({
              characterId: input.characterId,
              profileId: profile.id,
              version: profile.version,
              provider: profile.provider,
              providerVoiceId: profile.providerVoiceId,
              presetVoiceId: prepared.created.presetVoiceId,
              replacedCandidateProfileId: currentCandidate?.id ?? null,
            }),
            requestId: input.requestId,
          },
        });
        await tx.mainOutboxEvent.create({
          data: {
            eventType: "character.voice_candidate.created.v2",
            aggregateType: "character",
            aggregateId: input.characterId,
            payload: toInputJson({
              characterId: input.characterId,
              profileId: profile.id,
              version: profile.version,
              provider: profile.provider,
              providerVoiceId: profile.providerVoiceId,
              presetVoiceId: prepared.created.presetVoiceId,
              actorId: input.actor.id,
            }),
          },
        });
        return {
          profile: characterVoiceProfileDto(profile),
          replacedCandidateProfileId: currentCandidate?.id ?? null,
        };
      },
      decorateResult: (value, replayed) => ({
        ...(value as Record<string, unknown>),
        replayed,
      }),
    });
    mutationCompleted = true;
    const parsed = characterVoicePresetCreateResponseSchema.parse(result);
    if (parsed.replayed && preparedArtifacts.previewKey) {
      await cleanupPreparedArtifacts({
        voice,
        preparedArtifacts,
        referenceKey,
      });
    }
    return parsed;
  } catch (cause) {
    if (!mutationCompleted && preparedArtifacts.voiceId) {
      await cleanupPreparedArtifacts({
        voice,
        preparedArtifacts,
        referenceKey,
      });
    }
    throw cause;
  }
}

// SPEC: the bodies the manifest declares for the voice write operations, already
// parsed by their Route Handlers.
type VoiceActivationRequest = AdminV2RequestBody<
  "characterVoiceActivationRequestSchema+idempotency-key"
>;
type VoiceSystemDefaultResetRequest = AdminV2RequestBody<
  "characterVoiceSystemDefaultResetRequestSchema+idempotency-key"
>;

export async function activateCharacterVoiceProfile(input: {
  characterId: string;
  profileId: string;
  actor: AdminActor;
  idempotencyKey: string;
  requestId: string;
  request: VoiceActivationRequest;
}) {
  const request = input.request;
  const result = await executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    commandType: "character.voice.activate",
    target: { type: "character_voice_profile", id: input.profileId },
    payload: {
      characterId: input.characterId,
      profileId: input.profileId,
      ...request,
    },
    prepare: async () => {
      const candidate = await prisma.characterVoiceProfile.findFirst({
        where: {
          id: input.profileId,
          characterId: input.characterId,
          provider: { in: ["fish_audio", "pocket_tts"] },
          status: "candidate",
        },
        select: {
          provider: true,
          providerVoiceId: true,
          sampleText: true,
          deliverySettings: true,
        },
      });
      if (!candidate || !isCharacterVoiceProviderKey(candidate.provider)) {
        throw Errors.conflict("Voice profile is no longer an activatable candidate", {
          characterId: input.characterId,
          profileId: input.profileId,
        });
      }
      const runtime = await inspectVoiceIdentityProviderRuntime(candidate.provider);
      if (runtime.runtimeStatus !== "ready") {
        throw Errors.unavailable(
          `${voiceProviderLabel(candidate.provider)} must be ready before activation`,
          runtime,
        );
      }
      const voice = voiceIdentityPortForKey(candidate.provider);
      const preview = await voice.previewVoice({
        text: candidate.sampleText,
        voiceId: candidate.providerVoiceId,
        delivery: deliverySettings(candidate.deliverySettings),
      });
      if (!preview.ok) {
        throw Errors.unavailable(
          `${voiceProviderLabel(candidate.provider)} could not verify the candidate voice before activation`,
          preview.error,
        );
      }
      return {
        provider: candidate.provider,
        providerVoiceId: candidate.providerVoiceId,
      };
    },
    mutate: async (tx, prepared) => {
      const lockedCharacters = await tx.$queryRaw<Array<{
        id: string;
        voiceId: string | null;
      }>>`SELECT "id", "voiceId" FROM "characters" WHERE "id" = ${input.characterId} FOR UPDATE`;
      const lockedCharacter = lockedCharacters[0];
      if (!lockedCharacter) throw Errors.notFound("Character not found");
      const candidate = await tx.characterVoiceProfile.findFirst({
        where: {
          id: input.profileId,
          characterId: input.characterId,
          provider: prepared.provider,
          providerVoiceId: prepared.providerVoiceId,
          status: "candidate",
        },
        include: {
          referenceAsset: true,
          previewAsset: true,
        },
      });
      const current = await tx.characterVoiceProfile.findFirst({
        where: { characterId: input.characterId, status: "active" },
        orderBy: [{ version: "desc" }, { id: "desc" }],
      });
      if (!candidate) {
        throw Errors.conflict("Voice profile is no longer an activatable candidate", {
          characterId: input.characterId,
          profileId: input.profileId,
        });
      }
      const currentActiveProfileId = current?.id ?? null;
      if (currentActiveProfileId !== request.expectedActiveProfileId) {
        throw Errors.conflict("Active voice changed while this candidate was under review", {
          expectedActiveProfileId: request.expectedActiveProfileId,
          currentActiveProfileId,
        });
      }
      if (lockedCharacter.voiceId !== request.expectedCurrentVoiceId) {
        throw Errors.conflict("Character voice pointer changed while this candidate was under review", {
          expectedCurrentVoiceId: request.expectedCurrentVoiceId,
          currentVoiceId: lockedCharacter.voiceId,
        });
      }
      if (current && lockedCharacter.voiceId !== current.providerVoiceId) {
        throw Errors.conflict("Active voice profile and character voice pointer disagree", {
          activeProfileId: current.id,
          activeProfileVoiceId: current.providerVoiceId,
          currentVoiceId: lockedCharacter.voiceId,
        });
      }
      const now = new Date();
      if (current) {
        await tx.characterVoiceProfile.update({
          where: { id: current.id },
          data: { status: "archived", archivedAt: now },
        });
      }
      const activated = await tx.characterVoiceProfile.update({
        where: { id: candidate.id },
        data: { status: "active", archivedAt: null },
        include: {
          referenceAsset: true,
          previewAsset: true,
        },
      });
      await tx.character.update({
        where: { id: input.characterId },
        data: { voiceId: activated.providerVoiceId },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: "character.voice.activated",
          targetType: "character_voice_profile",
          targetId: activated.id,
          reason: request.reason,
          before: toInputJson({
            characterId: input.characterId,
            activeProfileId: current?.id ?? null,
            providerVoiceId: current?.providerVoiceId ?? null,
          }),
          after: toInputJson({
            characterId: input.characterId,
            activeProfileId: activated.id,
            providerVoiceId: activated.providerVoiceId,
            version: activated.version,
          }),
          requestId: input.requestId,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "character.voice.activated.v2",
          aggregateType: "character",
          aggregateId: input.characterId,
          payload: toInputJson({
            characterId: input.characterId,
            profileId: activated.id,
            providerVoiceId: activated.providerVoiceId,
            version: activated.version,
            replacedActiveProfileId: current?.id ?? null,
            actorId: input.actor.id,
          }),
        },
      });
      return {
        profile: characterVoiceProfileDto(activated),
        replacedActiveProfileId: current?.id ?? null,
      };
    },
    decorateResult: (value, replayed) => ({
      ...(value as Record<string, unknown>),
      replayed,
    }),
  });
  return characterVoiceActivationResponseSchema.parse(result);
}

export async function resetCharacterVoiceToSystemDefault(input: {
  characterId: string;
  actor: AdminActor;
  idempotencyKey: string;
  requestId: string;
  request: VoiceSystemDefaultResetRequest;
}) {
  const request = input.request;
  const result = await executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    commandType: "character.voice.reset_to_system_default",
    target: { type: "character", id: input.characterId },
    payload: request,
    mutate: async (tx) => {
      const lockedCharacters = await tx.$queryRaw<Array<{
        id: string;
        voiceId: string | null;
      }>>`SELECT "id", "voiceId" FROM "characters" WHERE "id" = ${input.characterId} FOR UPDATE`;
      const lockedCharacter = lockedCharacters[0];
      if (!lockedCharacter) throw Errors.notFound("Character not found");
      const current = await tx.characterVoiceProfile.findFirst({
        where: { characterId: input.characterId, status: "active" },
        orderBy: [{ version: "desc" }, { id: "desc" }],
      });
      const currentActiveProfileId = current?.id ?? null;
      if (currentActiveProfileId !== request.expectedActiveProfileId) {
        throw Errors.conflict(
          "Active voice changed before the system-default reset",
          {
            expectedActiveProfileId: request.expectedActiveProfileId,
            currentActiveProfileId,
          },
        );
      }
      if (lockedCharacter.voiceId !== request.expectedCurrentVoiceId) {
        throw Errors.conflict(
          "Character voice pointer changed before the system-default reset",
          {
            expectedCurrentVoiceId: request.expectedCurrentVoiceId,
            currentVoiceId: lockedCharacter.voiceId,
          },
        );
      }
      if (current && lockedCharacter.voiceId !== current.providerVoiceId) {
        throw Errors.conflict(
          "Active voice profile and character voice pointer disagree",
          {
            activeProfileId: current.id,
            activeProfileVoiceId: current.providerVoiceId,
            currentVoiceId: lockedCharacter.voiceId,
          },
        );
      }
      if (current) {
        await tx.characterVoiceProfile.update({
          where: { id: current.id },
          data: { status: "archived", archivedAt: new Date() },
        });
      }
      await tx.character.update({
        where: { id: input.characterId },
        data: { voiceId: null },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: "character.voice.reset_to_system_default",
          targetType: "character",
          targetId: input.characterId,
          reason: request.reason,
          before: toInputJson({
            activeProfileId: current?.id ?? null,
            providerVoiceId: lockedCharacter.voiceId,
          }),
          after: toInputJson({
            activeProfileId: null,
            providerVoiceId: null,
            authoritySource: "system_default",
          }),
          requestId: input.requestId,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "character.voice.reset_to_system_default.v1",
          aggregateType: "character",
          aggregateId: input.characterId,
          payload: toInputJson({
            characterId: input.characterId,
            archivedProfileId: current?.id ?? null,
            actorId: input.actor.id,
          }),
        },
      });
      return {
        currentVoiceId: null,
        archivedProfileId: current?.id ?? null,
      };
    },
    decorateResult: (value, replayed) => ({
      ...(value as Record<string, unknown>),
      replayed,
    }),
  });
  return characterVoiceSystemDefaultResetResponseSchema.parse(result);
}

export function characterVoiceProfileDto(profile: VoiceProfileWithAssets): CharacterVoiceProfile {
  const referenceMetadata = jsonObject(profile.referenceAsset.metadata);
  const previewMetadata = profile.previewAsset
    ? jsonObject(profile.previewAsset.metadata)
    : {};
  return characterVoiceProfileSchema.parse({
    id: profile.id,
    version: profile.version,
    provider: profile.provider,
    providerVoiceId: profile.providerVoiceId,
    model: profile.model,
    language: profile.language,
    delivery: deliverySettings(profile.deliverySettings),
    status: profile.status,
    reference: {
      assetId: profile.referenceAsset.id,
      filename:
        typeof referenceMetadata.filename === "string"
          ? referenceMetadata.filename
          : "voice-reference",
      contentType: profile.referenceAsset.contentType ?? "application/octet-stream",
      sizeBytes:
        typeof referenceMetadata.sizeBytes === "number"
          ? referenceMetadata.sizeBytes
          : 0,
      transcript:
        typeof referenceMetadata.referenceText === "string"
          ? referenceMetadata.referenceText
          : null,
    },
    preview: profile.previewAsset
      ? {
          assetId: profile.previewAsset.id,
          url: profile.previewAsset.url,
          durationMs:
            typeof previewMetadata.durationMs === "number"
              ? previewMetadata.durationMs
              : 0,
        }
      : null,
    sampleText: profile.sampleText,
    createdById: profile.createdById,
    createdAt: profile.createdAt.toISOString(),
    archivedAt: profile.archivedAt?.toISOString() ?? null,
  });
}

async function cleanupPreparedArtifacts(input: {
  voice: VoiceIdentityPort;
  preparedArtifacts: {
    voiceId: string | null;
    previewKey: string | null;
    referenceStored: boolean;
  };
  referenceKey: string;
}) {
  const cleanup: Promise<unknown>[] = [];
  if (input.preparedArtifacts.voiceId) {
    const voiceCleanup = input.voice.deleteVoice({
      voiceId: input.preparedArtifacts.voiceId,
    });
    cleanup.push(voiceCleanup);
  }
  if (input.preparedArtifacts.previewKey) {
    cleanup.push(providers.blob.delete({ key: input.preparedArtifacts.previewKey }));
  }
  if (input.preparedArtifacts.referenceStored) {
    cleanup.push(providers.blob.delete({ key: input.referenceKey }));
  }
  await Promise.allSettled(cleanup);
}

// SPEC: Character voice identity can canary independently from the system voice
// route. Activated profiles persist this provider and clip creation later pins it.
function configuredCharacterVoiceIdentity(): {
  providerKey: CharacterVoiceProviderKey;
  voice: VoiceIdentityPort;
} {
  const configuredProvider = configuredVoiceIdentityProviderKey();
  if (!isCharacterVoiceProviderKey(configuredProvider)) {
    throw Errors.unavailable(
      "Character Voice Identity requires VOICE_IDENTITY_PROVIDER=pocket-tts or fish-audio",
      { configuredProvider },
    );
  }
  return {
    providerKey: configuredProvider,
    voice: voiceIdentityPortForKey(configuredProvider),
  };
}

function configuredVoiceIdentityProviderKey(): VoiceProviderKey {
  if (env.VOICE_IDENTITY_PROVIDER === "pocket-tts") return "pocket_tts";
  if (env.VOICE_IDENTITY_PROVIDER === "fish-audio") return "fish_audio";
  return providers.voice.clip.providerKey;
}

function voiceIdentityPortForKey(
  providerKey: CharacterVoiceProviderKey,
): VoiceIdentityPort {
  const configuredIdentity = providers.voice.identity;
  if (configuredIdentity?.providerKey === providerKey) {
    return configuredIdentity;
  }
  const identity = createVoicePortsForKey(providerKey, providers.blob).identity;
  if (!identity) {
    throw Errors.unavailable(
      `${voiceProviderLabel(providerKey)} does not support Character Voice Identity`,
      { providerKey },
    );
  }
  return identity;
}

function isCharacterVoiceProviderKey(
  providerKey: string,
): providerKey is CharacterVoiceProviderKey {
  return providerKey === "fish_audio" || providerKey === "pocket_tts";
}

function voiceProviderLabel(providerKey: CharacterVoiceProviderKey) {
  return providerKey === "pocket_tts" ? "Pocket TTS" : "Fish Audio";
}

function mediaViewUrl(assetId: string, extension: string) {
  const token = Buffer.from(assetId, "utf8").toString("base64url");
  return `/user-content/${token}/content${extension}`;
}

function stringField(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function jsonFormField(form: FormData, key: string) {
  const value = stringField(form, key);
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw Errors.badRequest(`${key} must be valid JSON`);
  }
}

function deliverySettings(value: Prisma.JsonValue) {
  const parsed = fishAudioDeliverySettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_FISH_AUDIO_DELIVERY;
}

function normalizedAudioContentType(contentType: string, filename: string) {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim();
  if (normalized) return normalized;
  const extension = filename.toLowerCase().split(".").pop();
  return {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    flac: "audio/flac",
    ogg: "audio/ogg",
  }[extension ?? ""] ?? "application/octet-stream";
}

function extensionFor(contentType: string) {
  if (contentType.includes("mpeg")) return ".mp3";
  if (contentType.includes("flac")) return ".flac";
  if (contentType.includes("ogg")) return ".ogg";
  return ".wav";
}

function safeFilename(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 180) || "voice-reference.wav";
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
