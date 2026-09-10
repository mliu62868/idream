import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { scheduleCompanionMemoryProjection } from "@/server/modules/chat/companion-memory-authority";
import { beginChatTurn, createChatSession } from "@/server/modules/chat/turn-ledger";
import { recordMainToChatEvent } from "./chat-outbox";
import { startEventConsumer } from "./event-consumer";

// Registry publication has its own refresh lifecycle and query tests. Keep
// this independent periodic module from changing their certification fixtures;
// all five durable dispatchers below still run against the real test database.
vi.mock("@/server/modules/admin-v2/metrics/refresh", () => ({
  startMetricSnapshotRefresh: () => ({ close: async () => {} }),
}));

const prefix = `zt-event-consumer-${randomUUID()}-`;

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await prisma.mainOutboxEvent.deleteMany({
    where: { OR: [{ id: { startsWith: prefix } }, { aggregateId: { startsWith: prefix } }] },
  });
});

afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({
    where: { OR: [{ id: { startsWith: prefix } }, { aggregateId: { startsWith: prefix } }] },
  });
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.companionMemoryAuthority.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

async function fixture() {
  const userId = `${prefix}${randomUUID()}`;
  await createUser({ id: userId });
  const character = await createCharacter({
    id: `${userId}-character`, creatorId: userId, source: "user", visibility: "private",
  });
  const soul = compileCharacterSoul({
    name: "Mira", age: 28, gender: "female",
    characterPromise: "A warm companion", detailsMarkdown: "Warm and curious.",
  });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const content = await prisma.characterContentVersion.create({
    data: {
      characterId: character.id, version: 1, sourceType: "test",
      contentHash: soul.snapshot.compiled.fingerprint,
      personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)),
      openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {},
    },
  });
  await prisma.character.update({
    where: { id: character.id }, data: { currentContentVersionId: content.id },
  });
  const session = await createChatSession(userId, { characterId: character.id });
  return { userId, characterId: character.id, sessionId: session.id };
}

