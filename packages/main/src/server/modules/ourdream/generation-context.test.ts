import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import { characterContentHash } from "@/server/modules/admin-v2/shared/character-content-identity";

const db = vi.hoisted(() => ({
  chatTurn: { findFirst: vi.fn() }, character: { findFirst: vi.fn() },
  characterContentVersion: { findUnique: vi.fn() }, characterRelease: { findUnique: vi.fn(), findFirst: vi.fn() },
  characterProject: { findUnique: vi.fn(), findMany: vi.fn() }, characterServing: { findUnique: vi.fn() },
  characterVisualProfile: { findFirst: vi.fn() }, referenceSetRevision: { findFirst: vi.fn() },
  comic: { findUnique: vi.fn() }, generationJob: { findFirst: vi.fn() }, mediaAsset: { findFirst: vi.fn() },
}));
vi.mock("@/server/lib/db", () => ({ prisma: db }));
vi.mock("@/server/lib/env", () => ({ env: { BETTER_AUTH_SECRET: "handoff-test-secret-no-provider" } }));

import { applyGenerationContext, generationContextSource, loadGenerationContext, readGenerationContextToken, resolveGenerationContext, signGenerationContext } from "./generation-context";
import { generationJobSchema } from "./generation-request-schema";
import { buildGenerationPrompt } from "./generation-prompt";

const selector = { kind: "chat" as const, sessionId: "session-original", turnId: "turn-original", attempt: 2 };
const scene = { schemaVersion: 1, version: 4, location: "blue kitchen", time: "morning", participants: ["Cedar"], emotionalBeat: "quiet conversation", unresolvedThreads: [] };
const soul = compileCharacterSoul({ name: "Original companion", age: 25, gender: "female", characterPromise: "A curious companion", detailsMarkdown: "Calm and thoughtful." });
if (!soul.ok) throw new Error("Invalid test Soul");
const contentValues = { personaSnapshot: soul.snapshot, openingSnapshot: {}, appearanceSnapshot: { style: "realistic", identityAnchor: "short auburn hair" } };
const content = { id: "content-original", characterId: "character-1", contentHash: characterContentHash(contentValues), ...contentValues };

