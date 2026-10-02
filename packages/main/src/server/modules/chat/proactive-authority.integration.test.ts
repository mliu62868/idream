import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import { chatExchangeCompletedV2Schema, chatExchangeCorrectionV2Schema } from "@idream/shared/contracts";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { characterReleaseSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION } from "@/server/modules/ourdream/public-catalog-qualification";
import {
  archiveChatSession,
  beginChatTurn,
  cancelChatTurn,
  commitChatTerminal,
  createChatSession,
  deleteChatMessage,
  deleteChatSession,
  editChatTurn,
  getChatSession,
  listChatSessions,
  regenerateChatTurn,
} from "./turn-ledger";
import { clearCompanionMemory } from "./companion-memory-authority";
import * as agentRunAdmission from "./agent-run-admission";
import { dispatchDueProactiveTurns } from "./proactive-messages";

const prefix = `zt-proactive-authority-${randomUUID()}-`;

afterAll(async () => {
  const metricEvents = await prisma.analyticsEvent.findMany({ where: { userId: { startsWith: prefix } }, select: { id: true } });
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: metricEvents.map((event) => event.id) } } });
  await prisma.analyticsEvent.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.chatTurnUsageFact.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

async function fixture(existingUserId?: string) {
  const userId = existingUserId ?? `${prefix}${randomUUID()}`;
  if (!existingUserId) await createUser({ id: userId });
  const character = await createCharacter({
    id: existingUserId ? `${userId}-character-${randomUUID()}` : `${userId}-character`,
    creatorId: userId,
    source: "user",
    visibility: "private",
  });
  const soul = compileCharacterSoul({
    name: "Nova",
    age: 31,
    gender: "female",
    characterPromise: "A ceramicist who works late.",
    detailsMarkdown: "Unhurried and specific.",
  });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const content = await prisma.characterContentVersion.create({
    data: {
      characterId: character.id,
      version: 1,
      sourceType: "test",
      contentHash: soul.snapshot.compiled.fingerprint,
      personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)),
      openingSnapshot: { firstMessage: "Hello." },
      appearanceSnapshot: {},
    },
  });
  await prisma.character.update({
    where: { id: character.id },
    data: { currentContentVersionId: content.id },
  });
  const session = await createChatSession(userId, { characterId: character.id });
  return { userId, characterId: character.id, sessionId: session.id };
}

/** Burn the whole daily allowance with Turns the user actually sent. */
async function exhaustDailyAllowance(userId: string, sessionId: string, count = FREE_DAILY_MESSAGES) {
  const productDay = new Date(
    Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    ),
  );
  const turns = Array.from({ length: count }, (_, index) => ({
    id: `${userId}-used-${index}`,
    sessionId,
    idempotencyKey: `used-${index}`,
    requestHash: `hash-${index}`,
    userMessageId: `${userId}-used-user-${index}`,
    assistantMessageId: `${userId}-used-assistant-${index}`,
    userContent: "Earlier message.",
    assistantContent: "Earlier reply.",
    assistantStatus: "sent",
    origin: "user",
    memoryEnabled: true,
  }));
  await prisma.chatTurn.createMany({ data: turns });
  await prisma.chatTurnUsageFact.createMany({
    data: turns.map((turn) => ({ turnId: turn.id, userId, productDay })),
  });
}

async function commitFailed(
  snapshot: NonNullable<Awaited<ReturnType<typeof beginChatTurn>>["snapshot"]>,
) {
  await commitChatTerminal({
    version: 1,
    turnId: snapshot.turnId,
    sessionId: snapshot.sessionId,
    assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt,
    status: "failed",
    content: "",
    model: null,
    promptTokens: null,
    completionTokens: null,
    sceneVersion: snapshot.sceneVersion,
    scene: snapshot.scene,
    terminalEvidence: {
      authority: "test",
      prompt: {
        productPromptVersion: "companion-product-1",
        preparedTurnVersion: null,
        systemPromptDigest: null,
        soulFingerprint: null,
      },
    },
  });
}

function send(f: { userId: string; sessionId: string }, content = "Hello?") {
  return beginChatTurn({ userId: f.userId, sessionId: f.sessionId, content, idempotencyKey: randomUUID() });
}

async function commitSent(
  snapshot: NonNullable<Awaited<ReturnType<typeof beginChatTurn>>["snapshot"]>,
  content: string,
) {
  await commitChatTerminal({
    version: 1,
    turnId: snapshot.turnId,
    sessionId: snapshot.sessionId,
    assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt,
    status: "sent",
    content,
    model: "fixture",
    promptTokens: 2,
    completionTokens: 2,
    sceneVersion: snapshot.sceneVersion + 1,
    scene: {
      schemaVersion: 1,
      version: snapshot.sceneVersion + 1,
      location: null,
      time: null,
      participants: [],
      emotionalBeat: null,
      unresolvedThreads: [],
    },
    terminalEvidence: {
      authority: "test",
      prompt: {
        productPromptVersion: "companion-product-1",
        preparedTurnVersion: 4,
        systemPromptDigest: "a".repeat(64),
        soulFingerprint: "b".repeat(64),
      },
    },
  });
}

