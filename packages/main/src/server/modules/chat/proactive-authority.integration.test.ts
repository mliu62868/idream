import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import {
  beginChatTurn,
  commitChatTerminal,
  createChatSession,
  getChatSession,
  listChatSessions,
} from "./turn-ledger";

const prefix = `zt-proactive-authority-${randomUUID()}-`;

afterAll(async () => {
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
async function exhaustDailyAllowance(userId: string, sessionId: string) {
  const productDay = new Date(
    Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    ),
  );
  const turns = Array.from({ length: FREE_DAILY_MESSAGES }, (_, index) => ({
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
