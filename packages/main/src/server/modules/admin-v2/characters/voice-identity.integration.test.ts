import { randomUUID } from "node:crypto";
import { DEFAULT_FISH_AUDIO_DELIVERY } from "@idream/shared/admin";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { logger } from "@/server/lib/logger";

const providerState = vi.hoisted(() => ({
  providerKey: "fish_audio",
  identityProviderKey: null as "fish_audio" | "pocket_tts" | null,
  cloneCalls: 0,
  presetCalls: 0,
  synthesizeCalls: 0,
  failSynthesizeCall: null as number | null,
  deletedVoiceIds: [] as string[],
  referenceTexts: [] as string[],
  storedKeys: [] as string[],
  deletedKeys: [] as string[],
  inspectOk: true,
  unavailableProviders: [] as string[],
  persistedPreviewOk: true,
  voiceCloning: true,
  runtime: "mlx_audio",
  runtimeVersion: "mlx-audio-test",
  catalogVoices: [] as string[],
}));

vi.mock("@/server/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/lib/env")>();
  return { ...actual, env: { ...actual.env,
    get VOICE_IDENTITY_PROVIDER() {
      return providerState.identityProviderKey?.replace("_", "-") ?? actual.env.VOICE_IDENTITY_PROVIDER;
    },
  } };
});

vi.mock("@/server/providers", () => ({
  providers: {
    voice: {
      clip: {
        get providerKey() {
          return providerState.providerKey;
        },
        async synthesize() {
          throw new Error("Voice Clip is outside this Voice Identity test");
        },
      },
      identity: {
        get providerKey() {
          return providerState.identityProviderKey ?? providerState.providerKey;
        },
        async cloneVoice(input: {
          voiceId: string;
          language: string;
          referenceText: string;
        }) {
          providerState.cloneCalls += 1;
          providerState.referenceTexts.push(input.referenceText);
          return {
            ok: true as const,
            data: {
              voiceId: input.voiceId,
              model: "fish-audio-s2-pro-8bit",
              language: input.language,
            },
          };
        },
        async createPresetVoice(input: {
          voiceId: string;
          presetVoiceId: string;
          language: string;
        }) {
          providerState.presetCalls += 1;
          return {
            ok: true as const,
            data: {
              voiceId: input.voiceId,
              presetVoiceId: input.presetVoiceId,
              model: "pocket-tts",
              language: input.language,
            },
          };
        },
        async previewVoice() {
          providerState.synthesizeCalls += 1;
          if (
            !providerState.persistedPreviewOk ||
            providerState.synthesizeCalls === providerState.failSynthesizeCall
          ) {
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
                body: new Uint8Array([82, 73, 70, 70]),
                contentType: "audio/wav" as const,
                durationMs: 1_500,
              },
            };
        },
        async deleteVoice(input: { voiceId: string }) {
          providerState.deletedVoiceIds.push(input.voiceId);
          return { ok: true as const, data: { deleted: true as const } };
        },
        async inspectCapabilities() {
          return providerState.inspectOk && !providerState.unavailableProviders.includes(providerState.identityProviderKey ?? providerState.providerKey)
            ? {
                ok: true as const,
                data: {
                  voiceCloning: providerState.voiceCloning,
                  runtime: providerState.identityProviderKey
                    ? (providerState.identityProviderKey === "pocket_tts" ? "pocket_tts" : "mlx_audio")
                    : providerState.runtime,
                  runtimeVersion: providerState.runtimeVersion,
                  acceleration:
                    (providerState.identityProviderKey ?? providerState.providerKey) === "pocket_tts" ? "cpu" : "mlx",
                  catalogVoices: providerState.catalogVoices,
                },
              }
            : {
              ok: false as const,
              error: {
                code: "voice_runtime_unavailable",
                message: "Synthetic runtime outage",
                retryable: true,
              },
            };
        },
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
      async delete(input: { key: string }) {
        providerState.deletedKeys.push(input.key);
        return { ok: true as const, data: { deleted: true as const } };
      },
    },
  },
}));