describe("proactive Turns and the daily allowance", () => {
  // SPEC: 免费额度衡量的是用户自己发了多少条，不是这个关系今天产生了多少条。
  it("lets the Character reach out after the user has spent their allowance", async () => {
    const f = await fixture();
    await exhaustDailyAllowance(f.userId, f.sessionId);

    await expect(
      beginChatTurn({
        userId: f.userId,
        sessionId: f.sessionId,
        content: "One more?",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(AppError);

    // INTENT: 如果主动消息也被额度挡住，dispatcher 会对同一个会话每 15 分钟
    // 重试一次直到 UTC 次日 —— 一整天的无效重试和错误日志。
    const proactive = await beginChatTurn({
      userId: f.userId,
      sessionId: f.sessionId,
      content: "Take the lead in the moment: send a brief, specific check-in.",
      idempotencyKey: randomUUID(),
      origin: "proactive",
    });
    expect(proactive.snapshot).not.toBeNull();
  });

  // 主动那一条照样记账：它和普通消息烧掉同样的生成容量，运营口径不能少算。
  it("still records a usage fact for the proactive Turn", async () => {
    const f = await fixture();
    const proactive = await beginChatTurn({
      userId: f.userId,
      sessionId: f.sessionId,
      content: "Take the lead in the moment.",
      idempotencyKey: randomUUID(),
      origin: "proactive",
    });
    expect(
      await prisma.chatTurnUsageFact.count({
        where: { turnId: proactive.snapshot!.turnId },
      }),
    ).toBe(1);
  });
});

describe("proactive cadence without a reply", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const snapshot = JSON.parse(String(init?.body));
      return Response.json({
        ok: true, turnId: snapshot.turnId, attempt: snapshot.attempt,
        duplicate: false, terminal: false,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  async function makeDue(sessionId: string) {
    await prisma.recentChat.update({ where: { sessionId }, data: {
      proactiveEnabled: true, proactiveIntervalHours: 24,
      proactiveNextAt: new Date(Date.now() - 60_000),
    } });
  }

  it.each(["sent", "pending", "generating"] as const)("suppresses an unanswered %s check-in and still advances its cadence", async (status) => {
    const f = await fixture();
    const proactive = await beginChatTurn({
      userId: f.userId, sessionId: f.sessionId, content: "Take the lead.", idempotencyKey: randomUUID(), origin: "proactive",
    });
    if (status === "sent") await commitSent(proactive.snapshot!, "The kiln's still warm.");
    if (status === "generating") await agentRunAdmission.attemptChatAgentRunAdmission(proactive.snapshot!);
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: proactive.snapshot!.turnId } }))
      .toMatchObject({ assistantStatus: status });
    await makeDue(f.sessionId);
    await expect(dispatchDueProactiveTurns(20)).resolves.toEqual({ admitted: 0, failed: 0 });
    expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(1);
    const row = await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } });
    expect(row.proactiveNextAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it.each(["failed", "blocked", "cancelled"] as const)("allows one new check-in at the next cadence after a %s terminal", async (status) => {
    const f = await fixture();
    const proactive = await beginChatTurn({
      userId: f.userId, sessionId: f.sessionId,
      content: status === "blocked" ? "minor" : "Take the lead.",
      idempotencyKey: randomUUID(), origin: "proactive",
    });
    if (status === "failed") await commitFailed(proactive.snapshot!);
    if (status === "cancelled") await cancelChatTurn(f.userId, proactive.assistant.id, 1);
    expect(await prisma.chatTurn.findFirstOrThrow({ where: { sessionId: f.sessionId, assistantMessageId: proactive.assistant.id } }))
      .toMatchObject({ assistantStatus: status, attempt: 1 });
    await makeDue(f.sessionId);

    await expect(dispatchDueProactiveTurns(20)).resolves.toEqual({ admitted: 1, failed: 0 });
    await expect(dispatchDueProactiveTurns(20)).resolves.toEqual({ admitted: 0, failed: 0 });
    const turns = await prisma.chatTurn.findMany({ where: { sessionId: f.sessionId }, orderBy: { createdAt: "asc" } });
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ assistantStatus: status, attempt: 1 });
    expect(turns[1]).toMatchObject({ origin: "proactive", assistantStatus: "generating", attempt: 1 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const row = await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } });
    expect(row.proactiveNextAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it("does not let a newer blocked Turn hide a reply that is still active", async () => {
    const f = await fixture();
    const active = await send(f);
    await beginChatTurn({
      userId: f.userId, sessionId: f.sessionId, content: "minor",
      idempotencyKey: randomUUID(), origin: "proactive",
    });
    await makeDue(f.sessionId);

    await expect(dispatchDueProactiveTurns(20)).resolves.toEqual({ admitted: 0, failed: 0 });
    expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(2);
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: active.snapshot!.turnId } }))
      .toMatchObject({ assistantStatus: "pending", attempt: 1 });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("claims a due failed relationship once across concurrent dispatchers", async () => {
    const f = await fixture();
    const proactive = await beginChatTurn({
      userId: f.userId, sessionId: f.sessionId, content: "Take the lead.",
      idempotencyKey: randomUUID(), origin: "proactive",
    });
    await commitFailed(proactive.snapshot!);
    await makeDue(f.sessionId);

    const results = await Promise.all([dispatchDueProactiveTurns(1), dispatchDueProactiveTurns(1)]);
    expect(results.reduce((sum, result) => sum + result.admitted, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
    expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(2);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("does not shorten the user's cadence after a temporary admission failure", async () => {
    const f = await fixture();
    await makeDue(f.sessionId);
    // Only the rejection is injected: claiming and cadence persistence use PostgreSQL.
    const admission = vi.spyOn(agentRunAdmission, "beginAdmittedChatTurn")
      .mockRejectedValueOnce(new Error("Temporary admission failure"));
    try {
      await expect(dispatchDueProactiveTurns(20)).resolves.toEqual({ admitted: 0, failed: 1 });
      await expect(dispatchDueProactiveTurns(20)).resolves.toEqual({ admitted: 0, failed: 0 });
      expect(admission).toHaveBeenCalledTimes(1);
      expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId } })).toBe(0);
      const row = await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } });
      expect(row.proactiveNextAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    } finally {
      admission.mockRestore();
    }
  });
});

