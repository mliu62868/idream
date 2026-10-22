import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_FISH_AUDIO_DELIVERY, type FishAudioDeliverySettings } from "@idream/shared/contracts";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "@/server/lib/request-json";
import { getVoiceDefaultSettings, POCKET_TTS_CATALOG } from "@/server/modules/voice-defaults";
import { providers } from "@/server/providers";
import { createVoicePortsForKey } from "@/server/providers/voice/factory";
import { mediaViewUrl } from "./public-read-model";

export type CharacterDraftVoiceSelection = {
  provider: "pocket_tts";
  voiceId: string;
};

export type PreparedCharacterDraftVoice = {
  userId: string;
  draftId: string;
  provider: "pocket_tts";
  presetVoiceId: string;
  voiceId: string;
  model: string;
  language: string;
  delivery: FishAudioDeliverySettings;
  sampleText: string;
  reference: { id: string; key: string; sizeBytes: number; sha256: string };
  preview: { id: string; key: string; durationMs: number };
};

export async function getCharacterDraftVoiceCatalog() {
  const settings = await getVoiceDefaultSettings();
  const runtime = await createVoicePortsForKey("pocket_tts").identity?.inspectCapabilities();
  const catalog = settings.provider === "pocket_tts" ? settings.catalog : POCKET_TTS_CATALOG;
  const items = runtime?.ok ? catalog.filter(voice => runtime.data.catalogVoices?.includes(voice.id)) : [];
  const preferred = settings.provider === "pocket_tts" ? settings.defaultVoiceId : env.POCKET_TTS_DEFAULT_VOICE_ID;
  return {
    provider: "pocket_tts" as const,
    defaultVoiceId: items.find(voice => voice.id === preferred)?.id ?? items[0]?.id ?? env.POCKET_TTS_DEFAULT_VOICE_ID,
    items: items.map(({ id, label, description }) => ({ id, label, description })),
  };
}

export async function previewCharacterDraftVoice(input: {
  provider: string;
  voiceId: string;
  text: string;
}) {
  await assertCurrentCatalogSelection(input);
  const preview = await createVoicePortsForKey("pocket_tts").identity!.previewVoice({ text: input.text, voiceId: input.voiceId });
  if (!preview.ok) throw Errors.unavailable("Could not preview the selected catalog voice", preview.error);
  return { voiceId: input.voiceId, contentType: preview.data.contentType,
    audioBase64: Buffer.from(preview.data.body).toString("base64"), durationMs: preview.data.durationMs };
}

export async function prepareCharacterDraftVoice(input: {
  provider: string;
  voiceId: string;
  userId: string;
  draftId: string;
}): Promise<PreparedCharacterDraftVoice> {
  await assertCurrentCatalogSelection(input);
  return preparePresetCharacterVoice({
    ...input, delivery: DEFAULT_FISH_AUDIO_DELIVERY, language: env.POCKET_TTS_LANGUAGE,
    sampleText: "Hello, it's good to meet you. I'm happy we can spend some time together.",
  });
}

export async function prepareCharacterVoiceCopy(input: {
  userId: string;
  sourceCharacterId: string;
  presetVoiceId: string;
  model: string;
  language: string;
  delivery: FishAudioDeliverySettings;
  sampleText: string;
}): Promise<PreparedCharacterDraftVoice> {
  // A saved identity must not follow a later change to system voice defaults.
  return preparePresetCharacterVoice({
    userId: input.userId, draftId: `duplicate-${input.sourceCharacterId}-${randomUUID()}`,
    voiceId: input.presetVoiceId, language: input.language, delivery: input.delivery,
    sampleText: input.sampleText, expectedModel: input.model,
  });
}

async function preparePresetCharacterVoice(input: {
  userId: string;
  draftId: string;
  voiceId: string;
  language: string;
  delivery: FishAudioDeliverySettings;
  sampleText: string;
  expectedModel?: string;
}): Promise<PreparedCharacterDraftVoice> {
  // INVARIANT: Pocket catalog aliases remain available independently of the
  // default speech engine. Each Character owns a real, distinct alias.
  const voice = createVoicePortsForKey("pocket_tts").identity;
  if (!voice?.createPresetVoice) throw Errors.unavailable("Catalog voice creation is unavailable");
  const voiceId = `idream-${randomUUID()}`;
  const referenceKey = `voice-references/drafts/${input.draftId}/${voiceId}.json`;
  const previewKey = `voice-previews/drafts/${input.draftId}/${voiceId}.wav`;
  const storedKeys: string[] = [];
  const sampleText = input.sampleText;
  try {
    const created = await voice.createPresetVoice({
      ownerId: input.userId, voiceId, presetVoiceId: input.voiceId, language: input.language,
    });
    if (!created.ok) throw Errors.unavailable("Could not save the selected catalog voice", created.error);
    if (created.data.voiceId !== voiceId || created.data.presetVoiceId !== input.voiceId) {
      throw Errors.unavailable("Catalog voice provider returned a different identity");
    }
    if (input.expectedModel && (created.data.model !== input.expectedModel || created.data.language !== input.language)) {
      throw Errors.unavailable("The saved character voice can no longer be copied with the same model and language");
    }
    const preview = await voice.previewVoice({ text: sampleText, voiceId, delivery: input.delivery });
    if (!preview.ok) throw Errors.unavailable("Could not verify the selected catalog voice", preview.error);
    const storedPreview = await providers.blob.putPrivate({
      key: previewKey, body: preview.data.body, contentType: preview.data.contentType,
    });
    if (!storedPreview.ok) throw Errors.unavailable("Voice preview storage failed", storedPreview.error);
    storedKeys.push(storedPreview.data.key);
    const descriptor = new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1, provider: "pocket_tts", providerVoiceId: voiceId,
      presetVoiceId: input.voiceId, model: created.data.model, language: created.data.language,
    }));
    const storedReference = await providers.blob.putPrivate({
      key: referenceKey, body: descriptor, contentType: "application/vnd.idream.pocket-tts-preset+json",
    });
    if (!storedReference.ok) throw Errors.unavailable("Voice descriptor storage failed", storedReference.error);
    storedKeys.push(storedReference.data.key);
    return {
      userId: input.userId, draftId: input.draftId, provider: "pocket_tts",
      presetVoiceId: input.voiceId, voiceId, model: created.data.model, language: created.data.language,
      delivery: input.delivery, sampleText,
      reference: {
        id: `media_voice_reference_${voiceId}`, key: storedReference.data.key,
        sizeBytes: storedReference.data.size, sha256: createHash("sha256").update(descriptor).digest("hex"),
      },
      preview: { id: `media_voice_preview_${voiceId}`, key: storedPreview.data.key, durationMs: preview.data.durationMs },
    };
  } catch (error) {
    // Preparation has not entered a database transaction. Cleanup targets only
    // this request's owned alias, including a create response lost in transit.
    await Promise.allSettled([
      voice.deleteVoice({ voiceId }),
      ...storedKeys.map((key) => providers.blob.delete({ key })),
    ]);
    throw error;
  }
}

