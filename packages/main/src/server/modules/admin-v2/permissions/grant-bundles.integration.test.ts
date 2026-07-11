import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { grantUserBundle, listUserGrantBundles, revokeUserBundle } from "./grant-bundles";
import { actorWithPermission } from "@/server/modules/admin/service";

describe("persisted Admin grant bundle authority", () => {
  const suffix = randomUUID();
  const adminId = `grant-bundle-admin-${suffix}`;
  const operatorId = `grant-bundle-operator-${suffix}`;
  const characterId = `grant-bundle-character-${suffix}`;
  const headers = { "x-idream-user-id": adminId, "x-idream-role": "admin", "x-request-id": `grant-bundle-${suffix}` };

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `${adminId}@idream.internal`, role: "admin", status: "active" },
        { id: operatorId, email: `${operatorId}@idream.internal`, role: "ops", status: "active" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actorId: adminId }, { targetId: operatorId }] } });
    await prisma.adminUserPermission.deleteMany({ where: { userId: operatorId } });
    await prisma.adminUserGrantBundle.deleteMany({ where: { userId: operatorId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, operatorId] } } });
    await prisma.$disconnect();
  });

  function request(method: string, body?: unknown) {
    return new Request(`http://localhost/api/v2/admin/users/${operatorId}/grant-bundles`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("grants a scoped bundle, applies override precedence, and revokes it with Audit", async () => {
    expect(await effectivePermissions(operatorId, "ops")).not.toContain("character.project.read");
    const granted = await grantUserBundle(request("POST", {
      bundleKey: "character_producer",
      scope: { characterIds: [characterId] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      reason: "Assign one Character production portfolio",
      confirmation: `${operatorId}:character_producer:grant`,
    }), operatorId);
    expect(granted.status).toBe(201);
    const effective = await effectivePermissions(operatorId, "ops");
    for (const permission of [
      "character.project.read",
      "character.project.write",
      "character.release.read",
      "character.release.propose",
      "character.release.review",
      "character.performance.read",
    ] as const) expect(effective).toContain(permission);
    const scopedRequest = new Request("http://localhost/api/v2/admin/characters", {
      headers: { "x-idream-user-id": operatorId, "x-idream-role": "ops" },
    });
    await expect(actorWithPermission(scopedRequest, "character.project.read", { characterId })).resolves.toMatchObject({ id: operatorId });
    await expect(actorWithPermission(scopedRequest, "character.project.read", { characterId: `unassigned-${suffix}` })).rejects.toMatchObject({ code: "forbidden" });

    const listed = await listUserGrantBundles(request("GET"), operatorId);
    const body = await listed.json();
    expect(body.data.items).toEqual([expect.objectContaining({
      bundleKey: "character_producer",
      state: "active",
      scope: { characterIds: [characterId] },
    })]);

    await prisma.adminUserPermission.create({
      data: {
        userId: operatorId,
        permissionKey: "character.project.write",
        effect: "revoke",
        reason: "Read-only production assignment",
        createdById: adminId,
      },
    });
    const overridden = await effectivePermissions(operatorId, "ops");
    expect(overridden).toContain("character.project.read");
    expect(overridden).not.toContain("character.project.write");

    const revoked = await revokeUserBundle(request("DELETE", {
      reason: "Production assignment ended",
      confirmation: `${operatorId}:character_producer:revoke`,
    }), operatorId, "character_producer");
    expect(revoked.status).toBe(200);
    expect(await effectivePermissions(operatorId, "ops")).not.toContain("character.project.read");
    expect(await prisma.adminAuditLog.count({
      where: { actorId: adminId, targetId: operatorId, action: { in: ["admin.grant_bundle.granted", "admin.grant_bundle.revoked"] } },
    })).toBe(2);
  });
});