describe("proactive delivery marker", () => {
  // SPEC: 主动消息到达时没有人在看，会话列表是它唯一能自我宣告的地方。
  it("marks the session unread and clears it when the user opens it", async () => {
    const f = await fixture();
    const proactive = await beginChatTurn({
      userId: f.userId,
      sessionId: f.sessionId,
      content: "Take the lead in the moment.",
      idempotencyKey: randomUUID(),
      origin: "proactive",
    });
    await commitSent(proactive.snapshot!, "The studio's quiet tonight.");

    const listed = await listChatSessions(f.userId);
    expect(listed.find((row) => row.id === f.sessionId)?.unreadProactiveAt).toEqual(
      expect.any(String),
    );

    await getChatSession(f.userId, f.sessionId);
    const afterOpening = await listChatSessions(f.userId);
    expect(afterOpening.find((row) => row.id === f.sessionId)?.unreadProactiveAt).toBeNull();
  });

  it("does not mark a Turn the user sent themselves", async () => {
    const f = await fixture();
    const own = await beginChatTurn({
      userId: f.userId,
      sessionId: f.sessionId,
      content: "How did the firing go?",
      idempotencyKey: randomUUID(),
    });
    await commitSent(own.snapshot!, "Better than I hoped.");
    const listed = await listChatSessions(f.userId);
    expect(listed.find((row) => row.id === f.sessionId)?.unreadProactiveAt).toBeNull();
  });
});

// The best-effort cancel call to Chat is not what these tests measure; the local
// Chat service answering slowly (or not at all) must not time them out.
async function clearWithoutChat(userId: string, characterId: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 202 })));
  try {
    await clearCompanionMemory(userId, characterId);
  } finally {
    vi.unstubAllGlobals();
  }
}

