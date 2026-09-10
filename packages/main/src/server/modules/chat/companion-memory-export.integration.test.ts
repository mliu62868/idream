import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { durableEventEnvelopeSchema } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { clearCompanionMemory, scheduleCompanionMemoryProjection, scheduleCompanionMemoryRebuild, syncCompanionMemoryFromMain } from "./companion-memory-authority";
import { rebuildSpoolSessions, type CompanionWorkspaceRebuildSpool } from "../../../../../chat/src/agent-runtime/rebuild-source";

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
afterEach(() => {
  vi.restoreAllMocks();
  downstream.prepare.mockReset();
  downstream.promote.mockReset();
});
afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.companionMemoryAuthority.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await purgeTestData(prefix);
});

describe("Main to Chat memory export", () => {
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
});
