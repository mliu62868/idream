import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../generated/client/client.js";
import type {
  RelationshipLinkage,
  RelationshipMessage,
} from "./relationship-authority.js";
import {
  applyCompanionMemoryProjection,
  buildCompanionWorkspaceRebuild,
  canonicalCompanionMessages,
  companionMemoryProjectionTimeoutMs,
} from "./companion-memory-projection.js";
import {
  recordChatFileMutation,
} from "./file-mutations.js";

const originalToken = process.env.DSH_AGENT_TOKEN;
const originalDeadline = process.env.DSH_AGENT_DEADLINE_MS;

afterEach(() => {
  if (originalToken === undefined) delete process.env.DSH_AGENT_TOKEN;
  else process.env.DSH_AGENT_TOKEN = originalToken;
  if (originalDeadline === undefined) delete process.env.DSH_AGENT_DEADLINE_MS;
  else process.env.DSH_AGENT_DEADLINE_MS = originalDeadline;
  vi.restoreAllMocks();
});

function message(
  input: Partial<RelationshipMessage> & Pick<RelationshipMessage, "id" | "role">,
): RelationshipMessage {
  return {
    sessionId: "session-1",
    status: "sent",
    safetyStatus: "passed",
    attempt: 1,
    content: `${input.role}-${input.id}`,
    replyToMessageId: null,
    memoryAuthority: input.role === "assistant" ? "enabled" : "legacy_unknown",
    memoryExtractedAttempt: 0,
    createdAt: new Date(`2026-08-19T12:00:0${input.id.at(-1) ?? "0"}.000Z`),
    deletedAt: null,
    ...input,
  };
}