// SPEC: 额度只看 usage fact 本身；删消息/删会话不退额度，没拿到回复的 Turn 不扣额度。
describe("daily allowance ledger", () => {
  it("does not start a second reply by editing a newer blocked Turn", async () => {
    const f = await fixture();
    const active = await send(f);
    const blocked = await send(f, "minor");
    await expect(editChatTurn(f.userId, blocked.userMessage.id, "Hello again."))
      .rejects.toMatchObject({ status: 409, message: "A reply is already generating" });
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: active.snapshot!.turnId } }))
      .toMatchObject({ assistantStatus: "pending", attempt: 1, executionSnapshot: active.snapshot });
    expect(await prisma.chatTurn.count({ where: { sessionId: f.sessionId, assistantStatus: { in: ["pending", "generating"] } } }))
      .toBe(1);
  });

  it("rejects a blocked-to-safe edit once the user's allowance is full", async () => {
    const f = await fixture();
    await exhaustDailyAllowance(f.userId, f.sessionId);
    const blocked = await send(f, "minor");
    expect(blocked.assistant.status).toBe("blocked");
    await expect(editChatTurn(f.userId, blocked.userMessage.id, "Hello again."))
      .rejects.toMatchObject({ status: 402 });
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { userMessageId: blocked.userMessage.id } }))
      .toMatchObject({ assistantStatus: "blocked", attempt: 1 });
  });

  it("reserves exactly one usage fact when a blocked Turn first becomes executable", async () => {
    const f = await fixture();
    const blocked = await send(f, "minor");
    const edited = await editChatTurn(f.userId, blocked.userMessage.id, "Hello again.");
    const turnId = edited.snapshot!.turnId;
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId } }))
      .toMatchObject({ userId: f.userId, origin: "user", voidedAt: null });
    await commitSent(edited.snapshot!, "Hello.");
    // The independent memory worker is outside this quota fixture; acknowledge
    // the edit's rebuild before exercising a subsequent revision.
    await prisma.mainOutboxEvent.updateMany({
      where: { aggregateId: `${f.userId}:${f.characterId}`, eventType: "chat.companion_memory.rebuild_requested.v1" },
      data: { status: "delivered", deliveredAt: new Date() },
    });
    const other = await fixture(f.userId);
    await exhaustDailyAllowance(f.userId, other.sessionId, FREE_DAILY_MESSAGES - 1);
    // Paid-for revisions remain free even at the allowance boundary.
    const revised = await regenerateChatTurn(f.userId, edited.assistantMessageId);
    await commitSent(revised.snapshot, "Hello once more.");
    expect(await prisma.chatTurnUsageFact.count({ where: { turnId } })).toBe(1);
    await expect(send(f)).rejects.toMatchObject({ status: 402 });
  });

  it.each(["regenerate", "edit"] as const)("checks quota before %s restores a failed Turn in another session", async (revision) => {
    const f = await fixture();
    const failed = await send(f);
    await commitFailed(failed.snapshot!);
    const other = await fixture(f.userId);
    await exhaustDailyAllowance(f.userId, other.sessionId);
    await expect(revision === "regenerate"
      ? regenerateChatTurn(f.userId, failed.assistant.id)
      : editChatTurn(f.userId, failed.userMessage.id, "Hello again."))
      .rejects.toMatchObject({ status: 402 });
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId: failed.snapshot!.turnId } }))
      .toMatchObject({ voidedAt: expect.any(Date) });
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: failed.snapshot!.turnId } }))
      .toMatchObject({ assistantStatus: "failed", attempt: 1 });
  });

  it.each(["regenerate", "edit"] as const)("checks the original UTC day before a cross-day %s", async (revision) => {
    const f = await fixture();
    const old = await send(f, revision === "edit" ? "minor" : "Hello?");
    if (revision === "regenerate") await commitFailed(old.snapshot!);
    const turn = await prisma.chatTurn.findUniqueOrThrow({ where: { assistantMessageId: old.assistant.id } });
    const yesterday = new Date();
    yesterday.setUTCHours(0, 0, 0, 0);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await prisma.chatTurn.update({ where: { id: turn.id }, data: { createdAt: yesterday } });
    await prisma.chatTurnUsageFact.updateMany({ where: { turnId: turn.id }, data: { productDay: yesterday } });
    const other = await fixture(f.userId);
    await exhaustDailyAllowance(f.userId, other.sessionId);
    await prisma.chatTurnUsageFact.updateMany({
      where: { userId: f.userId, turnId: { not: turn.id } }, data: { productDay: yesterday },
    });
    await expect(revision === "regenerate"
      ? regenerateChatTurn(f.userId, old.assistant.id)
      : editChatTurn(f.userId, old.userMessage.id, "Hello again."))
      .rejects.toMatchObject({ status: 402 });
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({ attempt: 1 });
    expect(await prisma.chatTurnUsageFact.count({ where: { userId: f.userId, productDay: yesterday, voidedAt: null } }))
      .toBe(FREE_DAILY_MESSAGES);
  });

  it.each(["regenerate", "edit"] as const)("restores an available original-day slot for %s even when today is full", async (revision) => {
    const f = await fixture();
    const old = await send(f, revision === "edit" ? "minor" : "Hello?");
    if (revision === "regenerate") await commitFailed(old.snapshot!);
    const turn = await prisma.chatTurn.findUniqueOrThrow({ where: { assistantMessageId: old.assistant.id } });
    const yesterday = new Date();
    yesterday.setUTCHours(0, 0, 0, 0);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await prisma.chatTurn.update({ where: { id: turn.id }, data: { createdAt: yesterday } });
    await prisma.chatTurnUsageFact.updateMany({ where: { turnId: turn.id }, data: { productDay: yesterday } });
    const other = await fixture(f.userId);
    await exhaustDailyAllowance(f.userId, other.sessionId);
    const revised = revision === "regenerate"
      ? await regenerateChatTurn(f.userId, old.assistant.id)
      : await editChatTurn(f.userId, old.userMessage.id, "Hello again.");
    expect(revised.attempt).toBe(2);
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId: turn.id } }))
      .toMatchObject({ productDay: yesterday, voidedAt: null });
  });

  it.each(["failed", "cancelled"] as const)("retains a consumed cancellation when its next attempt is %s", async (outcome) => {
    const f = await fixture();
    await exhaustDailyAllowance(f.userId, f.sessionId, FREE_DAILY_MESSAGES - 1);
    const streaming = await send(f);
    await prisma.chatTurn.update({
      where: { id: streaming.snapshot!.turnId },
      data: { assistantStatus: "generating", admittedAt: new Date() },
    });
    await cancelChatTurn(f.userId, streaming.assistant.id, 1);
    const retry = await regenerateChatTurn(f.userId, streaming.assistant.id);
    if (outcome === "failed") await commitFailed(retry.snapshot);
    else await cancelChatTurn(f.userId, streaming.assistant.id, 2);
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId: retry.snapshot.turnId } }))
      .toMatchObject({ voidedAt: null });
    await expect(send(f)).rejects.toMatchObject({ status: 402 });
  });

  it("reserves the last allowance slot before concurrent failed-Turn revisions execute", async () => {
    const first = await fixture();
    const failedFirst = await send(first);
    await commitFailed(failedFirst.snapshot!);
    const second = await fixture(first.userId);
    const failedSecond = await send(second);
    await commitFailed(failedSecond.snapshot!);
    const other = await fixture(first.userId);
    await exhaustDailyAllowance(first.userId, other.sessionId, FREE_DAILY_MESSAGES - 1);
    const revisions = await Promise.allSettled([
      regenerateChatTurn(first.userId, failedFirst.assistant.id),
      editChatTurn(first.userId, failedSecond.userMessage.id, "Hello again."),
    ]);
    expect(revisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(revisions.find((result) => result.status === "rejected"))
      .toMatchObject({ reason: { status: 402 } });
    expect(await prisma.chatTurnUsageFact.count({ where: { userId: first.userId, voidedAt: null, origin: "user" } }))
      .toBe(FREE_DAILY_MESSAGES);
  });

  it("does not hand the allowance back when the user deletes a message", async () => {
    const f = await fixture();
    await exhaustDailyAllowance(f.userId, f.sessionId, FREE_DAILY_MESSAGES - 1);
    const last = await send(f);
    await commitSent(last.snapshot!, "Sure.");
    await deleteChatMessage(f.userId, last.assistant.id);
    await expect(send(f)).rejects.toMatchObject({ status: 402 });
  });

  it("does not hand the allowance back when the user deletes the whole session", async () => {
    const f = await fixture();
    await exhaustDailyAllowance(f.userId, f.sessionId);
    await deleteChatSession(f.userId, f.sessionId);
    const again = await createChatSession(f.userId, { characterId: f.characterId });
    await expect(send({ userId: f.userId, sessionId: again.id })).rejects.toMatchObject({ status: 402 });
  });

  it("does not charge a failed Turn, and charges it again once a regeneration succeeds", async () => {
    const f = await fixture();
    await exhaustDailyAllowance(f.userId, f.sessionId, FREE_DAILY_MESSAGES - 1);
    const failed = await send(f);
    await commitFailed(failed.snapshot!);
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId: failed.snapshot!.turnId } }))
      .toMatchObject({ origin: "user", voidedAt: expect.any(Date) });

    const regenerated = await regenerateChatTurn(f.userId, failed.assistant.id);
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId: failed.snapshot!.turnId } }))
      .toMatchObject({ voidedAt: null });
    await commitSent(regenerated.snapshot, "Here I am.");
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId: failed.snapshot!.turnId } }))
      .toMatchObject({ voidedAt: null });
    await expect(send(f)).rejects.toMatchObject({ status: 402 });
  });

  it("frees the allowance of a Turn cancelled before Chat ran it", async () => {
    const f = await fixture();
    await exhaustDailyAllowance(f.userId, f.sessionId, FREE_DAILY_MESSAGES - 1);
    const cancelled = await send(f);
    await cancelChatTurn(f.userId, cancelled.assistant.id, cancelled.snapshot!.attempt);
    const next = await send(f);
    expect(next.snapshot).not.toBeNull();
  });

  // INTENT: 已受理的回复已经在流式输出；读完再取消不能变成免费额度。
  it("keeps charging a Turn cancelled after Chat started streaming it", async () => {
    const f = await fixture();
    const streaming = await send(f);
    await prisma.chatTurn.update({
      where: { id: streaming.snapshot!.turnId },
      data: { assistantStatus: "generating", admittedAt: new Date() },
    });
    await cancelChatTurn(f.userId, streaming.assistant.id, streaming.snapshot!.attempt);
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId: streaming.snapshot!.turnId } }))
      .toMatchObject({ voidedAt: null });
  });

  // SPEC: 清空记忆取消进行中的回复，与用户点 Stop 同口径：Chat 还没受理的不扣额度。
  it("frees the allowance of a Turn that clearing memory cancelled before Chat ran it", async () => {
    const f = await fixture();
    const pending = await send(f);
    await clearWithoutChat(f.userId, f.characterId);
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: pending.snapshot!.turnId } }))
      .toMatchObject({ assistantStatus: "cancelled" });
    // A lost best-effort HTTP cancel is backed by the same durable event as Stop.
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: pending.snapshot!.turnId, eventType: "chat.agent_run.cancel_requested.v1" } })).toBe(1);
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId: pending.snapshot!.turnId } }))
      .toMatchObject({ voidedAt: expect.any(Date) });
  });

  it("keeps charging a Turn that clearing memory cancelled while Chat streamed it", async () => {
    const f = await fixture();
    const streaming = await send(f);
    await prisma.chatTurn.update({
      where: { id: streaming.snapshot!.turnId },
      data: { assistantStatus: "generating", admittedAt: new Date() },
    });
    await clearWithoutChat(f.userId, f.characterId);
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId: streaming.snapshot!.turnId } }))
      .toMatchObject({ voidedAt: null });
  });

  it("counts a deleted proactive Turn as proactive, not as the user's message", async () => {
    const f = await fixture();
    await exhaustDailyAllowance(f.userId, f.sessionId, FREE_DAILY_MESSAGES - 1);
    const proactive = await beginChatTurn({
      userId: f.userId, sessionId: f.sessionId, content: "Take the lead.", idempotencyKey: randomUUID(), origin: "proactive",
    });
    await commitSent(proactive.snapshot!, "Thinking of you.");
    await deleteChatMessage(f.userId, proactive.assistant.id);
    expect((await send(f)).snapshot).not.toBeNull();
  });
});

