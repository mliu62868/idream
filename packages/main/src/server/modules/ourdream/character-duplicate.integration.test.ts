import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FISH_AUDIO_DELIVERY } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import * as voiceFactory from "@/server/providers/voice/factory";
import { api, createCharacter, createMedia, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";
import { bindCharacterDraftVoice } from "./character-draft-voice";
import { compileUserCharacterContent, materializeUserCharacterContentVersion } from "./character-soul";
import { characterVisualProfileCreateData } from "./generation-character-authority";
import { createReferenceSetRevision, loadLockedGenerationReferenceAuthority } from "./generation-reference-set";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";

const prefix = `zt-duplicate-authority-${randomUUID()}-`;
const delivery = { ...DEFAULT_FISH_AUDIO_DELIVERY, speed: 1.13 };
const createPreset = vi.fn();
const preview = vi.fn();
const deleteVoice = vi.fn();

beforeEach(() => {
  const real = voiceFactory.createVoicePortsForKey;
  const ports = real("pocket_tts");
  if (!ports.identity?.createPresetVoice) throw new Error("Pocket identity port required");
  createPreset.mockReset().mockImplementation(async input => ({ ok: true, data: {
    voiceId: input.voiceId, presetVoiceId: input.presetVoiceId, model: "pocket-tts", language: input.language,
  } }));
  preview.mockReset().mockResolvedValue({ ok: true, data: { body: new Uint8Array([1, 2, 3]), contentType: "audio/wav", durationMs: 1000 } });
  deleteVoice.mockReset().mockResolvedValue({ ok: true, data: { deleted: true } });
  vi.spyOn(ports.identity, "createPresetVoice").mockImplementation(createPreset);
  vi.spyOn(ports.identity, "previewVoice").mockImplementation(preview);
  vi.spyOn(ports.identity, "deleteVoice").mockImplementation(deleteVoice);
  vi.spyOn(voiceFactory, "createVoicePortsForKey").mockImplementation(key => key === "pocket_tts" ? ports : real(key));
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await purgeTestData(prefix);
  await prisma.tag.deleteMany({ where: { slug: { startsWith: prefix } } });
  await prisma.$disconnect();
});

async function sourceCharacter(label: string, withVoice = true) {
  const userId = `${prefix}${label}`;
  const characterId = `${userId}-character`;
  await createUser({ id: userId });
  const image = await createMedia({ id: `${userId}-image`, ownerId: userId });
  const character = await createCharacter({
    id: characterId, creatorId: userId, source: "user", visibility: "private", imageAssetId: image.id,
    name: "Nova", age: 28, description: "A patient garden teacher.",
    advancedDetails: { detailsMarkdown: "## Personality\nPatient and caring.", firstMessage: "Welcome to the balcony." },
  });
  const content = compileUserCharacterContent(character);
  const version = await prisma.$transaction(tx => materializeUserCharacterContentVersion({ tx, characterId, sourceId: `${userId}-draft`, createdById: userId, content }));
  await prisma.character.update({ where: { id: characterId }, data: { currentContentVersionId: version.id } });
  const tag = await prisma.tag.create({ data: { slug: `${userId}-caring`, label: "Caring" } });
  await prisma.characterTag.create({ data: { characterId, tagId: tag.id } });
  if (withVoice) await prisma.$transaction(tx => bindCharacterDraftVoice(tx, {
    characterId, userId, prepared: {
      userId, draftId: `${userId}-draft`, provider: "pocket_tts", presetVoiceId: "anna", voiceId: `${userId}-alias`,
      model: "pocket-tts", language: "english", delivery, sampleText: "Welcome to the balcony.",
      reference: { id: `${userId}-reference`, key: `${userId}/voice.json`, sizeBytes: 100, sha256: "a".repeat(64) },
      preview: { id: `${userId}-preview`, key: `${userId}/preview.wav`, durationMs: 1000 },
    },
  }));
  const original = await prisma.character.findUniqueOrThrow({ where: { id: characterId }, include: { voiceProfiles: true } });
  const storedVersion = await prisma.characterContentVersion.findUniqueOrThrow({ where: { id: version.id } });
  return { userId, characterId, tag, original, version: storedVersion };
}

async function sourceVisualCharacter(label: string, withVoice = false) {
  const source = await sourceCharacter(label, withVoice);
  const primary = await prisma.mediaAsset.update({ where: { id: source.original.imageAssetId! }, data: { characterId: source.characterId } });
  const extra = await createMedia({ id: `${source.userId}-angle`, ownerId: source.userId });
  await prisma.mediaAsset.update({ where: { id: extra.id }, data: { characterId: source.characterId } });
  const values = characterVisualProfileCreateData({
    characterId: source.characterId, version: 3, status: "active", style: "realistic", name: "Nova", age: 28,
    description: source.original.description, gender: "female", appearance: source.original.appearance,
    advancedDetails: source.original.advancedDetails, anchorAssetIds: [primary.id], createdFrom: "create_preview",
  });
  values.identityPrompt = "Adult Nova with short auburn hair, a small scar above the left eyebrow, and a blue scarf.";
  values.faceTraits = { eyeColor: "hazel", birthmark: "left eyebrow" };
  values.adapterRefs = { identity: { source: "manual" }, platformAsset: { approvalId: "source-only" } };
  values.immutableHash = characterVisualProfileSnapshotHash(values);
  const profile = await prisma.characterVisualProfile.create({ data: values });
  const selectedReferences = [
    { mediaAssetId: primary.id, position: 0, role: "primary_face", weight: 1, selectionReason: "primary_identity_anchor",
      crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 }, qualityScore: 0.91, identityScore: 0.84 },
    { mediaAssetId: extra.id, position: 1, role: "identity_reference", weight: 0.7, selectionReason: "saved_angle" },
  ];
  const references = await prisma.$transaction(tx => createReferenceSetRevision(tx, profile, "selected_identity", selectedReferences));
  const original = await prisma.character.findUniqueOrThrow({ where: { id: source.characterId } });
  const assets = await prisma.mediaAsset.findMany({ where: { id: { in: [primary.id, extra.id] } }, orderBy: { id: "asc" } });
  return { ...source, original, profile, references, assets };
}

