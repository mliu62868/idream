import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { prisma } from "@/server/lib/db";
import { createCharacter, publishCharacterForPublicAudience, purgeTestData } from "@/server/test/helpers";
import { updateOperationalWorkPreference } from "./preferences";

/**
 * SPEC: Today preferences on Character Releases and on Character-targeted commands follow the same
 *       Character scope as the rest of the console: a Character-scoped character.release.read reaches
 *       only its assigned Characters, and a scoped actor cannot tell whether an out-of-scope Release exists.
 */
describe("Today preferences: Character Release scope", () => {
  const prefix = `today-release-scope-${randomUUID().slice(0, 8)}`;
  const adminId = `${prefix}-admin`;
  const creatorId = `${prefix}-creator`;
  const characterA = `${prefix}-character-a`;
  const characterB = `${prefix}-character-b`;
  const commandA = `${prefix}-command-a`;
  const commandB = `${prefix}-command-b`;
  const creator = { id: creatorId, role: "analyst" };
  const admin = { id: adminId, role: "admin" };
  let releaseA = "";
  let releaseB = "";

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
      // INTENT: analyst carries dashboard.read but no character.release.read of its own, so the only
      //         Release read this actor holds comes from the Character-scoped bundle.
      { id: creatorId, email: `${creatorId}@example.test`, role: "analyst", status: "active" },
    ] });
    await prisma.adminUserGrantBundle.create({ data: {
      userId: creatorId,
      bundleKey: "character_creator",
      scope: { characterIds: [characterA] },
      reason: "Today release scope fixture",
      createdById: adminId,
    } });
    for (const id of [characterA, characterB]) await createCharacter({ id, creatorId: adminId });
    releaseA = (await publishCharacterForPublicAudience({ characterId: characterA, ownerId: adminId })).releaseId;
    releaseB = (await publishCharacterForPublicAudience({ characterId: characterB, ownerId: adminId })).releaseId;
    const command = (id: string, characterId: string) => ({
      id,
      scope: id,
      commandType: "character.serving.pause",
      targetType: "character_serving",
      targetId: characterId,
      actorId: creatorId,
      requestId: `${id}-request`,
      requestHash: `${id}-hash`,
      idempotencyKey: `${id}-key`,
      status: "succeeded",
    });
    await prisma.controlPlaneCommand.createMany({ data: [command(commandA, characterA), command(commandB, characterB)] });
  });

  afterAll(async () => {
    await prisma.operationalWorkPreference.deleteMany({ where: { actorId: { in: [adminId, creatorId] } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: { in: [adminId, creatorId] } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: [commandA, commandB] } } });
    await prisma.adminUserGrantBundle.deleteMany({ where: { userId: creatorId } });
    await purgeTestData(prefix);
  });

  async function prefer(actor: { id: string; role: string }, sourceType: "character_release" | "control_plane_command", sourceId: string) {
    return updateOperationalWorkPreference({
      actor,
      permissions: await effectivePermissions(actor.id, actor.role as never),
      sourceType,
      sourceId,
      watching: true,
      requestId: `${prefix}-${sourceId}`,
      expectedVersion: 0,
    });
  }

  it("lets a scoped creator watch a Release of its assigned Character", async () => {
    await expect(prefer(creator, "character_release", releaseA)).resolves.toMatchObject({ watching: true });
  });

  it("refuses a Release outside the scope with the authority seam's 403 shape", async () => {
    await expect(prefer(creator, "character_release", releaseB)).rejects.toMatchObject({
      status: 403,
      details: { permission: "character.release.read", characterId: characterB },
    });
  });

  it("does not reveal whether an out-of-scope Release exists", async () => {
    await expect(prefer(creator, "character_release", `${prefix}-missing-release`)).rejects.toMatchObject({
      status: 403,
      details: { permission: "character.release.read", characterId: null },
    });
    await expect(prefer(admin, "character_release", `${prefix}-missing-release`)).rejects.toMatchObject({ status: 404 });
  });

  it("scopes the actor's own Character serving commands by the command target", async () => {
    await expect(prefer(creator, "control_plane_command", commandA)).resolves.toMatchObject({ watching: true });
    await expect(prefer(creator, "control_plane_command", commandB)).rejects.toMatchObject({
      status: 403,
      details: { permission: "character.release.read", characterId: characterB },
    });
  });

  it("leaves a global grant unchanged", async () => {
    await expect(prefer(admin, "character_release", releaseB)).resolves.toMatchObject({ watching: true });
  });
});