// SPEC: 主动消息之后，最新一轮是主动消息那一轮 —— 它能删除/重生成，更早那轮不能。
describe("revising around a proactive Turn", () => {
  async function afterProactive() {
    const f = await fixture();
    const own = await send(f, "How was the firing?");
    await commitSent(own.snapshot!, "Better than I hoped.");
    const proactive = await beginChatTurn({
      userId: f.userId, sessionId: f.sessionId, content: "Take the lead.", idempotencyKey: randomUUID(), origin: "proactive",
    });
    await commitSent(proactive.snapshot!, "The kiln's cooling.");
    return { f, own, proactive };
  }

  it("regenerates the proactive reply, not the exchange before it", async () => {
    const { f, own, proactive } = await afterProactive();
    await expect(regenerateChatTurn(f.userId, own.assistant.id)).rejects.toMatchObject({ status: 409 });
    const regenerated = await regenerateChatTurn(f.userId, proactive.assistant.id);
    expect(regenerated.attempt).toBe(2);
  });

  it("deletes the proactive reply, not the exchange before it", async () => {
    const { f, own, proactive } = await afterProactive();
    await expect(deleteChatMessage(f.userId, own.assistant.id)).rejects.toMatchObject({ status: 409 });
    await deleteChatMessage(f.userId, proactive.assistant.id);
    const session = await getChatSession(f.userId, f.sessionId);
    expect(session.messages.map((message) => (message as { id?: unknown }).id)).not.toContain(proactive.assistant.id);
  });
});

