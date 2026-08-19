import { describe, expect, it, vi } from "vitest";
import type { CompanionWorkspaceRebuildMessage } from "@idream/shared/chat/companion-runtime";
import {
  buildLegacyMemoryImportPlan,
  importLegacyMemoryRelationship,
  parseLegacyMemoryImportArgs,
  parseLegacyRecallProbeFile,
  persistLegacyWorkspaceCleanupRequired,
  redactedLegacyRecallProbeSummary,
} from "./legacy-memory-import.js";
import { createChatPrisma, createChatProjectorPrisma } from "./db.js";
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

const recallProbes = [{
  id: "tea-preference",
  query: "What tea does the user prefer?",
  legacyExpected: "jasmine tea",
}];

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
      recallProbes,
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
      recallProbes,
    });
    expect(rejected.request.entries).toEqual([]);
    expect(rejected.excluded.duplicateId).toBe(2);

    const eligible = buildLegacyMemoryImportPlan({
      userId: "user-1",
      characterId: "character-1",
      memories: [memory({ id: "stable", text: "Stable fact." })],
      canonicalMessages: canonical,
      recallProbes,
    });
    const ineligible = buildLegacyMemoryImportPlan({
      userId: "user-1",
      characterId: "character-1",
      memories: [memory({ id: "stable", text: "Stable fact." })],
      canonicalMessages: [],
      recallProbes,
    });
    expect(eligible.request.checksum).not.toBe(ineligible.request.checksum);
  });

  it("defaults to dry-run and requires one explicit relationship", () => {
    expect(parseLegacyMemoryImportArgs([
      "--user-id",
      "user-1",
      "--character-id",
      "character-1",
      "--probe-file",
      "/secure/probes.json",
    ])).toEqual({
      userId: "user-1",
      characterId: "character-1",
      probeFile: "/secure/probes.json",
      dryRun: true,
    });
    expect(parseLegacyMemoryImportArgs([
      "--user-id",
      "user-1",
      "--character-id",
      "character-1",
      "--probe-file",
      "/secure/probes.json",
      "--apply",
    ])).toEqual({
      userId: "user-1",
      characterId: "character-1",
      probeFile: "/secure/probes.json",
      dryRun: false,
    });
    expect(() => parseLegacyMemoryImportArgs(["--all", "--apply"]))
      .toThrow(/unknown argument/);
    expect(() => parseLegacyMemoryImportArgs(["--user-id", "user-1"]))
      .toThrow(/character-id/);
  });

  it("strictly parses a versioned operator recall probe file", () => {
    expect(parseLegacyRecallProbeFile(JSON.stringify({
      version: 1,
      probes: recallProbes,
    }))).toEqual(recallProbes);
    expect(() => parseLegacyRecallProbeFile(JSON.stringify({
      version: 1,
      probes: [],
    }))).toThrow();
    expect(() => parseLegacyRecallProbeFile(JSON.stringify({
      version: 1,
      probes: [recallProbes[0], recallProbes[0]],
    }))).toThrow(/unique/);
    expect(() => parseLegacyRecallProbeFile(JSON.stringify({
      version: 1,
      probes: recallProbes,
      characterId: "must-not-live-in-probe-files",
    }))).toThrow();
  });

  it("redacts operator questions and legacy answers from CLI evidence", () => {
    const summary = redactedLegacyRecallProbeSummary(recallProbes);
    expect(summary).toEqual({
      count: 1,
      checksum: "19c0a505b433054f795b03bec1f3e86cb5e9979baf7416716aeafa996e50ed0e",
      probes: [{
        id: "tea-preference",
        queryHash: "216a035835b91277f5f41f303a4c1a54f8367791bd7689a5578744b1c00cd4f6",
        legacyExpectedHash: "26b88faa606ffa9961833ed4934429f4c8c97e5600855b814de46cd6eb4bea97",
      }],
    });
    expect(JSON.stringify(summary)).not.toContain("What tea");
    expect(JSON.stringify(summary)).not.toContain("jasmine tea");
  });

  it("atomically marks Message and selected Version as cleanup-required", async () => {
    const execute = vi.fn(async () => 1);
    await persistLegacyWorkspaceCleanupRequired(
      { $executeRaw: execute } as never,
      "assistant-message-1",
      {
        cleanupRequired: true,
        state: "cutover_ready",
        importChecksum: "a".repeat(64),
        recallProbeSetChecksum: "b".repeat(64),
        igrepVersion: "0.1.132",
        cutoverReadyAt: "2026-08-19T12:00:00.000Z",
      },
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(execute.mock.calls[0])).toContain("companionWorkspace");

    await expect(persistLegacyWorkspaceCleanupRequired(
      { $executeRaw: async () => 0 } as never,
      "assistant-message-missing",
      {
        cleanupRequired: true,
        state: "cutover_ready",
        importChecksum: "a".repeat(64),
        recallProbeSetChecksum: "b".repeat(64),
        igrepVersion: "0.1.132",
        cutoverReadyAt: "2026-08-19T12:00:00.000Z",
      },
    )).rejects.toThrow(/Message and selected Version/);
  });

  it("merges the cleanup fact into real Message and selected Version rows", async () => {
    const prisma = createChatPrisma();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sessionId = `legacy-cleanup-session-${suffix}`;
    const messageId = `legacy-cleanup-message-${suffix}`;
    const versionId = `legacy-cleanup-version-${suffix}`;
    const fact = {
      cleanupRequired: true as const,
      state: "cutover_ready" as const,
      importChecksum: "a".repeat(64),
      recallProbeSetChecksum: "b".repeat(64),
      igrepVersion: "0.1.132",
      cutoverReadyAt: "2026-08-19T12:00:00.000Z",
    };
    try {
      await prisma.chatSession.create({
        data: {
          id: sessionId,
          userId: `legacy-cleanup-user-${suffix}`,
          characterId: "legacy-cleanup-character",
        },
      });
      await prisma.message.create({
        data: {
          id: messageId,
          sessionId,
          role: "assistant",
          content: "Existing content",
          status: "sent",
          runtimeTrace: {
            existing: true,
            companionWorkspace: { priorFact: "preserve-message" },
          },
          versions: {
            create: {
              id: versionId,
              content: "Existing content",
              selected: true,
              runtimeTrace: {
                existing: true,
                companionWorkspace: { priorFact: "preserve-version" },
              },
            },
          },
        },
      });
      await prisma.$transaction(async (tx) => {
        await persistLegacyWorkspaceCleanupRequired(tx, messageId, fact);
      });
      const [message, version] = await Promise.all([
        prisma.message.findUniqueOrThrow({ where: { id: messageId }, select: { runtimeTrace: true } }),
        prisma.messageVersion.findUniqueOrThrow({ where: { id: versionId }, select: { runtimeTrace: true } }),
      ]);
      expect(message.runtimeTrace).toEqual({
        existing: true,
        companionWorkspace: { priorFact: "preserve-message", ...fact },
      });
      expect(version.runtimeTrace).toEqual({
        existing: true,
        companionWorkspace: { priorFact: "preserve-version", ...fact },
      });
    } finally {
      await prisma.messageVersion.deleteMany({ where: { messageId } });
      await prisma.message.deleteMany({ where: { id: messageId } });
      await prisma.chatSession.deleteMany({ where: { id: sessionId } });
      await prisma.$disconnect();
    }
  });

  it("does not require sidecar credentials for a dry-run", async () => {
    const prisma = createChatPrisma();
    const projectorPrisma = createChatProjectorPrisma();
    try {
      await expect(importLegacyMemoryRelationship({
        userId: `legacy-dry-run-${Date.now()}`,
        characterId: "character-dry-run",
        dryRun: true,
        recallProbes,
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

  it("commits a cleanup intent before sidecar promotion while holding user authority", async () => {
    const reader = createChatPrisma();
    const writer = createChatPrisma();
    const projector = createChatProjectorPrisma();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const userId = `legacy-intent-user-${suffix}`;
    const characterId = `legacy-intent-character-${suffix}`;
    const sessionId = `legacy-intent-session-${suffix}`;
    const userMessageId = `legacy-intent-user-message-${suffix}`;
    const assistantMessageId = `legacy-intent-assistant-message-${suffix}`;
    const versionId = `legacy-intent-version-${suffix}`;
    const probeSetChecksum = redactedLegacyRecallProbeSummary(recallProbes).checksum;
    let sidecarCalled = false;
    try {
      await reader.chatSession.create({
        data: {
          id: sessionId,
          userId,
          characterId,
          messages: {
            create: [
              {
                id: userMessageId,
                role: "user",
                content: "I prefer jasmine tea.",
                status: "sent",
                safetyStatus: "passed",
                createdAt: new Date("2026-08-19T12:00:00.000Z"),
              },
              {
                id: assistantMessageId,
                role: "assistant",
                content: "I will remember that.",
                status: "sent",
                safetyStatus: "passed",
                replyToMessageId: userMessageId,
                memoryAuthority: "enabled",
                createdAt: new Date("2026-08-19T12:00:01.000Z"),
                runtimeTrace: { existing: true },
                versions: {
                  create: {
                    id: versionId,
                    content: "I will remember that.",
                    selected: true,
                    runtimeTrace: { existing: true },
                  },
                },
              },
            ],
          },
        },
      });
      const result = await importLegacyMemoryRelationship({
        userId,
        characterId,
        dryRun: false,
        recallProbes,
      }, {
        prisma: reader,
        projectorPrisma: projector,
        env: {
          DSH_AGENT_TOKEN: "test-token",
          DSH_AGENT_URL: "http://sidecar.test",
          DSH_AGENT_DEADLINE_MS: "2000",
        },
        fetchImpl: async (_url, init) => {
          sidecarCalled = true;
          const request = JSON.parse(String(init?.body)) as { checksum: string };
          const assistant = await writer.message.findUniqueOrThrow({
            where: { id: assistantMessageId },
            select: { runtimeTrace: true },
          });
          expect(assistant.runtimeTrace).toEqual({
            existing: true,
            companionWorkspace: {
              cleanupRequired: true,
              state: "import_pending",
              importChecksum: request.checksum,
              recallProbeSetChecksum: probeSetChecksum,
              igrepVersion: "0.1.132",
              cutoverReadyAt: null,
            },
          });
          await expect(writer.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'");
            await lockUser(tx, userId);
          }, { timeout: 2_000 })).rejects.toThrow(/lock timeout|canceling statement/);
          return Response.json({
            ok: true,
            imported: {
              skipped: false,
              entries: 0,
              written: 0,
              checksum: request.checksum,
              igrepVersion: "0.1.132",
              status: "cutover_ready",
              recallParity: {
                probeSetChecksum,
                total: 1,
                passed: 1,
                probes: [{
                  probeId: "tea-preference",
                  queryHash: "2".repeat(64),
                  legacyExpectedHash: "3".repeat(64),
                  recallContextHash: "4".repeat(64),
                  hitCount: 1,
                }],
              },
              completedAt: "2026-08-19T12:00:02.000Z",
            },
          });
        },
      });
      expect(sidecarCalled).toBe(true);
      expect(result).toMatchObject({ mode: "applied", marker: { status: "cutover_ready" } });
      const [message, version] = await Promise.all([
        reader.message.findUniqueOrThrow({
          where: { id: assistantMessageId },
          select: { runtimeTrace: true },
        }),
        reader.messageVersion.findUniqueOrThrow({
          where: { id: versionId },
          select: { runtimeTrace: true },
        }),
      ]);
      expect(message.runtimeTrace).toMatchObject({
        companionWorkspace: { cleanupRequired: true, state: "cutover_ready" },
      });
      expect(version.runtimeTrace).toMatchObject({
        companionWorkspace: { cleanupRequired: true, state: "cutover_ready" },
      });
    } finally {
      await reader.messageVersion.deleteMany({ where: { messageId: assistantMessageId } });
      await reader.message.deleteMany({ where: { sessionId } });
      await reader.chatSession.deleteMany({ where: { id: sessionId } });
      await Promise.all([reader.$disconnect(), writer.$disconnect(), projector.$disconnect()]);
    }
  });
});
