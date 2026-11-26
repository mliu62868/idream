import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { durableEventEnvelopeSchema } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import {
  companionRelationshipAggregateId,
  scheduleCompanionMemoryProjection,
  scheduleCompanionMemoryRebuild,
  syncCompanionMemoryFromMain,
} from "./companion-memory-authority";

// SPEC: memory promotion is fenced by the relationship authority row, not the
// user's row. These tests drive the real Main fence against PostgreSQL and stop
// only at the Chat HTTP seam.
const prefix = `zt-memory-fence-${randomUUID()}-`;

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.companionMemoryAuthority.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await purgeTestData(prefix);
});

async function relationship(name: string) {
  const userId = `${prefix}${name}-user`;
  const characterId = `${prefix}${name}-character`;
  const sessionId = `${prefix}${name}-session`;
  await createUser({ id: userId });
  await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
  await prisma.recentChat.create({ data: { sessionId, userId, characterId } });
  await prisma.chatTurn.create({ data: {
    id: `${prefix}${name}-turn`, sessionId, idempotencyKey: `${name}-1`, requestHash: "a".repeat(64),
    userMessageId: `${prefix}${name}-u1`, assistantMessageId: `${prefix}${name}-a1`,
    userContent: "Remember my cat is called Miso.", assistantContent: "Miso, noted.",
    userStatus: "sent", assistantStatus: "sent", memoryEnabled: true, terminalAt: new Date(),
  } });
  return { userId, characterId, aggregateId: companionRelationshipAggregateId(userId, characterId) };
}

async function envelope(eventId: string) {
  const row = await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: eventId } });
  return durableEventEnvelopeSchema.parse(row.payload);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type ChatStub = {
  onPrepare?: () => Promise<void>;
  onPromote?: () => Promise<void>;
};

function stubChat(stub: ChatStub = {}) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/rebuild/prepare") || url.endsWith("/prepare")) {
      calls.push("prepare");
      // Drain the real Main export so its PostgreSQL reads complete.
      if (init?.body) await new Response(init.body as BodyInit).text();
      await stub.onPrepare?.();
      return Response.json({ ok: true, rebuilt: { rebuildId: randomUUID() } });
    }
    if (url.includes("promote")) {
      calls.push("promote");
      await stub.onPromote?.();
      return Response.json({ ok: true, rebuilt: { sessions: 1, messages: 2 } });
    }
    if (url.includes("/purge")) {
      calls.push("purge");
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected Chat call ${url}`);
  });
  return calls;
}

describe("companion memory promotion fence", () => {
  it("promotes while the user's row stays free and holds only the relationship row", async () => {
    const { userId, characterId, aggregateId } = await relationship("free-user");
    const eventId = await prisma.$transaction((tx) => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
    const promoteStarted = deferred();
    const releasePromote = deferred();
    const calls = stubChat({
      onPromote: async () => {
        promoteStarted.resolve();
        await releasePromote.promise;
      },
    });
    const sync = syncCompanionMemoryFromMain(await envelope(eventId));
    await promoteStarted.promise;

    // Any user mutation (send, terminal commit, Stop) takes this row first.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    });
    // A relationship-memory mutation waits for the in-flight promote instead.
    await expect(prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "version" FROM "companion_memory_authorities" WHERE "aggregateId" = ${aggregateId} FOR UPDATE NOWAIT`;
    })).rejects.toThrow();

    releasePromote.resolve();
    await sync;
    expect(calls).toEqual(["prepare", "promote"]);
  });

  it("rejects a projection whose relationship was destructively changed during prepare", async () => {
    const { userId, characterId } = await relationship("destroyed");
    const eventId = await prisma.$transaction((tx) => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
    const calls = stubChat({
      onPrepare: async () => {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
          await scheduleCompanionMemoryRebuild(tx, { userId, characterId, purgeTurnIds: [`${prefix}destroyed-turn`] });
        });
      },
    });
    await syncCompanionMemoryFromMain(await envelope(eventId));
    expect(calls).toEqual(["prepare"]);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: eventId } }))
      .resolves.toMatchObject({ status: "delivered", lastError: { supersededBy: "destructive_memory_rebuild" } });
  });

  it("skips a stale projection version, including one that advanced during prepare", async () => {
    const { userId, characterId, aggregateId } = await relationship("stale");
    const firstId = await prisma.$transaction((tx) => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
    // A claimed projection cannot absorb newer Turns; the next one takes a new authority.
    await prisma.mainOutboxEvent.update({ where: { id: firstId }, data: { status: "processing", attempts: 1 } });
    const secondId = await prisma.$transaction((tx) => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
    expect(secondId).not.toBe(firstId);
    const calls = stubChat();
    await syncCompanionMemoryFromMain(await envelope(firstId));
    expect(calls).toEqual([]);

    const racing = stubChat({
      onPrepare: async () => {
        await prisma.mainOutboxEvent.update({ where: { id: secondId }, data: { attempts: 1 } });
        await prisma.$transaction((tx) => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
      },
    });
    await syncCompanionMemoryFromMain(await envelope(secondId));
    expect(racing).toEqual(["prepare"]);
    await expect(prisma.companionMemoryAuthority.findUniqueOrThrow({ where: { aggregateId } }))
      .resolves.toMatchObject({ version: BigInt(3) });
  });

  it("still promotes a rebuild after a later projection advanced the authority", async () => {
    const { userId, characterId } = await relationship("rebuild");
    const rebuildId = await prisma.$transaction((tx) =>
      scheduleCompanionMemoryRebuild(tx, { userId, characterId, purgeTurnIds: [`${prefix}rebuild-gone`] }));
    // A Turn sent during the rebuild schedules a projection seeded from canonical
    // memory; it cannot carry the rebuild's deletion, so the rebuild must publish.
    await prisma.$transaction((tx) => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
    const calls = stubChat();
    await syncCompanionMemoryFromMain(await envelope(rebuildId));
    expect(calls).toEqual(["purge", "prepare", "promote"]);
  });

  it("drops a promotion once account erasure removed the relationship authority", async () => {
    const { userId, characterId, aggregateId } = await relationship("erased");
    const eventId = await prisma.$transaction((tx) =>
      scheduleCompanionMemoryRebuild(tx, { userId, characterId }));
    const calls = stubChat({
      onPrepare: async () => {
        await prisma.companionMemoryAuthority.deleteMany({ where: { aggregateId } });
      },
    });
    await syncCompanionMemoryFromMain(await envelope(eventId));
    expect(calls).toEqual(["prepare"]);
  });
});