// SPEC: Serving 换了 Release 时，进行中的回复不能被归档吊死；等它结束，下次打开再切到新 Release。
describe("opening a chat after Serving moved to a new Release", () => {
  async function publicFixture() {
    const creatorId = `${prefix}${randomUUID()}`;
    const userId = `${prefix}${randomUUID()}`;
    await createUser({ id: creatorId, dataClass: "customer" });
    await createUser({ id: userId });
    const character = await createCharacter({
      id: `${creatorId}-character`, creatorId, source: "user", visibility: "public", name: "Nova", age: 31,
    });
    const soul = compileCharacterSoul({
      name: "Nova", age: 31, gender: "female", characterPromise: "A ceramicist who works late.", detailsMarkdown: "Unhurried and specific.",
    });
    if (!soul.ok) throw new Error("Invalid fixture Soul");
    const assetId = `${character.id}-avatar`;
    await prisma.mediaAsset.create({ data: {
      id: assetId, ownerId: creatorId, characterId: character.id, type: "image",
      url: `/user-content/${assetId}/content.webp`, storageKey: `tests/${assetId}.webp`, contentType: "image/webp",
      visibility: "public_pack", safetyStatus: "passed",
      metadata: { seedSource: prefix, synthetic: false, platformAsset: { status: "approved" } },
    } });
    await prisma.character.update({ where: { id: character.id }, data: { imageAssetId: assetId } });
    const project = await prisma.characterProject.create({ data: { characterId: character.id } });
    // Reuse the qualified editorial shape from direct-audience integration.
    // Publish pins and Serving atomically so both versions have valid authority.
    const release = async (tx: Prisma.TransactionClient, version: number) => {
      const content = await tx.characterContentVersion.create({ data: {
        characterId: character.id, version, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint,
        personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {},
      } });
      const revision = await tx.characterRevision.create({ data: {
        projectId: project.id, revision: version, characterContentVersionId: content.id, projectSnapshot: {},
      } });
      const snapshot = {
        projectId: project.id, revisionId: revision.id, characterContentVersionId: content.id,
        visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null,
        generationProvenance: {
          schemaVersion: "character-release-editorial-import-v1", recordId: character.id, dataset: prefix, sourceAssetId: assetId,
        },
        releasePlacementManifest: {
          schemaVersion: 1, kind: "editorial_import", placements: [{ slotKey: "character_avatar", assetId, slotVersion: 1 }],
        },
      };
      const published = await tx.characterRelease.create({ data: {
        ...snapshot, snapshotHash: characterReleaseSnapshotHash(snapshot),
        readiness: "ready", legacy: true, status: "published", publishedAt: new Date(),
      } });
      await tx.publicCatalogQualification.create({ data: {
        releaseId: published.id, releaseSnapshotHash: published.snapshotHash, kind: "editorial_import",
        evidence: {
          schemaVersion: "public-catalog-qualification-v1", policyVersion: PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION,
          characterId: character.id, sourceAssetId: assetId,
          checks: { exactSeedRecord: true, nonSynthetic: true, safetyPassed: true, publicPack: true, imageAvailable: true },
        },
      } });
      await tx.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
      return published;
    };
    const first = await prisma.$transaction(async (tx) => {
      const published = await release(tx, 1);
      await tx.characterServing.create({ data: { characterId: character.id, currentReleaseId: published.id, state: "live" } });
      return published;
    });
    const moveServing = () => prisma.$transaction(async (tx) => {
      const next = await release(tx, 2);
      await tx.characterRelease.update({ where: { id: first.id }, data: { status: "superseded" } });
      await tx.characterServing.update({ where: { characterId: character.id }, data: { currentReleaseId: next.id } });
      return next;
    });
    return { userId, creatorId, characterId: character.id, firstReleaseId: first.id, moveServing };
  }

  it("keeps the session with a pending reply and moves once the reply ended", async () => {
    const f = await publicFixture();
    const session = await createChatSession(f.userId, { characterId: f.characterId });
    const pending = await send({ userId: f.userId, sessionId: session.id });
    const next = await f.moveServing();

    const reopened = await createChatSession(f.userId, { characterId: f.characterId });
    expect(reopened.id).toBe(session.id);
    expect(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: session.id } })).toMatchObject({ status: "active" });

    await commitSent(pending.snapshot!, "Still here.");
    const moved = await createChatSession(f.userId, { characterId: f.characterId });
    expect(moved.id).not.toBe(session.id);
    expect(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: moved.id } })).toMatchObject({ characterReleaseId: next.id });
    expect(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: session.id } })).toMatchObject({ status: "archived", activeKey: null });
  });

  // SPEC: 作者自己的会话原地改钉到新上线的 Release（CR-08）：下一轮用新版本，旧 Turn 各守各的钉，会话不归档。
  it("re-pins the author's own session to the newly published Release while earlier Turns keep theirs", async () => {
    const f = await publicFixture();
    const session = await createChatSession(f.creatorId, { characterId: f.characterId });
    const before = await send({ userId: f.creatorId, sessionId: session.id }, "Before the update.");
    await commitSent(before.snapshot!, "Still v1.");
    const next = await f.moveServing();

    const after = await send({ userId: f.creatorId, sessionId: session.id }, "After the update.");
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: after.snapshot!.turnId } }))
      .toMatchObject({ characterReleaseId: next.id, characterContentVersionId: next.characterContentVersionId });
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: before.snapshot!.turnId } }))
      .toMatchObject({ characterReleaseId: f.firstReleaseId });
    expect(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: session.id } }))
      .toMatchObject({ status: "active", characterReleaseId: next.id, characterContentVersionId: next.characterContentVersionId });
    expect((await createChatSession(f.creatorId, { characterId: f.characterId })).id).toBe(session.id);
  });

  it("re-pins the author's session on open only once its pending reply ended", async () => {
    const f = await publicFixture();
    const session = await createChatSession(f.creatorId, { characterId: f.characterId });
    const pending = await send({ userId: f.creatorId, sessionId: session.id });
    const next = await f.moveServing();

    expect((await createChatSession(f.creatorId, { characterId: f.characterId })).id).toBe(session.id);
    expect(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: session.id } }))
      .toMatchObject({ characterReleaseId: f.firstReleaseId });

    await commitSent(pending.snapshot!, "Done.");
    expect((await createChatSession(f.creatorId, { characterId: f.characterId })).id).toBe(session.id);
    expect(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: session.id } }))
      .toMatchObject({ status: "active", characterReleaseId: next.id });
  });

  // SPEC: 旧会话里继续发消息，410 要告诉前端「角色更新了、去哪继续」，且什么都没扣。
  it("tells the page where to continue when an old session sends after the update, without admitting or charging", async () => {
    const f = await publicFixture();
    const session = await createChatSession(f.userId, { characterId: f.characterId });
    const next = await f.moveServing();
    expect((await getChatSession(f.userId, session.id)).continuation).toBe("character_release_changed");

    const refused = await send({ userId: f.userId, sessionId: session.id }, "Still there?").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({
      status: 410,
      details: { reason: "character_release_changed", characterId: f.characterId },
    });
    expect(await prisma.chatTurn.count({ where: { sessionId: session.id } })).toBe(0);
    expect(await prisma.chatTurnUsageFact.count({ where: { userId: f.userId } })).toBe(0);

    const continued = await createChatSession(f.userId, { characterId: f.characterId });
    expect(continued.id).not.toBe(session.id);
    expect(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: continued.id } }))
      .toMatchObject({ characterReleaseId: next.id, status: "active" });
  });
});

