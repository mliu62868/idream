import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { acceptControlPlaneCommand } from "../shared/control-plane-command";
import { executeCharacterReleaseCommand } from "./release-executor";
import { createCharacterRelease } from "./release-lifecycle";

describe("Character release recovery without publication", () => {
  const actorId = `release-recovery-${randomUUID()}`;
  const characters: string[] = [];
  const commands: string[] = [];
  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" } });
  });
  afterAll(async () => {
    const projects = await prisma.characterProject.findMany({ where: { characterId: { in: characters } }, select: { id: true } });
    const projectIds = projects.map((project) => project.id);
    const releases = await prisma.characterRelease.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [...characters, ...releases.map((release) => release.id)] } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.characterReleaseEvent.deleteMany({ where: { characterId: { in: characters } } });
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commands } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: commands } } });
    await prisma.characterServing.deleteMany({ where: { characterId: { in: characters } } });
    const releaseIds = releases.map((release) => release.id);
    const runs = await prisma.releaseValidationRun.findMany({ where: { releaseId: { in: releaseIds } }, select: { id: true } });
    await prisma.releaseCheckResult.deleteMany({ where: { validationRunId: { in: runs.map((run) => run.id) } } });
    await prisma.releaseValidationRun.deleteMany({ where: { releaseId: { in: releaseIds } } });
    await prisma.characterRelease.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.characterRevision.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.characterProject.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId: { in: characters } } });
    await prisma.character.deleteMany({ where: { id: { in: characters } } });
    await prisma.user.delete({ where: { id: actorId } });
  });

  async function fixture(state: "inactive" | "paused" | "retired" = "inactive", source: "official" | "user" = "official") {
    const characterId = `recovery-character-${randomUUID()}`;
    characters.push(characterId);
    await prisma.character.create({ data: { id: characterId, creatorId: actorId, name: "Recovery draft", age: 29, description: "A recoverable private draft", source, status: source === "official" ? "draft" : "approved", visibility: "private", appearance: {}, advancedDetails: {} } });
    const content = await prisma.characterContentVersion.create({ data: { characterId, version: 1, contentHash: characterId, personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "test", createdById: actorId } });
    const project = await prisma.characterProject.create({ data: { characterId, activeKey: state === "retired" ? null : `${source === "official" ? "official" : "customer-publication"}:${characterId}` } });
    const revision = await prisma.characterRevision.create({ data: { projectId: project.id, revision: 1, characterContentVersionId: content.id, projectSnapshot: {}, createdById: actorId } });
    const release = await prisma.characterRelease.create({ data: { projectId: project.id, revisionId: revision.id, characterContentVersionId: content.id, generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: characterId, status: state === "inactive" ? "approved" : "published", readiness: "blocked", publishedAt: state === "inactive" ? null : new Date() } });
    const serving = await prisma.characterServing.create({ data: { characterId, state, currentReleaseId: state === "inactive" ? null : release.id } });
    return { characterId, content, project, release, serving };
  }

  async function command(commandType: string, targetId: string, expectedVersion: number, extraPayload: Record<string, string> = {}) {
    const accepted = await acceptControlPlaneCommand(prisma, {
      environment: "test", actor: { id: actorId, role: "admin" }, idempotencyKey: randomUUID(), commandType,
      target: { type: commandType.includes("release.") && !commandType.endsWith(".rollback") ? "character_release" : "character_serving", id: targetId },
      expectedVersion, payload: { reason: "Operator abandons obsolete work", ...extraPayload }, retryMode: "idempotent", reason: "Operator abandons obsolete work", requestId: randomUUID(),
    });
    commands.push(accepted.commandId);
    return executeCharacterReleaseCommand(prisma, { commandId: accepted.commandId, workerId: actorId });
  }

  it("withdraws a blocked candidate with one durable event and preserves its immutable content on replay", async () => {
    const { characterId, release, serving } = await fixture();
    const result = await command("character.release.withdraw", release.id, release.version);
    expect(result.status).toBe("succeeded");
    expect(await prisma.characterRelease.findUniqueOrThrow({ where: { id: release.id } })).toMatchObject({ status: "withdrawn", version: release.version + 1, snapshotHash: release.snapshotHash, characterContentVersionId: release.characterContentVersionId });
    expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId } })).toEqual(serving);
    expect(await executeCharacterReleaseCommand(prisma, { commandId: result.commandId, workerId: actorId })).toEqual(result);
    expect(await prisma.characterReleaseEvent.count({ where: { commandId: result.commandId } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { action: "character.release.withdraw.executed", targetId: release.id } })).toBe(1);
  });

  // SPEC: 发布校验失败只撤回那个尚未上线的候选；当前 Serving 的 Release 与 Serving 本身一个字节都不动。
  it("withdraws only the unpublishable candidate when publish validation fails, never the serving Release", async () => {
    const { characterId, project, release: current, serving } = await fixture("paused");
    const candidate = await prisma.characterRelease.create({ data: {
      projectId: project.id, revisionId: current.revisionId, characterContentVersionId: current.characterContentVersionId,
      generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: `${characterId}-candidate`, status: "approved", readiness: "ready",
    } });
    const result = await command("character.release.publish", candidate.id, candidate.version);
    expect(result).toMatchObject({ status: "failed", errorCode: "release_validation_failed" });
    expect(await prisma.characterRelease.findUniqueOrThrow({ where: { id: candidate.id } })).toMatchObject({
      status: "withdrawn", readiness: "blocked", version: candidate.version + 1, publishedAt: null, snapshotHash: candidate.snapshotHash,
    });
    expect(await prisma.characterRelease.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current);
    expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId } })).toEqual(serving);
    const failed = await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: result.commandId } });
    const run = await prisma.releaseValidationRun.findFirstOrThrow({ where: { releaseId: candidate.id } });
    expect(failed).toMatchObject({ status: "failed", error: {
      code: "release_validation_failed", blockers: expect.any(Array), validationRunId: run.id,
      candidateWithdrawn: true, withdrawnReleaseId: candidate.id,
    } });
    expect((failed.error as { blockers: string[] }).blockers.length).toBeGreaterThan(0);
    expect(await prisma.characterReleaseEvent.findMany({ where: { commandId: result.commandId } })).toEqual([
      expect.objectContaining({ releaseId: candidate.id, type: "character.release.withdrawn" }),
    ]);
    expect(await prisma.adminAuditLog.count({ where: { action: "character.release.withdraw.automatic", targetId: candidate.id } })).toBe(1);
    // 草稿不再被冻结：没有 approved 候选留下。
    expect(await prisma.characterRelease.count({ where: { projectId: project.id, status: "approved" } })).toBe(0);
  });

  // INTENT: 回滚由命令自己建出 approved 的回滚 Release；校验失败时它同样不可能上线，不能留下冻结草稿的候选。
  it("withdraws a rollback Release that fails validation and keeps the current Release serving", async () => {
    const { characterId, project, release: current, serving } = await fixture("paused");
    const source = await prisma.characterRelease.create({ data: {
      projectId: project.id, revisionId: current.revisionId, characterContentVersionId: current.characterContentVersionId,
      generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: `${characterId}-old`, status: "superseded", readiness: "ready", publishedAt: new Date(0),
    } });
    const result = await command("character.release.rollback", characterId, serving.version, { sourceReleaseId: source.id });
    expect(result).toMatchObject({ status: "failed", errorCode: "release_validation_failed" });
    const rollback = await prisma.characterRelease.findFirstOrThrow({ where: { rollbackOfReleaseId: source.id } });
    expect(rollback).toMatchObject({ status: "withdrawn", readiness: "blocked", publishedAt: null });
    expect(await prisma.characterRelease.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current);
    expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId } })).toEqual(serving);
    expect(await prisma.characterRelease.count({ where: { projectId: project.id, status: "approved" } })).toBe(0);
  });

  it("rejects a stale candidate version without changing it", async () => {
    const { release } = await fixture();
    expect(await command("character.release.withdraw", release.id, release.version + 1)).toMatchObject({ status: "failed", errorCode: "release_version_conflict" });
    expect(await prisma.characterRelease.findUniqueOrThrow({ where: { id: release.id } })).toEqual(release);
  });

  it("archives and restores a draft without creating a live pointer or losing content", async () => {
    const { characterId, project, release, content, serving } = await fixture();
    const retired = await command("character.serving.retire", characterId, serving.version);
    expect(retired).toMatchObject({ status: "succeeded", releaseId: null });
    expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId } })).toMatchObject({ state: "retired", currentReleaseId: null });
    expect(await prisma.characterProject.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ activeKey: null });
    expect(await prisma.characterRelease.findUniqueOrThrow({ where: { id: release.id } })).toMatchObject({ status: "withdrawn" });
    expect(await prisma.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({ status: "archived", visibility: "private" });
    await expect(createCharacterRelease({ request: new Request("http://localhost"), characterId, expectedProjectVersion: project.version + 1, reason: "Must restore first", actor: { id: actorId, role: "admin" } })).rejects.toMatchObject({ status: 409 });
    expect(await command("character.serving.restore", characterId, serving.version + 1)).toMatchObject({ status: "succeeded", releaseId: null });
    expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId } })).toMatchObject({ state: "inactive", currentReleaseId: null });
    expect(await prisma.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({ status: "draft", visibility: "private" });
    expect(await prisma.characterContentVersion.findUniqueOrThrow({ where: { id: content.id } })).toEqual(content);
    expect(await prisma.characterProject.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ activeKey: `official:${characterId}`, version: project.version + 2 });
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: characterId, eventType: { in: ["character.draft.archived.v2", "character.draft.restored.v2"] } } })).toBe(2);
  });

  it("restores a customer publication draft with its original source and project authority", async () => {
    const { characterId, project, serving } = await fixture("inactive", "user");
    expect(await command("character.serving.retire", characterId, serving.version)).toMatchObject({ status: "succeeded" });
    expect(await command("character.serving.restore", characterId, serving.version + 1)).toMatchObject({ status: "succeeded" });
    expect(await prisma.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({ source: "user", status: "approved", visibility: "private" });
    expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId } })).toMatchObject({ state: "inactive", currentReleaseId: null });
    expect(await prisma.characterProject.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ activeKey: `customer-publication:${characterId}` });
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: characterId, action: "character.serving.retire.executed" } });
    expect(audit.before).toMatchObject({ activeKey: `customer-publication:${characterId}`, characterSource: "user", characterStatus: "approved" });
  });

  it("retires a paused published Character directly even when its release readiness is blocked", async () => {
    const { characterId, serving, release } = await fixture("paused");
    expect(await command("character.serving.retire", characterId, serving.version)).toMatchObject({ status: "succeeded", releaseId: release.id });
    expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId } })).toMatchObject({ state: "retired", currentReleaseId: release.id });
    expect(await prisma.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({ status: "archived", visibility: "private" });
  });

  it("cannot restore a previously published Character as a draft", async () => {
    const { characterId, serving } = await fixture("retired");
    expect(await command("character.serving.restore", characterId, serving.version)).toMatchObject({ status: "failed", errorCode: "draft_archive_state_invalid" });
    expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId } })).toEqual(serving);
  });
});
