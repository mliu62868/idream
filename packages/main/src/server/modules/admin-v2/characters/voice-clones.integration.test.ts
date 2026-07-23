import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";

const providerState = vi.hoisted(() => ({
  cloneCalls: 0,
  synthesizeCalls: 0,
  storedKeys: [] as string[],
}));

vi.mock("@/server/providers", () => ({
  providers: {
    voice: {
      providerKey: "pocket_tts",
      supportsVoiceCloning: true,
      async cloneVoice(input: {
        voiceId: string;
        language: string;
      }) {
        providerState.cloneCalls += 1;
        return {
          ok: true as const,
          data: {
            voiceId: input.voiceId,
            model: "kyutai/pocket-tts",
            language: input.language,
          },
        };
      },
      async synthesize(input: { voiceId?: string }) {
        providerState.synthesizeCalls += 1;
        return {
          ok: true as const,
          data: {
            key: `voice/${input.voiceId}.wav`,
            durationMs: 1_500,
          },
        };
      },
      async deleteVoice() {
        return { ok: true as const, data: { deleted: true as const } };
      },
    },
    blob: {
      async putPrivate(input: { key: string; body: Uint8Array }) {
        providerState.storedKeys.push(input.key);
        return {
          ok: true as const,
          data: { key: input.key, size: input.body.byteLength },
        };
      },
      async signGetUrl() {
        return { ok: true as const, data: { url: "https://blob.example.test/voice" } };
      },
      async delete() {
        return { ok: true as const, data: { deleted: true as const } };
      },
    },
  },
}));

import { createCharacterVoiceClone } from "./voice-clones";

describe("Character Pocket TTS voice clone authority", () => {
  const suffix = randomUUID();
  const actorId = `voice-admin-${suffix}`;
  const characterId = `voice-character-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@example.test`,
        role: "admin",
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Mara Voice",
        age: 31,
        description: "A voice clone integration fixture.",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
  });

  afterAll(async () => {
    await prisma.controlPlaneCommand.deleteMany({
      where: { targetType: "character", targetId: characterId },
    });
    await prisma.characterVoiceProfile.deleteMany({ where: { characterId } });
    await prisma.mediaAsset.deleteMany({ where: { characterId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("binds a cloned voice idempotently and archives the replaced voice", async () => {
    providerState.cloneCalls = 0;
    providerState.synthesizeCalls = 0;
    providerState.storedKeys = [];
    const firstKey = `voice-clone-first-${suffix}`;
    const first = await createCharacterVoiceClone({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: firstKey,
      requestId: `voice-request-first-${suffix}`,
      form: cloneForm("first-reference.wav", "First preview sentence."),
    });
    const replay = await createCharacterVoiceClone({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: firstKey,
      requestId: `voice-request-replay-${suffix}`,
      form: cloneForm("first-reference.wav", "First preview sentence."),
    });

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(providerState.cloneCalls).toBe(1);
    expect(providerState.synthesizeCalls).toBe(1);
    expect(first.profile).toMatchObject({
      version: 1,
      provider: "pocket_tts",
      status: "active",
      reference: {
        filename: "first-reference.wav",
        sizeBytes: 2_048,
      },
      preview: {
        durationMs: 1_500,
      },
    });

    const second = await createCharacterVoiceClone({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: `voice-clone-second-${suffix}`,
      requestId: `voice-request-second-${suffix}`,
      form: cloneForm("second-reference.mp3", "Second preview sentence.", "audio/mpeg"),
    });

    expect(second).toMatchObject({
      replayed: false,
      replacedProfileId: first.profile.id,
      profile: {
        version: 2,
        status: "active",
        reference: { filename: "second-reference.mp3" },
      },
    });
    const [character, profiles] = await Promise.all([
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
      prisma.characterVoiceProfile.findMany({
        where: { characterId },
        orderBy: { version: "asc" },
      }),
    ]);
    expect(character.voiceId).toBe(second.profile.providerVoiceId);
    expect(profiles.map((profile) => ({
      version: profile.version,
      status: profile.status,
      archived: profile.archivedAt !== null,
    }))).toEqual([
      { version: 1, status: "archived", archived: true },
      { version: 2, status: "active", archived: false },
    ]);
  });
});

function cloneForm(
  filename: string,
  sampleText: string,
  contentType = "audio/wav",
) {
  const body = new Uint8Array(2_048);
  return {
    language: "english",
    sampleText,
    reason: "Create the character voice authority",
    reference: {
      filename,
      contentType,
      body,
      sha256: "a".repeat(64),
    },
  };
}