function originalTurn() {
  return { id: selector.turnId, sessionId: selector.sessionId, attempt: 2, assistantStatus: "sent", userContent: "Stay by the blue window.", assistantContent: "I stay here with Cedar.",
    characterContentVersionId: content.id, characterReleaseId: "release-original", characterVisualProfileId: "visual-original", characterVisualProfileVersion: 3,
    sceneVersion: scene.version, scene: structuredClone(scene), createdAt: new Date("2026-09-09T12:00:00.000Z"),
    session: { userId: "user-original", characterId: "character-1", status: "active" },
    executionSnapshot: { version: 1, turnId: selector.turnId, sessionId: selector.sessionId, userMessageId: "user-message", assistantMessageId: "assistant-message", attempt: 2,
      userId: "user-original", characterId: "character-1", characterContentVersionId: content.id, characterReleaseId: "release-original", characterVisualProfileId: "visual-original", characterVisualProfileVersion: 3,
      memoryEnabled: true, contextRevision: 1, userContent: "Stay by the blue window.", recentTurns: [], sceneVersion: 0, scene: null },
    attachments: [{ id: "attachment-1", status: "completed", mediaAssetId: "image-original", generationJobId: "job-original", promptHint: "an earlier draft", metadata: { attempt: 2 } }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.chatTurn.findFirst.mockResolvedValue(originalTurn());
  db.character.findFirst.mockResolvedValue({ id: "character-1", name: "New name", age: 30, gender: "male", description: "new mutable description" });
  db.characterContentVersion.findUnique.mockResolvedValue(content);
  db.characterRelease.findUnique.mockResolvedValue({ id: "release-original", projectId: "project-1", characterContentVersionId: content.id, snapshotHash: "release-original-hash", status: "superseded", legacy: false, visualProfileId: "visual-original", visualProfileVersion: 3, referenceSetRevisionId: "references-original" });
  db.characterProject.findUnique.mockResolvedValue({ characterId: "character-1" });
  db.characterVisualProfile.findFirst.mockResolvedValue({ id: "visual-original", version: 3, immutableHash: "visual-original-hash", status: "archived" });
  db.generationJob.findFirst.mockResolvedValue({ id: "job-original", visualProfileId: "visual-original", visualProfileVersion: 3, referenceSetRevisionId: "references-original", momentSpec: { rawInput: "Cedar sits beside the blue kitchen window." } });
  db.mediaAsset.findFirst.mockResolvedValue({ id: "image-original", sourceJobId: "job-original", ownerId: "user-original", type: "image", safetyStatus: "passed", deletedAt: null, metadata: {}, url: "/media/image.png", storageKey: "owned/image.png" });
});

async function issued(input = selector) {
  const handoff = await loadGenerationContext("user-original", input);
  const token = signGenerationContext({ version: 2, userId: "user-original", source: input, digest: handoff.digest });
  return { handoff, token };
}

describe("Chat to Generate authority", () => {
  it("continues the original completed scene and immutable character after a newer Release", async () => {
    const { handoff, token } = await issued();
    expect(handoff.character).toMatchObject({ name: "Original companion", age: 25, gender: "female", description: "A curious companion" });
    expect(handoff.prompt).toContain("Location: blue kitchen");
    expect(handoff.pins).toMatchObject({ characterReleaseId: "release-original", visualProfileId: "visual-original", visualProfileVersion: 3, referenceSetRevisionId: "references-original" });
    expect(await resolveGenerationContext("user-original", token)).toMatchObject({ digest: handoff.digest });
    expect(db.chatTurn.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ session: { userId: "user-original", status: { not: "deleted" } } }) }));
  });

  it("restores the exact delivered image and accepted brief, not the latest portrait", async () => {
    const input = { ...selector, mediaAssetId: "image-original" };
    const { handoff, token } = await issued(input);
    const body = applyGenerationContext(generationJobSchema.parse({ mode: "image", characterId: "character-1", chatHandoffToken: token }), handoff);
    expect(handoff.prompt).toBe("Cedar sits beside the blue kitchen window.");
    expect(handoff.sourceMedia?.id).toBe("image-original");
    expect(body).toMatchObject({ visualProfileId: "visual-original", controls: { sourceImageAssetId: "image-original" }, prompt: handoff.prompt });
    expect(generationContextSource(handoff, token, "same-request")).toMatchObject({ sourceType: "chat_handoff", sourceMeta: { exchangeId: selector.turnId, attempt: 2, sourceMediaId: "image-original", sourceGenerationJobId: "job-original" } });
    expect(db.mediaAsset.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ sourceJobId: "job-original", ownerId: "user-original" }) });
  });

  it("keeps refresh tokens deterministic and rejects tampering or another viewer", async () => {
    const first = await issued();
    expect((await issued()).token).toBe(first.token);
    expect(() => readGenerationContextToken(first.token, "other-user")).toThrow("another account");
    expect(() => readGenerationContextToken(`${first.token.slice(0, -4)}AAAA`, "user-original")).toThrow("invalid");
    expect(Buffer.from(first.token.split(".")[0]!, "base64url").toString()).not.toContain("blue kitchen");
  });

  it("refuses a revised attempt, removed Turn, or withdrawn Release instead of switching versions", async () => {
    const { token } = await issued();
    db.chatTurn.findFirst.mockResolvedValueOnce({ ...originalTurn(), attempt: 3 });
    await expect(resolveGenerationContext("user-original", token)).rejects.toThrow("changed or is still running");
    db.chatTurn.findFirst.mockResolvedValueOnce(null);
    await expect(resolveGenerationContext("user-original", token)).rejects.toThrow("no longer available");
    db.characterRelease.findUnique.mockResolvedValueOnce({ id: "release-original", projectId: "project-1", characterContentVersionId: content.id, status: "withdrawn" });
    await expect(resolveGenerationContext("user-original", token)).rejects.toThrow("Release is unavailable");
  });

  it("rejects source drift even when the caller retains the same Turn id and attempt", async () => {
    const { token } = await issued();
    db.chatTurn.findFirst.mockResolvedValueOnce({ ...originalTurn(), scene: { ...scene, location: "a different room" } });
    await expect(resolveGenerationContext("user-original", token)).rejects.toThrow("context changed");
  });

  it("rejects an unrelated or stale attachment and another account's missing asset", async () => {
    await expect(loadGenerationContext("user-original", { ...selector, mediaAssetId: "foreign-image" })).rejects.toThrow("available delivery");
    db.chatTurn.findFirst.mockResolvedValueOnce({ ...originalTurn(), attachments: [{ ...originalTurn().attachments[0], metadata: { attempt: 1 } }] });
    await expect(loadGenerationContext("user-original", { ...selector, mediaAssetId: "image-original" })).rejects.toThrow("available delivery");
    db.mediaAsset.findFirst.mockResolvedValueOnce(null);
    await expect(loadGenerationContext("user-original", { ...selector, mediaAssetId: "image-original" })).rejects.toThrow("available delivery");
  });

  it("rejects forged visual pins and target changes while accepting explicit prompt edits", async () => {
    const { handoff, token } = await issued();
    const body = generationJobSchema.parse({ characterId: "character-1", chatHandoffToken: token, prompt: "Turn toward the window." });
    expect(applyGenerationContext(body, handoff).prompt).toBe("Turn toward the window.");
    expect(() => applyGenerationContext({ ...body, visualProfileId: "visual-new" }, handoff)).toThrow("original character");
    expect(() => applyGenerationContext({ ...body, characterId: "another-character" }, handoff)).toThrow("original character");
    expect(() => applyGenerationContext({ ...body, mode: "video" }, handoff)).toThrow("original character");
    expect(() => generationJobSchema.parse({ characterId: "character-1", chatHandoffToken: token, controls: { sourceImageAssetId: "foreign-image" } })).toThrow();
  });

  it("does not truncate a handoff image direction or drop its source-edit semantics", async () => {
    const { handoff } = await issued();
    expect(() => applyGenerationContext(generationJobSchema.parse({ characterId: "character-1", prompt: "x".repeat(901) }), handoff)).toThrow("900 characters");
    const prompt = buildGenerationPrompt({ mode: "image", character: handoff.character, visualProfile: null, consistencyMode: "strict", userPrompt: "Raise the left hand only.", presetFragment: "", lookFragment: "", sourceType: "chat_handoff", sourceImageAssetId: "image-original" });
    expect(prompt).toContain("Preserve its composition");
    expect(prompt).toContain("Raise the left hand only.");
  });

  it("refuses corrupt immutable content instead of borrowing mutable Character columns", async () => {
    db.characterContentVersion.findUnique.mockResolvedValueOnce({ ...content, appearanceSnapshot: { style: "tampered" } });
    await expect(loadGenerationContext("user-original", selector)).rejects.toThrow("current version cannot replace");
  });

  it("does not turn an ordinary chat command into an image brief when the Scene has no facts", async () => {
    db.chatTurn.findFirst.mockResolvedValueOnce({ ...originalTurn(), userContent: "Say hello in one sentence.", scene: { ...scene, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] } });
    const { handoff } = await issued();
    expect(handoff.prompt).toBe("");
    // Empty direction may still be priced; admission requires an explicit input.
    expect(applyGenerationContext(generationJobSchema.parse({ characterId: "character-1" }), handoff).prompt).toBe("");
  });
});