vi.mock("@/server/providers/voice/factory", () => ({
  createVoicePortsForKey(providerKey: "fish_audio" | "pocket_tts") {
    return {
      clip: {
        providerKey,
        async synthesize() {
          throw new Error("Voice Clip is outside this Voice Identity test");
        },
      },
      identity: {
        providerKey,
        async cloneVoice() {
          throw new Error("Clone is outside persisted-candidate activation");
        },
        async createPresetVoice(input: { voiceId: string; presetVoiceId: string; language: string }) {
          providerState.presetCalls += 1;
          return { ok: true as const, data: {
            voiceId: input.voiceId, presetVoiceId: input.presetVoiceId,
            model: "pocket-tts", language: input.language,
          } };
        },
        async previewVoice() {
          providerState.synthesizeCalls += 1;
          if (!providerState.persistedPreviewOk) {
            return {
              ok: false as const,
              error: {
                code: "preview_failed",
                message: "Persisted candidate voice is unavailable",
                retryable: true,
              },
            };
          }
          return {
            ok: true as const,
            data: {
              body: new Uint8Array([82, 73, 70, 70]),
              contentType: "audio/wav" as const,
              durationMs: 1_500,
            },
          };
        },
        async deleteVoice() {
          return { ok: true as const, data: { deleted: true as const } };
        },
        async inspectCapabilities() {
          if (!providerState.inspectOk || providerState.unavailableProviders.includes(providerKey)) {
            return {
              ok: false as const,
              error: {
                code: "voice_runtime_unavailable",
                message: "Synthetic runtime outage",
                retryable: true,
              },
            };
          }
          return {
            ok: true as const,
            data: {
              voiceCloning: providerState.voiceCloning,
              runtime: providerKey === "pocket_tts" ? "pocket_tts" : "mlx_audio",
              runtimeVersion: providerState.runtimeVersion,
              acceleration: providerKey === "pocket_tts" ? "cpu" : "mlx",
              catalogVoices:
                providerKey === "pocket_tts"
                  ? providerState.catalogVoices
                  : [],
            },
          };
        },
      },
    };
  },
}));

import { updateVoiceDefaultSettings, VOICE_DEFAULTS_SETTING_KEY } from "@/server/modules/voice-defaults";
import { toInputJson } from "../shared/prisma-json";

import {
  activateCharacterVoiceProfile,
  createCharacterVoiceClone,
  createCharacterVoicePreset,
  inspectConfiguredVoiceIdentityRuntime,
  inspectCharacterVoiceRuntimes,
  parseVoiceCloneForm,
  resetCharacterVoiceToSystemDefault,
} from "./voice-identity";

