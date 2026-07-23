import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";

const providerState = vi.hoisted(() => ({
  cloneCalls: 0,
  synthesizeCalls: 0,
  failSynthesizeCall: null as number | null,
  deletedVoiceIds: [] as string[],
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
        if (providerState.synthesizeCalls === providerState.failSynthesizeCall) {
          return {
            ok: false as const,
            error: {
              code: "preview_failed",
              message: "Synthetic concurrent preview failure",
              retryable: true,
            },
          };
        }
        return {
          ok: true as const,
          data: {
            key: `voice/${input.voiceId}.wav`,
            durationMs: 1_500,
          },
        };
      },
      async deleteVoice(input: { voiceId: string }) {
        providerState.deletedVoiceIds.push(input.voiceId);
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

import {
  activateCharacterVoiceProfile,
  createCharacterVoiceClone,
  parseVoiceCloneForm,
} from "./voice-clones";

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
      where: { actorId },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateType: "character", aggregateId: characterId },
    });
    await prisma.characterVoiceProfile.deleteMany({ where: { characterId } });
    await prisma.mediaAsset.deleteMany({ where: { characterId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("rejects audio containers that the installed soundfile runtime cannot decode", async () => {
    const form = new FormData();
    form.set("language", "english");
    form.set("sampleText", "Preview this voice candidate.");
    form.set("reason", "Verify the supported upload contract");
    form.set(
      "audio",
      new File([new Uint8Array(2_048)], "unsupported.m4a", {
        type: "audio/mp4",
      }),
    );

    await expect(parseVoiceCloneForm(new Request("http://localhost", {
      method: "POST",
      body: form,
    }))).rejects.toMatchObject({ status: 400 });
  });

  it("creates a candidate idempotently, then activates it with a distinct authority", async () => {
    providerState.cloneCalls = 0;
    providerState.synthesizeCalls = 0;
    providerState.failSynthesizeCall = null;
    providerState.deletedVoiceIds = [];
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
      status: "candidate",
      reference: {
        filename: "first-reference.wav",
        sizeBytes: 2_048,
      },
      preview: {
        url: expect.stringMatching(/^\/user-content\/.+\/content\.wav$/),
        durationMs: 1_500,
      },
    });
    expect(await prisma.character.findUniqueOrThrow({
      where: { id: characterId },
      select: { voiceId: true },
    })).toEqual({ voiceId: null });
    const firstActivationKey = `voice-activate-first-${suffix}`;
    const firstActivation = await activateCharacterVoiceProfile({
      characterId,
      profileId: first.profile.id,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: firstActivationKey,
      requestId: `voice-activate-request-first-${suffix}`,
      request: {
        reason: "The reviewed preview matches the character",
        expectedActiveProfileId: null,
        expectedCurrentVoiceId: null,
      },
    });
    const activationReplay = await activateCharacterVoiceProfile({
      characterId,
      profileId: first.profile.id,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: firstActivationKey,
      requestId: `voice-activate-request-replay-${suffix}`,
      request: {
        reason: "The reviewed preview matches the character",
        expectedActiveProfileId: null,
        expectedCurrentVoiceId: null,
      },
    });
    expect(firstActivation).toMatchObject({
      replayed: false,
      replacedActiveProfileId: null,
      profile: { id: first.profile.id, status: "active" },
    });
    expect(activationReplay).toEqual({ ...firstActivation, replayed: true });

    const second = await createCharacterVoiceClone({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: `voice-clone-second-${suffix}`,
      requestId: `voice-request-second-${suffix}`,
      form: cloneForm("second-reference.mp3", "Second preview sentence.", "audio/mpeg"),
    });

    expect(second).toMatchObject({
      replayed: false,
      replacedCandidateProfileId: null,
      profile: {
        version: 2,
        status: "candidate",
        reference: { filename: "second-reference.mp3" },
      },
    });
    expect((await prisma.character.findUniqueOrThrow({
      where: { id: characterId },
      select: { voiceId: true },
    })).voiceId).toBe(first.profile.providerVoiceId);
    await expect(activateCharacterVoiceProfile({
      characterId,
      profileId: second.profile.id,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: `voice-activate-stale-${suffix}`,
      requestId: `voice-activate-request-stale-${suffix}`,
      request: {
        reason: "Stale operator review should not win",
        expectedActiveProfileId: null,
        expectedCurrentVoiceId: null,
      },
    })).rejects.toMatchObject({ status: 409 });
    const secondActivation = await activateCharacterVoiceProfile({
      characterId,
      profileId: second.profile.id,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: `voice-activate-second-${suffix}`,
      requestId: `voice-activate-request-second-${suffix}`,
      request: {
        reason: "The replacement preview passed review",
        expectedActiveProfileId: first.profile.id,
        expectedCurrentVoiceId: first.profile.providerVoiceId,
      },
    });
    expect(secondActivation).toMatchObject({
      replayed: false,
      replacedActiveProfileId: first.profile.id,
      profile: { id: second.profile.id, status: "active" },
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
    expect(await prisma.adminAuditLog.findMany({
      where: { actorId },
      select: { action: true },
      orderBy: { createdAt: "asc" },
    })).toEqual([
      { action: "character.voice_candidate.created" },
      { action: "character.voice.activated" },
      { action: "character.voice_candidate.created" },
      { action: "character.voice.activated" },
    ]);
    expect(await prisma.mainOutboxEvent.count({
      where: { aggregateType: "character", aggregateId: characterId },
    })).toBe(4);
  });

  it("isolates concurrent idempotent preparations so a loser cannot delete the winner", async () => {
    providerState.cloneCalls = 0;
    providerState.synthesizeCalls = 0;
    providerState.failSynthesizeCall = 2;
    providerState.deletedVoiceIds = [];
    const key = `voice-clone-concurrent-${suffix}`;
    const request = () => createCharacterVoiceClone({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: key,
      requestId: randomUUID(),
      form: cloneForm("concurrent-reference.wav", "Concurrent preview sentence."),
    });

    const settled = await Promise.allSettled([request(), request()]);
    const winner = settled.find(
      (item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof request>>> =>
        item.status === "fulfilled",
    );
    expect(winner).toBeDefined();
    if (!winner) throw new Error("Expected one concurrent clone to succeed");
    expect(settled.some((item) => item.status === "rejected")).toBe(true);
    expect(providerState.deletedVoiceIds).not.toContain(
      winner.value.profile.providerVoiceId,
    );
    expect((await prisma.characterVoiceProfile.findUniqueOrThrow({
      where: { id: winner.value.profile.id },
    })).status).toBe("candidate");
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
