import { createHash } from "node:crypto";
import {
  characterVoiceCloneCreateRequestSchema,
  characterVoiceCloneCreateResponseSchema,
  characterVoiceProfileSchema,
  type CharacterVoiceProfile,
} from "@idream/shared/admin";
import type { CharacterVoiceProfile as CharacterVoiceProfileRecord, MediaAsset, Prisma } from "@prisma/client";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { providers } from "@/server/providers";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { operationalCharacterWhere } from "@/server/modules/admin/shared/metric-data-scope";

const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
const MIN_REFERENCE_BYTES = 1_024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/flac",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-m4a",
  "audio/x-wav",
]);

type VoiceProfileWithAssets = CharacterVoiceProfileRecord & {
  referenceAsset: MediaAsset;
  previewAsset: MediaAsset | null;
};

export type ParsedVoiceCloneForm = {
  language: string;
  sampleText: string;
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
    sampleText: stringField(form, "sampleText"),
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
    throw Errors.badRequest("Voice reference must be WAV, MP3, FLAC, OGG, or M4A audio");
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
  const voice = providers.voice;
  if (!voice.supportsVoiceCloning || !voice.cloneVoice) {
    throw Errors.unavailable(
      "Voice cloning requires VOICE_PROVIDER=pocket-tts",
      { configuredProvider: voice.providerKey },
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

  const voiceId = deterministicVoiceId(input.actor.id, input.idempotencyKey);
  const referenceAssetId = `media_voice_reference_${voiceId}`;
  const previewAssetId = `media_voice_preview_${voiceId}`;
  const profileId = `voice_profile_${voiceId}`;
  const referenceKey =
    `voice-references/${input.characterId}/${voiceId}${extensionFor(input.form.reference.contentType)}`;
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
        language: input.form.language,
        sampleText: input.form.sampleText,
        reason: input.form.reason,
        referenceFilename: input.form.reference.filename,
        referenceContentType: input.form.reference.contentType,
        referenceSizeBytes: input.form.reference.body.byteLength,
        referenceSha256: input.form.reference.sha256,
      },
      prepare: async () => {
        const cloned = await voice.cloneVoice!({
          voiceId,
          audio: input.form.reference.body,
          contentType: input.form.reference.contentType,
          filename: input.form.reference.filename,
          language: input.form.language,
        });
        if (!cloned.ok) {
          throw Errors.unavailable("Pocket TTS could not clone the reference voice", cloned.error);
        }
        preparedArtifacts.voiceId = cloned.data.voiceId;
        const preview = await voice.synthesize({
          text: input.form.sampleText,
          voiceId: cloned.data.voiceId,
        });
        if (!preview.ok) {
          await voice.deleteVoice?.({ voiceId: cloned.data.voiceId });
          throw Errors.unavailable("Pocket TTS cloned the voice but could not render its preview", preview.error);
        }
        preparedArtifacts.previewKey = preview.data.key;
        const storedReference = await providers.blob.putPrivate({
          key: referenceKey,
          body: input.form.reference.body,
          contentType: input.form.reference.contentType,
        });
        if (!storedReference.ok) {
          await Promise.all([
            voice.deleteVoice?.({ voiceId: cloned.data.voiceId }),
            providers.blob.delete({ key: preview.data.key }),
          ]);
          throw Errors.unavailable("Voice reference storage failed", storedReference.error);
        }
        preparedArtifacts.referenceStored = true;
        return {
          cloned: cloned.data,
          preview: preview.data,
        };
      },
      mutate: async (tx, prepared) => {
        await tx.$queryRaw`SELECT "id" FROM "characters" WHERE "id" = ${input.characterId} FOR UPDATE`;
        const [current, latest] = await Promise.all([
          tx.characterVoiceProfile.findFirst({
            where: { characterId: input.characterId, status: "active" },
            orderBy: [{ version: "desc" }, { id: "desc" }],
          }),
          tx.characterVoiceProfile.findFirst({
            where: { characterId: input.characterId },
            orderBy: [{ version: "desc" }, { id: "desc" }],
            select: { version: true },
          }),
        ]);
        const now = new Date();
        if (current) {
          await tx.characterVoiceProfile.update({
            where: { id: current.id },
            data: { status: "archived", archivedAt: now },
          });
        }
        await tx.mediaAsset.create({
          data: {
            id: referenceAssetId,
            ownerId: input.actor.id,
            characterId: input.characterId,
            type: "voice",
            url: `/api/v1/media/${referenceAssetId}/content`,
            storageKey: referenceKey,
            contentType: input.form.reference.contentType,
            visibility: "private",
            safetyStatus: "passed",
            metadata: toInputJson({
              purpose: "voice_clone_reference",
              filename: input.form.reference.filename,
              sizeBytes: input.form.reference.body.byteLength,
              sha256: input.form.reference.sha256,
              provider: "pocket_tts",
              providerVoiceId: prepared.cloned.voiceId,
            }),
          },
        });
        await tx.mediaAsset.create({
          data: {
            id: previewAssetId,
            ownerId: input.actor.id,
            characterId: input.characterId,
            type: "voice",
            url: `/api/v1/media/${previewAssetId}/content`,
            storageKey: prepared.preview.key,
            contentType: "audio/wav",
            visibility: "private",
            safetyStatus: "passed",
            metadata: toInputJson({
              purpose: "voice_clone_preview",
              durationMs: prepared.preview.durationMs,
              provider: "pocket_tts",
              providerVoiceId: prepared.cloned.voiceId,
            }),
          },
        });
        const profile = await tx.characterVoiceProfile.create({
          data: {
            id: profileId,
            characterId: input.characterId,
            version: (latest?.version ?? 0) + 1,
            provider: "pocket_tts",
            providerVoiceId: prepared.cloned.voiceId,
            model: prepared.cloned.model,
            language: prepared.cloned.language,
            status: "active",
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
        await tx.character.update({
          where: { id: input.characterId },
          data: { voiceId: prepared.cloned.voiceId },
        });
        return {
          profile: characterVoiceProfileDto(profile),
          replacedProfileId: current?.id ?? null,
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
      await providers.blob.delete({ key: preparedArtifacts.previewKey });
    }
    return parsed;
  } catch (cause) {
    if (!mutationCompleted && preparedArtifacts.voiceId) {
      const cleanup: Promise<unknown>[] = [];
      const voiceCleanup = voice.deleteVoice?.({ voiceId: preparedArtifacts.voiceId });
      if (voiceCleanup) cleanup.push(voiceCleanup);
      if (preparedArtifacts.previewKey) {
        cleanup.push(providers.blob.delete({ key: preparedArtifacts.previewKey }));
      }
      if (preparedArtifacts.referenceStored) {
        cleanup.push(providers.blob.delete({ key: referenceKey }));
      }
      await Promise.allSettled(cleanup);
    }
    throw cause;
  }
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

function deterministicVoiceId(actorId: string, idempotencyKey: string) {
  const digest = createHash("sha256")
    .update(`${env.APP_ENV}:${actorId}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32);
  return `idream-${digest}`;
}

function stringField(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
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
    m4a: "audio/mp4",
  }[extension ?? ""] ?? "application/octet-stream";
}

function extensionFor(contentType: string) {
  if (contentType.includes("mpeg")) return ".mp3";
  if (contentType.includes("flac")) return ".flac";
  if (contentType.includes("ogg")) return ".ogg";
  if (contentType.includes("m4a") || contentType.includes("mp4")) return ".m4a";
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
