import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("purges private and shadow residue before rebuilding retained canonical rows", async () => {
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

    expect(purge).toHaveBeenCalledWith({
      scope: "relationship",
      userId: "user-shadow",
      characterId: "character-shadow",
    });
    expect(rebuild).toHaveBeenCalledWith(expect.objectContaining({
      scope: "relationship",
      userId: "user-shadow",
      characterId: "character-shadow",
      messages: [],
    }));
    expect(purge.mock.invocationCallOrder[0])
      .toBeLessThan(rebuild.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
  });

  it("does not claim cleanup when no sidecar cleanup capability is configured", async () => {
    nativeCleanupEnv("");
    const purge = vi.fn();
    const rebuild = vi.fn();

    await applyCompanionMemoryProjection(
      {} as Prisma.TransactionClient,
      "user-native",
      { kind: "relationship_delete", characterId: "character-native" },
      { purge, rebuild },
    );

    expect(purge).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(companionMemoryProjectionTimeoutMs()).toBe(30_000);
  });
});
