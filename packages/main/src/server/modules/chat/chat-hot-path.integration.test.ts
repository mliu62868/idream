import { randomUUID } from "node:crypto";
import { CHAT_SEND_PROTOCOL_VERSION } from "@idream/shared/contracts";
import { compileCharacterSoul, renderPrometheusMetrics } from "@idream/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { attemptChatAgentRunAdmission, resetInlineAdmissionCircuit } from "./agent-run-admission";
import { beginChatTurn, createChatSession, getChatSession, regenerateChatTurn } from "./turn-ledger";

const prefix = `zt-chat-hot-path-${randomUUID()}-`;

afterEach(() => {
  vi.restoreAllMocks();
  resetInlineAdmissionCircuit();
});
afterAll(async () => {
  await prisma.chatTurnUsageFact.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await purgeTestData(prefix);
});

async function fixture() {
  const userId = `${prefix}${randomUUID()}`;
  await createUser({ id: userId });
  const character = await createCharacter({ id: `${userId}-character`, creatorId: userId, source: "user", visibility: "private" });
  const soul = compileCharacterSoul({
    name: "Mira", age: 28, gender: "female", characterPromise: "A warm companion", detailsMarkdown: "Warm and curious.",
  });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const content = await prisma.characterContentVersion.create({ data: {
    characterId: character.id, version: 1, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint,
    personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {},
  } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  const session = await createChatSession(userId, { characterId: character.id });
  return { userId, sessionId: session.id };
}

function send(f: { userId: string; sessionId: string }, idempotencyKey = randomUUID(), content = "Hi there") {
  return beginChatTurn({ sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION, userId: f.userId, sessionId: f.sessionId, content, idempotencyKey });
}

describe("send hot path", () => {
  it("gives the dispatcher a head start, reuses the locked entitlement map and carries the request key", async () => {
    const f = await fixture();
    const key = randomUUID();
    const begun = await send(f, key);
    const turn = await prisma.chatTurn.findUniqueOrThrow({ where: { id: begun.snapshot!.turnId } });
    expect(turn.admissionNextRunAt.getTime() - turn.attemptStartedAt.getTime()).toBeGreaterThanOrEqual(2_900);
    expect(begun.entitlements).toBeDefined();
    expect(begun.userMessage).toMatchObject({ requestKey: key });
    const session = await getChatSession(f.userId, f.sessionId);
    expect(session.messages.find((message) => message.id === begun.userMessage.id)).toMatchObject({ requestKey: key });
  });

  it("answers a replay from its receipt without a new moderation event or snapshot", async () => {
    const f = await fixture();
    const key = randomUUID();
    const first = await send(f, key);
    const turnId = first.snapshot!.turnId;
    const before = await prisma.moderationEvent.count();
    // Still pending: the replay may re-drive admission with the same frozen snapshot.
    const pendingReplay = await send(f, key);
    expect(pendingReplay).toMatchObject({ duplicate: true, snapshot: { turnId, attempt: 1 } });
    // Terminal: the replay is a read and freezes nothing.
    await prisma.chatTurn.update({ where: { id: turnId }, data: { assistantStatus: "failed", terminalAt: new Date() } });
    const snapshotBefore = (await prisma.chatTurn.findUniqueOrThrow({ where: { id: turnId } })).executionSnapshot;
    const terminalReplay = await send(f, key);
    expect(terminalReplay).toMatchObject({ duplicate: true, snapshot: null });
    expect((await prisma.chatTurn.findUniqueOrThrow({ where: { id: turnId } })).executionSnapshot).toEqual(snapshotBefore);
    expect(await prisma.moderationEvent.count()).toBe(before);
    // Reusing the key for other words is still refused, also without moderation.
    await expect(send(f, key, "Different words")).rejects.toMatchObject({ status: 409 });
    expect(await prisma.moderationEvent.count()).toBe(before);
  });

  it("tags chat conflicts with a machine reason", async () => {
    const f = await fixture();
    const begun = await send(f);
    await expect(send(f)).rejects.toMatchObject({ status: 409, details: { reason: "reply_in_progress" } });
    await expect(regenerateChatTurn(f.userId, begun.assistant.id))
      .rejects.toMatchObject({ status: 409, details: { reason: "reply_in_progress" } });
  });
});

describe("inline admission circuit", () => {
  it("stops waiting on a hung Chat after repeated timeouts while the dispatcher still admits", async () => {
    const f = await fixture();
    const timeout = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    for (let index = 0; index < 3; index += 1) {
      const begun = await send(f);
      await expect(attemptChatAgentRunAdmission(begun.snapshot!, timeout as unknown as typeof fetch, { mode: "inline" }))
        .resolves.toMatchObject({ admitted: false, reason: "Chat AgentRun admission timed out" });
      await prisma.chatTurn.update({ where: { id: begun.snapshot!.turnId }, data: { assistantStatus: "failed", terminalAt: new Date() } });
    }
    expect(timeout).toHaveBeenCalledTimes(3);
    const skipped = await send(f);
    await expect(attemptChatAgentRunAdmission(skipped.snapshot!, timeout as unknown as typeof fetch, { mode: "inline" }))
      .resolves.toMatchObject({ admitted: false, reason: "Inline admission skipped while Chat is degraded" });
    expect(timeout).toHaveBeenCalledTimes(3);
    await expect(prisma.chatTurn.findUniqueOrThrow({ where: { id: skipped.snapshot!.turnId } }))
      .resolves.toMatchObject({ assistantStatus: "pending", admissionAttempts: 0 });
    expect(renderPrometheusMetrics()).toMatch(/chat_admission_duration_seconds_count\{mode="inline",outcome="circuit_open"\} [1-9]/u);

    // The dispatcher is not gated by the inline circuit, and its success closes it.
    await prisma.chatTurn.update({ where: { id: skipped.snapshot!.turnId }, data: { admissionNextRunAt: new Date(0) } });
    const healthy = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(async (_url, init) => {
      const snapshot = JSON.parse(String(init?.body)) as { turnId: string; attempt: number };
      return Response.json({ ok: true, turnId: snapshot.turnId, attempt: snapshot.attempt, duplicate: false, terminal: false,
        deadlineAt: new Date(Date.now() + 300_000).toISOString() }, { status: 202 });
    });
    await expect(attemptChatAgentRunAdmission(skipped.snapshot!, healthy as unknown as typeof fetch)).resolves.toMatchObject({ admitted: true });
    expect(renderPrometheusMetrics()).toMatch(/chat_admission_pending_age_seconds_count\{mode="dispatch"\} [1-9]/u);
    await prisma.chatTurn.update({ where: { id: skipped.snapshot!.turnId }, data: { assistantStatus: "failed", terminalAt: new Date() } });
    const next = await send(f);
    await expect(attemptChatAgentRunAdmission(next.snapshot!, healthy as unknown as typeof fetch, { mode: "inline" })).resolves.toMatchObject({ admitted: true });
  });
});