describe("replies generating at once for one user", () => {
  // INVARIANT: the Chat agent pool is shared by everyone; one user cannot hold more than three of its slots.
  it("refuses a fourth concurrent reply across sessions with a message the reader can act on", async () => {
    const first = await fixture();
    const others = [await fixture(first.userId), await fixture(first.userId), await fixture(first.userId)];
    for (const f of [first, ...others.slice(0, 2)]) await send(f);
    const refused = send(others[2]!);
    await expect(refused).rejects.toMatchObject({ status: 409 });
    await expect(refused).rejects.toThrow(/^A reply is already generating in 3 of your chats\./);
    expect(await prisma.chatTurn.count({ where: { sessionId: others[2]!.sessionId } })).toBe(0);
  });

  it("applies the same limit to regenerate and edit", async () => {
    const first = await fixture();
    const done = await send(first, "Morning.");
    await commitSent(done.snapshot!, "Morning to you.");
    const others = [await fixture(first.userId), await fixture(first.userId), await fixture(first.userId)];
    for (const f of others) await send(f);
    await expect(regenerateChatTurn(first.userId, done.assistant.id)).rejects.toThrow(/^A reply is already generating in 3 of your chats\./);
    await expect(editChatTurn(first.userId, done.userMessage.id, "Evening.")).rejects.toThrow(/^A reply is already generating in 3 of your chats\./);
  });
});

describe("archiving a session", () => {
  // INVARIANT: 归档会话的 Turn 永远不会被受理；留下 pending 就是永远转圈。
  it("refuses while a reply is still pending", async () => {
    const f = await fixture();
    await send(f);
    await expect(archiveChatSession(f.userId, f.sessionId)).rejects.toMatchObject({ status: 409 });
  });
});

// SPEC: 成功回复的用户 Turn 在同事务里写 chat.exchange.completed.v2，所有聊天口径指标只读这个事件。
describe("chat exchange metric event", () => {
  async function exchangeEvents(turnId: string) {
    return prisma.analyticsEvent.findMany({
      where: { name: "chat.exchange.completed.v2", sourceService: "main", sourceEventId: { startsWith: `chat_exchange:${turnId}:` } },
      orderBy: { sourceEventId: "asc" },
    });
  }

  it("records one contract-valid event per sent attempt and none for a proactive Turn", async () => {
    const f = await fixture();
    const first = await send(f, "Morning.");
    await commitSent(first.snapshot!, "Morning to you.");
    const [event] = await exchangeEvents(first.snapshot!.turnId);
    expect(event).toBeDefined();
    const payload = chatExchangeCompletedV2Schema.parse(event.props);
    expect(payload).toMatchObject({
      exchangeId: first.snapshot!.turnId,
      assistantAttemptNo: 1,
      isRegeneration: false,
      userId: f.userId,
      characterId: f.characterId,
      sessionId: f.sessionId,
      engagementSessionId: `eng_${first.snapshot!.turnId}`,
    });
    expect(await prisma.mainOutboxEvent.count({
      where: { id: `product_metric_chat_exchange_${first.snapshot!.turnId}_1`, eventType: "product.event.persisted.v2" },
    })).toBe(1);

    // A message within 30 minutes continues the same engagement session.
    const second = await send(f, "Coffee?");
    await commitSent(second.snapshot!, "Always.");
    const regenerated = await regenerateChatTurn(f.userId, second.assistant.id);
    await commitSent(regenerated.snapshot, "Always, obviously.");
    const secondEvents = await exchangeEvents(second.snapshot!.turnId);
    expect(secondEvents.map((row) => chatExchangeCompletedV2Schema.parse(row.props))).toEqual([
      expect.objectContaining({ assistantAttemptNo: 1, engagementSessionId: `eng_${first.snapshot!.turnId}` }),
      expect.objectContaining({ assistantAttemptNo: 2, isRegeneration: true, engagementSessionId: `eng_${first.snapshot!.turnId}` }),
    ]);

    const proactive = await beginChatTurn({
      userId: f.userId, sessionId: f.sessionId, content: "Take the lead.", idempotencyKey: randomUUID(), origin: "proactive",
    });
    await commitSent(proactive.snapshot!, "Thinking of you.");
    expect(await exchangeEvents(proactive.snapshot!.turnId)).toEqual([]);
  });

  it("starts a new engagement session after 30 quiet minutes", async () => {
    const f = await fixture();
    const first = await send(f, "Morning.");
    await commitSent(first.snapshot!, "Morning to you.");
    await prisma.chatTurn.update({
      where: { id: first.snapshot!.turnId },
      data: { terminalAt: new Date(Date.now() - 31 * 60_000) },
    });
    const later = await send(f, "Back again.");
    await commitSent(later.snapshot!, "Welcome back.");
    const [event] = await exchangeEvents(later.snapshot!.turnId);
    expect(chatExchangeCompletedV2Schema.parse(event.props).engagementSessionId).toBe(`eng_${later.snapshot!.turnId}`);
  });
});

