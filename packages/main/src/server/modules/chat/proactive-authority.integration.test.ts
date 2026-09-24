import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import { chatExchangeCompletedV2Schema, chatExchangeCorrectionV2Schema } from "@idream/shared/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
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

async function fixture() {
  const userId = `${prefix}${randomUUID()}`;
  await createUser({ id: userId });
  const character = await createCharacter({
    id: `${userId}-character`,
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

// SPEC: 额度只看 usage fact 本身；删消息/删会话不退额度，没拿到回复的 Turn 不扣额度。
describe("daily allowance ledger", () => {
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
    await commitSent(regenerated.snapshot, "Here I am.");
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId: failed.snapshot!.turnId } }))
      .toMatchObject({ voidedAt: null });
    await expect(send(f)).rejects.toMatchObject({ status: 402 });
  });

  it("frees the allowance of a Turn cancelled before Chat ran it", async () => {
    const f = await fixture();
    await exhaustDailyAllowance(f.userId, f.sessionId, FREE_DAILY_MESSAGES - 1);
    const cancelled = await send(f);
    await cancelChatTurn(f.userId, cancelled.assistant.id);
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
    await cancelChatTurn(f.userId, streaming.assistant.id);
    expect(await prisma.chatTurnUsageFact.findUniqueOrThrow({ where: { turnId: streaming.snapshot!.turnId } }))
      .toMatchObject({ voidedAt: null });
  });

  // SPEC: 清空记忆取消进行中的回复，与用户点 Stop 同口径：Chat 还没受理的不扣额度。
  it("frees the allowance of a Turn that clearing memory cancelled before Chat ran it", async () => {
    const f = await fixture();
    const pending = await send(f);
    await clearCompanionMemory(f.userId, f.characterId);
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: pending.snapshot!.turnId } }))
      .toMatchObject({ assistantStatus: "cancelled" });
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
    await clearCompanionMemory(f.userId, f.characterId);
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
    await createUser({ id: creatorId });
    await createUser({ id: userId });
    const character = await createCharacter({ id: `${creatorId}-character`, creatorId, source: "user", visibility: "public" });
    const soul = compileCharacterSoul({
      name: "Nova", age: 31, gender: "female", characterPromise: "A ceramicist who works late.", detailsMarkdown: "Unhurried and specific.",
    });
    if (!soul.ok) throw new Error("Invalid fixture Soul");
    const project = await prisma.characterProject.create({ data: { characterId: character.id } });
    const release = async (version: number) => {
      const content = await prisma.characterContentVersion.create({ data: {
        characterId: character.id, version, sourceType: "test", contentHash: `${soul.snapshot.compiled.fingerprint}-${version}`,
        personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {},
      } });
      return prisma.characterRelease.create({ data: {
        projectId: project.id, revisionId: `${character.id}-revision-${version}`, characterContentVersionId: content.id,
        generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: `${character.id}-hash-${version}`,
        status: "published", publishedAt: new Date(),
      } });
    };
    const first = await release(1);
    await prisma.characterServing.create({ data: { characterId: character.id, currentReleaseId: first.id, state: "live" } });
    const moveServing = async () => {
      const next = await release(2);
      await prisma.characterRelease.update({ where: { id: first.id }, data: { status: "superseded" } });
      await prisma.characterServing.update({ where: { characterId: character.id }, data: { currentReleaseId: next.id } });
      return next;
    };
    return { userId, characterId: character.id, moveServing };
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

  // SPEC: 旧会话里继续发消息，410 要告诉前端「角色更新了、去哪继续」，且什么都没扣。
  it("tells the page where to continue when an old session sends after the update, without admitting or charging", async () => {
    const f = await publicFixture();
    const session = await createChatSession(f.userId, { characterId: f.characterId });
    const next = await f.moveServing();

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

  it("records nothing for an exchange that never delivered a reply", async () => {
    const f = await fixture();
    const failed = await send(f, "Morning.");
    await commitFailed(failed.snapshot!);
    await editChatTurn(f.userId, failed.userMessage.id, "Evening.");
    expect(await correctionEvents(failed.snapshot!.turnId)).toEqual([]);
  });
});