const comicSelector = { kind: "comic" as const, comicId: "published-comic", comicVersion: 4, pageId: "published-page" };
function publishedComic() {
  return { id: comicSelector.comicId, creatorId: "comic-author", title: "A night journey", description: "Author-published story", version: 4,
    status: "published", visibility: "unlisted", allowRemix: true,
    creator: { id: "comic-author", status: "active", role: "user", dataClass: "customer", deletedAt: null },
    episodes: [{ id: "chapter", title: "At the station", pages: [{ id: "published-page", mediaAssetId: "comic-image", caption: "Keep the scene. Turn the lamp on.",
      mediaAsset: { id: "comic-image", ownerId: "comic-author", characterId: "character-1", sourceJobId: "private-author-job", type: "image", deletedAt: null,
        safetyStatus: "passed", metadata: {}, storageKey: "author/image.webp", url: "/private-media/image.webp", prompt: "PRIVATE_AUTHOR_IMAGE_PROMPT" } }] }] };
}

describe("GenerationContext source isolation", () => {
  it("reads the persisted v1 token format without changing the old selector digest", async () => {
    const current = await loadGenerationContext("user-original", selector);
    const encoded = Buffer.from(JSON.stringify({ sessionId: selector.sessionId, turnId: selector.turnId, attempt: 2,
      version: 1, userId: "user-original", digest: current.digest })).toString("base64url");
    const signature = createHmac("sha256", "handoff-test-secret-no-provider").update(`generation-handoff-v1:${encoded}`).digest("base64url");
    expect(await resolveGenerationContext("user-original", `${encoded}.${signature}`)).toMatchObject({ source: selector, digest: current.digest });
    expect(() => generationJobSchema.parse({ characterId: "character-1", generationContextToken: "new", chatHandoffToken: "old" })).toThrow("one generation context token");
  });

  it("uses only published Comic direction and never loads a private source Character's content", async () => {
    db.comic.findUnique.mockResolvedValue(publishedComic());
    db.character.findFirst.mockResolvedValue(null);
    const context = await loadGenerationContext("remix-reader", comicSelector);
    expect(context).toMatchObject({ identityMode: "source_only", character: null, characterId: null, pins: null, scene: null,
      prompt: "Keep the scene. Turn the lamp on.", sourceMedia: { id: "comic-image" } });
    expect(db.characterContentVersion.findUnique).not.toHaveBeenCalled();
    expect(db.generationJob.findFirst).not.toHaveBeenCalled();
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE_AUTHOR_IMAGE_PROMPT|private-author-job|curious companion/);
    const body = applyGenerationContext(generationJobSchema.parse({ freeplay: true }), context);
    expect(body).toMatchObject({ freeplay: true, controls: { sourceImageAssetId: "comic-image" } });
    expect(() => applyGenerationContext(generationJobSchema.parse({ characterId: "character-1" }), context)).toThrow("original character or source image");
  });

  it("requires explicit remix permission and revokes tokens when their publication or version changes", async () => {
    const comic = publishedComic(); db.comic.findUnique.mockResolvedValue(comic); db.character.findFirst.mockResolvedValue(null);
    const context = await loadGenerationContext("remix-reader", comicSelector);
    const token = signGenerationContext({ version: 2, userId: "remix-reader", source: comicSelector, digest: context.digest, comicGrant: { mediaAssetId: "comic-image", allowRemix: true } });
    db.comic.findUnique.mockResolvedValueOnce({ ...comic, allowRemix: false });
    await expect(resolveGenerationContext("remix-reader", token)).rejects.toThrow("has not enabled remixing");
    db.comic.findUnique.mockResolvedValueOnce({ ...comic, version: 5 });
    await expect(resolveGenerationContext("remix-reader", token)).rejects.toThrow("version changed");
    db.comic.findUnique.mockResolvedValueOnce({ ...comic, status: "withdrawn" });
    await expect(resolveGenerationContext("remix-reader", token)).rejects.toThrow("no longer available");
    await expect(resolveGenerationContext("another-reader", token)).rejects.toThrow("another account");
  });

  it("pins public Character identity without reading the source generation prompt and refuses an implicit switch to source-only", async () => {
    db.comic.findUnique.mockResolvedValue(publishedComic());
    db.characterProject.findMany.mockResolvedValue([{ id: "project-1" }]);
    db.characterRelease.findFirst.mockResolvedValue({ id: "release-original", characterContentVersionId: content.id, snapshotHash: "release-hash" });
    db.referenceSetRevision.findFirst.mockResolvedValue({ id: "references-original", snapshotHash: "reference-hash" });
    const context = await loadGenerationContext("remix-reader", comicSelector);
    expect(context).toMatchObject({ identityMode: "character", characterId: "character-1", pins: { visualProfileId: "visual-original", referenceSetRevisionId: "references-original", characterReleaseId: "release-original" } });
    expect(db.generationJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ select: { visualProfileId: true, visualProfileVersion: true, referenceSetRevisionId: true } }));
    expect(context.prompt).toBe("Keep the scene. Turn the lamp on.");
    const token = signGenerationContext({ version: 2, userId: "remix-reader", source: comicSelector, digest: context.digest, comicGrant: { mediaAssetId: "comic-image", allowRemix: true } });
    db.character.findFirst.mockResolvedValue(null);
    await expect(resolveGenerationContext("remix-reader", token)).rejects.toThrow("context changed");
  });
});