// SPEC: Called only inside the transaction that creates a new user Character,
// or the one that applies an owner's edit draft. Its voice pointer, profile and
// private evidence commit with that Character version.
// INVARIANT: the pointer moves only from the value the caller read
// (`replacesVoiceId`, null on create); an edit archives the old profile first.
export async function bindCharacterDraftVoice(tx: {
  mediaAsset: { create(input: Prisma.MediaAssetCreateArgs): Promise<unknown> };
  characterVoiceProfile: { create(input: Prisma.CharacterVoiceProfileCreateArgs): Promise<unknown> };
  character: { updateMany(input: Prisma.CharacterUpdateManyArgs): Promise<{ count: number }> };
}, input: {
  characterId: string;
  userId: string;
  prepared: PreparedCharacterDraftVoice;
  replacesVoiceId?: string | null;
  version?: number;
}) {
  const { characterId, userId, prepared } = input;
  if (prepared.userId !== userId) throw Errors.conflict("Prepared voice belongs to another user");
  const updated = await tx.character.updateMany({
    where: { id: characterId, creatorId: userId, voiceId: input.replacesVoiceId ?? null, deletedAt: null },
    data: { voiceId: prepared.voiceId },
  });
  if (updated.count !== 1) throw Errors.conflict("Character voice changed before the selected voice was saved");
  const base = { ownerId: userId, characterId, type: "voice", visibility: "private", safetyStatus: "passed" };
  const reference = { ...base, id: prepared.reference.id, storageKey: prepared.reference.key,
    contentType: "application/vnd.idream.pocket-tts-preset+json", url: "" };
  const preview = { ...base, id: prepared.preview.id, storageKey: prepared.preview.key,
    contentType: "audio/wav", url: "" };
  await tx.mediaAsset.create({ data: {
    ...reference, url: mediaViewUrl(reference),
    metadata: toInputJson({
      purpose: "voice_preset_reference", filename: `${prepared.presetVoiceId}.pocket-voice`,
      sizeBytes: prepared.reference.sizeBytes, sha256: prepared.reference.sha256,
      provider: prepared.provider, providerVoiceId: prepared.voiceId, presetVoiceId: prepared.presetVoiceId,
    }),
  } });
  await tx.mediaAsset.create({ data: {
    ...preview, url: mediaViewUrl(preview),
    metadata: toInputJson({
      purpose: "voice_preset_preview", durationMs: prepared.preview.durationMs,
      provider: prepared.provider, providerVoiceId: prepared.voiceId, presetVoiceId: prepared.presetVoiceId,
    }),
  } });
  await tx.characterVoiceProfile.create({ data: {
    characterId, version: input.version ?? 1, provider: prepared.provider, providerVoiceId: prepared.voiceId,
    model: prepared.model, language: prepared.language, deliverySettings: toInputJson(prepared.delivery),
    status: "active", referenceAssetId: prepared.reference.id, previewAssetId: prepared.preview.id,
    sampleText: prepared.sampleText, createdById: userId,
  } });
}

export async function cleanupPreparedCharacterDraftVoice(prepared: PreparedCharacterDraftVoice) {
  // A lost commit acknowledgement must never delete a now-active provider alias.
  // If this read is unavailable, leave recoverable artifacts rather than guess.
  const committed = await prisma.characterVoiceProfile.findUnique({
    where: { providerVoiceId: prepared.voiceId }, select: { id: true },
  });
  if (committed) return;
  const voice = createVoicePortsForKey(prepared.provider).identity;
  await Promise.allSettled([
    voice?.deleteVoice({ voiceId: prepared.voiceId }),
    providers.blob.delete({ key: prepared.reference.key }),
    providers.blob.delete({ key: prepared.preview.key }),
  ]);
}

async function assertCurrentCatalogSelection(input: { provider: string; voiceId: string }) {
  if (input.provider !== "pocket_tts") throw Errors.conflict("Voice provider changed; choose a voice again");
  const catalog = await getCharacterDraftVoiceCatalog();
  if (!catalog.items.some(voice => voice.id === input.voiceId)) {
    throw Errors.badRequest("The selected voice is no longer available in the catalog");
  }
}