describe("durable event consumer time isolation", () => {
  it("admits a later Turn and delivers lifecycle intents while an earlier memory projection is still blocked", async () => {
    const f = await fixture();
    const memoryId = await prisma.$transaction((tx) => scheduleCompanionMemoryProjection(tx, f));
    let releaseMemory!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseMemory = resolve; });
    let memoryPreparing = false;
    const delivered: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/internal/companion-memory/rebuild/prepare")) {
        await new Response(init?.body).text();
        memoryPreparing = true;
        await blocked;
        return Response.json({ ok: true, rebuilt: { rebuildId: randomUUID(), messages: 0, sessions: 0 } });
      }
      if (target.endsWith("/internal/companion-memory/rebuild/promote")) {
        return Response.json({ ok: true, rebuilt: { messages: 0, sessions: 0 } });
      }
      if (target.endsWith("/internal/agent-runs")) {
        delivered.push("admission");
        return Response.json({ ok: true }, { status: 202 });
      }
      if (target.endsWith("/cancel")) {
        delivered.push("cancel");
        return Response.json({ ok: true, active: false });
      }
      if (target.endsWith("/internal/companion-memory/purge")) {
        delivered.push("purge");
        return Response.json({ ok: true, purged: 0 });
      }
      if (target.endsWith("/internal/events/account-deletion-v2/ingest")) {
        delivered.push("account-deletion");
        return Response.json({ acknowledged: true, status: "persisted", receiptId: `${prefix}receipt` });
      }
      throw new Error(`Unexpected owned transport: ${target}`);
    }));
    // Only the poll/heartbeat clocks are virtual; Postgres and polling waits
    // use real I/O. The blocked transport is the sole source of latency.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const worker = startEventConsumer();
    try {
      await expect.poll(() => memoryPreparing).toBe(true);
      const begun = await beginChatTurn({
        userId: f.userId, sessionId: f.sessionId,
        content: "Keep talking while memory catches up.", idempotencyKey: randomUUID(),
      });
      expect(begun.snapshot).not.toBeNull();
      await recordMainToChatEvent({
        eventId: `${prefix}later-cancel`,
        eventType: MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1,
        aggregateType: "chat_turn", aggregateId: `${prefix}cancelled-turn`,
        payload: { version: 1, userId: f.userId, turnId: `${prefix}cancelled-turn`, attempt: 1 },
      });
      await recordMainToChatEvent({
        eventId: `${prefix}later-purge`,
        eventType: MAIN_TO_CHAT_EVENTS.companionMemoryPurgeRequestedV1,
        aggregateType: "chat_relationship", aggregateId: `${f.userId}:${f.characterId}`,
        payload: { version: 1, userId: f.userId, characterId: f.characterId },
      });
      await recordMainToChatEvent({
        eventId: `${prefix}later-account-deletion`,
        eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
        schemaVersion: 2, aggregateType: "user", aggregateId: f.userId,
        payload: { userId: f.userId },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect.poll(() => [...delivered].sort(), { timeout: 1_000 }).toEqual([
        "account-deletion", "admission", "cancel", "purge",
      ]);
      await expect(prisma.chatTurn.findUniqueOrThrow({
        where: { id: begun.snapshot!.turnId },
      })).resolves.toMatchObject({ assistantStatus: "generating", admittedAt: expect.any(Date) });
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: memoryId },
      })).resolves.toMatchObject({ status: "processing", attempts: 1 });
    } finally {
      releaseMemory();
      await worker.close();
    }
  });

  it("finishes an in-flight delivery on close without claiming the next durable intent", async () => {
    const firstId = `${prefix}close-first`;
    const secondId = `${prefix}close-second`;
    for (const [index, id] of [firstId, secondId].entries()) {
      await recordMainToChatEvent({
        eventId: id, eventType: MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1,
        aggregateType: "chat_turn", aggregateId: `${prefix}close-turn`,
        payload: { version: 1, userId: `${prefix}user`, turnId: `${prefix}close-turn`, attempt: index + 1 },
      });
      await prisma.mainOutboxEvent.update({
        where: { id }, data: { createdAt: new Date(index), nextRunAt: new Date(0) },
      });
    }
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const delivered: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/1/cancel")) await blocked;
      if (!target.endsWith("/cancel")) throw new Error(`Unexpected owned transport: ${target}`);
      delivered.push(target);
      return Response.json({ ok: true, active: false });
    }));
    const worker = startEventConsumer();
    try {
      await expect.poll(async () => (await prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: firstId },
      })).status).toBe("processing");
      const closing = worker.close();
      // Closing must leave the owned in-flight lease intact until its ACK.
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: firstId },
      })).resolves.toMatchObject({ status: "processing", attempts: 1, leaseToken: expect.any(String) });
      releaseFirst();
      await closing;
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatch(/\/1\/cancel$/u);
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: firstId },
      })).resolves.toMatchObject({ status: "delivered", attempts: 1 });
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: secondId },
      })).resolves.toMatchObject({ status: "pending", attempts: 0, leaseToken: null });
    } finally {
      releaseFirst();
      await worker.close();
    }
  });

  it("rejects close at its deadline without clearing a blocked delivery's live lease", async () => {
    const eventId = `${prefix}close-deadline`;
    await recordMainToChatEvent({
      eventId, eventType: MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1,
      aggregateType: "chat_turn", aggregateId: `${prefix}deadline-turn`,
      payload: { version: 1, userId: `${prefix}user`, turnId: `${prefix}deadline-turn`, attempt: 1 },
    });
    let releaseDelivery!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    let deliveryStarted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (!String(url).endsWith("/cancel")) throw new Error(`Unexpected owned transport: ${url}`);
      deliveryStarted = true;
      await blocked;
      return Response.json({ ok: true, active: false });
    }));
    const worker = startEventConsumer();
    try {
      await expect.poll(() => deliveryStarted).toBe(true);
      const leased = await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: eventId } });
      expect(leased).toMatchObject({ status: "processing", attempts: 1, leaseToken: expect.any(String) });
      // Only the newly scheduled drain deadline is virtual. The remote call
      // remains blocked outside a real PostgreSQL transaction throughout.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let settled = false;
      const outcome = worker.close().then(
        () => { settled = true; return "resolved"; },
        (error: unknown) => { settled = true; return error; },
      );
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ message: "Durable event drain timed out with pending work" });
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: eventId },
      })).resolves.toMatchObject({
        status: "processing", attempts: 1,
        leaseToken: leased.leaseToken, leaseExpiresAt: leased.leaseExpiresAt,
      });
    } finally {
      vi.useRealTimers();
      releaseDelivery();
      await expect.poll(async () => (await prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: eventId },
      })).status).toBe("delivered");
      await worker.close().catch(() => undefined);
    }
  });
});