describe("companion memory projection", () => {
  it("replays only complete, unambiguous, memory-enabled canonical exchanges", () => {
    const user = message({ id: "user-1", role: "user" });
    const assistant = message({ id: "assistant-2", role: "assistant" });
    const deletedUser = message({
      id: "user-3",
      role: "user",
      deletedAt: new Date("2026-08-19T12:01:00.000Z"),
    });
    const deletedSourceAssistant = message({ id: "assistant-4", role: "assistant" });
    const privateAssistant = message({
      id: "assistant-5",
      role: "assistant",
      memoryAuthority: "disabled",
    });
    const linkage: RelationshipLinkage = {
      sources: new Map([
        [assistant.id, user],
        [deletedSourceAssistant.id, deletedUser],
        [privateAssistant.id, user],
      ]),
      ambiguousAssistantIds: [],
      candidateSourceIds: new Map(),
    };

    expect(canonicalCompanionMessages([{
      id: "session-1",
      messages: [privateAssistant, deletedSourceAssistant, assistant, deletedUser, user],
      linkage,
    }])).toEqual([
      expect.objectContaining({ id: "user-1", role: "user" }),
      expect.objectContaining({ id: "assistant-2", role: "assistant" }),
    ]);
  });

  it("purges relationship and user workspaces through the only cleanup port", async () => {
    const purge = vi.fn(async () => ({ purged: 1 }));
    const rebuild = vi.fn();

    await applyCompanionMemoryProjection(
      {} as Prisma.TransactionClient,
      "user-1",
      { kind: "relationship_delete", characterId: "character-1", quarantine: "filemut_reset_1" },
      { purge, rebuild },
    );
    await applyCompanionMemoryProjection(
      {} as Prisma.TransactionClient,
      "user-1",
      { kind: "account_delete" },
      { purge, rebuild },
    );

    // A reset retires the relationship workspace under the ledger id; an
    // account purge destroys the user directory, quarantine included.
    expect(purge.mock.calls).toEqual([
      [{ scope: "relationship", userId: "user-1", characterId: "character-1", quarantine: "filemut_reset_1" }],
      [{ scope: "user", userId: "user-1" }],
    ]);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("delegates one fenced rebuild for retained canonical rows", async () => {
    const purge = vi.fn();
    const rebuild = vi.fn(async () => ({ sessions: 0, messages: 0 }));
    const tx = {
      chatSession: { findMany: vi.fn(async () => []) },
      message: { findMany: vi.fn(async () => []) },
      chatSendReceipt: { findMany: vi.fn(async () => []) },
      chatFileMutation: { findMany: vi.fn(async () => []) },
    } as unknown as Prisma.TransactionClient;

    await applyCompanionMemoryProjection(
      tx,
      "user-1",
      { kind: "relationship_rebuild", characterId: "character-1" },
      { purge, rebuild },
    );

    expect(purge).not.toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledWith({
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      messages: [],
    });
  });

  it("loads a relationship with many sessions in a fixed four-query snapshot", async () => {
    const sessionCount = 10_001;
    const sessions = Array.from({ length: sessionCount }, (_, index) => ({
      id: `session-${index}`,
    }));
    const messages = sessions.flatMap(({ id }, index) => {
      const user = message({
        id: `user-${index}`,
        sessionId: id,
        role: "user",
        createdAt: new Date(1_787_169_600_000 + index * 2),
      });
      return [
        user,
        message({
          id: `assistant-${index}`,
          sessionId: id,
          role: "assistant",
          replyToMessageId: user.id,
          createdAt: new Date(1_787_169_600_001 + index * 2),
        }),
      ];
    });
    const findSessions = vi.fn(async () => sessions);
    const findMessages = vi.fn(async () => messages);
    const findReceipts = vi.fn(async () => []);
    const findResets = vi.fn(async () => []);
    const tx = {
      chatSession: { findMany: findSessions },
      message: { findMany: findMessages },
      chatSendReceipt: { findMany: findReceipts },
      chatFileMutation: { findMany: findResets },
    } as unknown as Prisma.TransactionClient;

    const rebuilt = await buildCompanionWorkspaceRebuild(tx, {
      userId: "user-many",
      characterId: "character-many",
    });

    expect(rebuilt.messages).toHaveLength(sessionCount * 2);
    expect(rebuilt.messages.at(-1)).toMatchObject({
      id: `assistant-${sessionCount - 1}`,
      sessionId: `session-${sessionCount - 1}`,
    });
    expect(findSessions).toHaveBeenCalledOnce();
    expect(findMessages).toHaveBeenCalledOnce();
    expect(findReceipts).toHaveBeenCalledOnce();
    expect(findResets).toHaveBeenCalledOnce();
  });

  it("drops everything said before a relationship reset, and keeps what came after", async () => {
    const resetAt = new Date("2026-08-19T12:30:00.000Z");
    const before = message({
      id: "user-1",
      role: "user",
      createdAt: new Date("2026-08-19T12:00:00.000Z"),
    });
    const beforeReply = message({
      id: "assistant-2",
      role: "assistant",
      replyToMessageId: before.id,
      createdAt: new Date("2026-08-19T12:00:01.000Z"),
    });
    const after = message({
      id: "user-3",
      role: "user",
      createdAt: new Date("2026-08-19T13:00:00.000Z"),
    });
    const afterReply = message({
      id: "assistant-4",
      role: "assistant",
      replyToMessageId: after.id,
      createdAt: new Date("2026-08-19T13:00:01.000Z"),
    });
    const sessions = [{ id: "session-1" }];
    const messages = [before, beforeReply, after, afterReply];
    const tx = {
      chatSession: { findMany: vi.fn(async () => sessions) },
      message: { findMany: vi.fn(async () => messages) },
      chatSendReceipt: { findMany: vi.fn(async () => []) },
      chatFileMutation: {
        findMany: vi.fn(async () => [
          {
            sequence: 7n,
            createdAt: resetAt,
            payload: { characterId: "character-1" },
          },
        ]),
      },
    } as unknown as Prisma.TransactionClient;

    const rebuilt = await buildCompanionWorkspaceRebuild(tx, {
      userId: "user-1",
      characterId: "character-1",
    });

    expect(rebuilt.messages.map((entry) => entry.id)).toEqual([
      "user-3",
      "assistant-4",
    ]);
  });

  it("keeps a reset scoped to its own character", async () => {
    const early = message({
      id: "user-1",
      role: "user",
      createdAt: new Date("2026-08-19T12:00:00.000Z"),
    });
    const reply = message({
      id: "assistant-2",
      role: "assistant",
      replyToMessageId: early.id,
      createdAt: new Date("2026-08-19T12:00:01.000Z"),
    });
    const tx = {
      chatSession: { findMany: vi.fn(async () => [{ id: "session-1" }]) },
      message: { findMany: vi.fn(async () => [early, reply]) },
      chatSendReceipt: { findMany: vi.fn(async () => []) },
      chatFileMutation: {
        findMany: vi.fn(async () => [
          {
            sequence: 7n,
            createdAt: new Date("2026-08-19T12:30:00.000Z"),
            payload: { characterId: "someone-else" },
          },
        ]),
      },
    } as unknown as Prisma.TransactionClient;

    const rebuilt = await buildCompanionWorkspaceRebuild(tx, {
      userId: "user-1",
      characterId: "character-1",
    });

    expect(rebuilt.messages.map((entry) => entry.id)).toEqual([
      "user-1",
      "assistant-2",
    ]);
  });

  it("keeps DB projection transactions short and independent of turn deadlines", () => {
    process.env.DSH_AGENT_TOKEN = "cleanup-token";
    process.env.DSH_AGENT_DEADLINE_MS = "7000";
    expect(companionMemoryProjectionTimeoutMs()).toBe(120_000);
    expect(companionMemoryProjectionTimeoutMs()).toBeGreaterThan(7_000);
  });

  it("persists the single-authority projection intent without legacy cleanup flags", async () => {
    const executeRaw = vi.fn(async (..._args: unknown[]) => 1);
    const tx = { $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;

    await recordChatFileMutation(tx, "user-1", {
      kind: "relationship_delete",
      characterId: "character-1",
    });

    const persistedPayload = executeRaw.mock.calls[0]?.[4];
    expect(JSON.parse(String(persistedPayload))).toEqual({
      kind: "relationship_delete",
      characterId: "character-1",
    });
  });

  it("rejects legacy prose-summary memory intents before they enter the durable ledger", async () => {
    const executeRaw = vi.fn(async (..._args: unknown[]) => 1);
    const tx = { $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;

    await expect(recordChatFileMutation(tx, "user-1", {
      kind: "memory_extract",
      sessionId: "session-1",
      userMessageId: "user-message-1",
      characterId: "character-1",
      turnKey: "assistant-message-1",
      attempt: 1,
      summaryDelta: "legacy prose must not become a second memory authority",
    } as never)).rejects.toThrow();

    expect(executeRaw).not.toHaveBeenCalled();
  });
});