// SPEC: 编辑/删除一条已计入指标的回复，同事务写 chat.exchange.corrected.v2；从未送达过的不写。
describe("chat exchange correction metric event", () => {
  async function correctionEvents(turnId: string) {
    const rows = await prisma.analyticsEvent.findMany({
      where: { name: "chat.exchange.corrected.v2", sourceService: "main", sourceEventId: { startsWith: `chat_exchange_correction:${turnId}:` } },
      orderBy: { sourceEventId: "asc" },
    });
    return rows.map((row) => chatExchangeCorrectionV2Schema.parse(row.props));
  }

  it("records an edit of a sent exchange at the replaced attempt", async () => {
    const f = await fixture();
    const turn = await send(f, "Morning.");
    await commitSent(turn.snapshot!, "Morning to you.");
    await editChatTurn(f.userId, turn.userMessage.id, "Evening.");
    expect(await correctionEvents(turn.snapshot!.turnId)).toEqual([
      { exchangeId: turn.snapshot!.turnId, correctionType: "edited", correctionRevision: 1, userId: f.userId },
    ]);
    expect(await prisma.mainOutboxEvent.count({
      where: { id: `product_metric_chat_exchange_correction_${turn.snapshot!.turnId}_edited_1`, eventType: "product.event.persisted.v2" },
    })).toBe(1);
  });

  it("records a deleted message", async () => {
    const f = await fixture();
    const turn = await send(f, "Coffee?");
    await commitSent(turn.snapshot!, "Always.");
    await deleteChatMessage(f.userId, turn.assistant.id);
    expect(await correctionEvents(turn.snapshot!.turnId)).toEqual([{
      exchangeId: turn.snapshot!.turnId, correctionType: "deleted", correctionRevision: 1, userId: f.userId,
      sessionId: f.sessionId, messageIds: [turn.userMessage.id, turn.assistant.id],
    }]);
  });

  it("supersedes every counted exchange of a deleted session", async () => {
    const f = await fixture();
    const turn = await send(f, "Morning.");
    await commitSent(turn.snapshot!, "Morning to you.");
    await deleteChatSession(f.userId, f.sessionId);
    expect(await correctionEvents(turn.snapshot!.turnId)).toEqual([
      expect.objectContaining({ correctionType: "superseded", correctionRevision: 1, sessionId: f.sessionId }),
    ]);
  });

  // INTENT: 删会话在持 users 行锁的事务里逐轮写修正，每轮 4 次往返时上千轮的会话会撞 5s 事务超时、删不掉。
  // 4000 轮：本机逐轮写约 1.8s/千轮，4000 轮在旧写法下稳定越过 5s；批量写约 0.3s/千轮。
  it("deletes a four-thousand-Turn session inside the transaction timeout", async () => {
    const f = await fixture();
    const session = await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } });
    const now = new Date();
    const turns = Array.from({ length: 4_000 }, (_, index) => ({
      id: `${f.sessionId}-long-${index}`,
      sessionId: f.sessionId,
      idempotencyKey: `long-${index}`,
      requestHash: `long-hash-${index}`,
      userMessageId: `${f.sessionId}-long-user-${index}`,
      assistantMessageId: `${f.sessionId}-long-assistant-${index}`,
      userContent: "Earlier message.",
      assistantContent: "Earlier reply.",
      assistantStatus: "sent",
      origin: "user",
      memoryEnabled: false,
      statsCountedAt: now,
      characterContentVersionId: session.characterContentVersionId,
      createdAt: new Date(now.getTime() - (4_000 - index) * 1_000),
    }));
    await prisma.chatTurn.createMany({ data: turns });
    // Resolving is the assertion: the old per-Turn writes threw P2028 (transaction timeout).
    await deleteChatSession(f.userId, f.sessionId);
    expect(await prisma.analyticsEvent.count({
      where: { name: "chat.exchange.corrected.v2", sourceService: "main", sourceEventId: { startsWith: `chat_exchange_correction:${f.sessionId}-long-` } },
    })).toBe(4_000);
    expect(await prisma.mainOutboxEvent.count({
      where: { id: { startsWith: `product_metric_chat_exchange_correction_${f.sessionId}-long-` } },
    })).toBe(4_000);
    expect(await correctionEvents(turns[0].id)).toEqual([
      { exchangeId: turns[0].id, correctionType: "superseded", correctionRevision: 1, userId: f.userId, sessionId: f.sessionId, messageIds: [turns[0].userMessageId, turns[0].assistantMessageId] },
    ]);
  }, 30_000);

  it("records nothing for an exchange that never delivered a reply", async () => {
    const f = await fixture();
    const failed = await send(f, "Morning.");
    await commitFailed(failed.snapshot!);
    await editChatTurn(f.userId, failed.userMessage.id, "Evening.");
    expect(await correctionEvents(failed.snapshot!.turnId)).toEqual([]);
  });
});
