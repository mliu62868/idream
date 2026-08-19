import { describe, expect, it } from "vitest";
import type { CompanionWorkspaceRebuildMessage } from "@idream/shared/chat/companion-runtime";
import {
  buildLegacyMemoryImportPlan,
  importLegacyMemoryRelationship,
  parseLegacyMemoryImportArgs,
} from "./legacy-memory-import.js";
import { createChatPrisma, createChatProjectorPrisma } from "./db.js";
import { withReadableChatFileSnapshot } from "./file-mutations.js";
import type { MemoryItem } from "./memories.js";
import { lockUser } from "./turn-lock.js";

const canonical: CompanionWorkspaceRebuildMessage[] = [
  {
    id: "valid-user",
    sessionId: "valid-session",
    role: "user",
    content: "I prefer jasmine tea.",
    createdAt: "2026-08-19T12:00:00.000Z",
  },
  {
    id: "valid-assistant",
    sessionId: "valid-session",
    role: "assistant",
    content: "I will remember that.",
    createdAt: "2026-08-19T12:00:01.000Z",
  },
];

function memory(input: Partial<MemoryItem> & Pick<MemoryItem, "id" | "text">): MemoryItem {
  return {
    characterId: "character-1",
    type: "preference",
    sourceMessageIds: ["valid-user"],
    confidence: 0.8,
    ...input,
    id: input.id,
    text: input.text,
  };
}

describe("legacy memory importer authority", () => {
  it("imports only character facts backed by complete current memory-enabled turns", () => {
    const plan = buildLegacyMemoryImportPlan({
      userId: "user-1",
      characterId: "character-1",
      memories: [
        memory({ id: "valid", text: "User prefers jasmine tea." }),
        memory({ id: "assistant-source", text: "They promised to visit.", sourceMessageIds: ["valid-assistant"] }),
        memory({ id: "boundary", text: "Do not mention work.", type: "boundary" }),
        memory({ id: "global", text: "Global boundary.", characterId: null }),
        memory({ id: "no-source", text: "Unattributed fact.", sourceMessageIds: [] }),
        memory({ id: "deleted", text: "Deleted fact.", sourceMessageIds: ["deleted-user"] }),
        memory({ id: "private", text: "No-memory fact.", sourceMessageIds: ["private-user"] }),
      ],
      canonicalMessages: canonical,
    });

    expect(plan.request.entries).toEqual([
      {
        legacyMemoryId: "valid",
        type: "preference",
        text: "User prefers jasmine tea.",
        sourceMessageIds: ["valid-user"],
      },
      {
        legacyMemoryId: "assistant-source",
        type: "preference",
        text: "They promised to visit.",
        sourceMessageIds: ["valid-assistant"],
      },
    ]);
    expect(plan.excluded).toEqual({
      boundary: 1,
      nonCharacter: 1,
      withoutSource: 1,
      untraceableSource: 2,
      duplicateId: 0,
    });
    expect(plan.request.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.total).toBe(7);
  });

  it("fails closed on duplicate legacy ids and includes canonical eligibility in the checksum", () => {
    const memories = [
      memory({ id: "duplicate", text: "First fact." }),
      memory({ id: "duplicate", text: "Second fact." }),
    ];
    const rejected = buildLegacyMemoryImportPlan({
      userId: "user-1",
      characterId: "character-1",
      memories,
      canonicalMessages: canonical,
    });
    expect(rejected.request.entries).toEqual([]);
    expect(rejected.excluded.duplicateId).toBe(2);

    const eligible = buildLegacyMemoryImportPlan({
      userId: "user-1",
      characterId: "character-1",
      memories: [memory({ id: "stable", text: "Stable fact." })],
      canonicalMessages: canonical,
    });
    const ineligible = buildLegacyMemoryImportPlan({
      userId: "user-1",
      characterId: "character-1",
      memories: [memory({ id: "stable", text: "Stable fact." })],
      canonicalMessages: [],
    });
    expect(eligible.request.checksum).not.toBe(ineligible.request.checksum);
  });

  it("defaults to dry-run and requires one explicit relationship", () => {
    expect(parseLegacyMemoryImportArgs([
      "--user-id",
      "user-1",
      "--character-id",
      "character-1",
    ])).toEqual({ userId: "user-1", characterId: "character-1", dryRun: true });
    expect(parseLegacyMemoryImportArgs([
      "--user-id",
      "user-1",
      "--character-id",
      "character-1",
      "--apply",
    ])).toEqual({ userId: "user-1", characterId: "character-1", dryRun: false });
    expect(() => parseLegacyMemoryImportArgs(["--all", "--apply"]))
      .toThrow(/unknown argument/);
    expect(() => parseLegacyMemoryImportArgs(["--user-id", "user-1"]))
      .toThrow(/character-id/);
  });

  it("does not require sidecar credentials for a dry-run", async () => {
    const prisma = createChatPrisma();
    const projectorPrisma = createChatProjectorPrisma();
    try {
      await expect(importLegacyMemoryRelationship({
        userId: `legacy-dry-run-${Date.now()}`,
        characterId: "character-dry-run",
        dryRun: true,
      }, {
        prisma,
        projectorPrisma,
        env: {},
      })).resolves.toMatchObject({
        mode: "dry-run",
        total: 0,
        request: { entries: [] },
      });
    } finally {
      await Promise.all([prisma.$disconnect(), projectorPrisma.$disconnect()]);
    }
  });

  it("holds the shared user authority lock for the bounded apply window", async () => {
    const reader = createChatPrisma();
    const writer = createChatPrisma();
    const projector = createChatProjectorPrisma();
    const lockUserId = `legacy-lock-${Date.now()}`;
    let markEntered = (): void => {};
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let releaseSnapshot = (): void => {};
    const release = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    let writerAcquired = false;
    let snapshot: Promise<void> | undefined;
    let mutation: Promise<void> | undefined;
    try {
      snapshot = withReadableChatFileSnapshot(
        lockUserId,
        async () => {
          markEntered();
          await release;
        },
        reader,
        projector,
        2_000,
      );
      await entered;
      mutation = writer.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'");
        await lockUser(tx, lockUserId);
        writerAcquired = true;
      }, { timeout: 2_000 });
      await expect(mutation).rejects.toThrow(/lock timeout|canceling statement/);
      expect(writerAcquired).toBe(false);
      releaseSnapshot();
      await snapshot;
      mutation = writer.$transaction(async (tx) => {
        await lockUser(tx, lockUserId);
        writerAcquired = true;
      }, { timeout: 2_000 });
      await mutation;
      expect(writerAcquired).toBe(true);
    } finally {
      releaseSnapshot();
      await Promise.allSettled([snapshot, mutation].filter((value): value is Promise<void> => Boolean(value)));
      await Promise.all([reader.$disconnect(), writer.$disconnect(), projector.$disconnect()]);
    }
  });
});
