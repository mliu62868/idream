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

  async function command(commandType: string, targetId: string, expectedVersion: number) {
    const accepted = await acceptControlPlaneCommand(prisma, {
      environment: "test", actor: { id: actorId, role: "admin" }, idempotencyKey: randomUUID(), commandType,
      target: { type: commandType.includes("release.") ? "character_release" : "character_serving", id: targetId },
      expectedVersion, payload: { reason: "Operator abandons obsolete work" }, retryMode: "idempotent", reason: "Operator abandons obsolete work", requestId: randomUUID(),
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
