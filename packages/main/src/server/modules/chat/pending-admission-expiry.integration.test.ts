import { randomUUID } from "node:crypto";
import { CHAT_SEND_PROTOCOL_VERSION, MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { compileCharacterSoul, renderPrometheusMetrics } from "@idream/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { attemptChatAgentRunAdmission, dispatchPendingChatAgentRuns, expireStalePendingChatTurns } from "./agent-run-admission";
import { beginChatTurn, createChatSession, getChatSession, regenerateChatTurn } from "./turn-ledger";
import { InvalidExecutionSnapshotError, isPermanentSnapshotFailure } from "./execution-snapshot";
import { Errors } from "@/server/lib/errors";
import { z } from "zod";

const prefix = `zt-admission-expiry-${randomUUID()}-`;

afterEach(() => {
  vi.restoreAllMocks();
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

async function send(f: { userId: string; sessionId: string }, content = "Are you there?") {
  const begun = await beginChatTurn({
    sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION, userId: f.userId, sessionId: f.sessionId, content, idempotencyKey: randomUUID(),
  });
  return begun;
}

/** Chat never answered: the attempt has been pending for longer than the TTL. */
async function ageAttempt(turnId: string, ageMs = env.CHAT_PENDING_ADMISSION_TTL_MS + 1_000) {
  await prisma.chatTurn.update({ where: { id: turnId }, data: { attemptStartedAt: new Date(Date.now() - ageMs) } });
}

function cancelIntent(turnId: string) {
  return prisma.mainOutboxEvent.findFirst({
    where: { eventType: MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1, aggregateId: turnId },
    select: { payload: true },
  });
}

describe("pending admission TTL", () => {
  it("fails an unadmitted Turn, voids its allowance, cancels Chat and releases the chat", async () => {
    const f = await fixture();
    const begun = await send(f);
    const turnId = begun.snapshot!.turnId;
    await ageAttempt(turnId);

    await expireStalePendingChatTurns();

    const turn = await prisma.chatTurn.findUniqueOrThrow({ where: { id: turnId } });
    expect(turn).toMatchObject({
      assistantStatus: "failed", userStatus: "sent", userContent: "Are you there?", terminalAt: expect.any(Date),
      terminalEvidence: { authority: "main_admission_expiry", failureCode: "admission_expired", reason: "ttl" },
    });
    await expect(prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId } }))
      .resolves.toMatchObject({ voidedAt: expect.any(Date), consumedAt: null });
    await expect(cancelIntent(turnId)).resolves.toMatchObject({
      payload: { payload: { turnId, attempt: 1, userId: f.userId } },
    });
    expect(renderPrometheusMetrics()).toMatch(/chat_pending_admission_expired_total\{reason="ttl"\} [1-9]/u);

    const session = await getChatSession(f.userId, f.sessionId);
    expect(session.messages.find((message) => message.id === begun.assistant.id))
      .toMatchObject({ status: "failed", failureCode: "admission_expired" });
    expect(session.messages.find((message) => message.id === begun.userMessage.id))
      .toMatchObject({ status: "sent", content: "Are you there?" });
    // The conversation is no longer locked behind a reply that will never come.
    await expect(send(f, "Hello again")).resolves.toMatchObject({ duplicate: false, blocked: false });
  });

  it("leaves fresh attempts, live admissions and restarted revisions alone", async () => {
    const f = await fixture();
    const begun = await send(f);
    const turnId = begun.snapshot!.turnId;
    await expireStalePendingChatTurns();
    await expect(prisma.chatTurn.findUniqueOrThrow({ where: { id: turnId } })).resolves.toMatchObject({ assistantStatus: "pending" });

    // A request to Chat is in flight under a live lease: expiry waits for it.
    await ageAttempt(turnId);
    await prisma.chatTurn.update({ where: { id: turnId }, data: {
      admissionLeaseToken: randomUUID(), admissionLeaseUntil: new Date(Date.now() + 10_000),
    } });
    await expireStalePendingChatTurns();
    await expect(prisma.chatTurn.findUniqueOrThrow({ where: { id: turnId } })).resolves.toMatchObject({ assistantStatus: "pending" });

    await prisma.chatTurn.update({ where: { id: turnId }, data: { admissionLeaseToken: null, admissionLeaseUntil: null } });
    await expireStalePendingChatTurns();
    await expect(prisma.chatTurn.findUniqueOrThrow({ where: { id: turnId } })).resolves.toMatchObject({ assistantStatus: "failed" });

    // Regenerate starts a new attempt and a new TTL window.
    const regenerated = await regenerateChatTurn(f.userId, begun.assistant.id);
    const restarted = await prisma.chatTurn.findUniqueOrThrow({ where: { id: turnId } });
    expect(restarted).toMatchObject({ assistantStatus: "pending", attempt: regenerated.attempt });
    expect(Date.now() - restarted.attemptStartedAt.getTime()).toBeLessThan(10_000);
    await expireStalePendingChatTurns();
    await expect(prisma.chatTurn.findUniqueOrThrow({ where: { id: turnId } })).resolves.toMatchObject({ assistantStatus: "pending" });
    await expect(prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId } })).resolves.toMatchObject({ voidedAt: null });
  });

  it("never admits an attempt that outlived its TTL", async () => {
    const f = await fixture();
    const begun = await send(f);
    await ageAttempt(begun.snapshot!.turnId);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(attemptChatAgentRunAdmission(begun.snapshot!, fetchImpl)).resolves.toMatchObject({ admitted: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops retrying a permanently invalid snapshot after a bounded number of passes", async () => {
    const f = await fixture();
    const begun = await send(f);
    const turnId = begun.snapshot!.turnId;
    await prisma.$executeRaw`UPDATE "chat_turns" SET "executionSnapshot" = '{"version":1,"broken":true}'::jsonb WHERE id = ${turnId}`;
    // Other due Turns in the shared test database must not reach the network.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
    for (let pass = 0; pass < 3; pass += 1) {
      await prisma.chatTurn.update({ where: { id: turnId }, data: { admissionNextRunAt: new Date(Date.now() - 1_000) } });
      await dispatchPendingChatAgentRuns(200);
    }
    await expect(prisma.chatTurn.findUniqueOrThrow({ where: { id: turnId } })).resolves.toMatchObject({
      assistantStatus: "failed",
      terminalEvidence: { failureCode: "admission_expired", reason: "snapshot_invalid" },
    });
    await expect(cancelIntent(turnId)).resolves.not.toBeNull();
  });

  it("counts only deterministic snapshot failures toward the bounded retry", () => {
    expect(isPermanentSnapshotFailure(new InvalidExecutionSnapshotError("corrupt"))).toBe(true);
    expect(isPermanentSnapshotFailure(z.object({ a: z.string() }).safeParse({}).error)).toBe(true);
    expect(isPermanentSnapshotFailure(Errors.notFound("Chat turn not found"))).toBe(true);
    // Lock timeouts, resets and serialization failures say nothing about the snapshot.
    expect(isPermanentSnapshotFailure(new Error("canceling statement due to lock timeout"))).toBe(false);
    expect(isPermanentSnapshotFailure(Object.assign(new Error("serialization failure"), { code: "P2034" }))).toBe(false);
  });
});
