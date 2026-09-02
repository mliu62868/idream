import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { toInputJson } from "../shared/prisma-json";
import * as contentAudit from "../content/audit";
import { setCharacterChatTools } from "../content/chat-tools";
import { projectServingToCharacter } from "./serving-projection";
import {
  transitionCharacterRelease,
  transitionCharacterServing,
} from "./transition";

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

// SPEC: 聚合状态写入唯一入口的行为契约 —— 允许的边、版本 CAS、调用方错误词表。
// INTENT: 这三个 transition 此前没有测试文件；它们的正确性只被发布链的端到端路径间接覆盖，
// 「当前状态由谁读」这个刚改掉的语义没有任何断言看着。
describe("Character aggregate transitions", () => {
  const suffix = randomUUID();
  const id = (name: string) => `transition-${name}-${suffix}`;
  const actorId = id("admin");
  const characterId = id("character");
  const projectId = id("project");
  const contentId = id("content");
  const revisionId = id("revision");
  const releaseId = id("release");
  const servingId = id("serving");

  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${actorId}@idream.internal`, role: "admin", status: "active" } });
    await prisma.character.create({ data: { id: characterId, creatorId: actorId, name: "Transition Fixture", age: 24, description: "Aggregate transition fixture", visibility: "private", status: "draft", appearance: {}, advancedDetails: {} } });
    await prisma.characterContentVersion.create({ data: { id: contentId, characterId, version: 1, contentHash: contentId, personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "test", createdById: actorId } });
    await prisma.characterProject.create({ data: { id: projectId, characterId } });
    await prisma.characterRevision.create({ data: { id: revisionId, projectId, revision: 1, characterContentVersionId: contentId, projectSnapshot: {}, createdById: actorId } });
    await prisma.characterRelease.create({ data: { id: releaseId, projectId, revisionId, characterContentVersionId: contentId, generationProvenance: toInputJson({}), releasePlacementManifest: toInputJson({}), snapshotHash: id("snapshot"), status: "approved" } });
    await prisma.characterServing.create({ data: { id: servingId, characterId, state: "inactive" } });
  });

  afterAll(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.characterRelease.deleteMany({ where: { projectId } });
    await prisma.characterRevision.deleteMany({ where: { id: revisionId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("advances an allowed edge, bumps version, and returns the new authoritative snapshot", async () => {
    const before = await prisma.characterRelease.findUniqueOrThrow({ where: { id: releaseId } });
    const published = await prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, {
        releaseId,
        to: "published",
        expectedVersion: before.version,
        data: { readiness: "ready", publishedAt: new Date() },
      }),
    );
    expect(published).toMatchObject({
      status: "published",
      readiness: "ready",
      version: before.version + 1,
    });
  });

  it("rejects an edge the state machine does not permit", async () => {
    // published 只能退出服务；不能退回 approved。
    await expect(prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, { releaseId, to: "approved" }),
    )).rejects.toMatchObject({ status: 409 });
    await expect(prisma.characterRelease.findUniqueOrThrow({ where: { id: releaseId } }))
      .resolves.toMatchObject({ status: "published" });
  });

  it("rejects a stale expected version without touching the row", async () => {
    const before = await prisma.characterRelease.findUniqueOrThrow({ where: { id: releaseId } });
    await expect(prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, {
        releaseId,
        to: "superseded",
        expectedVersion: before.version - 1,
      }),
    )).rejects.toMatchObject({ status: 409 });
    await expect(prisma.characterRelease.findUniqueOrThrow({ where: { id: releaseId } }))
      .resolves.toEqual(before);
  });

  it("reads the current state itself, so a caller cannot assert a state the row does not have", async () => {
    // 调用方不再传 from：published 之后同一次调用重放，当前状态已不是 approved，边不成立。
    await prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, { releaseId, to: "superseded" }),
    );
    await expect(prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, { releaseId, to: "superseded" }),
    )).rejects.toMatchObject({ status: 409 });
  });

  it("raises the caller's own error vocabulary on conflict", async () => {
    class CommandError extends Error {
      constructor(readonly code: string) {
        super(code);
      }
    }
    await expect(prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, {
        releaseId,
        to: "published",
        conflict: () => new CommandError("current_release_transition_invalid"),
      }),
    )).rejects.toMatchObject({ code: "current_release_transition_invalid" });
  });

  it("fails closed for a missing aggregate row", async () => {
    await expect(prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, { releaseId: `${releaseId}-missing`, to: "published" }),
    )).rejects.toMatchObject({ status: 409 });
  });

  it("applies the serving pointer as an additional compare-and-swap term", async () => {
    const serving = await prisma.characterServing.findUniqueOrThrow({ where: { id: servingId } });
    await expect(prisma.$transaction((tx) =>
      transitionCharacterServing(tx, {
        servingId,
        to: "live",
        expectedCurrentReleaseId: releaseId,
        data: { currentReleaseId: releaseId },
      }),
    )).rejects.toMatchObject({ status: 409 });
    const live = await prisma.$transaction((tx) =>
      transitionCharacterServing(tx, {
        servingId,
        to: "live",
        expectedVersion: serving.version,
        expectedCurrentReleaseId: null,
        data: { currentReleaseId: releaseId },
      }),
    );
    expect(live).toMatchObject({ state: "live", currentReleaseId: releaseId });
  });

  it("preserves operator settings while publish and rollback replace Soul projections", async () => {
    await prisma.character.update({ where: { id: characterId }, data: {
      advancedDetails: { imageToolEnabled: false, firstMessage: "Old opening", operatorLabel: "curated" },
    } });
    for (const firstMessage of ["New release opening", "Rollback opening"]) {
      await prisma.$transaction((tx) => projectServingToCharacter(tx, {
        characterId,
        state: "live",
        content: { advancedDetails: { firstMessage, soulFingerprint: firstMessage } },
      }));
      await expect(prisma.character.findUniqueOrThrow({ where: { id: characterId } }))
        .resolves.toMatchObject({ advancedDetails: {
          imageToolEnabled: false, operatorLabel: "curated", firstMessage, soulFingerprint: firstMessage,
        } });
    }
    await setCharacterChatTools({
      request: new Request("http://localhost/api/v2/admin/content/characters/tools"),
      actor: { id: actorId, role: "admin" },
      characterId,
      body: { imageToolEnabled: true, reason: "Enable images after release review" },
    });
    await expect(prisma.character.findUniqueOrThrow({ where: { id: characterId } }))
      .resolves.toMatchObject({ advancedDetails: {
        imageToolEnabled: true, operatorLabel: "curated", firstMessage: "Rollback opening", soulFingerprint: "Rollback opening",
      } });
    await expect(prisma.adminAuditLog.count({ where: { actorId, action: "content.chat-tools.write" } }))
      .resolves.toBe(1);
  });

  it("reads the newly committed Soul when an operator waits for the Release row lock", async () => {
    await prisma.character.update({ where: { id: characterId }, data: {
      advancedDetails: { imageToolEnabled: true, firstMessage: "Before concurrent release" },
    } });
    const locked = barrier<number>();
    const commit = barrier();
    const release = prisma.$transaction(async (tx) => {
      await projectServingToCharacter(tx, {
        characterId,
        state: "live",
        content: { advancedDetails: { firstMessage: "Concurrent release opening" } },
      });
      const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      locked.resolve(connection!.pid);
      await commit.promise;
    }, { timeout: 10_000 });
    const ownerPid = await locked.promise;
    const tools = setCharacterChatTools({
      request: new Request("http://localhost/chat-tools"), actor: { id: actorId, role: "admin" },
      characterId, body: { imageToolEnabled: false, reason: "Disable during release" },
    });
    try {
      // Observe a real Postgres lock wait, rather than relying on a sleep to
      // guess whether the operator has reached its read/merge boundary.
      await expect.poll(async () => {
        const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND ${ownerPid} = ANY(pg_blocking_pids(pid))
        `;
        return row!.count;
      }, { timeout: 2_000 }).toBeGreaterThan(0);
    } finally {
      commit.resolve();
      await Promise.all([release, tools]);
    }
    await expect(prisma.character.findUniqueOrThrow({ where: { id: characterId } }))
      .resolves.toMatchObject({ advancedDetails: {
        imageToolEnabled: false, firstMessage: "Concurrent release opening",
      } });
  });

  it("preserves an operator disable when Release waits for the audited transaction", async () => {
    await prisma.character.update({ where: { id: characterId }, data: {
      advancedDetails: { imageToolEnabled: true, firstMessage: "Before operator disable" },
    } });
    const locked = barrier<number>();
    const commit = barrier();
    const writeAudit = contentAudit.writeContentAudit;
    const audit = vi.spyOn(contentAudit, "writeContentAudit").mockImplementation(async (...args) => {
      const result = await writeAudit(...args);
      const tx = args[3] ?? prisma;
      const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      locked.resolve(connection!.pid);
      await commit.promise;
      return result;
    });
    try {
      const tools = setCharacterChatTools({
        request: new Request("http://localhost/chat-tools"), actor: { id: actorId, role: "admin" },
        characterId, body: { imageToolEnabled: false, reason: "Disable before release projection" },
      });
      const ownerPid = await locked.promise;
      const release = prisma.$transaction((tx) => projectServingToCharacter(tx, {
        characterId,
        state: "live",
        content: { advancedDetails: { firstMessage: "Release after operator disable" } },
      }), { timeout: 10_000 });
      try {
        await expect.poll(async () => {
          const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
            SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND ${ownerPid} = ANY(pg_blocking_pids(pid))
          `;
          return row!.count;
        }, { timeout: 2_000 }).toBeGreaterThan(0);
      } finally {
        commit.resolve();
        await Promise.all([tools, release]);
      }
    } finally {
      commit.resolve();
      audit.mockRestore();
    }
    await expect(prisma.character.findUniqueOrThrow({ where: { id: characterId } }))
      .resolves.toMatchObject({ advancedDetails: {
        imageToolEnabled: false, firstMessage: "Release after operator disable",
      } });
  });

  it("rolls back the operator switch when its audit cannot be committed", async () => {
    const before = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const auditCount = await prisma.adminAuditLog.count({ where: { actorId } });
    const audit = vi.spyOn(contentAudit, "writeContentAudit")
      .mockRejectedValueOnce(new Error("Audit write unavailable"));
    try {
      await expect(setCharacterChatTools({
        request: new Request("http://localhost/chat-tools"), actor: { id: actorId, role: "admin" },
        characterId, body: { imageToolEnabled: true, reason: "Enable with failing audit" },
      })).rejects.toThrow("Audit write unavailable");
    } finally {
      audit.mockRestore();
    }
    await expect(prisma.character.findUniqueOrThrow({ where: { id: characterId } }))
      .resolves.toEqual(before);
    await expect(prisma.adminAuditLog.count({ where: { actorId } })).resolves.toBe(auditCount);
  });

});
