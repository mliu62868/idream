import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { proxyChatRequest } from "@/server/bff/chat-proxy";
import { createChatSession } from "./turn-ledger";
import { compileUserCharacterContent, materializeUserCharacterContentVersion } from "@/server/modules/ourdream/character-soul";
import { createUser, createCharacter, purgeTestData } from "@/server/test/helpers";
const prefix = "zt-voice-input-";
const userId = `${prefix}owner`, outsider = `${prefix}outsider`;
let sessionId: string, groupId: string;
const previous = { provider: env.ASR_PROVIDER, token: env.PARAKEET_ASR_API_TOKEN };
function request(method: string, path: string, options: { user?: string; scope?: string; key?: string; audio?: boolean; recipient?: string | null } = {}) {
  const actor = options.user ?? userId;
  const form = new FormData();
  form.append("audio", new Blob(["test-audio"], { type: "audio/webm" }), "clip.webm");
  return new Request(`http://localhost/api/v1/chat/${path}`, { method, headers: { "x-idream-user-id": actor, "x-idream-viewer-scope": options.scope ?? `user:${actor}`, ...(options.key ? { "idempotency-key": options.key } : {}), ...(path.startsWith("groups/") && options.recipient !== null ? { "x-idream-voice-character-id": options.recipient ?? `${prefix}character` } : {}) }, ...(options.audio ? { body: form } : {}) });
}
async function run(req: Request) { return proxyChatRequest(req, new URL(req.url).pathname.split("/").slice(3)); }
beforeAll(async () => {
  await purgeTestData(prefix);
  await createUser({ id: userId }); await createUser({ id: outsider });
  await prisma.ageGateAcceptance.create({ data: { userId } });
  await prisma.ageGateAcceptance.create({ data: { userId: outsider } });
  const character = await createCharacter({ id: `${prefix}character`, creatorId: userId, source: "user", visibility: "private" });
  await prisma.$transaction(async tx => {
    const version = await materializeUserCharacterContentVersion({ tx, characterId: character.id, sourceId: null, createdById: userId, content: compileUserCharacterContent(character) });
    await tx.character.update({ where: { id: character.id }, data: { currentContentVersionId: version.id } });
  });
  sessionId = (await createChatSession(userId, { characterId: `${prefix}character` })).id;
  groupId = `${prefix}group`;
  await prisma.groupConversation.create({ data: { id: groupId, userId, title: "Voice input group" } });
  const originalSession = await prisma.recentChat.findUniqueOrThrow({ where: { sessionId } });
  await prisma.recentChat.create({ data: { sessionId: `${prefix}group-member`, userId, groupId, characterId: originalSession.characterId, characterContentVersionId: originalSession.characterContentVersionId } });
  env.ASR_PROVIDER = "parakeet-redux"; env.PARAKEET_ASR_API_TOKEN = "integration-test-token";
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { env.ASR_PROVIDER = previous.provider; env.PARAKEET_ASR_API_TOKEN = previous.token; await purgeTestData(prefix); await prisma.$disconnect(); });
describe("Main voice input authority", () => {
  it("reads actual gateway capability independently of Chat availability", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ready: true, model: "moondream/parakeet-redux", modelRevision: "2bf128600aac4b16946f7ed8372e56117fe5e23b", runtimeVersion: "2.6.1" })));
    const response = await run(request("GET", `sessions/${sessionId}/voice-input`));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ supported: true, available: true, ownerScope: `user:${userId}`, languages: ["en"] });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("handles multipart before JSON and creates no Turn or charges", async () => {
    const id = randomUUID();
    const turns = await prisma.chatTurn.count({ where: { sessionId } });
    const charges = await prisma.dreamcoinLedger.count({ where: { userId } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ requestId: id, status: "completed", text: "Hello there", audioDurationMs: 500, expiresAt: Date.now() + 120_000 })));
    const response = await run(request("POST", `sessions/${sessionId}/transcriptions`, { key: id, audio: true }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.text).toBe("Hello there");
    expect(await prisma.chatTurn.count({ where: { sessionId } })).toBe(turns);
    expect(await prisma.dreamcoinLedger.count({ where: { userId } })).toBe(charges);
  });
  it("rejects foreign sessions and stale viewer scopes before contacting the model", async () => {
    const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    expect((await run(request("GET", `sessions/${sessionId}/voice-input`, { user: outsider }))).status).toBe(404);
    expect((await run(request("GET", `sessions/${sessionId}/voice-input`, { scope: `user:${outsider}` }))).status).toBe(409);
    expect(mock).not.toHaveBeenCalled();
  });
  it("uses group authority and supports DELETE before POST", async () => {
    const id = randomUUID();
    const mock = vi.fn().mockResolvedValue(Response.json({ requestId: id, status: "cancelled" })); vi.stubGlobal("fetch", mock);
    expect((await run(request("DELETE", `groups/${groupId}/transcriptions/${id}`))).status).toBe(200);
    expect(mock.mock.calls[0][1].headers["x-asr-conversation-id"]).toBe(`group:${groupId}`);
  });
  it("checks the selected group recipient before microphone capability or transcription", async () => {
    const mock = vi.fn().mockResolvedValue(Response.json({ ready: true, model: "moondream/parakeet-redux", modelRevision: "2bf128600aac4b16946f7ed8372e56117fe5e23b", runtimeVersion: "2.6.1" })); vi.stubGlobal("fetch", mock);
    expect((await run(request("GET", `groups/${groupId}/voice-input`, { recipient: null }))).status).toBe(400);
    expect((await run(request("GET", `groups/${groupId}/voice-input`, { recipient: `${prefix}not-member` }))).status).toBe(404);
    expect(mock).not.toHaveBeenCalled();
    await prisma.recentChat.update({ where: { sessionId: `${prefix}group-member` }, data: { status: "archived" } });
    try {
      expect((await run(request("POST", `groups/${groupId}/transcriptions`, { key: randomUUID(), audio: true }))).status).toBe(410);
      expect(mock).not.toHaveBeenCalled();
    } finally { await prisma.recentChat.update({ where: { sessionId: `${prefix}group-member` }, data: { status: "active" } }); }
    expect((await run(request("GET", `groups/${groupId}/voice-input`))).status).toBe(200);
  });
  it("withholds a completed candidate after conversation archival and cancels it", async () => {
    const id = randomUUID();
    const mock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === "POST") { await prisma.recentChat.update({ where: { sessionId }, data: { status: "archived" } }); return Response.json({ requestId: id, status: "completed", text: "Late text", audioDurationMs: 500, expiresAt: Date.now() + 120_000 }); }
      return Response.json({ requestId: id, status: "cancelled" });
    }); vi.stubGlobal("fetch", mock);
    const response = await run(request("POST", `sessions/${sessionId}/transcriptions`, { key: id, audio: true }));
    expect(response.status).toBe(410);
    expect(mock.mock.calls.some(call => call[1].method === "DELETE")).toBe(true);
    await prisma.recentChat.update({ where: { sessionId }, data: { status: "active" } });
  });
  it("refuses read-only Release pins and paused Serving before starting ASR", async () => {
    const characterId = `${prefix}character`;
    const content = await prisma.character.findUniqueOrThrow({ where: { id: characterId }, select: { currentContentVersionId: true } });
    const releaseId = `${prefix}read-only-release`;
    await prisma.characterRelease.create({ data: {
      id: releaseId, projectId: `${prefix}read-only-project`, revisionId: `${prefix}read-only-revision`,
      characterContentVersionId: content.currentContentVersionId!, status: "published", readiness: "ready",
      generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: `${prefix}read-only-hash`,
    } });
    await prisma.characterServing.create({ data: { characterId, currentReleaseId: releaseId, state: "live" } });
    await prisma.character.update({ where: { id: characterId }, data: { creatorId: outsider, visibility: "public" } });
    const mock = vi.fn().mockResolvedValue(Response.json({ ready: true, model: "moondream/parakeet-redux", modelRevision: "2bf128600aac4b16946f7ed8372e56117fe5e23b", runtimeVersion: "2.6.1" })); vi.stubGlobal("fetch", mock);
    try {
      const stale = await run(request("GET", `sessions/${sessionId}/voice-input`));
      expect(stale.status).toBe(410);
      expect((await stale.json()).details).toMatchObject({ reason: "character_release_changed" });
      expect(mock).not.toHaveBeenCalled();
      expect((await run(request("GET", `groups/${groupId}/voice-input`))).status).toBe(410);
      expect(mock).not.toHaveBeenCalled();
      await prisma.recentChat.update({ where: { sessionId }, data: { characterReleaseId: releaseId } });
      expect((await run(request("GET", `sessions/${sessionId}/voice-input`))).status).toBe(200);
      await prisma.characterServing.update({ where: { characterId }, data: { state: "paused" } });
      const before = mock.mock.calls.length;
      expect((await run(request("POST", `sessions/${sessionId}/transcriptions`, { key: randomUUID(), audio: true }))).status).toBe(410);
      expect(mock.mock.calls).toHaveLength(before);
    } finally {
      await prisma.recentChat.update({ where: { sessionId }, data: { characterReleaseId: null } });
      await prisma.character.update({ where: { id: characterId }, data: { creatorId: userId, visibility: "private" } });
      await prisma.characterServing.delete({ where: { characterId } });
      await prisma.characterRelease.delete({ where: { id: releaseId } });
    }
  });
  it("enforces persisted age gate and active account on every request", async () => {
    await prisma.ageGateAcceptance.deleteMany({ where: { userId: outsider } });
    expect((await run(request("GET", `groups/${groupId}/voice-input`, { user: outsider }))).status).toBe(403);
    await prisma.user.update({ where: { id: outsider }, data: { status: "suspended" } });
    expect((await run(request("GET", `groups/${groupId}/voice-input`, { user: outsider }))).status).toBe(401);
  });
});