describe("Character voice identity authority", () => {
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

  it("owns the configured Voice Identity runtime projection", async () => {
    providerState.providerKey = "fish_audio";
    providerState.inspectOk = true;
    providerState.voiceCloning = true;
    providerState.runtime = "mlx_audio";
    providerState.runtimeVersion = "mlx-audio-test";

    await expect(inspectConfiguredVoiceIdentityRuntime()).resolves.toMatchObject({
      provider: "fish_audio",
      cloningAvailable: true,
      runtimeStatus: "ready",
      runtimeEngine: "mlx_audio",
      runtimeVersion: "mlx-audio-test",
      runtimeLanguage: expect.any(String),
    });

    providerState.inspectOk = false;
    await expect(inspectConfiguredVoiceIdentityRuntime()).resolves.toMatchObject({
      provider: "fish_audio",
      cloningAvailable: false,
      runtimeStatus: "unavailable",
      runtimeEngine: "unknown",
      runtimeVersion: null,
    });

    providerState.providerKey = "pipeline";
    await expect(inspectConfiguredVoiceIdentityRuntime()).resolves.toMatchObject({
      provider: "pipeline",
      cloningAvailable: false,
      runtimeStatus: "inactive",
      runtimeEngine: "inactive",
      runtimeVersion: null,
    });

    providerState.providerKey = "fish_audio";
    providerState.inspectOk = true;
  });

  it("creates and activates a Pocket catalog candidate without cloning weights", async () => {
    providerState.providerKey = "pocket_tts";
    providerState.inspectOk = true;
    providerState.voiceCloning = false;
    providerState.runtime = "pocket_tts";
    providerState.runtimeVersion = "3.0.2";
    providerState.catalogVoices = ["alba", "anna"];
    providerState.presetCalls = 0;
    providerState.synthesizeCalls = 0;
    providerState.deletedVoiceIds = [];

    try {
      await expect(inspectConfiguredVoiceIdentityRuntime()).resolves.toEqual({
        provider: "pocket_tts",
        cloningAvailable: false,
        runtimeStatus: "ready",
        runtimeEngine: "pocket_tts",
        runtimeVersion: "3.0.2",
        runtimeLanguage: expect.any(String),
        catalogVoiceIds: ["alba", "anna"],
      });

      const candidate = await createCharacterVoicePreset({
        characterId,
        actor: { id: actorId, role: "admin" },
        idempotencyKey: `voice-preset-${suffix}`,
        requestId: `voice-preset-request-${suffix}`,
        request: {
          presetVoiceId: "anna",
          sampleText: "Anna is the reviewed Pocket catalog voice.",
          reason: "Assign a fast distinct voice to this role",
        },
      });
      expect(providerState.presetCalls).toBe(1);
      expect(candidate).toMatchObject({
        replayed: false,
        profile: {
          provider: "pocket_tts",
          status: "candidate",
          language: "english",
          reference: {
            filename: "anna.pocket-voice",
            contentType: "application/vnd.idream.pocket-tts-preset+json",
            sizeBytes: expect.any(Number),
            transcript: null,
          },
          preview: { durationMs: 1_500 },
        },
      });
      expect(candidate.profile.reference.sizeBytes).toBeGreaterThan(0);
      expect(candidate.profile.providerVoiceId).not.toBe("anna");

      const [character, active] = await Promise.all([
        prisma.character.findUniqueOrThrow({
          where: { id: characterId },
          select: { voiceId: true },
        }),
        prisma.characterVoiceProfile.findFirst({
          where: { characterId, status: "active" },
          select: { id: true },
        }),
      ]);
      await expect(activateCharacterVoiceProfile({
        characterId,
        profileId: candidate.profile.id,
        actor: { id: actorId, role: "admin" },
        idempotencyKey: `voice-preset-activate-${suffix}`,
        requestId: `voice-preset-activate-request-${suffix}`,
        request: {
          reason: "The Pocket catalog preview matches this character",
          expectedActiveProfileId: active?.id ?? null,
          expectedCurrentVoiceId: character.voiceId,
        },
      })).resolves.toMatchObject({
        replayed: false,
        profile: {
          id: candidate.profile.id,
          provider: "pocket_tts",
          status: "active",
        },
      });
      await expect(prisma.character.findUniqueOrThrow({
        where: { id: characterId },
        select: { voiceId: true },
      })).resolves.toEqual({ voiceId: candidate.profile.providerVoiceId });
    } finally {
      const presetProfiles = await prisma.characterVoiceProfile.findMany({
        where: { characterId, provider: "pocket_tts" },
        select: { id: true, referenceAssetId: true, previewAssetId: true },
      });
      await prisma.character.update({
        where: { id: characterId },
        data: { voiceId: null },
      });
      await prisma.characterVoiceProfile.deleteMany({
        where: { id: { in: presetProfiles.map((profile) => profile.id) } },
      });
      await prisma.mediaAsset.deleteMany({
        where: {
          id: {
            in: presetProfiles.flatMap((profile) => [
              profile.referenceAssetId,
              ...(profile.previewAssetId ? [profile.previewAssetId] : []),
            ]),
          },
        },
      });
      await prisma.adminAuditLog.deleteMany({
        where: {
          requestId: {
            in: [
              `voice-preset-request-${suffix}`,
              `voice-preset-activate-request-${suffix}`,
            ],
          },
        },
      });
      await prisma.mainOutboxEvent.deleteMany({
        where: { aggregateType: "character", aggregateId: characterId },
      });
      providerState.providerKey = "fish_audio";
      providerState.voiceCloning = true;
      providerState.runtime = "mlx_audio";
      providerState.runtimeVersion = "mlx-audio-test";
      providerState.catalogVoices = [];
    }
  });

  it("rejects audio containers that the installed soundfile runtime cannot decode", async () => {
    const form = new FormData();
    form.set("language", "english");
    form.set("referenceText", "Unsupported container reference transcript.");
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

  it("parses the exact transcript stored with the reference-audio contract", async () => {
    const form = new FormData();
    form.set("language", "english");
    form.set("referenceText", "The rain in Spain stays mainly in the plain.");
    form.set("sampleText", "Preview this voice candidate.");
    form.set("reason", "Verify the reference transcript");
    form.set(
      "audio",
      new File([new Uint8Array(2_048)], "reference.wav", {
        type: "audio/wav",
      }),
    );

    await expect(parseVoiceCloneForm(new Request("http://localhost", {
      method: "POST",
      body: form,
    }))).resolves.toMatchObject({
      referenceText: "The rain in Spain stays mainly in the plain.",
      reference: {
        filename: "reference.wav",
        contentType: "audio/wav",
        body: expect.any(Uint8Array),
      },
    });
  });

  it("creates a candidate idempotently, then activates it with a distinct authority", async () => {
    providerState.cloneCalls = 0;
    providerState.synthesizeCalls = 0;
    providerState.failSynthesizeCall = null;
    providerState.deletedVoiceIds = [];
    providerState.referenceTexts = [];
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
    expect(providerState.referenceTexts).toEqual([
      "The reference speaker reads this exact transcript.",
    ]);
    expect(first.profile).toMatchObject({
      version: 1,
      provider: "fish_audio",
      delivery: DEFAULT_FISH_AUDIO_DELIVERY,
      status: "candidate",
      reference: {
        filename: "first-reference.wav",
        sizeBytes: 2_048,
        transcript: "The reference speaker reads this exact transcript.",
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
    expect(await prisma.characterVoiceProfile.findUniqueOrThrow({
      where: { id: first.profile.id },
      select: { provider: true, deliverySettings: true },
    })).toEqual({
      provider: "fish_audio",
      deliverySettings: DEFAULT_FISH_AUDIO_DELIVERY,
    });
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

  it("activates a persisted candidate even when the system provider changes", async () => {
    providerState.providerKey = "fish_audio";
    providerState.synthesizeCalls = 0;
    providerState.failSynthesizeCall = null;
    const candidate = await createCharacterVoiceClone({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: `voice-clone-provider-switch-${suffix}`,
      requestId: `voice-request-provider-switch-${suffix}`,
      form: cloneForm(
        "provider-switch-reference.wav",
        "Provider switch preview.",
      ),
    });
    const character = await prisma.character.findUniqueOrThrow({
      where: { id: characterId },
      select: { voiceId: true },
    });
    const active = await prisma.characterVoiceProfile.findFirst({
      where: { characterId, status: "active" },
      select: { id: true },
    });

    providerState.providerKey = "pipeline";
    try {
      await expect(
        activateCharacterVoiceProfile({
          characterId,
          profileId: candidate.profile.id,
          actor: { id: actorId, role: "admin" },
          idempotencyKey: `voice-activate-provider-switch-${suffix}`,
          requestId: `voice-activate-request-provider-switch-${suffix}`,
          request: {
            reason: "This must not cross provider authority",
            expectedActiveProfileId: active?.id ?? null,
            expectedCurrentVoiceId: character.voiceId,
          },
        }),
      ).resolves.toMatchObject({
        replayed: false,
        profile: {
          id: candidate.profile.id,
          provider: "fish_audio",
          status: "active",
        },
      });
    } finally {
      providerState.providerKey = "fish_audio";
    }
    expect(
      (
        await prisma.character.findUniqueOrThrow({
          where: { id: characterId },
          select: { voiceId: true },
        })
      ).voiceId,
    ).toBe(candidate.profile.providerVoiceId);
    expect(
      (
        await prisma.characterVoiceProfile.findUniqueOrThrow({
          where: { id: candidate.profile.id },
          select: { status: true },
        })
      ).status,
    ).toBe("active");
  });

  it("rejects activation when the candidate provider is unavailable", async () => {
    providerState.providerKey = "fish_audio";
    providerState.inspectOk = true;
    providerState.voiceCloning = true;
    providerState.synthesizeCalls = 0;
    providerState.failSynthesizeCall = null;
    const candidate = await createCharacterVoiceClone({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: `voice-clone-unavailable-${suffix}`,
      requestId: `voice-request-unavailable-${suffix}`,
      form: cloneForm("unavailable-reference.wav", "Unavailable preview."),
    });
    const before = await prisma.character.findUniqueOrThrow({
      where: { id: characterId },
      select: { voiceId: true },
    });
    const active = await prisma.characterVoiceProfile.findFirst({
      where: { characterId, status: "active" },
      select: { id: true },
    });

    providerState.inspectOk = false;
    try {
      await expect(
        activateCharacterVoiceProfile({
          characterId,
          profileId: candidate.profile.id,
          actor: { id: actorId, role: "admin" },
          idempotencyKey: `voice-activate-unavailable-${suffix}`,
          requestId: `voice-activate-request-unavailable-${suffix}`,
          request: {
            reason: "Unavailable providers must not become live authority",
            expectedActiveProfileId: active?.id ?? null,
            expectedCurrentVoiceId: before.voiceId,
          },
        }),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      providerState.inspectOk = true;
    }

    await expect(
      prisma.character.findUniqueOrThrow({
        where: { id: characterId },
        select: { voiceId: true },
      }),
    ).resolves.toEqual(before);
    await expect(
      prisma.characterVoiceProfile.findUniqueOrThrow({
        where: { id: candidate.profile.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "candidate" });
  });

  it("rejects activation when the exact persisted candidate voice cannot render", async () => {
    providerState.providerKey = "fish_audio";
    providerState.inspectOk = true;
    providerState.voiceCloning = true;
    providerState.persistedPreviewOk = true;
    const candidate = await createCharacterVoiceClone({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey: `voice-clone-broken-preview-${suffix}`,
      requestId: `voice-request-broken-preview-${suffix}`,
      form: cloneForm("broken-preview-reference.wav", "Broken preview candidate."),
    });
    const before = await prisma.character.findUniqueOrThrow({
      where: { id: characterId },
      select: { voiceId: true },
    });
    const active = await prisma.characterVoiceProfile.findFirst({
      where: { characterId, status: "active" },
      select: { id: true },
    });

    providerState.persistedPreviewOk = false;
    try {
      await expect(
        activateCharacterVoiceProfile({
          characterId,
          profileId: candidate.profile.id,
          actor: { id: actorId, role: "admin" },
          idempotencyKey: `voice-activate-broken-preview-${suffix}`,
          requestId: `voice-activate-request-broken-preview-${suffix}`,
          request: {
            reason: "The exact candidate voice must still render",
            expectedActiveProfileId: active?.id ?? null,
            expectedCurrentVoiceId: before.voiceId,
          },
        }),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      providerState.persistedPreviewOk = true;
    }

    await expect(
      prisma.character.findUniqueOrThrow({
        where: { id: characterId },
        select: { voiceId: true },
      }),
    ).resolves.toEqual(before);
    await expect(
      prisma.characterVoiceProfile.findUniqueOrThrow({
        where: { id: candidate.profile.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "candidate" });
  });

  it("returns an active character voice to inherited system authority idempotently", async () => {
    const character = await prisma.character.findUniqueOrThrow({
      where: { id: characterId },
      select: { voiceId: true },
    });
    const active = await prisma.characterVoiceProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    const idempotencyKey = `voice-reset-system-default-${suffix}`;
    const request = {
      reason: "Return the character to the managed system default",
      expectedActiveProfileId: active.id,
      expectedCurrentVoiceId: character.voiceId,
    };
    const first = await resetCharacterVoiceToSystemDefault({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey,
      requestId: `voice-reset-request-${suffix}`,
      request,
    });
    const replay = await resetCharacterVoiceToSystemDefault({
      characterId,
      actor: { id: actorId, role: "admin" },
      idempotencyKey,
      requestId: `voice-reset-replay-${suffix}`,
      request,
    });

    expect(first).toEqual({
      replayed: false,
      currentVoiceId: null,
      archivedProfileId: active.id,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await prisma.character.findUniqueOrThrow({
      where: { id: characterId },
      select: { voiceId: true },
    })).toEqual({ voiceId: null });
    expect(await prisma.characterVoiceProfile.findUniqueOrThrow({
      where: { id: active.id },
      select: { status: true, archivedAt: true },
    })).toMatchObject({
      status: "archived",
      archivedAt: expect.any(Date),
    });
    expect(await prisma.adminAuditLog.count({
      where: {
        actorId,
        action: "character.voice.reset_to_system_default",
      },
    })).toBe(1);
    expect(await prisma.mainOutboxEvent.count({
      where: {
        aggregateType: "character",
        aggregateId: characterId,
        eventType: "character.voice.reset_to_system_default.v1",
      },
    })).toBe(1);
  });
  it("keeps Pocket presets and candidate readiness independent of Fish cloning", async () => {
    providerState.providerKey = "pocket_tts";
    providerState.identityProviderKey = "fish_audio";
    providerState.inspectOk = true;
    providerState.voiceCloning = true;
    providerState.catalogVoices = ["alba", "anna"];
    const presetInput = {
      characterId, actor: { id: actorId, role: "admin" as const },
      idempotencyKey: `voice-split-preset-${suffix}`, requestId: randomUUID(),
      request: { presetVoiceId: "anna", sampleText: "A distinct catalog voice.", reason: "Review the catalog candidate" },
    };
    try {
      await expect(inspectCharacterVoiceRuntimes("pocket_tts")).resolves.toMatchObject({
        provider: "fish_audio", cloningAvailable: true, runtimeStatus: "ready",
        presetRuntime: { provider: "pocket_tts", runtimeStatus: "ready", catalogVoiceIds: ["alba", "anna"] },
        candidateRuntimeStatus: "ready",
      });
      providerState.unavailableProviders = ["fish_audio"];
      await expect(inspectCharacterVoiceRuntimes("pocket_tts")).resolves.toMatchObject({
        provider: "fish_audio", cloningAvailable: false, runtimeStatus: "unavailable",
        presetRuntime: { provider: "pocket_tts", runtimeStatus: "ready", catalogVoiceIds: ["alba", "anna"] },
        candidateRuntimeStatus: "ready",
      });
      const candidate = await createCharacterVoicePreset(presetInput);
      expect(candidate.profile.provider).toBe("pocket_tts");
      const current = await prisma.character.findUniqueOrThrow({ where: { id: characterId }, select: { voiceId: true } });
      const active = await prisma.characterVoiceProfile.findFirst({ where: { characterId, status: "active" }, select: { id: true } });
      await expect(activateCharacterVoiceProfile({
        characterId, profileId: candidate.profile.id, actor: { id: actorId, role: "admin" },
        idempotencyKey: `voice-split-activation-${suffix}`, requestId: randomUUID(),
        request: { expectedCurrentVoiceId: current.voiceId, expectedActiveProfileId: active?.id ?? null,
          reason: "Activate the healthy Pocket candidate while cloning is offline" },
      })).resolves.toMatchObject({ profile: { id: candidate.profile.id, status: "active" } });
      providerState.inspectOk = false;
      providerState.providerKey = "mock";
      await expect(createCharacterVoicePreset(presetInput)).resolves.toEqual({ ...candidate, replayed: true });
    } finally {
      providerState.providerKey = "fish_audio";
      providerState.identityProviderKey = null;
      providerState.unavailableProviders = [];
      providerState.inspectOk = true;
      providerState.catalogVoices = [];
    }
  });

  it("replays committed clones after runtime outage and configured provider change", async () => {
    const input = {
      characterId, actor: { id: actorId, role: "admin" as const },
      idempotencyKey: `voice-outage-replay-${suffix}`, requestId: randomUUID(),
      form: cloneForm("outage.wav", "A durable clone receipt."),
    };
    const first = await createCharacterVoiceClone(input);
    const cloneCalls = providerState.cloneCalls;
    providerState.inspectOk = false;
    providerState.providerKey = "mock";
    try {
      await expect(createCharacterVoiceClone(input)).resolves.toEqual({ ...first, replayed: true });
      expect(providerState.cloneCalls).toBe(cloneCalls);
    } finally {
      providerState.inspectOk = true;
      providerState.providerKey = "fish_audio";
    }
  });

  it("preserves committed voice artifacts after a lost transaction acknowledgement", async () => {
    const input = {
      characterId, actor: { id: actorId, role: "admin" as const },
      idempotencyKey: `voice-lost-commit-${suffix}`, requestId: randomUUID(),
      form: cloneForm("commit.wav", "The committed clone must remain playable."),
    };
    const transact = prisma.$transaction.bind(prisma);
    const transaction = vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (callback, options) => {
      await transact(callback, options);
      throw new Error("Synthetic lost COMMIT acknowledgement");
    });
    try {
      await expect(createCharacterVoiceClone(input)).rejects.toThrow("Synthetic lost COMMIT acknowledgement");
    } finally {
      transaction.mockRestore();
    }
    const replay = await createCharacterVoiceClone(input);
    expect(replay.replayed).toBe(true);
    expect(providerState.deletedVoiceIds).not.toContain(replay.profile.providerVoiceId);
    expect(providerState.deletedKeys.some((key) => key.includes(replay.profile.providerVoiceId))).toBe(false);
    expect(await prisma.characterVoiceProfile.findUnique({ where: { id: replay.profile.id } })).not.toBeNull();
  });
  it("waits for an in-flight Character commit before deciding whether to delete artifacts", async () => {
    const input = {
      characterId, actor: { id: actorId, role: "admin" as const },
      idempotencyKey: `voice-pending-commit-${suffix}`, requestId: randomUUID(),
      form: cloneForm("pending.wav", "A commit still in flight must retain its voice."),
    };
    let releaseCommit = () => {};
    let signalWritten = () => {};
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const written = new Promise<void>((resolve) => { signalWritten = resolve; });
    const transact = prisma.$transaction.bind(prisma);
    let pendingCommit: Promise<unknown> | null = null;
    let blockingPid = 0;
    const transaction = vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (callback, options) => {
      pendingCommit = transact(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        blockingPid = rows[0]!.pid;
        const result = await callback(tx);
        signalWritten();
        await commitGate;
        return result;
      }, options);
      await Promise.race([written, pendingCommit]);
      throw new Error("Lost connection while COMMIT is still pending");
    });
    const operation = createCharacterVoiceClone(input);
    void operation.catch(() => {});
    try {
      await Promise.race([written, operation]);
      const deadline = Date.now() + 2_000;
      let waitingOnCommit = false;
      while (Date.now() < deadline) {
        const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE ${blockingPid} = ANY(pg_blocking_pids(pid))
          ) AS waiting`;
        if (rows[0]?.waiting) { waitingOnCommit = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waitingOnCommit).toBe(true);
    } finally {
      releaseCommit();
      await pendingCommit;
      transaction.mockRestore();
    }
    await expect(operation).rejects.toThrow("Lost connection while COMMIT is still pending");
    const replay = await createCharacterVoiceClone(input);
    expect(replay.replayed).toBe(true);
    expect(providerState.deletedVoiceIds).not.toContain(replay.profile.providerVoiceId);
    expect(providerState.deletedKeys.some((key) => key.includes(replay.profile.providerVoiceId))).toBe(false);
  });

  it("preserves the original failure and logs deferred cleanup when commit authority is unreadable", async () => {
    const input = {
      characterId, actor: { id: actorId, role: "admin" as const },
      idempotencyKey: `voice-unreadable-commit-${suffix}`, requestId: randomUUID(),
      form: cloneForm("unreadable.wav", "Keep evidence until commit authority can be read."),
    };
    const previousDeletes = [...providerState.deletedVoiceIds];
    const transaction = vi.spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(new Error("Original mutation connection loss"))
      .mockRejectedValueOnce(new Error("Commit authority database unavailable"));
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(createCharacterVoiceClone(input)).rejects.toThrow("Original mutation connection loss");
      expect(providerState.deletedVoiceIds).toEqual(previousDeletes);
      expect(warning).toHaveBeenCalledWith(expect.objectContaining({
        characterId, providerVoiceId: expect.stringMatching(/^idream-/),
        err: expect.objectContaining({ message: "Commit authority database unavailable" }),
      }), "Voice cleanup deferred because commit authority could not be verified");
    } finally {
      transaction.mockRestore();
      warning.mockRestore();
    }
  });

  it("replays a saved default setting after the system provider changes", async () => {
    const previous = await prisma.appSetting.findUnique({ where: { key: VOICE_DEFAULTS_SETTING_KEY } });
    providerState.providerKey = "mock";
    const input = {
      actor: { id: actorId, role: "admin" as const },
      idempotencyKey: `voice-default-replay-${suffix}`, requestId: randomUUID(),
      request: { provider: "mock", expectedVersion: previous?.version ?? 0,
        defaultVoiceId: "default", genderVoiceIds: { female: "default", male: "default", trans: "default" },
        delivery: DEFAULT_FISH_AUDIO_DELIVERY, reason: "Verify durable default setting receipt",
      },
    };
    try {
      const saved = await updateVoiceDefaultSettings(input);
      providerState.providerKey = "fish_audio";
      await expect(updateVoiceDefaultSettings(input)).resolves.toEqual({ ...saved, replayed: true });
    } finally {
      providerState.providerKey = "fish_audio";
      if (previous) {
        await prisma.appSetting.update({ where: { key: VOICE_DEFAULTS_SETTING_KEY }, data: {
          value: toInputJson(previous.value), version: previous.version, status: previous.status, updatedAt: previous.updatedAt,
        } });
      } else {
        await prisma.appSetting.deleteMany({ where: { key: VOICE_DEFAULTS_SETTING_KEY } });
      }
      await prisma.mainOutboxEvent.deleteMany({ where: {
        eventType: "voice.defaults.updated.v1", payload: { path: ["actorId"], equals: actorId },
      } });
    }
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
    referenceText: "The reference speaker reads this exact transcript.",
    sampleText,
    delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    reason: "Create the character voice authority",
    reference: {
      filename,
      contentType,
      body,
      sha256: "a".repeat(64),
    },
  };
}
