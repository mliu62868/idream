import { afterEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { Prisma } from "../generated/client/client.js";
import { createChatPrisma, createChatProjectorPrisma } from "./db.js";
import type {
  RelationshipLinkage,
  RelationshipMessage,
} from "./relationship-authority.js";
import {
  applyCompanionMemoryProjection,
  canonicalCompanionMessages,
  companionWorkspaceCleanupRequired,
  companionMemoryProjectionTimeoutMs,
} from "./companion-memory-projection.js";
import {
  appliedFileMutationReceipt,
  recordChatFileMutation,
} from "./file-mutations.js";

const ENV_KEYS = [
  "CHAT_COMPANION_RUNTIME",
  "CHAT_MEMORY_BACKEND",
  "CHAT_COMPANION_DSH_ROLLOUT_BPS",
  "CHAT_COMPANION_DSH_ROLLOUT_ALLOWLIST",
  "CHAT_COMPANION_DSH_ROLLOUT_SALT",
  "CHAT_COMPANION_DSH_SHADOW_ENABLED",
  "DSH_AGENT_TOKEN",
  "DSH_AGENT_DEADLINE_MS",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

function nativeCleanupEnv(token = "cleanup-token"): void {
  process.env.CHAT_COMPANION_RUNTIME = "native";
  process.env.CHAT_MEMORY_BACKEND = "legacy";
  process.env.CHAT_COMPANION_DSH_ROLLOUT_BPS = "0";
  process.env.CHAT_COMPANION_DSH_ROLLOUT_ALLOWLIST = "";
  process.env.CHAT_COMPANION_DSH_SHADOW_ENABLED = "false";
  process.env.DSH_AGENT_TOKEN = token;
  process.env.DSH_AGENT_DEADLINE_MS = "7000";
  delete process.env.CHAT_COMPANION_DSH_ROLLOUT_SALT;
}

function message(input: Partial<RelationshipMessage> & Pick<RelationshipMessage, "id" | "role">): RelationshipMessage {
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
  it("does not retain cleanup authority in applied privacy receipts", () => {
    expect(appliedFileMutationReceipt({
      kind: "relationship_delete",
      characterId: "character-1",
      companionCleanupRequired: true,
    })).toEqual({
      kind: "relationship_delete",
      characterId: "character-1",
    });
  });

  it("only considers pending cleanup intents when recovering authority", async () => {
    nativeCleanupEnv("");
    const queryRaw = vi.fn(async (..._args: unknown[]) => [{ required: false }]);
    await companionWorkspaceCleanupRequired(
      { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
      "user-1",
      "character-1",
    );
    expect(String(queryRaw.mock.calls[0]?.[0])).toContain("mutation.status = 'pending'");
  });

  it("recognizes a pending cleanup intent and forgets its applied SQL receipt", async () => {
    nativeCleanupEnv("");
    const prisma = createChatPrisma();
    const projector = createChatProjectorPrisma();
    const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mutationId = `cleanup-receipt-${suffix}`;
    const userId = `cleanup-user-${suffix}`;
    const characterId = `cleanup-character-${suffix}`;
    try {
      await superPool.query(
        `INSERT INTO chat.chat_file_mutations (id, user_id, kind, payload)
         VALUES ($1, $2, 'relationship_delete', $3::jsonb)`,
        [mutationId, userId, JSON.stringify({
          kind: "relationship_delete",
          characterId,
          companionCleanupRequired: true,
        })],
      );

      await prisma.$transaction(async (tx) => {
        expect(await companionWorkspaceCleanupRequired(tx, userId, characterId)).toBe(true);
      });

      const updated = await projector.$executeRaw`
        UPDATE chat.chat_file_mutations
        SET status = 'applied',
            payload = chat.redact_file_mutation_payload(id, kind, payload),
            attempts = attempts + 1,
            applied_at = timezone('utc', now())
        WHERE id = ${mutationId}
          AND status = 'pending'
      `;
      expect(updated).toBe(1);
      const rows = await projector.$queryRaw<Array<{ payload: unknown; status: string }>>`
        SELECT status, payload
        FROM chat.chat_file_mutations
        WHERE id = ${mutationId}
      `;
      expect(rows).toEqual([{
        status: "applied",
        payload: { kind: "relationship_delete", characterId },
      }]);
      await prisma.$transaction(async (tx) => {
        expect(await companionWorkspaceCleanupRequired(tx, userId, characterId)).toBe(false);
      });
    } finally {
      const cleanup = await superPool.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query(
          "SELECT set_config('idream.account_erasure_file_mutation_user', $1, true)",
          [userId],
        );
        await cleanup.query(
          "DELETE FROM chat.chat_file_mutations WHERE id = $1",
          [mutationId],
        );
        await cleanup.query("COMMIT");
      } catch (error) {
        await cleanup.query("ROLLBACK");
        throw error;
      } finally {
        cleanup.release();
        await Promise.all([
          prisma.$disconnect(),
          projector.$disconnect(),
          superPool.end(),
        ]);
      }
    }
  });

  it("replays only complete, unambiguous, memory-enabled canonical exchanges", () => {
    const user1 = message({ id: "user-1", role: "user" });
    const assistant1 = message({ id: "assistant-2", role: "assistant" });
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
    const sources = new Map([
      [assistant1.id, user1],
      [deletedSourceAssistant.id, deletedUser],
      [privateAssistant.id, user1],
    ]);
    const linkage: RelationshipLinkage = {
      sources,
      ambiguousAssistantIds: ["assistant-ambiguous"],
      candidateSourceIds: new Map(),
    };

    expect(canonicalCompanionMessages([{
      id: "session-1",
      messages: [privateAssistant, deletedSourceAssistant, assistant1, deletedUser, user1],
      linkage,
    }])).toEqual([
      expect.objectContaining({ id: "user-1", role: "user" }),
      expect.objectContaining({ id: "assistant-2", role: "assistant" }),
    ]);
  });

  it("purges every workspace after rollback even when new turns use native", async () => {
    nativeCleanupEnv();
    const purge = vi.fn(async () => ({ purged: 1 }));
    const rebuild = vi.fn();

    await applyCompanionMemoryProjection(
      {} as Prisma.TransactionClient,
      "user-rollback",
      { kind: "relationship_delete", characterId: "character-rollback" },
      { purge, rebuild },
    );
    await applyCompanionMemoryProjection(
      {} as Prisma.TransactionClient,
      "user-rollback",
      { kind: "account_delete" },
      { purge, rebuild },
    );

    expect(purge.mock.calls).toEqual([
      [{ scope: "relationship", userId: "user-rollback", characterId: "character-rollback" }],
      [{ scope: "user", userId: "user-rollback" }],
    ]);
    expect(rebuild).not.toHaveBeenCalled();
    expect(companionMemoryProjectionTimeoutMs()).toBe(37_000);
  });

  it("delegates one fenced rebuild for retained canonical rows", async () => {
    nativeCleanupEnv();
    process.env.CHAT_COMPANION_DSH_SHADOW_ENABLED = "true";
    const purge = vi.fn(async () => ({ purged: 1 }));
    const rebuild = vi.fn(async () => ({ sessions: 0, messages: 0 }));
    const tx = {
      chatSession: { findMany: vi.fn(async () => []) },
    } as unknown as Prisma.TransactionClient;

    await applyCompanionMemoryProjection(
      tx,
      "user-shadow",
      { kind: "relationship_rebuild", characterId: "character-shadow" },
      { purge, rebuild },
    );

    expect(purge).not.toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledWith(expect.objectContaining({
      scope: "relationship",
      userId: "user-shadow",
      characterId: "character-shadow",
      messages: [],
    }));
  });

  it("uses an explicitly injected cleanup port even when deployment credentials are absent", async () => {
    nativeCleanupEnv("");
    process.env.CHAT_COMPANION_RUNTIME = "dsh";
    process.env.CHAT_MEMORY_BACKEND = "igrep-dsh";
    process.env.CHAT_COMPANION_DSH_ROLLOUT_SALT = "cleanup-test-salt";
    const purge = vi.fn(async () => ({ purged: 1 }));
    const rebuild = vi.fn();

    await applyCompanionMemoryProjection(
      {} as Prisma.TransactionClient,
      "user-native",
      {
        kind: "relationship_delete",
        characterId: "character-native",
        companionCleanupRequired: true,
      },
      { purge, rebuild },
    );

    expect(purge).toHaveBeenCalledWith({
      scope: "relationship",
      userId: "user-native",
      characterId: "character-native",
    });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("keeps a durable cleanup intent pending when its required capability is missing", async () => {
    nativeCleanupEnv("");

    await expect(applyCompanionMemoryProjection(
      {} as Prisma.TransactionClient,
      "user-rollback",
      {
        kind: "relationship_delete",
        characterId: "character-rollback",
        companionCleanupRequired: true,
      },
    )).rejects.toThrow("DSH workspace cleanup is required but unavailable");
  });

  it("pins historical workspace authority into the durable privacy intent", async () => {
    nativeCleanupEnv("");
    const executeRaw = vi.fn(async (..._args: unknown[]) => 1);
    const tx = {
      $queryRaw: vi.fn(async () => [{ required: true }]),
      $executeRaw: executeRaw,
    } as unknown as Prisma.TransactionClient;

    await recordChatFileMutation(tx, "user-rollback", {
      kind: "relationship_delete",
      characterId: "character-rollback",
    });

    const persistedPayload = executeRaw.mock.calls[0]?.[4];
    expect(typeof persistedPayload).toBe("string");
    expect(JSON.parse(String(persistedPayload))).toEqual({
      kind: "relationship_delete",
      characterId: "character-rollback",
      companionCleanupRequired: true,
    });
  });

  it("skips a persisted negative cleanup decision without requiring credentials", async () => {
    nativeCleanupEnv("");

    await expect(applyCompanionMemoryProjection(
      {} as Prisma.TransactionClient,
      "user-native",
      {
        kind: "relationship_delete",
        characterId: "character-native",
        companionCleanupRequired: false,
      },
    )).resolves.toBeUndefined();
  });
});
