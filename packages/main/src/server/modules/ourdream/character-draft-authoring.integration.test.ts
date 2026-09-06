import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FISH_AUDIO_DELIVERY } from "@idream/shared/admin";
import * as draftVoice from "./character-draft-voice";
import { resolveCharacterVoiceAuthority } from "@/server/modules/voice-defaults";
import { prisma } from "@/server/lib/db";
import { transitionGenerationRequest } from "@/server/ai/generation-request-transition";
import { api, createUser, expectOk, expectError, purgeTestData } from "@/server/test/helpers";

const prefix = `zt-create-authoring-${randomUUID()}-`;
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.generationAttempt.deleteMany({ where: { requestId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

async function recordPreviewInput(draftId: string, previewId: string, userId: string) {
  const draft = await prisma.characterDraft.findUniqueOrThrow({ where: { id: draftId } });
  const recipe = await prisma.generationRecipe.upsert({
    where: { id: `${prefix}recipe` }, update: {},
    create: { id: `${prefix}recipe`, recipeKey: `${prefix}recipe`, label: "Preview recipe", body: "Identity portrait", presetOrder: [], safetyHints: {}, sampleMatrix: [] },
  });
  return prisma.generationJob.create({ data: {
    id: `${prefix}${previewId}`, userId, mode: "image", controls: {}, presetIds: [],
    sourceType: "character_preview", sourceId: previewId, recipeId: recipe.recipeKey, recipeVersion: recipe.version,
    prompt: [recipe.body, `${draft.style ?? "realistic"} portrait of an adult ${draft.gender ?? "female"} character`,
      draft.name ? `Character name: ${draft.name}` : null, `Appearance: ${JSON.stringify(draft.appearance ?? {})}`,
      `Hair: ${JSON.stringify(draft.hair ?? {})}`, `Body: ${JSON.stringify(draft.body ?? {})}`,
      `Details: ${JSON.stringify(draft.advancedDetails ?? {})}`, "single subject, clear face, identity reference portrait"].filter(Boolean).join(". "),
  } });
}

describe("Create authoring authority", () => {
  it("keeps completed candidates unconfirmed until explicit selection and preserves that anchor after later completion", async () => {
    const userId = `${prefix}late-candidate-owner`;
    await createUser({ id: userId });
    const draft = await prisma.characterDraft.create({ data: {
      ownerId: userId, name: "Avery", gender: "female", style: "realistic", step: 3,
      appearance: { prompt: "Freckles" }, hair: {}, body: {}, tags: [],
      advancedDetails: { age: 25, description: "A warm companion", firstMessage: "Hello there." },
    } });
    const candidates = [];
    for (const index of [1, 2]) {
      const preview = await prisma.characterPreviewJob.create({ data: { draftId: draft.id, status: "running" } });
      const request = await recordPreviewInput(draft.id, preview.id, userId);
      await prisma.generationJob.update({ where: { id: request.id }, data: { status: "running" } });
      const asset = await prisma.mediaAsset.create({ data: {
        id: `${prefix}late-candidate-${index}`, sourceJobId: request.id, ownerId: userId,
        type: "image", url: `/user-content/late-candidate-${index}.png`, storageKey: `${prefix}late-candidate-${index}.png`,
        visibility: "private", safetyStatus: "passed", metadata: { synthetic: false },
      } });
      candidates.push({ preview, request, asset });
    }
    const first = candidates[0]!;
    const second = candidates[1]!;
    const complete = (requestId: string) => prisma.$transaction(tx => transitionGenerationRequest(tx, {
      requestId, to: "completed", data: { completedAt: new Date() },
    }));
    await complete(first.request.id);
    const beforeConfirmation = await api("GET", "character-drafts/current", { userId, ageGate: true });
    expectOk(beforeConfirmation);
    expect(beforeConfirmation.data.draft.previewJobId).toBeNull();
    const unconfirmedSubmit = await api("POST", `character-drafts/${draft.id}/submit`, {
      userId, ageGate: true, body: { visibility: "private" },
    });
    expectError(unconfirmedSubmit, 400, "bad_request");
    expect(await prisma.character.count({ where: { creatorId: userId } })).toBe(0);
    expectOk(await api("POST", `character-drafts/${draft.id}/preview-anchor`, {
      userId, ageGate: true, body: { previewJobId: first.preview.id },
    }));
    await complete(second.request.id);
    // Duplicate terminal delivery must not change the user's selection either.
    await complete(second.request.id);
    expect((await prisma.characterDraft.findUniqueOrThrow({ where: { id: draft.id } })).previewJobId).toBe(first.preview.id);
    expect((await prisma.characterPreviewJob.findUniqueOrThrow({ where: { id: second.preview.id } })).resultAssetId).toBe(second.asset.id);
    const savedStep = await api("PATCH", `character-drafts/${draft.id}`, {
      userId, ageGate: true, body: { step: 4, appearance: { prompt: "Freckles" }, hair: {}, body: {} },
    });
    expectOk(savedStep);
    expect(savedStep.data.draft.previewJobId).toBe(first.preview.id);
    const submitted = await api("POST", `character-drafts/${draft.id}/submit`, {
      userId, ageGate: true, body: { visibility: "private" },
    });
    expectOk(submitted);
    const character = await prisma.character.findUniqueOrThrow({ where: { id: submitted.data.character.id } });
    expect(character.imageAssetId).toBe(first.asset.id);
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: first.asset.id } })).characterId).toBe(character.id);
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: second.asset.id } })).characterId).toBeNull();
  });

  it("preserves face, hair and body in the Character, content snapshot and active visual profile", async () => {
    const userId = `${prefix}owner`;
    await createUser({ id: userId });
    const created = await api("POST", "character-drafts", { userId, ageGate: true, body: { name: "Avery", age: 25, gender: "female", style: "realistic" } });
    expectOk(created);
    const draftId = created.data.draft.id as string;
    const selection = { provider: "pocket_tts", voiceId: "marius" } as const;
    const prepared: draftVoice.PreparedCharacterDraftVoice = {
      userId, draftId, provider: "pocket_tts", presetVoiceId: "marius", voiceId: `${prefix}alias`,
      model: "pocket-tts", language: "english", delivery: DEFAULT_FISH_AUDIO_DELIVERY, sampleText: "Hello.",
      reference: { id: `${prefix}reference`, key: `${prefix}reference.json`, sizeBytes: 24, sha256: "a".repeat(64) },
      preview: { id: `${prefix}voice-preview`, key: `${prefix}voice-preview.wav`, durationMs: 1000 },
    };
    const prepare = vi.spyOn(draftVoice, "prepareCharacterDraftVoice").mockResolvedValue(prepared);
    const appearance = { prompt: "Freckles", eyes: "Hazel", ethnicity: "Latina", skinTone: "Olive", faceShape: "Oval" };
    const hair = { prompt: "Short auburn curls" };
    const body = { type: "Athletic" };
    const patched = await api("PATCH", `character-drafts/${draftId}`, { userId, ageGate: true, body: {
      appearance, hair, body,
      advancedDetails: { description: "A warm radio host", firstMessage: "Welcome back.", detailsMarkdown: "## Occupation\nRadio host\n\n## Relationship\nChildhood friend", voiceSelection: selection },
    } });
    expectOk(patched);
    const resumed = await api("GET", "character-drafts/current", { userId, ageGate: true });
    expectOk(resumed);
    expect(resumed.data.draft.advancedDetails.voiceSelection).toEqual(selection);
    const anchor = await prisma.mediaAsset.create({ data: {
      id: `${prefix}anchor`, ownerId: userId, type: "image", url: "/user-content/create-authoring.png", storageKey: `${prefix}anchor.png`,
      visibility: "private", safetyStatus: "passed", metadata: { synthetic: false },
    } });
    const preview = await prisma.characterPreviewJob.create({ data: { draftId, status: "completed", provider: "test", resultAssetId: anchor.id, completedAt: new Date() } });
    await recordPreviewInput(draftId, preview.id, userId);
    const confirmed = await api("POST", `character-drafts/${draftId}/preview-anchor`, {
      userId, ageGate: true, body: { previewJobId: preview.id },
    });
    expectOk(confirmed);
    for (const step of [4, 5]) {
      const saved = await api("PATCH", `character-drafts/${draftId}`, {
        userId, ageGate: true, body: { step, appearance, hair, body },
      });
      expectOk(saved);
      expect(saved.data.draft.previewJobId).toBe(preview.id);
    }
    const submitted = await api("POST", `character-drafts/${draftId}/submit`, { userId, ageGate: true, body: { visibility: "private" } });
    expectOk(submitted);
    const characterId = submitted.data.character.id as string;
    const [character, visual, content] = await Promise.all([
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
      prisma.characterVisualProfile.findFirstOrThrow({ where: { characterId, status: "active" } }),
      prisma.characterContentVersion.findFirstOrThrow({ where: { characterId } }),
    ]);
    expect(character.appearance).toEqual({ ...appearance, hair, body });
    expect(content.appearanceSnapshot).toEqual({ style: "realistic", appearance: { ...appearance, hair, body } });
    expect(visual.faceTraits).toEqual(appearance);
    expect(visual.hairTraits).toEqual(hair);
    expect(visual.bodyTraits).toEqual(body);
    expect(visual.identityPrompt).toContain("Short auburn curls");
    expect(visual.identityPrompt).toContain("Athletic");
    expect(character.systemPrompt).toContain("## Occupation\nRadio host");
    expect(character.systemPrompt).toContain("## Relationship\nChildhood friend");
    expect(prepare).toHaveBeenCalledWith({ ...selection, userId, draftId });
    expect(character.voiceId).toBe(prepared.voiceId);
    expect(await resolveCharacterVoiceAuthority({ characterId, voiceId: character.voiceId, gender: character.gender })).toMatchObject({
      providerKey: "pocket_tts", voiceId: prepared.voiceId, source: "character_clone", characterVoiceProfileVersion: 1,
    });
    const replay = await api("POST", `character-drafts/${draftId}/submit`, { userId, ageGate: true, body: { visibility: "private" } });
    expectOk(replay);
    expect(replay.data.character.id).toBe(characterId);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await prisma.characterVoiceProfile.count({ where: { characterId, status: "active" } })).toBe(1);
    const library = await api("GET", "library/media", { userId, ageGate: true, query: { type: "voice" } });
    expectOk(library);
    expect(library.data.items.map((item: { id: string }) => item.id)).toContain(prepared.preview.id);
    expect(library.data.items.map((item: { id: string }) => item.id)).not.toContain(prepared.reference.id);
    const recent = await api("GET", "library/recent", { userId, ageGate: true });
    expectOk(recent);
    expect(recent.data.items.map((item: { id: string }) => item.id)).toContain(prepared.preview.id);
    expect(recent.data.items.map((item: { id: string }) => item.id)).not.toContain(prepared.reference.id);
  });

  it("keeps the identity across voice changes before and after confirmation but rejects real trait changes", async () => {
    const userId = `${prefix}preview-match-owner`;
    await createUser({ id: userId });
    const draft = await prisma.characterDraft.create({ data: {
      ownerId: userId, name: "Avery", gender: "female", style: "realistic", step: 3,
      appearance: { prompt: "Freckles", eyes: "Hazel" }, hair: {}, body: {}, tags: [],
      advancedDetails: { age: 25, description: "", detailsMarkdown: "", firstMessage: "", voiceSelection: { provider: "pocket_tts", voiceId: "marius" } },
    } });
    const asset = await prisma.mediaAsset.create({ data: {
      id: `${prefix}matching-anchor`, ownerId: userId, type: "image", url: "/user-content/matching.png", visibility: "private", safetyStatus: "passed", metadata: { synthetic: false },
    } });
    const preview = await prisma.characterPreviewJob.create({ data: { draftId: draft.id, status: "completed", resultAssetId: asset.id, completedAt: new Date() } });
    await recordPreviewInput(draft.id, preview.id, userId);
    const restored = await api("GET", "character-drafts/current", { userId, ageGate: true });
    expectOk(restored);
    expect(restored.data.previewJob.id).toBe(preview.id);
    // This durable prompt predates voice exclusion. Changing the preset must
    // still allow its existing image to be confirmed without generating again.
    expectOk(await api("PATCH", `character-drafts/${draft.id}`, { userId, ageGate: true, body: {
      advancedDetails: { voiceSelection: { provider: "pocket_tts", voiceId: "alba" } },
    } }));
    expectOk(await api("POST", `character-drafts/${draft.id}/preview-anchor`, { userId, ageGate: true, body: { previewJobId: preview.id } }));
    const voiceChanged = await api("PATCH", `character-drafts/${draft.id}`, { userId, ageGate: true, body: { advancedDetails: { voiceSelection: null } } });
    expectOk(voiceChanged);
    expect(voiceChanged.data.draft.previewJobId).toBe(preview.id);
    const voiceRestored = await api("GET", "character-drafts/current", { userId, ageGate: true });
    expectOk(voiceRestored);
    expect(voiceRestored.data.previewJob.id).toBe(preview.id);
    const changed = await api("PATCH", `character-drafts/${draft.id}`, { userId, ageGate: true, body: { appearance: { prompt: "Freckles", eyes: "Blue" } } });
    expectOk(changed);
    expect(changed.data.draft.previewJobId).toBeNull();
    const stale = await api("GET", "character-drafts/current", { userId, ageGate: true });
    expectOk(stale);
    expect(stale.data.previewJob).toBeNull();
    expect(stale.data.asset).toBeNull();
    expectError(await api("POST", `character-drafts/${draft.id}/preview-anchor`, { userId, ageGate: true, body: { previewJobId: preview.id } }), 400, "bad_request");
  });

  it("projects only the latest Attempt execution into preview reads without changing durable preview state", async () => {
    const userId = `${prefix}progress-owner`;
    await createUser({ id: userId });
    const draft = await prisma.characterDraft.create({ data: { ownerId: userId, name: "Avery", appearance: {}, hair: {}, body: {}, tags: [], advancedDetails: { age: 25 } } });
    const preview = await prisma.characterPreviewJob.create({ data: { draftId: draft.id, status: "queued" } });
    const job = await recordPreviewInput(draft.id, preview.id, userId);
    const attempt = await prisma.generationAttempt.create({ data: { requestId: job.id, attemptNo: 1, status: "queued" } });
    const readStatus = async () => {
      const polled = await api("GET", `character-drafts/${draft.id}/preview`, { userId, ageGate: true, query: { previewJobId: preview.id } });
      const current = await api("GET", "character-drafts/current", { userId, ageGate: true });
      expectOk(polled); expectOk(current);
      expect(current.data.previewJob.status).toBe(polled.data.previewJob.status);
      return polled.data.previewJob.status;
    };
    expect(await readStatus()).toBe("queued");
    await prisma.generationAttempt.update({ where: { id: attempt.id }, data: { status: "running" } });
    expect(await readStatus()).toBe("running");
    expect((await prisma.characterPreviewJob.findUniqueOrThrow({ where: { id: preview.id } })).status).toBe("queued");
    const retry = await prisma.generationAttempt.create({ data: { requestId: job.id, attemptNo: 2, status: "queued" } });
    expect(await readStatus()).toBe("queued");
    await prisma.generationAttempt.update({ where: { id: retry.id }, data: { status: "running" } });
    for (const status of ["completed", "failed"]) {
      await prisma.characterPreviewJob.update({ where: { id: preview.id }, data: { status } });
      expect(await readStatus()).toBe(status);
    }
  });

  it("rolls back the Character and voice together if submission fails after binding", async () => {
    const userId = `${prefix}rollback-owner`;
    await createUser({ id: userId });
    const draft = await prisma.characterDraft.create({ data: {
      ownerId: userId, name: "Avery", gender: "female", style: "realistic", appearance: {}, hair: {}, body: {}, tags: [],
      advancedDetails: { age: 25, description: "A warm companion", firstMessage: "Hello.", voiceSelection: { provider: "pocket_tts", voiceId: "marius" } },
    } });
    const anchor = await prisma.mediaAsset.create({ data: {
      id: `${prefix}rollback-anchor`, ownerId: userId, type: "image", url: "/user-content/anchor.png", storageKey: `${prefix}rollback-anchor.png`,
      visibility: "private", safetyStatus: "passed", metadata: { synthetic: false },
    } });
    const preview = await prisma.characterPreviewJob.create({ data: { draftId: draft.id, status: "completed", provider: "test", resultAssetId: anchor.id, completedAt: new Date() } });
    await prisma.characterDraft.update({ where: { id: draft.id }, data: { previewJobId: preview.id } });
    const prepared: draftVoice.PreparedCharacterDraftVoice = {
      userId, draftId: draft.id, provider: "pocket_tts", presetVoiceId: "marius", voiceId: `${prefix}rollback-alias`,
      model: "pocket-tts", language: "english", delivery: DEFAULT_FISH_AUDIO_DELIVERY, sampleText: "Hello.",
      reference: { id: `${prefix}rollback-reference`, key: `${prefix}rollback-reference.json`, sizeBytes: 24, sha256: "a".repeat(64) },
      preview: { id: `${prefix}rollback-voice-preview`, key: `${prefix}rollback-voice-preview.wav`, durationMs: 1000 },
    };
    vi.spyOn(draftVoice, "prepareCharacterDraftVoice").mockResolvedValue(prepared);
    const bind = draftVoice.bindCharacterDraftVoice;
    vi.spyOn(draftVoice, "bindCharacterDraftVoice").mockImplementation(async (...args) => { await bind(...args); throw new Error("Voice binding confirmation failed"); });
    const cleanup = vi.spyOn(draftVoice, "cleanupPreparedCharacterDraftVoice").mockResolvedValue(undefined);
    const result = await api("POST", `character-drafts/${draft.id}/submit`, { userId, ageGate: true, body: { visibility: "private" } });
    expect(result.status).toBe(500);
    expect(await prisma.character.count({ where: { creatorId: userId } })).toBe(0);
    expect(await prisma.characterVoiceProfile.count({ where: { providerVoiceId: prepared.voiceId } })).toBe(0);
    expect(await prisma.mediaAsset.count({ where: { id: { in: [prepared.reference.id, prepared.preview.id] } } })).toBe(0);
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: anchor.id } })).characterId).toBeNull();
    expect(cleanup).toHaveBeenCalledWith(prepared);
    expect((await prisma.characterDraft.findUniqueOrThrow({ where: { id: draft.id } })).advancedDetails).not.toHaveProperty("submittedCharacterId");
  });

  it("serves catalog choices and requires a signed-in user for a fixed-text voice preview", async () => {
    const catalog = { provider: "pocket_tts" as const, defaultVoiceId: "alba", items: [{ id: "marius", label: "Marius", description: "Official English voice" }] };
    vi.spyOn(draftVoice, "getCharacterDraftVoiceCatalog").mockResolvedValue(catalog);
    const preview = vi.spyOn(draftVoice, "previewCharacterDraftVoice").mockResolvedValue({ voiceId: "marius", contentType: "audio/wav", audioBase64: "UklGRg==", durationMs: 1000 });
    const listed = await api("GET", "character-voices", { ageGate: true });
    expectOk(listed);
    expect(listed.data).toEqual(catalog);
    const anonymous = await api("POST", "character-voices/preview", { ageGate: true, body: { provider: "pocket_tts", voiceId: "marius" } });
    expectError(anonymous, 401, "unauthorized");
    expect(preview).not.toHaveBeenCalled();
    const userId = `${prefix}preview-user`;
    await createUser({ id: userId });
    const played = await api("POST", "character-voices/preview", { userId, ageGate: true, body: { provider: "pocket_tts", voiceId: "marius" } });
    expectOk(played);
    expect(played.data.voiceId).toBe("marius");
    expect(preview).toHaveBeenCalledWith({ provider: "pocket_tts", voiceId: "marius", text: "Hello, it's good to meet you. I'm happy we can spend some time together." });
    const arbitraryText = await api("POST", "character-voices/preview", { userId, ageGate: true, body: { provider: "pocket_tts", voiceId: "marius", text: "Not a catalog sample" } });
    expectError(arbitraryText, 400, "bad_request");
    expect(preview).toHaveBeenCalledTimes(1);
  });
});
