import { rm } from "node:fs/promises";
import path from "node:path";
import { resolveLocalBlobRoot } from "@idream/shared/storage/local-blob";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { PocketTtsVoiceModel } from "@/server/providers/voice/pocket-tts";
import {
  api,
  createCharacter,
  createUser,
  expectError,
  expectOk,
  publishCharacterForPublicAudience,
  purgeTestData,
} from "@/server/test/helpers";
import { resolveCharacterVoiceAuthority } from "@/server/modules/voice-defaults";
import { providers } from "@/server/providers";
import { VOICE_SAMPLE_TEXT } from "./character-voice-sample";

const P = "zt-voice-sample-";
const creatorId = `${P}creator`;
const viewerId = `${P}viewer`;
const publicId = `${P}public`;
const privateId = `${P}private`;
const silentId = `${P}silent`;
const racedId = `${P}raced`;
const characterIds = [publicId, privateId, silentId, racedId];

// 0.1 s of 16-bit mono silence: a real WAV, so ffmpeg (when present) can transcode it.
function silentWav() {
  const samples = 2_400;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24_000, 24); buffer.writeUInt32LE(48_000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(buffer);
}

async function bindVoice(characterId: string, version: number) {
  const referenceId = `${characterId}-voice-ref-${version}`;
  const providerVoiceId = `${characterId}-voice-${version}`;
  await prisma.mediaAsset.create({ data: {
    id: referenceId, ownerId: creatorId, characterId, type: "voice", url: "", contentType: "application/json",
    visibility: "private", metadata: {},
  } });
  await prisma.characterVoiceProfile.updateMany({ where: { characterId, status: "active" }, data: { status: "archived" } });
  await prisma.characterVoiceProfile.create({ data: {
    characterId, version, provider: "pocket_tts", providerVoiceId, model: "pocket-tts", language: "english",
    status: "active", referenceAssetId: referenceId, sampleText: "Operator sample", createdById: creatorId,
  } });
  await prisma.character.update({ where: { id: characterId }, data: { voiceId: providerVoiceId } });
}

async function cleanup() {
  await prisma.characterVoiceProfile.deleteMany({ where: { characterId: { in: characterIds } } });
  await purgeTestData(P);
  await Promise.all(characterIds.map((id) =>
    rm(path.join(resolveLocalBlobRoot(), "voice-samples/characters", id), { recursive: true, force: true })));
}

const preview = vi.spyOn(PocketTtsVoiceModel.prototype, "previewVoice");

beforeAll(async () => {
  await cleanup();
  await createUser({ id: creatorId });
  await createUser({ id: viewerId });
  for (const id of [publicId, silentId, racedId]) {
    await createCharacter({ id, creatorId, visibility: "public" });
    await publishCharacterForPublicAudience({ characterId: id, ownerId: creatorId });
  }
  await createCharacter({ id: privateId, creatorId, source: "user", visibility: "private" });
  await bindVoice(publicId, 1);
  await bindVoice(privateId, 1);
  await bindVoice(racedId, 1);
});
afterEach(() => preview.mockReset());
afterAll(async () => {
  preview.mockRestore();
  await cleanup();
  await prisma.$disconnect();
});

function renderSilence(delayMs = 0) {
  preview.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { ok: true as const, data: { body: silentWav(), contentType: "audio/wav", durationMs: 100 } };
  });
}

describe("Character voice sample", () => {
  it("synthesizes the fixed text once per voice profile version and replays the cache", async () => {
    renderSilence();
    const detail = await api("GET", `characters/${publicId}`, { ageGate: true });
    expectOk(detail);
    expect(detail.data.character.voiceSampleAvailable).toBe(true);

    const first = await api("GET", `characters/${publicId}/voice-sample`, { ageGate: true });
    expectOk(first);
    expect(first.headers.get("content-type")).toMatch(/^audio\/(mpeg|wav)$/);
    expect(first.bytes?.byteLength).toBeGreaterThan(0);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]?.[0]).toMatchObject({ text: VOICE_SAMPLE_TEXT, voiceId: `${publicId}-voice-1` });

    const replay = await api("GET", `characters/${publicId}/voice-sample`, { userId: viewerId, ageGate: true });
    expectOk(replay);
    expect(replay.bytes).toEqual(first.bytes);
    expect(preview).toHaveBeenCalledTimes(1);

    // A new voice version is a new cache entry; the old sample is never served for it.
    await bindVoice(publicId, 2);
    expectOk(await api("GET", `characters/${publicId}/voice-sample`, { ageGate: true }));
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls[1]?.[0]).toMatchObject({ voiceId: `${publicId}-voice-2` });
  });

  it("hides a private Character's sample from everyone but its creator", async () => {
    renderSilence();
    expectError(await api("GET", `characters/${privateId}/voice-sample`, { userId: viewerId, ageGate: true }), 404);
    expectError(await api("GET", `characters/${privateId}/voice-sample`, { ageGate: true }), 404);
    expect(preview).not.toHaveBeenCalled();
    expectOk(await api("GET", `characters/${privateId}/voice-sample`, { userId: creatorId, ageGate: true }));
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("previews the system default voice Chat uses when a Character has no voice of its own", async () => {
    renderSilence();
    // The test env speaks through the mock provider, which has no real voice to preview.
    const clip = providers.voice.clip as { providerKey: string };
    const configured = clip.providerKey;
    expect((await api("GET", `characters/${silentId}`, { ageGate: true })).data.character.voiceSampleAvailable).toBe(false);
    clip.providerKey = "pocket_tts";
    try {
      const detail = await api("GET", `characters/${silentId}`, { ageGate: true });
      expect(detail.data.character.voiceSampleAvailable).toBe(true);
      expectOk(await api("GET", `characters/${silentId}/voice-sample`, { ageGate: true }));
      const authority = await resolveCharacterVoiceAuthority({ characterId: silentId });
      expect(authority.source).toBe("system_default");
      expect(preview.mock.calls[0]?.[0]).toMatchObject({ text: VOICE_SAMPLE_TEXT, voiceId: authority.voiceId });
    } finally {
      clip.providerKey = configured;
    }
  });

  it("requires the age gate", async () => {
    expectError(await api("GET", `characters/${publicId}/voice-sample`), 403);
  });

  it("synthesizes once when first requests arrive concurrently", async () => {
    renderSilence(200);
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      api("GET", `characters/${racedId}/voice-sample`, { ageGate: true, anonymousId: `${P}anon-${index}` })));
    for (const result of results) expectOk(result);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((result) => Buffer.from(result.bytes ?? []).toString("hex"))).size).toBe(1);
  });
});
