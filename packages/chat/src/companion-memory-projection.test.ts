import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANION_WORKSPACE_REBUILD_MAX_TIMEOUT_MS } from "@idream/shared/chat/companion-runtime";
import type { Prisma } from "../generated/client/client.js";
import type {
  RelationshipLinkage,
  RelationshipMessage,
} from "./relationship-authority.js";
import {
  applyCompanionMemoryProjection,
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
      { kind: "relationship_delete", characterId: "character-1" },
      { purge, rebuild },
    );
    await applyCompanionMemoryProjection(
      {} as Prisma.TransactionClient,
      "user-1",
      { kind: "account_delete" },
      { purge, rebuild },
    );

    expect(purge.mock.calls).toEqual([
      [{ scope: "relationship", userId: "user-1", characterId: "character-1" }],
      [{ scope: "user", userId: "user-1" }],
    ]);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("delegates one fenced rebuild for retained canonical rows", async () => {
    const purge = vi.fn();
    const rebuild = vi.fn(async () => ({ sessions: 0, messages: 0 }));
    const tx = {
      chatSession: { findMany: vi.fn(async () => []) },
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

  it("keeps projection timeout above every rebuild budget near a turn deadline", () => {
    process.env.DSH_AGENT_TOKEN = "cleanup-token";
    process.env.DSH_AGENT_DEADLINE_MS = "7000";
    expect(companionMemoryProjectionTimeoutMs()).toBe(
      COMPANION_WORKSPACE_REBUILD_MAX_TIMEOUT_MS + 30_000,
    );
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
});
