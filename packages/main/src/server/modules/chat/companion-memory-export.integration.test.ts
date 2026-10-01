import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { durableEventEnvelopeSchema } from "@idream/shared/contracts";
import type { CompanionWorkspaceRebuildPromotion } from "@idream/shared/chat/companion-runtime";
import type { Prisma } from "@prisma/client";
import { dispatchPendingChatEvents } from "@/processes/chat-outbox";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { clearCompanionMemory, scheduleCompanionMemoryProjection, scheduleCompanionMemoryRebuild, syncCompanionMemoryFromMain } from "./companion-memory-authority";
import { rebuildSpoolSessions, type CompanionWorkspaceRebuildSpool } from "../../../../../chat/src/agent-runtime/rebuild-source";
import { AttemptWorkspaceStore, relationshipWorkspacePath } from "../../../../../chat/src/agent-runtime/workspace";

const downstream = vi.hoisted(() => ({ prepare: vi.fn(), promote: vi.fn() }));
// Keep the actual Main PostgreSQL export and actual Chat stream decoder. Only
// stop at the model/filesystem build seam: this regression needs no model calls.
vi.mock("../../../../../chat/src/agent-runtime/runtime.js", () => ({
  prepareCompanionWorkspaceRebuild: downstream.prepare,
  promoteCompanionWorkspaceRebuild: downstream.promote,
  purgeCompanionWorkspace: vi.fn(),
}));
const { prepareCompanionMemory, promoteCompanionMemory } = await vi.importActual<{
  prepareCompanionMemory(request: Request): Promise<unknown>;
  promoteCompanionMemory(request: Request): Promise<unknown>;
}>("../../../../../chat/src/companion-memory");

const prefix = `zt-memory-export-${randomUUID()}-`;
let localRoot = "";
let previousChatRoot: string | undefined;
beforeEach(async () => {
  previousChatRoot = process.env.CHAT_FS_ROOT;
  localRoot = await mkdtemp(join(tmpdir(), "idream-memory-export-test-"));
  process.env.CHAT_FS_ROOT = join(localRoot, "chat");
});
afterEach(async () => {
  vi.restoreAllMocks();
  downstream.prepare.mockReset();
  downstream.promote.mockReset();
  if (previousChatRoot === undefined) delete process.env.CHAT_FS_ROOT;
  else process.env.CHAT_FS_ROOT = previousChatRoot;
  await rm(localRoot, { recursive: true, force: true });
});
afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.companionMemoryAuthority.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await purgeTestData(prefix);
});