describe("owned Character duplication authority", () => {
  it("copies the sealed visual facts and complete references into independent private authority without changing its source", async () => {
    const source = await sourceVisualCharacter("visual-copy");
    const response = await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true });
    expectOk(response);
    const copyId = response.data.character.id;
    const profile = await prisma.characterVisualProfile.findFirst({ where: { characterId: copyId, status: "active" } });
    expect(profile).not.toBeNull();
    expect(profile).toMatchObject({ version: 1, identityPrompt: source.profile.identityPrompt, faceTraits: source.profile.faceTraits,
      hairTraits: source.profile.hairTraits, bodyTraits: source.profile.bodyTraits, signatureTraits: source.profile.signatureTraits,
      styleTraits: source.profile.styleTraits, negativeIdentityPrompt: source.profile.negativeIdentityPrompt });
    expect(profile!.immutableHash).toBe(characterVisualProfileSnapshotHash(profile!));
    expect(profile!.adapterRefs).not.toHaveProperty("platformAsset");
    const authority = await prisma.$transaction(tx => loadLockedGenerationReferenceAuthority(tx, copyId, profile!, "balanced"));
    expect(authority.referenceManifest.map(({ role, weight }) => ({ role, weight }))).toEqual([{ role: "primary_face", weight: 1 }, { role: "identity_reference", weight: 0.7 }]);
    expect(authority.referenceManifest[0]).toMatchObject({ crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 }, qualityScore: 0.91, identityScore: 0.84 });
    expect(authority.referenceAssetIds).toHaveLength(2);
    expect(authority.referenceAssetIds.every(id => !source.assets.some(asset => asset.id === id))).toBe(true);
    const assets = await prisma.mediaAsset.findMany({ where: { id: { in: authority.referenceAssetIds } } });
    expect(assets).toHaveLength(2);
    for (const asset of assets) expect(asset).toMatchObject({ ownerId: source.userId, characterId: copyId, visibility: "private", safetyStatus: "passed" });
    expect(await prisma.character.findUniqueOrThrow({ where: { id: source.characterId } })).toEqual(source.original);
    expect(await prisma.characterVisualProfile.findUniqueOrThrow({ where: { id: source.profile.id } })).toEqual(source.profile);
    expect(await prisma.referenceSetRevision.findUniqueOrThrow({ where: { id: source.references.id }, include: { references: { orderBy: { position: "asc" } } } })).toEqual(source.references);
    expect(await prisma.mediaAsset.findMany({ where: { id: { in: source.assets.map(asset => asset.id) } }, orderBy: { id: "asc" } })).toEqual(source.assets);
    expect(await prisma.characterServing.count({ where: { characterId: copyId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: source.userId } })).toBe(0);
  });

  it("keeps the copied references usable after an actual private Edit draft rename Save", async () => {
    const source = await sourceVisualCharacter("visual-rename");
    const duplicated = await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true });
    expectOk(duplicated);
    const copyId = duplicated.data.character.id;
    const opened = await api("POST", `characters/${copyId}/edit-draft`, { userId: source.userId, ageGate: true });
    expectOk(opened);
    const draft = opened.data.draft;
    expectOk(await api("PATCH", `character-drafts/${draft.id}`, { userId: source.userId, ageGate: true, body: {
      expectedUpdatedAt: draft.updatedAt, name: "Nova Copy Renamed",
    } }));
    expectOk(await api("POST", `character-drafts/${draft.id}/submit`, { userId: source.userId, ageGate: true, body: { visibility: "private" } }));
    const saved = await prisma.character.findUniqueOrThrow({ where: { id: copyId } });
    expect(saved.name).toBe("Nova Copy Renamed");
    const profile = await prisma.characterVisualProfile.findFirstOrThrow({ where: { characterId: copyId, status: "active" } });
    expect(profile).toMatchObject({ version: 2, identityPrompt: source.profile.identityPrompt,
      faceTraits: source.profile.faceTraits, negativeIdentityPrompt: source.profile.negativeIdentityPrompt });
    const authority = await prisma.$transaction(tx => loadLockedGenerationReferenceAuthority(tx, copyId, profile, "balanced"));
    expect(authority.anchorAssetIds).toHaveLength(1);
    expect(authority.referenceAssetIds).toHaveLength(2);
    expect(authority.referenceManifest.map(({ role, weight }) => ({ role, weight }))).toEqual([{ role: "primary_face", weight: 1 }, { role: "identity_reference", weight: 0.7 }]);
    expect(authority.referenceManifest[0]).toMatchObject({ crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 }, qualityScore: 0.91, identityScore: 0.84 });
    expect(profile.immutableHash).toBe(characterVisualProfileSnapshotHash(profile));
    expect(await prisma.characterVisualProfile.findUniqueOrThrow({ where: { id: source.profile.id } })).toEqual(source.profile);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: source.characterId } })).toEqual(source.original);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: source.userId } })).toBe(0);
  });

  it.each(["unsealed-profile", "unsealed-reference", "missing-reference", "foreign-character", "foreign-owner", "deleted-reference"])("rejects %s visual authority without silently dropping a required reference", async invalid => {
    const source = await sourceVisualCharacter(`visual-invalid-${invalid}`, true);
    if (invalid === "unsealed-profile") await prisma.characterVisualProfile.update({ where: { id: source.profile.id }, data: { immutableHash: "invalid" } });
    if (invalid === "unsealed-reference") await prisma.referenceSetRevision.update({ where: { id: source.references.id }, data: { snapshotHash: "invalid" } });
    if (invalid === "missing-reference") await prisma.referenceSetRevision.delete({ where: { id: source.references.id } });
    if (invalid === "deleted-reference") await prisma.mediaAsset.update({ where: { id: `${source.userId}-angle` }, data: { deletedAt: new Date() } });
    if (invalid === "foreign-character") await prisma.mediaAsset.update({ where: { id: `${source.userId}-angle` }, data: { characterId: null } });
    if (invalid === "foreign-owner") {
      const other = `${source.userId}-other`;
      await createUser({ id: other });
      await prisma.mediaAsset.update({ where: { id: `${source.userId}-angle` }, data: { ownerId: other } });
    }
    expectError(await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true }), 409, "conflict");
    expect(createPreset).not.toHaveBeenCalled();
    expect(await prisma.character.count({ where: { creatorId: source.userId } })).toBe(1);
  });

  it("rejects changed visual authority after external voice preparation and cleans only the unused copy alias", async () => {
    const source = await sourceVisualCharacter("changed-visual", true);
    preview.mockImplementationOnce(async () => {
      const next = { ...source.profile, identityPrompt: "A changed portrait" };
      await prisma.characterVisualProfile.update({ where: { id: source.profile.id }, data: {
        identityPrompt: next.identityPrompt, immutableHash: characterVisualProfileSnapshotHash(next),
      } });
      return { ok: true, data: { body: new Uint8Array([1]), contentType: "audio/wav", durationMs: 1000 } };
    });
    expectError(await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true }), 409, "conflict");
    expect(await prisma.character.count({ where: { creatorId: source.userId } })).toBe(1);
    expect(deleteVoice).toHaveBeenCalledWith({ voiceId: createPreset.mock.calls[0]![0].voiceId });
    expect(await prisma.characterVoiceProfile.findUniqueOrThrow({ where: { providerVoiceId: source.original.voiceId! } })).toMatchObject({ status: "active" });
  });

  it("copies only the current owner's public draft identity and still rejects another viewer's Duplicate", async () => {
    const source = await sourceVisualCharacter("owned-public");
    await prisma.character.update({ where: { id: source.characterId }, data: { visibility: "public" } });
    const other = `${source.userId}-other`;
    await createUser({ id: other });
    expectError(await api("POST", `characters/${source.characterId}/duplicate`, { userId: other, ageGate: true }), 404, "not_found");
    const response = await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true });
    expectOk(response);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: response.data.character.id } })).toMatchObject({ visibility: "private" });
    expect(await prisma.characterVisualProfile.findFirstOrThrow({ where: { characterId: response.data.character.id, status: "active" } })).toMatchObject({ identityPrompt: source.profile.identityPrompt });
    expect(await prisma.characterServing.count({ where: { characterId: response.data.character.id } })).toBe(0);
  });

  it("establishes an independent identity anchor from an owned legacy cover and leaves a coverless draft unready", async () => {
    const source = await sourceCharacter("legacy-cover", false);
    const response = await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true });
    expectOk(response);
    const copy = await prisma.character.findUniqueOrThrow({ where: { id: response.data.character.id } });
    const profile = await prisma.characterVisualProfile.findFirstOrThrow({ where: { characterId: copy.id, status: "active" } });
    const authority = await prisma.$transaction(tx => loadLockedGenerationReferenceAuthority(tx, copy.id, profile, "balanced"));
    expect(authority.anchorAssetIds).toEqual([copy.imageAssetId]);
    expect(copy.imageAssetId).not.toBe(source.original.imageAssetId);
    const empty = await sourceCharacter("no-cover", false);
    await prisma.character.update({ where: { id: empty.characterId }, data: { imageAssetId: null } });
    const duplicated = await api("POST", `characters/${empty.characterId}/duplicate`, { userId: empty.userId, ageGate: true });
    expectOk(duplicated);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: duplicated.data.character.id }, include: { visualProfiles: true } })).toMatchObject({ imageAssetId: null, visualProfiles: [] });
  });

  it("retains tags and the saved voice in independent private authority, then reopens them in Edit", async () => {
    const source = await sourceCharacter("copy");
    await prisma.mediaAsset.update({ where: { id: `${source.userId}-reference` }, data: { metadata: {
      purpose: "voice_preset_reference", provider: "pocket_tts", providerVoiceId: source.original.voiceId, presetVoiceId: "anna",
      platformAsset: { status: "approved", approvalId: "source-only" },
    } } });
    const response = await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true });
    expectOk(response);
    const copy = await prisma.character.findUniqueOrThrow({ where: { id: response.data.character.id }, include: {
      tags: true, voiceProfiles: { include: { referenceAsset: true, previewAsset: true } }, currentContentVersion: true, serving: true,
    } });
    expect(copy.tags.map(t => t.tagId)).toEqual([source.tag.id]);
    expect(copy).toMatchObject({ name: "Nova Copy", visibility: "private", status: "approved", serving: null });
    expect(copy.voiceId).toBeTruthy();
    expect(copy.voiceId).not.toBe(source.original.voiceId);
    expect(copy.voiceProfiles).toHaveLength(1);
    const voice = copy.voiceProfiles[0]!;
    expect(voice).toMatchObject({ characterId: copy.id, version: 1, status: "active", provider: "pocket_tts", providerVoiceId: copy.voiceId, model: "pocket-tts", language: "english", deliverySettings: delivery, createdById: source.userId });
    expect(voice.referenceAssetId).not.toBe(`${source.userId}-reference`);
    expect(voice.previewAssetId).not.toBe(`${source.userId}-preview`);
    for (const asset of [voice.referenceAsset, voice.previewAsset!]) {
      expect(asset).toMatchObject({ ownerId: source.userId, characterId: copy.id, visibility: "private", safetyStatus: "passed" });
      expect(asset.metadata).toMatchObject({ presetVoiceId: "anna", providerVoiceId: copy.voiceId });
      expect(asset.metadata).not.toHaveProperty("platformAsset");
    }
    expect(preview).toHaveBeenCalledWith({ text: "Welcome to the balcony.", voiceId: copy.voiceId, delivery });
    expect(copy.currentContentVersion).toMatchObject({ version: 1, sourceId: source.characterId, openingSnapshot: source.version.openingSnapshot });
    expect(await prisma.characterContentVersion.findUniqueOrThrow({ where: { id: source.version.id } })).toEqual(source.version);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: source.characterId }, include: { voiceProfiles: true } })).toEqual(source.original);
    expect(await prisma.characterProject.count({ where: { characterId: copy.id } })).toBe(0);
    expect(await prisma.characterRelease.count({ where: { characterContentVersionId: copy.currentContentVersionId! } })).toBe(0);
    expect(await prisma.characterSubmission.count({ where: { characterId: copy.id } })).toBe(0);
    expect(await prisma.voiceUsageFact.count({ where: { userId: source.userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: source.userId } })).toBe(0);
    const edit = await api("POST", `characters/${copy.id}/edit-draft`, { userId: source.userId, ageGate: true });
    expectOk(edit);
    expect(edit.data.draft.tags).toEqual([source.tag.slug]);
    expect(edit.data.draft.advancedDetails.voiceSelection).toEqual({ provider: "pocket_tts", voiceId: "anna" });
    await prisma.characterVoiceProfile.update({ where: { id: source.original.voiceProfiles[0]!.id }, data: { status: "archived", archivedAt: new Date() } });
    await prisma.mediaAsset.update({ where: { id: `${source.userId}-reference` }, data: { deletedAt: new Date() } });
    expect(await prisma.characterVoiceProfile.findUniqueOrThrow({ where: { id: voice.id }, include: { referenceAsset: true } })).toMatchObject({ status: "active", referenceAsset: { deletedAt: null, characterId: copy.id } });
  });

  it("keeps an unvoiced source unvoiced while retaining its tags", async () => {
    const source = await sourceCharacter("unvoiced", false);
    const response = await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true });
    expectOk(response);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: response.data.character.id }, include: { tags: true, voiceProfiles: true } })).toMatchObject({ voiceId: null, voiceProfiles: [], tags: [{ tagId: source.tag.id }] });
    expect(createPreset).not.toHaveBeenCalled();
  });

  it("rejects an unavailable identity image before spending work preparing the saved voice", async () => {
    const source = await sourceCharacter("unavailable-image");
    await prisma.mediaAsset.update({ where: { id: `${source.userId}-image` }, data: { metadata: { platformAsset: { status: "archived" } } } });
    expectError(await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true }), 409, "conflict");
    expect(createPreset).not.toHaveBeenCalled();
    expect(await prisma.character.count({ where: { creatorId: source.userId } })).toBe(1);
  });

  it.each(["archived", "deleted-reference", "foreign-reference", "wrong-alias"])("rejects %s voice authority without creating a partial copy", async invalid => {
    const source = await sourceCharacter(invalid);
    if (invalid === "archived") await prisma.characterVoiceProfile.update({ where: { id: source.original.voiceProfiles[0]!.id }, data: { status: "archived" } });
    if (invalid === "deleted-reference") await prisma.mediaAsset.update({ where: { id: `${source.userId}-reference` }, data: { deletedAt: new Date() } });
    if (invalid === "foreign-reference") {
      const other = `${source.userId}-other`;
      await createUser({ id: other });
      await prisma.mediaAsset.update({ where: { id: `${source.userId}-reference` }, data: { ownerId: other } });
    }
    if (invalid === "wrong-alias") await prisma.mediaAsset.update({ where: { id: `${source.userId}-reference` }, data: { metadata: {
      provider: "pocket_tts", providerVoiceId: "another-voice", presetVoiceId: "anna",
    } } });
    expectError(await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true }), 409, "conflict");
    expect(await prisma.character.count({ where: { creatorId: source.userId } })).toBe(1);
    expect(createPreset).not.toHaveBeenCalled();
  });

  it("cleans the prepared alias when the source voice changes before the copy commits", async () => {
    const source = await sourceCharacter("changed");
    preview.mockImplementationOnce(async () => {
      await prisma.character.update({ where: { id: source.characterId }, data: { voiceId: null } });
      return { ok: true, data: { body: new Uint8Array([1]), contentType: "audio/wav", durationMs: 1000 } };
    });
    expectError(await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true }), 409, "conflict");
    expect(await prisma.character.count({ where: { creatorId: source.userId } })).toBe(1);
    expect(deleteVoice).toHaveBeenCalledWith({ voiceId: createPreset.mock.calls[0]![0].voiceId });
    expect(await prisma.mediaAsset.count({ where: { ownerId: source.userId } })).toBe(3);
  });

  it("fails voice preparation explicitly and leaves no Character or voice usage behind", async () => {
    const source = await sourceCharacter("failed");
    preview.mockResolvedValueOnce({ ok: false, error: { code: "offline", message: "Offline", retryable: true } });
    expectError(await api("POST", `characters/${source.characterId}/duplicate`, { userId: source.userId, ageGate: true }), 503, "unavailable");
    expect(await prisma.character.count({ where: { creatorId: source.userId } })).toBe(1);
    expect(await prisma.voiceUsageFact.count({ where: { userId: source.userId } })).toBe(0);
    expect(deleteVoice).toHaveBeenCalledWith({ voiceId: createPreset.mock.calls[0]![0].voiceId });
  });
});
