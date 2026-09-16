import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { reclaimStalledChatAgentRuns } from "./agent-run-admission";
import { beginChatTurn, createChatSession } from "./turn-ledger";

const prefix = `zt-stalled-attempt-${randomUUID()}-`;

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
    name: "Mira",
    age: 28,
    gender: "female",
    characterPromise: "A warm companion",
    detailsMarkdown: "Warm and curious.",
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
  return { userId, sessionId: session.id };
}

/** Reproduce a Chat process that died after admission: generating, then silence. */
async function abandonInGenerating(turnId: string, ageMs: number) {
  const stalledAt = new Date(Date.now() - ageMs);
  await prisma.$executeRaw`
    UPDATE "chat_turns"
       SET "assistantStatus" = 'generating', "updatedAt" = ${stalledAt}
     WHERE id = ${turnId}
  `;
}

describe("reclaiming an abandoned Chat attempt", () => {
  // SPEC: `generating` 是唯一一个进得去出不来的已接纳状态。
  // INTENT: pending 调度器只认 pending，所以 Chat 在接纳之后死掉就没人再碰这行。
  // 更糟的是并发闸会因此永久拒绝这个关系的下一条消息 —— 用户看到的是一个
  // 永远转不完的气泡，加上一句「A reply is already generating」。
  it("ends the Turn, releases the relationship and asks Chat to stop", async () => {
    const f = await fixture();
    const begun = await beginChatTurn({
      userId: f.userId,
      sessionId: f.sessionId,
      content: "Are you there?",
      idempotencyKey: randomUUID(),
    });
    const turnId = begun.snapshot!.turnId;
    await abandonInGenerating(turnId, 7 * 60_000);

    // 闸门确实卡死了：修之前这就是用户永远发不出下一句的原因。
    await expect(
      beginChatTurn({
        userId: f.userId,
        sessionId: f.sessionId,
        content: "Hello?",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(AppError);

    expect(await reclaimStalledChatAgentRuns(50)).toEqual({ reclaimed: 1 });

    const reclaimed = await prisma.chatTurn.findUniqueOrThrow({ where: { id: turnId } });
    expect(reclaimed.assistantStatus).toBe("failed");
    expect(reclaimed.terminalAt).not.toBeNull();
    expect(reclaimed.terminalEvidence).toMatchObject({
      authority: "main_stalled_attempt_reclaim",
    });

    // 同一事务写出的 durable cancel intent，让仍然活着但很慢的 Chat 停下来。
    expect(
      await prisma.mainOutboxEvent.count({
        where: { aggregateId: turnId, eventType: { contains: "cancel" } },
      }),
    ).toBe(1);

    // 关系恢复可用 —— 这才是用户真正感受到的修复。
    const next = await beginChatTurn({
      userId: f.userId,
      sessionId: f.sessionId,
      content: "Hello?",
      idempotencyKey: randomUUID(),
    });
    expect(next.snapshot).not.toBeNull();
  });

  it("leaves an attempt that is still inside its deadline alone", async () => {
    const f = await fixture();
    const begun = await beginChatTurn({
      userId: f.userId,
      sessionId: f.sessionId,
      content: "Still thinking?",
      idempotencyKey: randomUUID(),
    });
    await abandonInGenerating(begun.snapshot!.turnId, 60_000);

    expect(await reclaimStalledChatAgentRuns(50)).toEqual({ reclaimed: 0 });
    expect(
      (await prisma.chatTurn.findUniqueOrThrow({ where: { id: begun.snapshot!.turnId } }))
        .assistantStatus,
    ).toBe("generating");
  });

  // 扫描和加锁之间 Chat 可能刚好提交了终态；那条真实终态不能被覆盖。
  it("does not overwrite a reply that arrived before the lock", async () => {
    const f = await fixture();
    const begun = await beginChatTurn({
      userId: f.userId,
      sessionId: f.sessionId,
      content: "Made it?",
      idempotencyKey: randomUUID(),
    });
    await abandonInGenerating(begun.snapshot!.turnId, 7 * 60_000);
    await prisma.chatTurn.update({
      where: { id: begun.snapshot!.turnId },
      data: { assistantStatus: "sent", assistantContent: "I'm here.", terminalAt: new Date() },
    });

    expect(await reclaimStalledChatAgentRuns(50)).toEqual({ reclaimed: 0 });
    const settled = await prisma.chatTurn.findUniqueOrThrow({
      where: { id: begun.snapshot!.turnId },
    });
    expect(settled.assistantStatus).toBe("sent");
    expect(settled.assistantContent).toBe("I'm here.");
  });
});