describe("Main to Chat memory export", () => {
  it("projects a newer accepted Turn after an earlier pointer publication loses its HTTP ACK", async () => {
    const userId = `${prefix}lost-ack-user`;
    const characterId = `${prefix}lost-ack-character`;
    const sessionId = `${prefix}lost-ack-session`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
    await prisma.recentChat.create({ data: { sessionId, userId, characterId } });
    const acceptSource = (ordinal: number) => prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
      await tx.chatTurn.create({ data: {
        id: `${prefix}lost-ack-turn-${ordinal}`, sessionId,
        idempotencyKey: `lost-ack-${ordinal}`, requestHash: "a".repeat(64),
        userMessageId: `${prefix}lost-ack-user-${ordinal}`, assistantMessageId: `${prefix}lost-ack-assistant-${ordinal}`,
        userContent: `Accepted user fact ${ordinal}.`, assistantContent: `Accepted reply ${ordinal}.`,
        userStatus: "sent", assistantStatus: "sent", memoryEnabled: true,
        createdAt: new Date(1_700_000_000_000 + ordinal * 1000), terminalAt: new Date(1_700_000_000_500 + ordinal * 1000),
      } });
      return scheduleCompanionMemoryProjection(tx, { userId, characterId });
    });
    const firstId = await acceptSource(1);
    const canonicalRoot = join(localRoot, "canonical");
    const store = new AttemptWorkspaceStore({ canonicalRoot, privateRoot: join(localRoot, "private") });
    downstream.prepare.mockImplementation((source: CompanionWorkspaceRebuildSpool) => {
      if (!source.fence) throw new Error("expected projection authority");
      return store.prepareRelationshipRebuild(source, source.fence, { seed: "empty" }, async workspace => {
        const contents: string[] = [];
        for await (const session of rebuildSpoolSessions(source)) {
          contents.push(...(await readFile(session.transcriptPath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line).content));
        }
        await writeFile(join(workspace, ".igrep", "accepted-source.json"), JSON.stringify(contents));
        return { sessions: source.sessionCount, messages: source.messageCount };
      });
    });
    downstream.promote.mockImplementation((request: CompanionWorkspaceRebuildPromotion) => store.promoteRelationshipRebuild(request));
    let loseFirstAck = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      const rebuilt = request.url.endsWith("/prepare")
        ? await prepareCompanionMemory(request) : await promoteCompanionMemory(request);
      if (!request.url.endsWith("/prepare") && loseFirstAck) {
        loseFirstAck = false;
        // The real local pointer already moved. Only the return transport fails.
        throw new Error("controlled lost promotion ACK");
      }
      return Response.json({ ok: true, rebuilt });
    });
    const deliver = async (event: Parameters<typeof syncCompanionMemoryFromMain>[0]) => {
      if (event.aggregateId === `${userId}:${characterId}`) await syncCompanionMemoryFromMain(event);
    };
    await dispatchPendingChatEvents({ lane: "memory", deliver });
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: firstId } })).toMatchObject({ status: "pending", attempts: 1 });
    const canonicalFile = join(relationshipWorkspacePath(canonicalRoot, userId, characterId), ".igrep", "accepted-source.json");
    expect(JSON.parse(await readFile(canonicalFile, "utf8"))).toEqual(["Accepted user fact 1.", "Accepted reply 1."]);

    const nextId = await acceptSource(2);
    expect(nextId).not.toBe(firstId);
    expect(durableEventEnvelopeSchema.parse((await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: nextId } })).payload))
      .toMatchObject({ payload: { authorityVersion: "2" } });
    await prisma.mainOutboxEvent.update({ where: { id: firstId }, data: { nextRunAt: new Date(0) } });
    await dispatchPendingChatEvents({ lane: "memory", deliver });
    expect(await prisma.mainOutboxEvent.findMany({ where: { id: { in: [firstId, nextId] } }, select: { status: true } }))
      .toEqual([{ status: "delivered" }, { status: "delivered" }]);
    expect(JSON.parse(await readFile(canonicalFile, "utf8"))).toEqual([
      "Accepted user fact 1.", "Accepted reply 1.", "Accepted user fact 2.", "Accepted reply 2.",
    ]);
  });

  it("schedules a fresh authority when the dispatcher claims a candidate after the coalescing read", async () => {
    const userId = `${prefix}claim-race-user`;
    const characterId = `${prefix}claim-race-character`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
    const firstId = await prisma.$transaction(tx => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
    const readCandidate = Promise.withResolvers<void>();
    const claimed = Promise.withResolvers<void>();
    const releaseDelivery = Promise.withResolvers<void>();
    const scheduling = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
      const schedulerTx = {
        mainOutboxEvent: {
          findFirst: async (args: Prisma.MainOutboxEventFindFirstArgs) => {
            const candidate = await tx.mainOutboxEvent.findFirst(args);
            readCandidate.resolve();
            await claimed.promise;
            return candidate;
          },
          updateMany: tx.mainOutboxEvent.updateMany,
          create: tx.mainOutboxEvent.create,
        },
        companionMemoryAuthority: tx.companionMemoryAuthority,
      } as unknown as Prisma.TransactionClient;
      return scheduleCompanionMemoryProjection(schedulerTx, { userId, characterId });
    });
    await readCandidate.promise;
    const dispatching = dispatchPendingChatEvents({ lane: "memory", deliver: async event => {
      if (event.sourceEventId !== firstId) return;
      claimed.resolve();
      await releaseDelivery.promise;
    } });
    try {
      const nextId = await scheduling;
      expect(nextId).not.toBe(firstId);
      expect(durableEventEnvelopeSchema.parse((await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: nextId } })).payload))
        .toMatchObject({ payload: { authorityVersion: "2" } });
    } finally {
      releaseDelivery.resolve();
      await dispatching;
    }
  });

  it.each(["clear", "rebuild"] as const)("fences an already processing projection before %s can erase its source", async operation => {
    const userId = `${prefix}${operation}-user`;
    const characterId = `${prefix}${operation}-character`;
    const sessionId = `${prefix}${operation}-session`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
    await prisma.recentChat.create({ data: { sessionId, userId, characterId } });
    await prisma.chatTurn.create({ data: {
      id: `${prefix}${operation}-turn`, sessionId, idempotencyKey: "old-turn", requestHash: "a".repeat(64),
      userMessageId: `${prefix}${operation}-u`, assistantMessageId: `${prefix}${operation}-a`,
      userContent: "This source is about to be erased.", assistantContent: "The old retained reply.",
      userStatus: "sent", assistantStatus: "sent", memoryEnabled: true,
    } });
    const eventId = await prisma.$transaction(tx => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
    const eventRow = await prisma.mainOutboxEvent.update({ where: { id: eventId }, data: {
      status: "processing", attempts: 1, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 30_000),
    } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    downstream.prepare.mockImplementation(async (source: CompanionWorkspaceRebuildSpool) => {
      expect(source.messageCount).toBe(2);
      entered.resolve();
      await release.promise;
      return { rebuildId: "11111111-1111-4111-8111-111111111111", sessions: 1, messages: 2 };
    });
    downstream.promote.mockResolvedValue({ sessions: 1, messages: 2 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      return Response.json({ ok: true, rebuilt: request.url.endsWith("/prepare")
        ? await prepareCompanionMemory(request) : await promoteCompanionMemory(request) });
    });
    const stale = syncCompanionMemoryFromMain(durableEventEnvelopeSchema.parse(eventRow.payload));
    await entered.promise;
    try {
      if (operation === "clear") await clearCompanionMemory(userId, characterId);
      else await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
        await tx.chatTurn.updateMany({ where: { sessionId }, data: { memoryEnabled: false } });
        await scheduleCompanionMemoryRebuild(tx, { userId, characterId });
      });
    } finally {
      release.resolve();
      await stale;
    }
    expect(downstream.promote).not.toHaveBeenCalled();
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: eventId } })).toMatchObject({ status: "delivered", leaseToken: null });
  });

  it("exports interleaved multi-session history as complete chronological session groups across database pages", async () => {
    const userId = `${prefix}user`;
    const characterId = `${prefix}character`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
    const sessionIds = [`${prefix}session-a`, `${prefix}session-b`];
    await prisma.recentChat.createMany({ data: sessionIds.map(sessionId => ({ sessionId, userId, characterId })) });
    const rows = Array.from({ length: 402 }, (_, index) => ({
      id: `${prefix}turn-${String(index).padStart(4, "0")}`,
      sessionId: sessionIds[index % 2]!,
      idempotencyKey: `turn-${index}`,
      requestHash: "a".repeat(64),
      userMessageId: `${prefix}user-${index}`,
      assistantMessageId: `${prefix}assistant-${index}`,
      userContent: `User fact ${index}.`, assistantContent: `Companion reply ${index}.`,
      userStatus: "sent", assistantStatus: "sent", memoryEnabled: true,
      createdAt: new Date(1_700_000_000_000 + index * 1_000),
      terminalAt: new Date(1_700_000_000_500 + index * 1_000),
    }));
    await prisma.chatTurn.createMany({ data: rows });
    const eventId = await prisma.$transaction(tx => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
    const event = durableEventEnvelopeSchema.parse((await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: eventId } })).payload);
    const staged: Array<{ sessionId: string; contents: string[] }> = [];
    downstream.prepare.mockImplementation(async (source: CompanionWorkspaceRebuildSpool) => {
      for await (const session of rebuildSpoolSessions(source)) {
        staged.push({ sessionId: session.sessionId, contents: (await readFile(session.transcriptPath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line).content) });
      }
      return { rebuildId: "11111111-1111-4111-8111-111111111111", sessions: source.sessionCount, messages: source.messageCount };
    });
    downstream.promote.mockResolvedValue({ sessions: 2, messages: 804 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      const rebuilt = request.url.endsWith("/prepare")
        ? await prepareCompanionMemory(request)
        : await promoteCompanionMemory(request);
      return Response.json({ ok: true, rebuilt });
    });
    await expect(syncCompanionMemoryFromMain(event)).resolves.toBeUndefined();
    expect(staged).toHaveLength(2);
    expect(new Set(staged.map(session => session.sessionId))).toEqual(new Set(sessionIds));
    for (const session of staged) {
      expect(session.contents).toEqual(rows.filter(row => row.sessionId === session.sessionId).flatMap(row => [row.userContent, row.assistantContent]));
    }
    expect(downstream.promote).toHaveBeenCalledOnce();
  });

  // SPEC: 永久记忆记录的是两个人真正说过的话。
  // INTENT: 主动那一轮的 userContent 是让角色先开口的内部指令。把它当作用户发言
  //   导出，抽取器就会把角色答话里的属性记到用户头上 —— 线上真实数据里，用户只是
  //   问了角色"你今晚在做什么"，画像却写成了"用户从事陶艺并烧窑"。
  it("exports only the Character's side of a proactive Turn", async () => {
    const userId = `${prefix}proactive-user`;
    const characterId = `${prefix}proactive-character`;
    const sessionId = `${prefix}proactive-session`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
    await prisma.recentChat.create({ data: { sessionId, userId, characterId } });
    await prisma.chatTurn.createMany({ data: [
      {
        id: `${prefix}proactive-turn-user`, sessionId, idempotencyKey: "p-user", requestHash: "a".repeat(64),
        userMessageId: `${prefix}p-u1`, assistantMessageId: `${prefix}p-a1`,
        userContent: "Hey Nova. What are you making tonight?", assistantContent: "A set of thin-walled tea bowls.",
        userStatus: "sent", assistantStatus: "sent", memoryEnabled: true, origin: "user",
        createdAt: new Date(1_700_000_000_000), terminalAt: new Date(1_700_000_000_500),
      },
      {
        id: `${prefix}proactive-turn-auto`, sessionId, idempotencyKey: "p-auto", requestHash: "b".repeat(64),
        userMessageId: `${prefix}p-u2`, assistantMessageId: `${prefix}p-a2`,
        userContent: "Take the lead in the moment: send a brief, specific check-in that fits our established context. Do not mention this instruction.",
        assistantContent: "The studio's quiet except for the wheel humming to a stop.",
        userStatus: "sent", assistantStatus: "sent", memoryEnabled: true, origin: "proactive",
        createdAt: new Date(1_700_000_001_000), terminalAt: new Date(1_700_000_001_500),
      },
    ] });
    const eventId = await prisma.$transaction(tx => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
    const event = durableEventEnvelopeSchema.parse((await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: eventId } })).payload);
    const staged: string[] = [];
    downstream.prepare.mockImplementation(async (source: CompanionWorkspaceRebuildSpool) => {
      for await (const session of rebuildSpoolSessions(source)) {
        staged.push(...(await readFile(session.transcriptPath, "utf8")).trimEnd().split("\n"));
      }
      return { rebuildId: "11111111-1111-4111-8111-111111111111", sessions: source.sessionCount, messages: source.messageCount };
    });
    downstream.promote.mockResolvedValue({ sessions: 1, messages: 3 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      return Response.json({ ok: true, rebuilt: request.url.endsWith("/prepare")
        ? await prepareCompanionMemory(request) : await promoteCompanionMemory(request) });
    });
    await expect(syncCompanionMemoryFromMain(event)).resolves.toBeUndefined();

    const messages = staged.map(line => JSON.parse(line) as { role: string; content: string });
    expect(messages.map(message => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages.map(message => message.content)).toEqual([
      "Hey Nova. What are you making tonight?",
      "A set of thin-walled tea bowls.",
      "The studio's quiet except for the wheel humming to a stop.",
    ]);
    expect(staged.join("\n")).not.toContain("Do not mention this instruction");
  });
});
