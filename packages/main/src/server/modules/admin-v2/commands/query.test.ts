import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getCommandRoute } from "@/app/api/v2/admin/commands/[commandId]/route";
import { prisma } from "@/server/lib/db";
import { acceptControlPlaneCommand } from "../shared/control-plane-command";
import { getControlPlaneCommand } from "./query";

describe("Admin v2 command status query", () => {
  const adminId = `admin-v2-query-${randomUUID()}`;
  const analystId = `admin-v2-query-analyst-${randomUUID()}`;
  let commandId = "";
  const targetReadMatrix = [
    ["character_release", "character.release.read"],
    ["character_serving", "character.release.read"],
    ["chat_session", "character.release.read"],
    ["character_project", "character.project.read"],
    ["creative_run", "creative.run.read"],
    ["ops_incident", "ops.incident.read"],
    ["incident_action_plan", "ops.incident.read"],
    ["admin_case", "case.read"],
  ] as const;
  const readerIdByPermission = new Map(
    [...new Set(targetReadMatrix.map(([, permission]) => permission))].map((permission) => [
      permission,
      `admin-v2-query-${permission.replaceAll(".", "-")}-${randomUUID()}`,
    ]),
  );

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: adminId,
        email: `${adminId}@example.test`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.user.createMany({
      data: [
        {
          id: analystId,
          email: `${analystId}@example.test`,
          role: "analyst",
          status: "active",
        },
        ...[...readerIdByPermission.values()].map((readerId) => ({
          id: readerId,
          email: `${readerId}@example.test`,
          role: "user",
          status: "active",
        })),
      ],
    });
    await prisma.adminUserPermission.createMany({
      data: [...readerIdByPermission].flatMap(([permissionKey, readerId]) =>
        ["dashboard.read", permissionKey].map((grantedPermission) => ({
          userId: readerId,
          permissionKey: grantedPermission,
          effect: "grant",
          reason: "command target permission matrix test",
          createdById: adminId,
        })),
      ),
    });
    const accepted = await acceptControlPlaneCommand(prisma, {
      environment: "test",
      actor: { id: adminId, role: "admin" },
      idempotencyKey: randomUUID(),
      commandType: "incident.resolve",
      target: { type: "ops_incident", id: "incident-query-1" },
      expectedVersion: 2,
      payload: {},
      reason: "verify status endpoint",
      requestId: randomUUID(),
    });
    commandId = accepted.commandId;
    await prisma.controlPlaneCommand.createMany({
      data: targetReadMatrix.map(([targetType], index) => ({
        id: `command-target-${index}-${adminId}`,
        scope: `test:${adminId}:target-matrix`,
        idempotencyKey: `target-matrix-${index}`,
        commandType: `test.${targetType}.readback`,
        targetType,
        targetId: `target-${index}`,
        actorId: adminId,
        requestId: `request-${index}`,
        requestHash: `hash-${index}`,
        requestPayload: {},
      })),
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: "incident-query-1" } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId: adminId } });
    const readerIds = [...readerIdByPermission.values()];
    await prisma.adminUserPermission.deleteMany({ where: { userId: { in: readerIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, analystId, ...readerIds] } } });
    await prisma.$disconnect();
  });

  it("returns the authoritative command state through effective permissions", async () => {
    const response = await getControlPlaneCommand(
      new Request("http://localhost/api/v2/admin/commands/command", {
        headers: { "x-idream-user-id": adminId, "x-idream-role": "admin" },
      }),
      commandId,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      data: {
        commandId,
        commandType: "incident.resolve",
        target: { type: "ops_incident", id: "incident-query-1" },
        status: "accepted",
        verificationState: "pending",
        needsReconciliation: false,
      },
    });
  });

  it("does not expose command state to an unauthenticated caller", async () => {
    for (const id of [commandId, "unknown-command"]) {
      const response = await getControlPlaneCommand(
        new Request("http://localhost/api/v2/admin/commands/command"),
        id,
      );
      expect(response.status).toBe(401);
    }
  });

  it("rejects an authenticated actor without the target read permission", async () => {
    const response = await getControlPlaneCommand(
      new Request("http://localhost/api/v2/admin/commands/command", {
        headers: { "x-idream-user-id": analystId, "x-idream-role": "analyst" },
      }),
      commandId,
    );
    expect(response.status).toBe(403);
  });

  it.each(targetReadMatrix)(
    "reads %s commands through the real Route Handler with its declared %s permission",
    async (targetType, permission) => {
      const index = targetReadMatrix.findIndex(([candidate]) => candidate === targetType);
      const targetCommandId = `command-target-${index}-${adminId}`;
      const readerId = readerIdByPermission.get(permission)!;
      const response = await getCommandRoute(
        new Request(`http://localhost/api/v2/admin/commands/${targetCommandId}`, {
          headers: { "x-idream-user-id": readerId, "x-idream-role": "user" },
        }),
        { params: Promise.resolve({ commandId: targetCommandId }) },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: { commandId: targetCommandId, target: { type: targetType } },
      });
    },
  );
  describe("Character scope", () => {
    const producerId = `admin-v2-query-producer-${randomUUID()}`;
    const inScope = `query-character-in-${randomUUID()}`;
    const outOfScope = `query-character-out-${randomUUID()}`;
    const projectId = `query-project-${randomUUID()}`;
    const releaseId = `query-release-${randomUUID()}`;

    function read(commandIdToRead: string, actor: { id: string; role: string }) {
      return getCommandRoute(
        new Request(`http://localhost/api/v2/admin/commands/${commandIdToRead}`, {
          headers: { "x-idream-user-id": actor.id, "x-idream-role": actor.role },
        }),
        { params: Promise.resolve({ commandId: commandIdToRead }) },
      );
    }

    async function seedCommand(targetType: string, targetId: string, requestPayload: object = {}) {
      const id = `command-scope-${randomUUID()}`;
      await prisma.controlPlaneCommand.create({
        data: {
          id, scope: `test:${adminId}:scope`, idempotencyKey: id, commandType: `test.${targetType}.readback`,
          targetType, targetId, actorId: adminId, requestId: id, requestHash: id, requestPayload,
        },
      });
      return id;
    }

    beforeAll(async () => {
      await prisma.user.create({
        data: { id: producerId, email: `${producerId}@example.test`, role: "user", status: "active" },
      });
      await prisma.adminUserPermission.create({
        data: { userId: producerId, permissionKey: "dashboard.read", effect: "grant", reason: "scope test", createdById: adminId },
      });
      await prisma.adminUserGrantBundle.create({
        data: {
          userId: producerId,
          bundleKey: "character_producer",
          scope: { characterIds: [inScope] },
          reason: "Command read scope fixture",
          createdById: adminId,
        },
      });
      await prisma.character.create({
        data: { id: outOfScope, name: "Out of scope", age: 24, description: "fixture", appearance: {}, advancedDetails: {} },
      });
      await prisma.characterProject.create({ data: { id: projectId, characterId: outOfScope } });
      await prisma.characterRelease.create({
        data: {
          id: releaseId, projectId, revisionId: releaseId, characterContentVersionId: releaseId,
          generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: releaseId, status: "approved",
        },
      });
    });

    afterAll(async () => {
      await prisma.characterRelease.deleteMany({ where: { id: releaseId } });
      await prisma.characterProject.deleteMany({ where: { id: projectId } });
      await prisma.character.deleteMany({ where: { id: outOfScope } });
      await prisma.adminUserGrantBundle.deleteMany({ where: { userId: producerId } });
      await prisma.adminUserPermission.deleteMany({ where: { userId: producerId } });
      await prisma.user.deleteMany({ where: { id: producerId } });
    });

    it("lets a scoped producer read a command on its own Character only", async () => {
      const own = await seedCommand("character_serving", inScope);
      const foreign = await seedCommand("character_serving", outOfScope);

      expect((await read(own, { id: producerId, role: "user" })).status).toBe(200);
      expect((await read(foreign, { id: producerId, role: "user" })).status).toBe(403);
    });

    it("resolves the Character through a Release, Project, and session payload target", async () => {
      const targets = [
        await seedCommand("character_release", releaseId),
        await seedCommand("character_project", projectId),
        await seedCommand("chat_session", `missing-session-${randomUUID()}`, { characterId: outOfScope }),
      ];

      for (const target of targets) {
        expect((await read(target, { id: producerId, role: "user" })).status).toBe(403);
      }
    });

    it("fails closed on an unresolvable target for a scoped actor, not for a global one", async () => {
      const unresolved = await seedCommand("character_project", "uncommitted");

      expect((await read(unresolved, { id: producerId, role: "user" })).status).toBe(403);
      expect((await read(unresolved, { id: adminId, role: "admin" })).status).toBe(200);
    });
  });
});
