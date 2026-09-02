import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FISH_AUDIO_DELIVERY } from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  defaults: vi.fn(),
  previewDefault: vi.fn(),
  createPorts: vi.fn(),
  createPreset: vi.fn(),
  preview: vi.fn(),
  deleteVoice: vi.fn(),
  put: vi.fn(),
  deleteBlob: vi.fn(),
  findProfile: vi.fn(),
}));

vi.mock("@/server/modules/voice-defaults", () => ({
  getVoiceDefaultSettings: mocks.defaults,
  previewVoiceDefault: mocks.previewDefault,
}));
vi.mock("@/server/providers/voice/factory", () => ({ createVoicePortsForKey: mocks.createPorts }));
vi.mock("@/server/providers", () => ({
  providers: { blob: { putPrivate: mocks.put, delete: mocks.deleteBlob } },
}));
vi.mock("@/server/lib/db", () => ({
  prisma: { characterVoiceProfile: { findUnique: mocks.findProfile } },
}));
vi.mock("@/server/lib/env", () => ({ env: { POCKET_TTS_LANGUAGE: "english", VOICE_IDENTITY_PROVIDER: "fish-audio" } }));

import {
  bindCharacterDraftVoice,
  cleanupPreparedCharacterDraftVoice,
  getCharacterDraftVoiceCatalog,
  prepareCharacterDraftVoice,
  previewCharacterDraftVoice,
} from "./character-draft-voice";

const selection = { provider: "pocket_tts", voiceId: "anna" } as const;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.defaults.mockResolvedValue({
    provider: "pocket_tts", defaultVoiceId: "alba", delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    catalog: [
      { id: "alba", label: "Alba", description: "First voice" },
      { id: "anna", label: "Anna", description: "Second voice" },
    ],
  });
  mocks.createPorts.mockReturnValue({ identity: {
    providerKey: "pocket_tts", createPresetVoice: mocks.createPreset,
    previewVoice: mocks.preview, deleteVoice: mocks.deleteVoice,
  } });
  mocks.createPreset.mockImplementation(async (input) => ({ ok: true, data: {
    voiceId: input.voiceId, presetVoiceId: input.presetVoiceId, model: "pocket-tts", language: "english",
  } }));
  mocks.preview.mockResolvedValue({ ok: true, data: { body: new Uint8Array([1, 2, 3]), contentType: "audio/wav", durationMs: 3_200 } });
  mocks.put.mockImplementation(async (input) => ({ ok: true, data: { key: input.key, size: input.body.length } }));
  mocks.findProfile.mockResolvedValue(null);
  mocks.deleteVoice.mockResolvedValue({ ok: true, data: { deleted: true } });
  mocks.deleteBlob.mockResolvedValue({ ok: true, data: { deleted: true } });
});

