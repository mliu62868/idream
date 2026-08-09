import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { toInputJson } from "../shared/prisma-json";
import {
  transitionCharacterProject,
  transitionCharacterRelease,
  transitionCharacterServing,
} from "./transition";

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
    await prisma.characterProject.create({ data: { id: projectId, characterId, ownerId: actorId, phase: "qa", audience: {}, successCriteria: [] } });
    await prisma.characterRevision.create({ data: { id: revisionId, projectId, revision: 1, characterContentVersionId: contentId, projectSnapshot: {}, createdById: actorId } });
    await prisma.characterRelease.create({ data: { id: releaseId, projectId, revisionId, characterContentVersionId: contentId, generationProvenance: toInputJson({}), releasePlacementManifest: toInputJson({}), snapshotHash: id("snapshot"), status: "in_review" } });
    await prisma.characterServing.create({ data: { id: servingId, characterId, state: "inactive" } });
  });

  afterAll(async () => {
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
    const approved = await prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, {
        releaseId,
        to: "approved",
        expectedVersion: before.version,
        data: { readiness: "ready" },
      }),
    );
    expect(approved).toMatchObject({
      status: "approved",
      readiness: "ready",
      version: before.version + 1,
    });
  });

  it("rejects an edge the state machine does not permit", async () => {
    // approved 只能到 published；直接退回 in_review 不是一条边。
    await expect(prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, { releaseId, to: "in_review" }),
    )).rejects.toMatchObject({ status: 409 });
    await expect(prisma.characterRelease.findUniqueOrThrow({ where: { id: releaseId } }))
      .resolves.toMatchObject({ status: "approved" });
  });

  it("rejects a stale expected version without touching the row", async () => {
    const before = await prisma.characterRelease.findUniqueOrThrow({ where: { id: releaseId } });
    await expect(prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, {
        releaseId,
        to: "published",
        expectedVersion: before.version - 1,
      }),
    )).rejects.toMatchObject({ status: 409 });
    await expect(prisma.characterRelease.findUniqueOrThrow({ where: { id: releaseId } }))
      .resolves.toEqual(before);
  });

  it("reads the current state itself, so a caller cannot assert a state the row does not have", async () => {
    // 调用方不再传 from：published 之后同一次调用重放，当前状态已不是 approved，边不成立。
    await prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, { releaseId, to: "published", data: { publishedAt: new Date() } }),
    );
    await expect(prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, { releaseId, to: "published" }),
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
        to: "approved",
        conflict: () => new CommandError("current_release_transition_invalid"),
      }),
    )).rejects.toMatchObject({ code: "current_release_transition_invalid" });
  });

  it("fails closed for a missing aggregate row", async () => {
    await expect(prisma.$transaction((tx) =>
      transitionCharacterRelease(tx, { releaseId: `${releaseId}-missing`, to: "approved" }),
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

  it("carries domain data through the project phase transition", async () => {
    const project = await prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } });
    const retired = await prisma.$transaction((tx) =>
      transitionCharacterProject(tx, {
        projectId,
        to: "retired",
        expectedVersion: project.version,
        data: { activeKey: null },
      }),
    );
    expect(retired).toMatchObject({ phase: "retired", version: project.version + 1 });
    // retired 是终态，没有出边。
    await expect(prisma.$transaction((tx) =>
      transitionCharacterProject(tx, { projectId, to: "producing" }),
    )).rejects.toMatchObject({ status: 409 });
  });
});