describe("character draft catalog voice", () => {
  it("exposes the current catalog and previews with the saved system delivery", async () => {
    expect(await getCharacterDraftVoiceCatalog()).toEqual({
      provider: "pocket_tts", defaultVoiceId: "alba", items: [
        { id: "alba", label: "Alba", description: "First voice" },
        { id: "anna", label: "Anna", description: "Second voice" },
      ],
    });
    mocks.previewDefault.mockResolvedValue({ audioBase64: "AQID" });
    await expect(previewCharacterDraftVoice({ ...selection, text: "Hello there." })).resolves.toEqual({ audioBase64: "AQID" });
    expect(mocks.previewDefault).toHaveBeenCalledWith({ ...selection, text: "Hello there.", delivery: DEFAULT_FISH_AUDIO_DELIVERY });
  });

  it("creates and verifies a distinct real Pocket alias despite a Fish identity route", async () => {
    const first = await prepareCharacterDraftVoice({ ...selection, userId: "user-1", draftId: "draft-1" });
    const second = await prepareCharacterDraftVoice({ ...selection, userId: "user-1", draftId: "draft-2" });
    expect(first.voiceId).not.toBe(selection.voiceId);
    expect(first.voiceId).not.toBe(second.voiceId);
    expect(mocks.createPorts).toHaveBeenCalledWith("pocket_tts", expect.anything());
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ voiceId: first.voiceId }));
    expect(first).toMatchObject({ provider: "pocket_tts", presetVoiceId: "anna", model: "pocket-tts", preview: { durationMs: 3_200 } });
  });

  it("rejects an outdated provider or missing voice before creating any alias", async () => {
    await expect(prepareCharacterDraftVoice({ provider: "fish_audio", voiceId: "anna", userId: "user-1", draftId: "draft-1" })).rejects.toThrow(/provider changed/i);
    await expect(prepareCharacterDraftVoice({ ...selection, voiceId: "missing", userId: "user-1", draftId: "draft-1" })).rejects.toThrow(/catalog/i);
    expect(mocks.createPreset).not.toHaveBeenCalled();
  });

  it("cleans the owned alias and stored preview when descriptor storage fails", async () => {
    mocks.put.mockImplementation(async (input) => input.contentType === "audio/wav"
      ? { ok: true, data: { key: input.key, size: input.body.length } }
      : { ok: false, error: { code: "storage_failed", message: "Offline", retryable: true } });
    await expect(prepareCharacterDraftVoice({ ...selection, userId: "user-1", draftId: "draft-1" })).rejects.toThrow(/storage/i);
    expect(mocks.deleteVoice).toHaveBeenCalledWith({ voiceId: mocks.createPreset.mock.calls[0]![0].voiceId });
    expect(mocks.deleteBlob).toHaveBeenCalledTimes(1);
  });

  it("binds the verified profile and both private assets inside the caller transaction", async () => {
    const prepared = await prepareCharacterDraftVoice({ ...selection, userId: "user-1", draftId: "draft-1" });
    const tx = {
      mediaAsset: { create: vi.fn(async (_input: Prisma.MediaAssetCreateArgs) => ({})) },
      characterVoiceProfile: { create: vi.fn(async (_input: Prisma.CharacterVoiceProfileCreateArgs) => ({})) },
      character: { updateMany: vi.fn(async (_input: Prisma.CharacterUpdateManyArgs) => ({ count: 1 })) },
    };
    await bindCharacterDraftVoice(tx, { characterId: "character-1", userId: "user-1", prepared });
    expect(tx.character.updateMany).toHaveBeenCalledWith({ where: { id: "character-1", creatorId: "user-1", voiceId: null, deletedAt: null }, data: { voiceId: prepared.voiceId } });
    expect(tx.characterVoiceProfile.create).toHaveBeenCalledWith({ data: expect.objectContaining({ characterId: "character-1", createdById: "user-1", version: 1, status: "active", provider: "pocket_tts", providerVoiceId: prepared.voiceId, referenceAssetId: prepared.reference.id, previewAssetId: prepared.preview.id }) });
    expect(tx.mediaAsset.create.mock.calls.map(([input]) => input.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: "user-1", characterId: "character-1", visibility: "private", contentType: "audio/wav" }),
      expect.objectContaining({ ownerId: "user-1", characterId: "character-1", visibility: "private", contentType: "application/vnd.idream.pocket-tts-preset+json" }),
    ]));
  });

  it("never deletes a committed voice after an ambiguous transaction response", async () => {
    const prepared = await prepareCharacterDraftVoice({ ...selection, userId: "user-1", draftId: "draft-1" });
    mocks.findProfile.mockResolvedValue({ id: "saved-profile" });
    await cleanupPreparedCharacterDraftVoice(prepared);
    expect(mocks.deleteVoice).not.toHaveBeenCalled();
    expect(mocks.deleteBlob).not.toHaveBeenCalled();
    mocks.findProfile.mockResolvedValue(null);
    await cleanupPreparedCharacterDraftVoice(prepared);
    expect(mocks.deleteVoice).toHaveBeenCalledWith({ voiceId: prepared.voiceId });
    expect(mocks.deleteBlob).toHaveBeenCalledTimes(2);
  });

  it("refuses to attach the prepared identity to another user or an already configured Character", async () => {
    const prepared = await prepareCharacterDraftVoice({ ...selection, userId: "user-1", draftId: "draft-1" });
    const tx = {
      mediaAsset: { create: vi.fn(async (_input: Prisma.MediaAssetCreateArgs) => ({})) },
      characterVoiceProfile: { create: vi.fn(async (_input: Prisma.CharacterVoiceProfileCreateArgs) => ({})) },
      character: { updateMany: vi.fn(async (_input: Prisma.CharacterUpdateManyArgs) => ({ count: 0 })) },
    };
    await expect(bindCharacterDraftVoice(tx, { characterId: "character-1", userId: "other-user", prepared })).rejects.toThrow(/another user/i);
    expect(tx.character.updateMany).not.toHaveBeenCalled();
    await expect(bindCharacterDraftVoice(tx, { characterId: "character-1", userId: "user-1", prepared })).rejects.toThrow(/voice changed/i);
    expect(tx.mediaAsset.create).not.toHaveBeenCalled();
    expect(tx.characterVoiceProfile.create).not.toHaveBeenCalled();
  });

  it("retains prepared artifacts when an unavailable database cannot settle commit ownership", async () => {
    const prepared = await prepareCharacterDraftVoice({ ...selection, userId: "user-1", draftId: "draft-1" });
    mocks.findProfile.mockRejectedValue(new Error("Connection unavailable"));
    await expect(cleanupPreparedCharacterDraftVoice(prepared)).rejects.toThrow("Connection unavailable");
    expect(mocks.deleteVoice).not.toHaveBeenCalled();
    expect(mocks.deleteBlob).not.toHaveBeenCalled();
  });
});
